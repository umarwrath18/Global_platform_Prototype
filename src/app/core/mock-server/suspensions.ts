import { ApprovalItem } from '../merchants/change-requests';
import { MerchantLifecycleStatus, StaffRole } from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../merchants/onboarding-config';
import {
  CONTROL_CHIP,
  CONTROL_KEYS,
  DETECTED_BY,
  isFraudType,
  MERCHANT_REVIEW_MESSAGE,
  MERCHANT_REVIEW_TITLE,
  needsCaseRef,
  NO_CONTROLS,
  PaymentControls,
  REACTIVATION_OUTCOMES,
  REVIEW_WINDOW_MS,
  SALES_SUSPENSION_TYPES,
  Suspension,
  SuspensionEffect,
  SuspensionScope,
  SuspensionType,
  SUSPENSION_SCOPE_LABEL,
  SUSPENSION_TYPE_LABEL,
  SUSPENSION_TYPES,
  SuspensionView,
} from '../merchants/suspensions';
import type { Caller, MerchantDb, MerchantRecord } from './merchant-server';
import { fail } from './server-errors';

// Merchant and sub-merchant suspension (docs/merchant-suspension.md). Scope: the whole merchant
// (all countries and sub-merchants), one country MID (with its sub-merchants) or one sub-merchant.
// Payment controls block new pay-ins, payouts and refunds, and hold settlement. Fraud types are Risk
// only, take effect at once, and need a second Risk person to review within 24 hours and to approve
// a reactivation. Held settlement is released only by FinOps.

export type SuspensionEvent = 'merchant_suspended' | 'suspension_reviewed' | 'merchant_reactivated' | 'reactivation_requested' | 'settlement_release_requested' | 'settlement_released';

export interface SuspensionContext {
  db: MerchantDb;
  caller: Caller;
  role: StaffRole;
  now: number;
  notify: (event: SuspensionEvent, merchant: MerchantRecord, audience: StaffRole[], title: string, body: string, to?: string[]) => void;
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max).trim() : '');
const countryName = (c: string | null) => (c ? (ONBOARDING_COUNTRIES[c]?.name ?? c) : '');

function merchantOf(db: MerchantDb, gmid: string): MerchantRecord {
  const m = db.merchants.find((x) => x.id === gmid);
  if (!m) fail(404, 'NOT_FOUND', { message: 'Merchant not found.' });
  return m!;
}

function findSuspension(db: MerchantDb, id: string): Suspension {
  const s = (db.suspensions ?? []).find((x) => x.id === id);
  if (!s) fail(404, 'NOT_FOUND', { message: 'Suspension not found.' });
  return s!;
}

const liveCountries = (db: MerchantDb, gmid: string) => db.applications.filter((a) => a.merchantId === gmid && a.status === 'operational').map((a) => a.country);
const subsOf = (db: MerchantDb, gmid: string) => (db.entities ?? []).filter((e) => e.gmid === gmid && e.kind === 'sub');
const subName = (db: MerchantDb, id: string | null) => (id ? ((db.entities ?? []).find((e) => e.id === id)?.displayName ?? id) : null);

/** Who and what a suspension covers, e.g. "Whole merchant · 3 MIDs and 2 sub-merchants". */
function coverage(db: MerchantDb, s: Pick<Suspension, 'gmid' | 'scope' | 'country' | 'subMerchantId'>): string {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  if (s.scope === 'sub_merchant') return `${subName(db, s.subMerchantId)} (${countryName(s.country)})`;
  const countries = s.scope === 'merchant' ? liveCountries(db, s.gmid) : [s.country!];
  const subs = subsOf(db, s.gmid).filter((e) => e.status === 'live' && countries.includes(e.country ?? ''));
  return `${n(countries.length, 'MID')}${subs.length ? ` and ${n(subs.length, 'sub-merchant')}` : ''}${s.scope === 'country' ? ` in ${countryName(s.country)}` : ''}`;
}

