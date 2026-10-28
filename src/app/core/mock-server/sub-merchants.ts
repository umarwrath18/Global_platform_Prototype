import { CountryApplication, StaffRole } from '../merchants/merchant-models';
import { countryName, ONBOARDING_COUNTRIES, subMerchantRoutes } from '../merchants/onboarding-config';
import { activePricing } from '../merchants/products';
import { regionForCountry } from '../merchants/regions';
import { SUB_MERCHANT_CHECKS, SubMerchantView } from '../merchants/sub-merchants';
import { entityOfApplication, entityProblems, formatEntityId, goLiveBlocker, isRuleError, issueMid, MerchantEntity, parentEntityOf, RegionalMid, toMidView } from './merchant-identity';
import type { Caller, MerchantDb, MerchantRecord } from './merchant-server';
import { productState } from './product-pricing';
import { fail } from './server-errors';

// Sub-merchants (simulated backend). Created by Sales / Operations where the country allows it,
// reviewed by Risk, taken live by CS. Go-live issues the sub-merchant's own live MID in one save,
// only when the parent is live in that country and neither is suspended. Every step is recorded
// on the sub-merchant. A sub-merchant's suspension affects only itself.

export interface SubMerchantContext {
  db: MerchantDb;
  caller: Caller;
  role: StaffRole;
  now: number;
  /** Guided mode completes open go-live checks instead of refusing. */
  strict: boolean;
  notify: (event: 'sub_merchant_submitted' | 'sub_merchant_decided' | 'sub_merchant_live', merchant: MerchantRecord, audience: StaffRole[], title: string, body: string) => void;
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

function requireRole(ctx: SubMerchantContext, roles: StaffRole[], message: string) {
  if (!roles.includes(ctx.role)) fail(403, 'ROLE_NOT_PERMITTED', { message });
}

function findSub(db: MerchantDb, id: string): MerchantEntity {
  const e = (db.entities ?? []).find((x) => x.id === id && x.kind === 'sub');
  return e ?? fail(404, 'NOT_FOUND', { message: 'No such sub-merchant.' });
}

function parentMerchant(db: MerchantDb, sub: MerchantEntity): MerchantRecord {
  return db.merchants.find((m) => m.id === sub.gmid) ?? fail(404, 'NOT_FOUND', { message: `No Global Merchant ${sub.gmid}.` });
}

function record(ctx: SubMerchantContext, sub: MerchantEntity, action: string, comment: string | null = null, system = false) {
  sub.history ??= [];
  sub.history.push({ at: ctx.now, action, by: system ? 'System' : ctx.caller.name, role: system ? 'system' : ctx.role, comment });
}

/** The parent entity's application in a country (not rejected), whose products and pricing apply. */
function parentApplication(db: MerchantDb, parent: MerchantEntity, country: string): CountryApplication | undefined {
  return db.applications.find((a) => a.country === country && a.status !== 'rejected' && entityOfApplication(db.entities ?? [], a)?.id === parent.id);
}

export function createSubMerchant(ctx: SubMerchantContext, gmid: string, body: any): SubMerchantView {
  const merchant = ctx.db.merchants.find((m) => m.id === gmid) ?? fail(404, 'NOT_FOUND', { message: `No Global Merchant ${gmid}.` });
  const parent = parentEntityOf(ctx.db.entities ?? [], gmid) ?? fail(409, 'INVALID_TRANSITION', { message: 'This merchant has no parent entity yet. Reload and try again.' });
  const country = str(body?.country, 2).toUpperCase();
  const cfg = ONBOARDING_COUNTRIES[country] ?? fail(422, 'COUNTRY_NOT_SUPPORTED', { message: 'Choose a country the parent has applied for.' });
  const routes = subMerchantRoutes(cfg);
  const route = body?.route === 'parent' ? 'parent' : 'ops';
  if (route === 'parent') {
    if (!routes.parentInitiated) fail(409, 'SUB_MERCHANT_ROUTE_NOT_ALLOWED', { message: `Parent-created sub-merchants are not permitted in ${cfg.name}.` });
    fail(403, 'ROLE_NOT_PERMITTED', { message: 'Parent-created sub-merchants need a merchant-facing portal, which does not exist in this prototype.' });
  }
  requireRole(ctx, ['sales'], 'Only Sales / Operations can create sub-merchants.');
  if (!routes.opsInitiated) fail(409, 'SUB_MERCHANT_ROUTE_NOT_ALLOWED', { message: `Country configuration doesn't allow Sales / Operations to create sub-merchants in ${cfg.name}.` });
  if (merchant.lifecycleStatus === 'suspended') fail(409, 'MERCHANT_SUSPENDED', { message: `${merchant.legalName} is suspended, so it can't add sub-merchants. Risk must reactivate the merchant first.` });
  if (!parentApplication(ctx.db, parent, country)) fail(422, 'VALIDATION_FAILED', { message: `${merchant.legalName} has no application in ${cfg.name}, so it can't have sub-merchants there.` });

  const errors: { section: 'business'; field: string; message: string }[] = [];
  const displayName = str(body?.displayName, 200).trim();
  if (displayName.length < 2) errors.push({ section: 'business', field: 'displayName', message: 'Enter the sub-merchant name.' });
  else if (displayName.length > 120) errors.push({ section: 'business', field: 'displayName', message: 'Use 120 characters or fewer.' });
  let legalEntity: MerchantEntity['legalEntity'] = null;
  if (body?.legalEntity) {
    const legalName = str(body.legalEntity.legalName, 200).trim();
    const registrationNumber = str(body.legalEntity.registrationNumber, 40).trim();
    if (!legalName) errors.push({ section: 'business', field: 'legalEntity.legalName', message: 'Enter the registered legal name.' });
    else if (legalName.length > 160) errors.push({ section: 'business', field: 'legalEntity.legalName', message: 'Use 160 characters or fewer.' });
    if (!registrationNumber) errors.push({ section: 'business', field: 'legalEntity.registrationNumber', message: `Enter the ${cfg.localRegistration.label}.` });
    else if (cfg.localRegistration.pattern && !new RegExp(cfg.localRegistration.pattern).test(registrationNumber)) {
      errors.push({ section: 'business', field: 'legalEntity.registrationNumber', message: `${cfg.localRegistration.label} format is not valid${cfg.localRegistration.hint ? ` (${cfg.localRegistration.hint})` : ''}.` });
    } else if (registrationNumber.replace(/\W/g, '').toUpperCase() === merchant.registrationNumber.replace(/\W/g, '').toUpperCase()) {
      errors.push({ section: 'business', field: 'legalEntity.registrationNumber', message: "That's the parent's registration number. Choose \"trades under the parent\" instead." });
    }
    legalEntity = { legalName, registrationNumber };
  }
  if (errors.length) fail(422, 'VALIDATION_FAILED', { errors });
  const clash = (ctx.db.entities ?? []).find((e) => e.parentEntityId === parent.id && e.country === country && e.displayName?.toLowerCase() === displayName.toLowerCase() && e.status !== 'rejected');
  if (clash) fail(409, 'DUPLICATE_MERCHANT', { message: `${merchant.legalName} already has a sub-merchant called ${clash.displayName} in ${cfg.name}.` });

  ctx.db.seq.entity ??= 1;
  const sub: MerchantEntity = {
    id: formatEntityId(ctx.db.seq.entity++),
    gmid,
    kind: 'sub',
    parentEntityId: parent.id,
    legalEntity,
    displayName,
    lifecycleStatus: 'active',
    lifecycleReason: null,
    createdAt: ctx.now,
    createdBy: ctx.caller.name,
    country,
    status: 'draft',
    createdVia: 'ops',
    goLiveChecks: SUB_MERCHANT_CHECKS.map((c) => ({ ...c, done: false, doneAt: null, doneBy: null })),
    history: [],
    submittedBy: null,
    submittedAt: null,
    decidedBy: null,
    decidedRole: null,
    decidedAt: null,
    decisionComment: null,
  };
  const problems = entityProblems(sub, [...(ctx.db.entities ?? []), sub]);
  if (problems.length) fail(422, 'VALIDATION_FAILED', { message: problems.join(' ') });
  ctx.db.entities!.push(sub);
  record(ctx, sub, `Sub-merchant created (${legalEntity ? 'separate legal entity' : 'trades under the parent'})`);
  if (body?.submit === true) submit(ctx, sub, merchant);
  return subMerchantView(ctx.db, sub, ctx.now);
}

export function submitSubMerchant(ctx: SubMerchantContext, id: string): SubMerchantView {
  requireRole(ctx, ['sales'], 'Only Sales / Operations can submit sub-merchants to Risk.');
  const sub = findSub(ctx.db, id);
  if (sub.status !== 'draft') fail(409, 'INVALID_TRANSITION', { message: 'Only a draft sub-merchant can be submitted.' });
  submit(ctx, sub, parentMerchant(ctx.db, sub));
  return subMerchantView(ctx.db, sub, ctx.now);
}

function submit(ctx: SubMerchantContext, sub: MerchantEntity, merchant: MerchantRecord) {
  Object.assign(sub, { status: 'pending_risk_review', submittedBy: ctx.caller.name, submittedAt: ctx.now });
  record(ctx, sub, 'Submitted for Risk review');
  ctx.notify('sub_merchant_submitted', merchant, ['risk'], `Sub-merchant to review: ${sub.displayName} · ${merchant.legalName}`, `${ctx.caller.name} submitted ${sub.displayName} (${countryName(sub.country!)}) under ${merchant.legalName} for Risk review.`);
}

/** Lightweight Risk review: approve, or reject with a reason (final; create a new record to retry). */
export function reviewSubMerchant(ctx: SubMerchantContext, id: string, body: any): SubMerchantView {
  requireRole(ctx, ['risk'], 'Only Risk can approve or reject sub-merchants.');
  const sub = findSub(ctx.db, id);
  if (sub.status !== 'pending_risk_review') fail(409, 'INVALID_TRANSITION', { message: 'This sub-merchant is not waiting for Risk review.' });
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'reject') fail(400, 'VALIDATION_FAILED', { message: 'Choose approve or reject.' });
  const comment = str(body?.comment, 1000).trim();
  if (decision === 'reject' && comment.length < 10) fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'business', field: 'comment', message: 'Give the reason for rejecting (at least 10 characters).' }] });
  Object.assign(sub, { status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: ctx.caller.name, decidedRole: ctx.role, decidedAt: ctx.now, decisionComment: comment || null });
  record(ctx, sub, decision === 'approve' ? 'Approved by Risk' : 'Rejected by Risk', comment || null);
  const merchant = parentMerchant(ctx.db, sub);
  ctx.notify('sub_merchant_decided', merchant, ['sales', 'cs'], `Sub-merchant ${decision === 'approve' ? 'approved' : 'rejected'}: ${sub.displayName}`, `Risk ${decision === 'approve' ? 'approved' : 'rejected'} ${sub.displayName} under ${merchant.legalName}.${comment ? ` ${comment}` : ''}`);
  return subMerchantView(ctx.db, sub, ctx.now);
}