export function toSuspensionView(db: MerchantDb, s: Suspension): SuspensionView {
  return { ...s, merchantName: db.merchants.find((m) => m.id === s.gmid)?.legalName ?? s.gmid, countryName: s.country ? countryName(s.country) : null, subMerchantName: subName(db, s.subMerchantId), coverage: coverage(db, s) };
}

export function suspensionsOf(db: MerchantDb, gmid: string): SuspensionView[] {
  return (db.suspensions ?? []).filter((s) => s.gmid === gmid).sort((a, b) => b.createdAt - a.createdAt).map((s) => toSuspensionView(db, s));
}

const held = (s: Suspension) => s.settlement.status === 'held' || s.settlement.status === 'release_pending';
const covers = (s: Suspension, country: string, subId: string | null) =>
  s.scope === 'merchant' || (s.scope === 'country' && s.country === country) || (s.scope === 'sub_merchant' && subId !== null && s.subMerchantId === subId);

/** What one MID (subId null) or sub-merchant is under right now. Merchant beats country beats own. */
export function effectFor(db: MerchantDb, gmid: string, country: string, subId: string | null): SuspensionEffect {
  const mine = (db.suspensions ?? []).filter((s) => s.gmid === gmid && covers(s, country, subId));
  const active = mine.filter((s) => s.status === 'active');
  const order: SuspensionScope[] = ['merchant', 'country', 'sub_merchant'];
  const top = [...active].sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope))[0];
  const controls: PaymentControls = { ...NO_CONTROLS };
  for (const s of active) for (const k of CONTROL_KEYS) if (k !== 'settlement' && s.controls[k]) controls[k] = true;
  if (mine.some(held)) controls.settlement = true;
  return { suspended: !!top, via: top?.scope ?? null, suspensionId: top?.id ?? null, type: top?.type ?? null, controls };
}

/** Payment blocks for the sample transactions of one country (see transaction-data.ts). */
export function transactionBlocks(db: MerchantDb, gmid: string, country: string) {
  return (db.suspensions ?? [])
    .filter((s) => s.gmid === gmid && (s.scope === 'merchant' || s.country === country))
    .map((s) => ({
      from: s.createdAt,
      to: s.liftedAt,
      payins: s.controls.payins,
      payouts: s.controls.payouts,
      /** '*' = the MID and all its sub-merchants. */
      subMerchantId: s.scope === 'sub_merchant' ? s.subMerchantId! : '*',
      settlementHeld: held(s),
    }));
}

/** True when the merchant's portal is read only (an active fraud or compliance suspension anywhere). */
export function merchantUnderReview(db: MerchantDb, gmid: string): boolean {
  return (db.suspensions ?? []).some((s) => s.gmid === gmid && s.status === 'active' && (isFraudType(s.type) || s.type === 'compliance'));
}

// ------------------------------------------------------------------ create

export interface SuspendInput {
  type: SuspensionType;
  scope: SuspensionScope;
  country: string | null;
  subMerchantId: string | null;
  controls: PaymentControls;
  caseRef: string;
  detectedBy: string;
  reason: string;
  linkedTransactions: string[];
}

/** Checks a suspension request (before the MFA code is asked). */
export function checkSuspend(ctx: SuspensionContext, gmid: string, body: any): SuspendInput {
  const { db, role } = ctx;
  const merchant = merchantOf(db, gmid);
  const type = body?.type as SuspensionType;
  if (!SUSPENSION_TYPES.includes(type)) fail(400, 'VALIDATION_FAILED', { message: 'Choose a suspension type.' });
  if (role !== 'risk' && role !== 'sales') fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only Sales / Operations or Risk can suspend a merchant.' });
  if (role === 'sales' && !SALES_SUSPENSION_TYPES.includes(type)) fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only Risk can suspend for fraud or compliance.' });
  const scope = body?.scope as SuspensionScope;
  if (!['merchant', 'country', 'sub_merchant'].includes(scope)) fail(400, 'VALIDATION_FAILED', { message: 'Choose a scope.' });
  let country: string | null = null;
  let subMerchantId: string | null = null;
  const live = liveCountries(db, gmid);
  if (scope === 'merchant') {
    if (!live.length) fail(409, 'INVALID_TRANSITION', { message: 'Only a merchant with at least one operational country can be suspended.' });
  } else if (scope === 'country') {
    country = str(body?.country, 2).toUpperCase();
    if (!live.includes(country)) fail(400, 'VALIDATION_FAILED', { message: 'Choose a country where the merchant is live.' });
  } else {
    subMerchantId = str(body?.subMerchantId, 40);
    const sub = subsOf(db, gmid).find((e) => e.id === subMerchantId);
    if (!sub) fail(400, 'VALIDATION_FAILED', { message: 'Choose a sub-merchant of this merchant.' });
    if (sub!.status === 'rejected') fail(409, 'INVALID_TRANSITION', { message: 'A rejected sub-merchant cannot be suspended or reactivated.' });
    country = sub!.country ?? null;
  }
  const same = (db.suspensions ?? []).find((s) => s.gmid === gmid && s.status === 'active' && s.scope === scope && s.country === (scope === 'merchant' ? null : country) && s.subMerchantId === subMerchantId);
  if (same) {
    const what = scope === 'merchant' ? 'This merchant' : scope === 'country' ? `${merchant.legalName} in ${countryName(country)}` : 'This sub-merchant';
    fail(409, 'INVALID_TRANSITION', { message: `${what} is already suspended.` });
  }
  const controls: PaymentControls = { ...NO_CONTROLS };
  for (const k of CONTROL_KEYS) controls[k] = body?.controls?.[k] === true;
  const caseRef = str(body?.caseRef, 40);
  if (needsCaseRef(type) && !caseRef) fail(400, 'VALIDATION_FAILED', { message: 'Enter a case reference.' });
  const detectedBy = str(body?.detectedBy, 60) || 'Internal review';
  if (!(DETECTED_BY as readonly string[]).includes(detectedBy)) fail(400, 'VALIDATION_FAILED', { message: 'Choose how it was detected.' });
  const reason = str(body?.reason);
  if (reason.length < 5) fail(400, 'VALIDATION_FAILED', { message: 'Enter a reason with at least 5 characters.' });
  const linked = Array.isArray(body?.linkedTransactions) ? body.linkedTransactions : [];
  if (linked.length > 20 || linked.some((x: unknown) => typeof x !== 'string' || !/^(TXN|PYO)[A-Z0-9]{6,30}$/.test(x))) fail(400, 'VALIDATION_FAILED', { message: 'Link up to 20 transactions by their IDs.' });
  return { type, scope, country: scope === 'merchant' ? null : country, subMerchantId, controls, caseRef, detectedBy, reason, linkedTransactions: [...new Set(linked as string[])] };
}