export function setSubMerchantCheck(ctx: SubMerchantContext, id: string, body: any): SubMerchantView {
  requireRole(ctx, ['cs'], 'Only Customer Success completes go-live checks.');
  const sub = findSub(ctx.db, id);
  if (sub.status !== 'approved') fail(409, 'INVALID_TRANSITION', { message: 'Go-live checks open once Risk has approved the sub-merchant.' });
  const item = sub.goLiveChecks?.find((c) => c.key === body?.key) ?? fail(404, 'NOT_FOUND', { message: 'No such check.' });
  const done = body?.done === true;
  Object.assign(item, { done, doneAt: done ? ctx.now : null, doneBy: done ? ctx.caller.name : null });
  record(ctx, sub, `${done ? 'Completed' : 'Reopened'}: ${item.label}`);
  return subMerchantView(ctx.db, sub, ctx.now);
}

/**
 * CS takes an approved sub-merchant live: the parent must be live in that country and neither may be
 * suspended. Issues the sub-merchant's own live MID in the same save. Repeating a completed go-live
 * returns the existing result. No Global Account changes (the parent's account already has the country).
 */
export function goLiveSubMerchant(ctx: SubMerchantContext, id: string): SubMerchantView {
  requireRole(ctx, ['cs'], 'Only Customer Success can take a sub-merchant live.');
  const sub = findSub(ctx.db, id);
  if (sub.status === 'live') return subMerchantView(ctx.db, sub, ctx.now);
  if (sub.status !== 'approved') fail(409, 'INVALID_TRANSITION', { message: 'A sub-merchant goes live after Risk approves it.' });
  const blocked = goLiveBlocker({ merchants: ctx.db.merchants, entities: ctx.db.entities ?? [], applications: ctx.db.applications }, sub.id, sub.country!);
  if (blocked) fail(409, blocked.code, { message: blocked.message });
  const regionCode = regionForCountry(sub.country!) ?? fail(422, 'COUNTRY_NOT_SUPPORTED', { message: 'No region is configured for this country, so no live MID can be issued.' });
  const open = (sub.goLiveChecks ?? []).filter((c) => !c.done);
  if (open.length && ctx.strict) fail(409, 'CHECKLIST_INCOMPLETE', { message: `Complete: ${open.map((c) => c.label).join('; ')}.` });
  for (const c of open) {
    Object.assign(c, { done: true, doneAt: ctx.now, doneBy: ctx.caller.name });
    record(ctx, sub, `Completed: ${c.label}`);
  }
  const issued = issueMid(ctx.db, { entityId: sub.id, gmid: sub.gmid, regionCode, country: sub.country!, source: 'go_live', issuedAt: ctx.now, issuedBy: ctx.caller.name, applicationId: null, demo: false });
  if (isRuleError(issued)) fail(409, issued.code, { message: issued.message });
  const mid = issued as RegionalMid;
  sub.status = 'live';
  record(ctx, sub, `Live in ${countryName(sub.country!)} – live MID ${mid.mid} issued`);
  const merchant = parentMerchant(ctx.db, sub);
  ctx.notify('sub_merchant_live', merchant, ['sales', 'cs', 'risk'], `Live: ${sub.displayName} · ${countryName(sub.country!)}`, `${sub.displayName} under ${merchant.legalName} is live with MID ${mid.mid}.`);
  return subMerchantView(ctx.db, sub, ctx.now);
}