export function suspend(ctx: SuspensionContext, gmid: string, input: SuspendInput, opts: { legacy?: boolean } = {}): SuspensionView {
  const { db, caller, role, now } = ctx;
  const merchant = merchantOf(db, gmid);
  db.seq.suspension = (db.seq.suspension ?? 0) + 1;
  const fraud = isFraudType(input.type);
  const s: Suspension = {
    id: `SUS-${String(db.seq.suspension).padStart(4, '0')}`,
    gmid,
    ...input,
    status: 'active',
    createdBy: caller.name,
    createdById: caller.userId,
    createdRole: role,
    createdAt: now,
    review: { required: fraud, status: fraud ? 'pending' : 'not_required', dueAt: fraud ? now + REVIEW_WINDOW_MS : null, by: null, byId: null, at: null, note: null },
    reactivation: null,
    settlement: { status: input.controls.settlement ? 'held' : 'not_held', requestedBy: null, requestedAt: null, decidedBy: null, decidedAt: null, note: null },
    liftedAt: null,
    liftedBy: null,
    ...(opts.legacy ? { legacy: true } : {}),
  };
  (db.suspensions ??= []).push(s);
  syncLifecycle(ctx, s, 'suspended');
  const chips = CONTROL_KEYS.filter((k) => s.controls[k]).map((k) => CONTROL_CHIP[k]);
  const scopeText = scopeLabel(db, s);
  ctx.notify(
    'merchant_suspended',
    merchant,
    ['risk', 'sales', 'cs', 'finops'],
    `${s.scope === 'sub_merchant' ? 'Sub-merchant' : 'Merchant'} suspended: ${s.scope === 'sub_merchant' ? subName(db, s.subMerchantId) : merchant.legalName}`,
    `${SUSPENSION_TYPE_LABEL[s.type]} · ${scopeText}${s.caseRef ? ` · Case ${s.caseRef}` : ''}. ${chips.length ? `${chips.join(', ')}.` : 'New onboarding is on hold.'}${fraud ? ' A second Risk review is due within 24 hours.' : ''}`,
    ['support@mobi.xyz'],
  );
  // The merchant gets the same neutral message whatever the reason (never "fraud" or "suspended").
  if (chips.length) ctx.notify('merchant_suspended', merchant, [], MERCHANT_REVIEW_TITLE, MERCHANT_REVIEW_MESSAGE, merchant.primaryContact?.email ? [merchant.primaryContact.email] : []);
  return toSuspensionView(db, s);
}

function scopeLabel(db: MerchantDb, s: Suspension) {
  if (s.scope === 'merchant') return SUSPENSION_SCOPE_LABEL.merchant;
  if (s.scope === 'country') return `${countryName(s.country)} (with its sub-merchants)`;
  return `Sub-merchant ${subName(db, s.subMerchantId)} (${countryName(s.country)})`;
}

/** Keeps the merchant's and sub-merchant's lifecycle fields (which onboarding checks read) in step. */
function syncLifecycle(ctx: SuspensionContext, s: Suspension, action: 'suspended' | 'reactivated') {
  const { db, caller, role, now } = ctx;
  const merchant = merchantOf(db, s.gmid);
  const stillActive = (scope: SuspensionScope, sub: string | null) => (db.suspensions ?? []).some((x) => x.id !== s.id && x.gmid === s.gmid && x.status === 'active' && x.scope === scope && (scope !== 'sub_merchant' || x.subMerchantId === sub));
  const reason = action === 'suspended' ? s.reason : (s.reactivation?.reason ?? 'Reactivated');
  if (s.scope === 'merchant') {
    const from: MerchantLifecycleStatus = merchant.lifecycleStatus ?? 'active';
    if (action === 'suspended') {
      merchant.lifecycleStatus = 'suspended';
      merchant.lifecycleReason = s.reason;
    } else if (!stillActive('merchant', null)) {
      merchant.lifecycleStatus = 'active';
      merchant.lifecycleReason = null;
    }
    merchant.lifecycleUpdatedAt = now;
    merchant.lifecycleUpdatedBy = caller.name;
    (db.lifecycleEvents ??= []).unshift({ at: now, action, by: caller.name, role, reason, fromStatus: from, toStatus: merchant.lifecycleStatus ?? 'active', merchantId: merchant.id, detail: detailOf(db, s, action) });
  } else {
    if (s.scope === 'sub_merchant') {
      const sub = (db.entities ?? []).find((e) => e.id === s.subMerchantId);
      if (sub) {
        if (action === 'suspended') {
          sub.lifecycleStatus = 'suspended';
          sub.lifecycleReason = s.reason;
        } else if (!stillActive('sub_merchant', sub.id)) {
          sub.lifecycleStatus = 'active';
          sub.lifecycleReason = null;
        }
        (sub.history ??= []).push({ at: now, action: action === 'suspended' ? 'Sub-merchant suspended' : 'Sub-merchant reactivated', by: caller.name, role, comment: reason });
      }
    }
    const status = merchant.lifecycleStatus ?? 'active';
    (db.lifecycleEvents ??= []).unshift({ at: now, action, by: caller.name, role, reason, fromStatus: status, toStatus: status, merchantId: merchant.id, detail: detailOf(db, s, action) });
  }
  db.lifecycleEvents = (db.lifecycleEvents ?? []).slice(0, 500);
}