/** Suspends or reactivates one sub-merchant only (Sales / Operations or Risk suspend; only Risk reactivates). */
export function subMerchantLifecycle(ctx: SubMerchantContext, id: string, body: any): SubMerchantView {
  const action = body?.action;
  const reason = str(body?.reason, 500).trim();
  if (action !== 'suspend' && action !== 'reactivate') fail(400, 'VALIDATION_FAILED', { message: 'Choose a valid lifecycle action.' });
  if (reason.length < 5) fail(400, 'VALIDATION_FAILED', { message: 'Enter a reason with at least 5 characters.' });
  if (action === 'suspend') requireRole(ctx, ['sales', 'risk'], 'Only Sales / Operations or Risk can suspend a sub-merchant.');
  else requireRole(ctx, ['risk'], 'Only Risk can reactivate a suspended sub-merchant.');
  const sub = findSub(ctx.db, id);
  if (sub.status === 'rejected') fail(409, 'INVALID_TRANSITION', { message: 'A rejected sub-merchant cannot be suspended or reactivated.' });
  const current = sub.lifecycleStatus ?? 'active';
  if (action === 'suspend' && current === 'suspended') fail(409, 'INVALID_TRANSITION', { message: 'This sub-merchant is already suspended.' });
  if (action === 'reactivate' && current !== 'suspended') fail(409, 'INVALID_TRANSITION', { message: 'Only a suspended sub-merchant can be reactivated.' });
  sub.lifecycleStatus = action === 'suspend' ? 'suspended' : 'active';
  sub.lifecycleReason = action === 'suspend' ? reason : null;
  record(ctx, sub, action === 'suspend' ? 'Sub-merchant suspended' : 'Sub-merchant reactivated', reason);
  return subMerchantView(ctx.db, sub, ctx.now);
}