function detailOf(db: MerchantDb, s: Suspension, action: 'suspended' | 'reactivated') {
  const what = s.scope === 'merchant' ? 'Merchant' : s.scope === 'country' ? `${countryName(s.country)} MID` : `Sub-merchant ${subName(db, s.subMerchantId)}`;
  const chips = CONTROL_KEYS.filter((k) => s.controls[k]).map((k) => CONTROL_CHIP[k]);
  return action === 'suspended'
    ? `${what} suspended · ${SUSPENSION_TYPE_LABEL[s.type]}${s.caseRef ? ` · Case ${s.caseRef}` : ''}${chips.length ? ` · ${chips.join(', ')}` : ''}`
    : `${what} reactivated${s.reactivation?.outcome ? ` · ${s.reactivation.outcome}` : ''}`;
}

// ------------------------------------------------------------------ review (fraud)

export function checkReview(ctx: SuspensionContext, id: string, body: any) {
  const s = findSuspension(ctx.db, id);
  if (ctx.role !== 'risk') fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only Risk can review a suspension.' });
  if (s.status !== 'active' || s.review.status !== 'pending') fail(409, 'INVALID_TRANSITION', { message: 'This suspension is not waiting for a review.' });
  if (s.createdById === ctx.caller.userId) fail(403, 'ROLE_NOT_PERMITTED', { message: 'You raised this suspension, so another Risk reviewer must review it.' });
  const decision = body?.decision;
  if (decision !== 'confirm' && decision !== 'lift') fail(400, 'VALIDATION_FAILED', { message: 'Choose Confirm suspension or Lift suspension.' });
  const note = str(body?.note);
  if (note.length < 5) fail(400, 'VALIDATION_FAILED', { message: 'Enter a review note with at least 5 characters.' });
  return { s, decision: decision as 'confirm' | 'lift', note };
}

export function review(ctx: SuspensionContext, id: string, body: any): SuspensionView {
  const { s, decision, note } = checkReview(ctx, id, body);
  const { caller, now, db } = ctx;
  s.review = { ...s.review, status: decision === 'confirm' ? 'confirmed' : 'lifted', by: caller.name, byId: caller.userId, at: now, note };
  const merchant = merchantOf(db, s.gmid);
  if (decision === 'lift') {
    s.reactivation = { status: 'approved', requestedBy: caller.name, requestedById: caller.userId, requestedAt: now, outcome: 'Lifted at second review', reason: note, releaseSettlement: true, decidedBy: caller.name, decidedAt: now, note };
    lift(ctx, s);
  } else {
    ctx.notify('suspension_reviewed', merchant, ['risk'], `Suspension confirmed: ${merchant.legalName}`, `${caller.name} confirmed the ${SUSPENSION_TYPE_LABEL[s.type].toLowerCase()} suspension${s.caseRef ? ` (case ${s.caseRef})` : ''}.`);
  }
  return toSuspensionView(db, s);
}

// ------------------------------------------------------------------ reactivation

export function checkReactivation(ctx: SuspensionContext, id: string, body: any) {
  const s = findSuspension(ctx.db, id);
  if (ctx.role !== 'risk') fail(403, 'ROLE_NOT_PERMITTED', { message: s.scope === 'sub_merchant' ? 'Only Risk can reactivate a suspended sub-merchant.' : 'Only Risk can reactivate a suspended merchant.' });
  if (s.status !== 'active') fail(409, 'INVALID_TRANSITION', { message: s.scope === 'sub_merchant' ? 'Only a suspended sub-merchant can be reactivated.' : 'Only a suspended merchant can be reactivated.' });
  if (s.reactivation?.status === 'pending') fail(409, 'INVALID_TRANSITION', { message: 'A reactivation is already waiting for approval.' });
  const outcome = str(body?.outcome, 60) || (isFraudType(s.type) ? '' : 'Resolved with the merchant');
  if (!(REACTIVATION_OUTCOMES as readonly string[]).includes(outcome)) fail(400, 'VALIDATION_FAILED', { message: 'Choose an outcome.' });
  const reason = str(body?.reason);
  if (reason.length < 5) fail(400, 'VALIDATION_FAILED', { message: 'Enter a reason with at least 5 characters.' });
  return { s, outcome, reason, releaseSettlement: body?.releaseSettlement !== false };
}

export function requestReactivation(ctx: SuspensionContext, id: string, body: any): SuspensionView {
  const { s, outcome, reason, releaseSettlement } = checkReactivation(ctx, id, body);
  const { caller, now, db } = ctx;
  s.reactivation = { status: 'pending', requestedBy: caller.name, requestedById: caller.userId, requestedAt: now, outcome, reason, releaseSettlement, decidedBy: null, decidedAt: null, note: null };
  if (isFraudType(s.type)) {
    const merchant = merchantOf(db, s.gmid);
    ctx.notify('reactivation_requested', merchant, ['risk'], `Reactivation waiting for Risk: ${merchant.legalName}`, `${caller.name} asked to reactivate (${outcome}). Another Risk reviewer must approve it.`);
  } else {
    // Non-fraud: reactivates at once.
    s.reactivation = { ...s.reactivation, status: 'approved', decidedBy: caller.name, decidedAt: now };
    lift(ctx, s);
  }
  return toSuspensionView(db, s);
}

export function checkReactivationDecision(ctx: SuspensionContext, id: string, body: any) {
  const s = findSuspension(ctx.db, id);
  if (ctx.role !== 'risk') fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only Risk can approve a reactivation.' });
  if (s.reactivation?.status !== 'pending') fail(409, 'INVALID_TRANSITION', { message: 'No reactivation is waiting for approval.' });
  if (s.reactivation!.requestedById === ctx.caller.userId) fail(403, 'ROLE_NOT_PERMITTED', { message: 'You asked for this reactivation, so another Risk reviewer must approve it.' });
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'reject') fail(400, 'VALIDATION_FAILED', { message: 'Choose Approve or Reject.' });
  const note = str(body?.note);
  if (decision === 'reject' && note.length < 5) fail(400, 'VALIDATION_FAILED', { message: 'Enter a reason with at least 5 characters.' });
  return { s, decision: decision as 'approve' | 'reject', note };
}

export function decideReactivation(ctx: SuspensionContext, id: string, body: any): SuspensionView {
  const { s, decision, note } = checkReactivationDecision(ctx, id, body);
  const { caller, now, db } = ctx;
  s.reactivation = { ...s.reactivation!, status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: caller.name, decidedAt: now, note: note || null };
  if (decision === 'approve') lift(ctx, s);
  else {
    const merchant = merchantOf(db, s.gmid);
    ctx.notify('reactivation_requested', merchant, ['risk'], `Reactivation rejected: ${merchant.legalName}`, `${caller.name} rejected the reactivation: ${note}`);
  }
  return toSuspensionView(db, s);
}