export function subMerchantView(db: MerchantDb, sub: MerchantEntity, now: number): SubMerchantView {
  const parent = (db.entities ?? []).find((e) => e.id === sub.parentEntityId);
  const app = parent ? parentApplication(db, parent, sub.country!) : undefined;
  const mid = (db.mids ?? []).find((m) => m.entityId === sub.id);
  const blocker = sub.status === 'approved' ? goLiveBlocker({ merchants: db.merchants, entities: db.entities ?? [], applications: db.applications }, sub.id, sub.country!) : null;
  let products: SubMerchantView['inherited']['products'] = [];
  if (app) {
    const s = productState(db, app);
    products = s.config.products.filter((p) => p.enabled).map((p) => ({
      name: s.methods.find((m) => m.code === p.methodCode)?.name ?? p.methodCode,
      mdrPct: activePricing(s.versions, p.methodCode, now)?.mdrPct ?? null,
      settlement: s.config.settlement[p.methodCode] ?? null,
    }));
  }
  return {
    id: sub.id,
    displayName: sub.displayName ?? '',
    legalEntity: sub.legalEntity,
    country: sub.country!,
    status: sub.status ?? 'draft',
    createdVia: sub.createdVia ?? 'ops',
    createdBy: sub.createdBy,
    createdAt: sub.createdAt,
    lifecycleStatus: sub.lifecycleStatus ?? 'active',
    lifecycleReason: sub.lifecycleReason ?? null,
    goLiveChecks: sub.goLiveChecks ?? [],
    history: [...(sub.history ?? [])].reverse(),
    mid: mid ? toMidView(mid) : null,
    goLiveBlocker: blocker?.message ?? null,
    parentApplicationId: app?.id ?? null,
    inherited: { products },
  };
}

export function subMerchantsOf(db: MerchantDb, gmid: string, now: number): SubMerchantView[] {
  return (db.entities ?? []).filter((e) => e.gmid === gmid && e.kind === 'sub').sort((a, b) => a.createdAt - b.createdAt).map((e) => subMerchantView(db, e, now));
}