/** Lifts the suspension: payments resume; held settlement goes to FinOps if Risk asked to release it. */
function lift(ctx: SuspensionContext, s: Suspension) {
  const { caller, now, db } = ctx;
  s.status = 'lifted';
  s.liftedAt = now;
  s.liftedBy = caller.name;
  if (s.review.status === 'pending') s.review = { ...s.review, status: 'not_required' };
  syncLifecycle(ctx, s, 'reactivated');
  const merchant = merchantOf(db, s.gmid);
  const who = s.scope === 'sub_merchant' ? `Sub-merchant ${subName(db, s.subMerchantId)}` : s.scope === 'country' ? `${merchant.legalName} in ${countryName(s.country)}` : merchant.legalName;
  ctx.notify('merchant_reactivated', merchant, ['risk', 'sales', 'cs', 'finops'], `Reactivated: ${who}`, `${s.reactivation?.outcome ?? 'Reactivated'}. Payments resume.${s.settlement.status === 'held' ? ' Settlement stays on hold until FinOps releases it.' : ''}`, ['support@mobi.xyz']);
  if (s.settlement.status === 'held' && s.reactivation?.releaseSettlement) requestRelease(ctx, s);
}

// ------------------------------------------------------------------ settlement release (FinOps)

function requestRelease(ctx: SuspensionContext, s: Suspension) {
  const { caller, now, db } = ctx;
  s.settlement = { ...s.settlement, status: 'release_pending', requestedBy: caller.name, requestedAt: now };
  const merchant = merchantOf(db, s.gmid);
  ctx.notify('settlement_release_requested', merchant, ['finops'], `Settlement release waiting for FinOps: ${merchant.legalName}`, `Held settlement${s.caseRef ? ` (case ${s.caseRef})` : ''} can be released. Release or keep it on hold in Approvals.`);
}

/** Risk asks FinOps to release settlement that stayed on hold after reactivation. */
export function requestSettlementRelease(ctx: SuspensionContext, id: string): SuspensionView {
  const s = findSuspension(ctx.db, id);
  if (ctx.role !== 'risk') fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only Risk can ask for a settlement release.' });
  if (s.status !== 'lifted' || s.settlement.status !== 'held') fail(409, 'INVALID_TRANSITION', { message: 'Settlement can be released once the suspension is lifted.' });
  requestRelease(ctx, s);
  return toSuspensionView(ctx.db, s);
}

export function checkSettlementDecision(ctx: SuspensionContext, id: string, body: any) {
  const s = findSuspension(ctx.db, id);
  if (ctx.role !== 'finops') fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only FinOps can release held settlement.' });
  if (s.settlement.status !== 'release_pending') fail(409, 'INVALID_TRANSITION', { message: 'No settlement release is waiting.' });
  const decision = body?.decision;
  if (decision !== 'release' && decision !== 'keep') fail(400, 'VALIDATION_FAILED', { message: 'Choose Release settlement or Keep on hold.' });
  const note = str(body?.note);
  if (decision === 'keep' && note.length < 5) fail(400, 'VALIDATION_FAILED', { message: 'Enter a reason with at least 5 characters.' });
  return { s, decision: decision as 'release' | 'keep', note };
}

export function decideSettlement(ctx: SuspensionContext, id: string, body: any): SuspensionView {
  const { s, decision, note } = checkSettlementDecision(ctx, id, body);
  const { caller, now, db } = ctx;
  s.settlement = { ...s.settlement, status: decision === 'release' ? 'released' : 'held', decidedBy: caller.name, decidedAt: now, note: note || null };
  const merchant = merchantOf(db, s.gmid);
  ctx.notify('settlement_released', merchant, ['risk', 'finops'], decision === 'release' ? `Settlement released: ${merchant.legalName}` : `Settlement kept on hold: ${merchant.legalName}`, decision === 'release' ? `${caller.name} released the held settlement.` : `${caller.name} kept the settlement on hold: ${note}`);
  return toSuspensionView(db, s);
}

// ------------------------------------------------------------------ earlier simple Suspend / Reactivate

/** The earlier one-step Suspend (reason only): a commercial suspension of the whole merchant or one sub-merchant, no payment controls. */
export function legacySuspend(ctx: SuspensionContext, gmid: string, reason: string, subMerchantId: string | null = null) {
  const input = checkSuspend(ctx, gmid, { type: ctx.role === 'risk' ? 'compliance' : 'commercial', scope: subMerchantId ? 'sub_merchant' : 'merchant', subMerchantId, controls: NO_CONTROLS, caseRef: 'LEGACY', detectedBy: 'Internal review', reason });
  return suspend(ctx, gmid, { ...input, type: 'commercial', caseRef: '' }, { legacy: true });
}

/** The earlier one-step Reactivate: lifts the active suspension(s) of that scope at once (Risk). */
export function legacyReactivate(ctx: SuspensionContext, gmid: string, reason: string, subMerchantId: string | null = null) {
  const active = (ctx.db.suspensions ?? []).filter((s) => s.gmid === gmid && s.status === 'active' && (subMerchantId ? s.scope === 'sub_merchant' && s.subMerchantId === subMerchantId : s.scope === 'merchant'));
  for (const s of active) {
    s.reactivation = { status: 'approved', requestedBy: ctx.caller.name, requestedById: ctx.caller.userId, requestedAt: ctx.now, outcome: 'Resolved with the merchant', reason, releaseSettlement: true, decidedBy: ctx.caller.name, decidedAt: ctx.now, note: null };
    lift(ctx, s);
  }
  return active.length;
}

// ------------------------------------------------------------------ approvals

export function suspensionApprovals(db: MerchantDb): ApprovalItem[] {
  const out: ApprovalItem[] = [];
  for (const s of db.suspensions ?? []) {
    const name = db.merchants.find((m) => m.id === s.gmid)?.legalName ?? s.gmid;
    const scope = s.scope === 'sub_merchant' ? `Sub-merchant ${subName(db, s.subMerchantId)}` : s.scope === 'country' ? countryName(s.country) : 'Whole merchant';
    const base = { merchantId: s.gmid, merchantName: name, applicationId: null, country: s.country, link: ['/merchants', s.gmid] };
    if (s.review.required) {
      out.push({
        ...base, kind: 'suspension_review', id: `${s.id}-review`, title: 'Suspension review', summary: `${SUSPENSION_TYPE_LABEL[s.type]} · ${scope}${s.caseRef ? ` · Case ${s.caseRef}` : ''}${s.review.dueAt ? ` · due ${fmt(s.review.dueAt)}` : ''}`,
        requestedBy: s.createdBy, requestedRole: s.createdRole, requestedAt: s.createdAt, status: s.review.status === 'pending' ? 'pending' : s.review.status === 'not_required' ? 'withdrawn' : 'approved', approverTeam: 'risk', decidedAt: s.review.at ?? s.liftedAt, query: { suspension: s.id, action: 'review' },
      });
    }
    if (s.reactivation && isFraudType(s.type)) {
      const r = s.reactivation;
      out.push({
        ...base, kind: 'reactivation', id: `${s.id}-reactivation`, title: 'Reactivation', summary: `${r.outcome} · ${scope}${s.caseRef ? ` · Case ${s.caseRef}` : ''}`,
        requestedBy: r.requestedBy, requestedRole: 'risk', requestedAt: r.requestedAt, status: r.status === 'pending' ? 'pending' : r.status === 'approved' ? 'approved' : 'rejected', approverTeam: 'risk', decidedAt: r.decidedAt, query: { suspension: s.id, action: 'reactivation' },
      });
    }
    if (s.settlement.requestedAt) {
      out.push({
        ...base, kind: 'settlement_release', id: `${s.id}-settlement`, title: 'Settlement release', summary: `After reactivation · ${scope}${s.caseRef ? ` · Case ${s.caseRef}` : ''}`,
        requestedBy: s.settlement.requestedBy ?? s.liftedBy ?? '', requestedRole: 'risk', requestedAt: s.settlement.requestedAt, status: s.settlement.status === 'release_pending' ? 'pending' : s.settlement.status === 'released' ? 'approved' : 'rejected', approverTeam: 'finops', decidedAt: s.settlement.decidedAt, query: { suspension: s.id, action: 'settlement' },
      });
    }
  }
  return out;
}

function fmt(t: number) {
  return new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
