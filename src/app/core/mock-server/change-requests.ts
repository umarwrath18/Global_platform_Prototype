import { validateApplication, validateRegistrationNumber } from '../merchants/application-rules';
import {
  ApprovalItem,
  ApprovalsView,
  CHANGE_SECTION_LABEL,
  ChangeRequest,
  ChangeRequestRecord,
  ChangeSection,
  describeChange,
  IdentityValue,
  ProfileEvent,
  SectionValue,
} from '../merchants/change-requests';
import { mccLabel } from '../merchants/mcc';
import { ApplicationData, CountryApplication, FieldIssue, READINESS_STATUSES, StaffRole } from '../merchants/merchant-models';
import { countryName, ONBOARDING_COUNTRIES, REGISTRATION_COUNTRIES } from '../merchants/onboarding-config';
import type { Caller, MerchantDb, MerchantRecord } from './merchant-server';
import { fail } from './server-errors';

// Change requests after Risk approval (simulated backend). Sales / Operations request, Risk decides,
// and an approved change is applied in the same save. Rejected or withdrawn requests change nothing.
// The application's submitted profile and rules snapshot always stay as Risk reviewed them.

export interface ChangeContext {
  db: MerchantDb;
  caller: Caller;
  role: StaffRole;
  now: number;
  /** The server's own parser for application data (same rules as onboarding). */
  readData: (country: string, raw: unknown) => ApplicationData;
  /** Adds an entry to a country application's history. */
  recordApp: (app: CountryApplication, text: string, comment?: string) => void;
  notify: (event: 'change_requested' | 'change_decided', merchant: MerchantRecord, app: CountryApplication | null, audience: StaffRole[], title: string, body: string) => void;
}

const COUNTRY_SECTIONS: ChangeSection[] = ['business', 'bank', 'directors', 'documents'];
const normReg = (s: string) => s.replace(/[^a-z0-9]/gi, '').toUpperCase();
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Risk has approved at least one of the merchant's applications. */
export function merchantRiskApproved(db: MerchantDb, merchantId: string): boolean {
  return db.applications.some((a) => a.merchantId === merchantId && a.history.some((h) => h.toStatus === 'risk_approved'));
}

export function toChangeView(r: ChangeRequestRecord): ChangeRequest {
  const { proposed: _p, requestedById: _u, ...view } = r;
  return view;
}

function requireRole(ctx: ChangeContext, needed: StaffRole, message: string) {
  if (ctx.role !== needed) fail(403, 'ROLE_NOT_PERMITTED', { message });
}

function findMerchant(db: MerchantDb, id: string) {
  return db.merchants.find((m) => m.id === id) ?? fail(404, 'NOT_FOUND', { message: `No Global Merchant ${id}.` });
}

function readReason(body: any) {
  const reason = str(body?.reason, 500).trim();
  if (reason.length < 10) fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'business', field: 'reason', message: 'Explain why this should change (at least 10 characters).' }] });
  return reason;
}

function requireNoPending(db: MerchantDb, match: (r: ChangeRequestRecord) => boolean, what: string) {
  const pending = (db.changeRequests ?? []).find((r) => r.status === 'pending' && match(r));
  if (pending) fail(409, 'CHANGE_PENDING', { message: `${what} already has a change waiting for Risk (${pending.id}). Wait for that decision or withdraw it first.` });
}

function nextId(db: MerchantDb) {
  db.seq.changeRequest ??= 1;
  return `CR-${String(db.seq.changeRequest++).padStart(4, '0')}`;
}

// ------------------------------------------------------------------ identity

/** Validates a legal-identity value with the onboarding rules, plus the duplicate check. */
export function readIdentity(db: MerchantDb, merchantId: string, raw: any): IdentityValue {
  const errors: FieldIssue[] = [];
  const issue = (field: string, message: string) => errors.push({ section: 'business', field: `identity.${field}`, message });
  const legalName = str(raw?.legalName, 200).trim();
  const registrationCountry = str(raw?.registrationCountry, 2).toUpperCase();
  const registrationNumber = str(raw?.registrationNumber, 40).trim();
  if (!legalName) issue('legalName', 'Enter the registered legal name.');
  else if (legalName.length > 160) issue('legalName', 'Use 160 characters or fewer.');
  if (!REGISTRATION_COUNTRIES.some((c) => c.code === registrationCountry)) issue('registrationCountry', 'Select the country of registration.');
  else {
    const regError = validateRegistrationNumber(registrationCountry, registrationNumber);
    if (regError) issue('registrationNumber', regError);
  }
  if (errors.length) fail(422, 'VALIDATION_FAILED', { errors });
  const clash = registrationNumber && db.merchants.find((x) => x.id !== merchantId && x.registrationCountry === registrationCountry && normReg(x.registrationNumber) === normReg(registrationNumber));
  if (clash) fail(409, 'DUPLICATE_MERCHANT', { existingMerchantId: clash.id, message: `${clash.legalName} (${clash.id}) already uses this registration number.` });
  return { legalName, registrationCountry, registrationNumber };
}

const identityOf = (m: MerchantRecord): IdentityValue => ({ legalName: m.legalName, registrationCountry: m.registrationCountry, registrationNumber: m.registrationNumber });

export function profileEvent(db: MerchantDb, e: ProfileEvent) {
  db.profileEvents ??= [];
  db.profileEvents.unshift(e);
  db.profileEvents = db.profileEvents.slice(0, 1000);
}

/** Requests a change to an approved merchant's legal identity (Sales / Operations). */
export function requestProfileChange(ctx: ChangeContext, merchantId: string, body: any): ChangeRequest {
  requireRole(ctx, 'sales', 'Only Sales / Operations can request profile changes.');
  const m = findMerchant(ctx.db, merchantId);
  if (!merchantRiskApproved(ctx.db, m.id)) fail(409, 'INVALID_TRANSITION', { message: `${m.legalName} hasn't been approved by Risk yet, so its profile can be edited directly.` });
  if (body?.section !== 'identity') fail(422, 'VALIDATION_FAILED', { message: 'Profile change requests cover the legal identity. Contact details can be edited directly.' });
  const proposed = readIdentity(ctx.db, m.id, body?.value);
  const changes = describeChange('identity', identityOf(m), proposed);
  if (!changes.length) fail(422, 'VALIDATION_FAILED', { message: 'There are no changes to request.' });
  requireNoPending(ctx.db, (r) => r.scope === 'merchant_profile' && r.merchantId === m.id, 'The legal identity');
  const reason = readReason(body);
  const r = create(ctx, { scope: 'merchant_profile', section: 'identity', merchantId: m.id, applicationId: null, country: null, changes, proposed, reason });
  profileEvent(ctx.db, { at: ctx.now, merchantId: m.id, action: 'change_requested', changes, reason, by: ctx.caller.name, role: ctx.role, requestId: r.id, comment: null });
  ctx.notify('change_requested', m, null, ['risk'], `Change to review: ${m.legalName} · Legal identity`, `${ctx.caller.name} asked to change the legal identity (${r.id}): ${summary(r)}. Reason: ${reason}`);
  return toChangeView(r);
}

// ------------------------------------------------------------------ country

/** Requests a change to an approved country's business, bank, director or document details. */
export function requestCountryChange(ctx: ChangeContext, applicationId: string, body: any): ChangeRequest {
  requireRole(ctx, 'sales', 'Only Sales / Operations can request country changes.');
  const app = ctx.db.applications.find((a) => a.id === applicationId) ?? fail(404, 'NOT_FOUND', { message: `No application ${applicationId}.` });
  const m = findMerchant(ctx.db, app.merchantId);
  if (app.status === 'draft' || app.status === 'returned') fail(409, 'INVALID_TRANSITION', { message: 'This application is still editable; change it directly.' });
  if (!READINESS_STATUSES.includes(app.status)) fail(409, 'INVALID_TRANSITION', { message: 'Changes can be requested once Risk has approved this country.' });
  const section = body?.section as ChangeSection;
  if (!COUNTRY_SECTIONS.includes(section)) fail(422, 'VALIDATION_FAILED', { message: 'Choose business details, bank account, directors or documents.' });

  const proposed = readCountrySection(ctx, app, section, body?.value);
  const cfg = ONBOARDING_COUNTRIES[app.country];
  const changes = describeChange(section, app.data[section as keyof ApplicationData] as SectionValue, proposed, cfg);
  if (!changes.length) fail(422, 'VALIDATION_FAILED', { message: 'There are no changes to request.' });
  requireNoPending(ctx.db, (r) => r.applicationId === app.id && r.section === section, CHANGE_SECTION_LABEL[section]);
  const reason = readReason(body);
  const r = create(ctx, { scope: 'country_details', section, merchantId: m.id, applicationId: app.id, country: app.country, changes, proposed, reason });
  ctx.recordApp(app, `Change requested – ${CHANGE_SECTION_LABEL[section]} (${r.id})`, reason);
  ctx.notify('change_requested', m, app, ['risk'], `Change to review: ${m.legalName} · ${cfg.name} · ${CHANGE_SECTION_LABEL[section]}`, `${ctx.caller.name} asked to change ${CHANGE_SECTION_LABEL[section].toLowerCase()} for ${app.id} (${r.id}): ${summary(r)}. Reason: ${reason}`);
  return toChangeView(r);
}

/**
 * Parses one section with the onboarding parser and validates it against the country's current
 * rules. A blank bank account number keeps the current one (it is never shown in full).
 */
function readCountrySection(ctx: ChangeContext, app: CountryApplication, section: ChangeSection, raw: any): SectionValue {
  const merchant = findMerchant(ctx.db, app.merchantId);
  let value = raw;
  if (section === 'bank') value = { ...(raw ?? {}), accountNumber: str(raw?.accountNumber, 120).trim() || app.data.bank['accountNumber'] || '' };
  const data = ctx.readData(app.country, { ...app.data, [section]: value });
  const issues = validateApplication(app.country, data, merchant).filter((i) => i.section === section);
  if (issues.length) fail(422, 'VALIDATION_FAILED', { errors: issues, message: `${issues.length} item${issues.length === 1 ? '' : 's'} must be fixed.` });
  return structuredClone(data[section as keyof ApplicationData]) as SectionValue;
}

// ------------------------------------------------------------------ decisions

/** Risk approves (applied now) or rejects (nothing changes) a pending change request. */
export function decideChange(ctx: ChangeContext, id: string, body: any): ChangeRequest {
  requireRole(ctx, 'risk', 'Only Risk can approve or reject change requests.');
  const r = (ctx.db.changeRequests ?? []).find((x) => x.id === id) ?? fail(404, 'NOT_FOUND', { message: `No change request ${id}.` });
  if (r.status !== 'pending') fail(409, 'INVALID_TRANSITION', { message: `Change request ${r.id} has already been ${r.status}.` });
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'reject') fail(400, 'VALIDATION_FAILED', { message: 'Choose approve or reject.' });
  const comment = str(body?.comment, 1000).trim();
  if (decision === 'reject' && comment.length < 10) fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'business', field: 'comment', message: 'Give the reason for rejecting (at least 10 characters).' }] });

  const m = findMerchant(ctx.db, r.merchantId);
  const app = r.applicationId ? (ctx.db.applications.find((a) => a.id === r.applicationId) ?? fail(404, 'NOT_FOUND', { message: `No application ${r.applicationId}.` })) : null;
  if (decision === 'approve') {
    // Re-check: other merchants or the country rules may have changed since the request.
    if (r.scope === 'merchant_profile') {
      const value = readIdentity(ctx.db, m.id, r.proposed);
      Object.assign(m, value, { updatedAt: ctx.now });
    } else {
      const value = readCountrySection(ctx, app!, r.section, r.proposed);
      (app!.data as any)[r.section] = value;
      app!.updatedAt = ctx.now;
    }
  }
  Object.assign(r, { status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: ctx.caller.name, decidedRole: ctx.role, decidedAt: ctx.now, decisionComment: comment || null });
  const verb = decision === 'approve' ? 'approved' : 'rejected';
  if (r.scope === 'merchant_profile') {
    profileEvent(ctx.db, { at: ctx.now, merchantId: m.id, action: decision === 'approve' ? 'change_approved' : 'change_rejected', changes: r.changes, reason: r.reason, by: ctx.caller.name, role: ctx.role, requestId: r.id, comment: comment || null });
  } else {
    ctx.recordApp(app!, decision === 'approve' ? `${CHANGE_SECTION_LABEL[r.section]} changed – ${r.id} approved by Risk` : `Change rejected by Risk – ${CHANGE_SECTION_LABEL[r.section]} (${r.id})`, comment || undefined);
  }
  ctx.notify('change_decided', m, app, ['sales'], `Change ${verb}: ${m.legalName} · ${CHANGE_SECTION_LABEL[r.section]}`, `Risk ${verb} ${r.id}${app ? ` for ${app.id}` : ''}.${comment ? ` ${comment}` : ''}`);
  return toChangeView(r);
}

/** The requester withdraws their own pending request. Nothing changes. */
export function withdrawChange(ctx: ChangeContext, id: string): ChangeRequest {
  requireRole(ctx, 'sales', 'Only Sales / Operations can withdraw change requests.');
  const r = (ctx.db.changeRequests ?? []).find((x) => x.id === id) ?? fail(404, 'NOT_FOUND', { message: `No change request ${id}.` });
  if (r.status !== 'pending') fail(409, 'INVALID_TRANSITION', { message: `Change request ${r.id} has already been ${r.status}.` });
  if (r.requestedById !== ctx.caller.userId) fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only the person who made the request can withdraw it.' });
  Object.assign(r, { status: 'withdrawn', decidedBy: ctx.caller.name, decidedRole: ctx.role, decidedAt: ctx.now });
  const m = findMerchant(ctx.db, r.merchantId);
  if (r.scope === 'merchant_profile') {
    profileEvent(ctx.db, { at: ctx.now, merchantId: m.id, action: 'change_withdrawn', changes: r.changes, reason: r.reason, by: ctx.caller.name, role: ctx.role, requestId: r.id, comment: null });
  } else {
    const app = ctx.db.applications.find((a) => a.id === r.applicationId);
    if (app) ctx.recordApp(app, `Change withdrawn – ${CHANGE_SECTION_LABEL[r.section]} (${r.id})`);
  }
  return toChangeView(r);
}

function create(ctx: ChangeContext, base: Pick<ChangeRequestRecord, 'scope' | 'section' | 'merchantId' | 'applicationId' | 'country' | 'changes' | 'proposed' | 'reason'>): ChangeRequestRecord {
  const r: ChangeRequestRecord = {
    id: nextId(ctx.db),
    ...base,
    requestedBy: ctx.caller.name,
    requestedById: ctx.caller.userId,
    requestedRole: ctx.role,
    requestedAt: ctx.now,
    status: 'pending',
    decidedBy: null,
    decidedRole: null,
    decidedAt: null,
    decisionComment: null,
  };
  ctx.db.changeRequests ??= [];
  ctx.db.changeRequests.push(r);
  return r;
}

const summary = (r: Pick<ChangeRequestRecord, 'changes'>) => r.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('; ');

// ------------------------------------------------------------------ approvals page

/** Everything waiting for a decision, and recent decisions, for the acting team. */
export function approvalsFor(db: MerchantDb, role: StaffRole): ApprovalsView {
  const name = (id: string) => db.merchants.find((m) => m.id === id)?.legalName ?? id;
  const items: ApprovalItem[] = [];
  for (const r of db.changeRequests ?? []) {
    items.push({
      kind: 'change', id: r.id, title: `${CHANGE_SECTION_LABEL[r.section]}${r.country ? ` · ${countryName(r.country)}` : ''}`, merchantId: r.merchantId, merchantName: name(r.merchantId),
      applicationId: r.applicationId, country: r.country, summary: summary(r), requestedBy: r.requestedBy, requestedRole: r.requestedRole, requestedAt: r.requestedAt,
      status: r.status, approverTeam: 'risk', decidedAt: r.decidedAt, link: r.applicationId ? ['/applications', r.applicationId] : ['/merchants', r.merchantId],
    });
  }
  for (const r of db.mccRequests ?? []) {
    items.push({
      kind: 'mcc', id: r.id, title: 'MCC change', merchantId: r.merchantId, merchantName: name(r.merchantId), applicationId: null, country: null,
      summary: `${mccLabel(r.previous)} → ${mccLabel(r.proposed)}`, requestedBy: r.requestedBy, requestedRole: r.requestedRole, requestedAt: r.requestedAt,
      status: r.status, approverTeam: 'risk', decidedAt: r.decidedAt, link: ['/merchants', r.merchantId],
    });
  }
  for (const v of db.pricingVersions ?? []) {
    if (v.source !== 'post_onboarding') continue;
    const app = db.applications.find((a) => a.id === v.applicationId);
    if (!app) continue;
    const method = ONBOARDING_COUNTRIES[app.country]?.paymentMethods.find((p) => p.code === v.methodCode)?.name ?? v.methodCode;
    items.push({
      kind: 'pricing', id: v.id, title: `Pricing change · ${countryName(app.country)}`, merchantId: app.merchantId, merchantName: name(app.merchantId), applicationId: app.id, country: app.country,
      summary: `${method}: ${Number(v.mdrPct.toFixed(2))}% MDR from ${new Date(v.effectiveFrom).toISOString().slice(0, 10)}`, requestedBy: v.createdBy, requestedRole: v.createdRole, requestedAt: v.createdAt,
      status: v.state === 'pending_approval' ? 'pending' : v.state === 'cancelled' ? 'withdrawn' : v.state, approverTeam: 'finops', decidedAt: v.decidedAt ?? v.cancelledAt, link: ['/applications', app.id, 'products'],
    });
  }
  for (const e of db.entities ?? []) {
    if (e.kind !== 'sub' || !e.submittedAt) continue;
    items.push({
      kind: 'sub_merchant', id: e.id, title: `New sub-merchant · ${countryName(e.country ?? '')}`, merchantId: e.gmid, merchantName: name(e.gmid), applicationId: null, country: e.country ?? null,
      summary: `${e.displayName}${e.legalEntity ? ` (separate legal entity: ${e.legalEntity.legalName}, ${e.legalEntity.registrationNumber})` : ' (trades under the parent)'}`,
      requestedBy: e.submittedBy ?? e.createdBy, requestedRole: 'sales', requestedAt: e.submittedAt, status: e.status === 'pending_risk_review' ? 'pending' : e.status === 'rejected' ? 'rejected' : 'approved',
      approverTeam: 'risk', decidedAt: e.decidedAt ?? null, link: ['/merchants', e.gmid],
    });
  }
  const pendingOf = (keep: (i: ApprovalItem) => boolean) => items.filter((i) => i.status === 'pending' && keep(i)).sort((a, b) => a.requestedAt - b.requestedAt);
  const recentOf = (keep: (i: ApprovalItem) => boolean) => items.filter((i) => i.status !== 'pending' && keep(i)).sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, 20);
  if (role === 'risk' || role === 'finops') {
    const mine = (i: ApprovalItem) => i.approverTeam === role;
    return { pending: pendingOf(mine), recent: recentOf(mine), heading: role === 'risk' ? 'Waiting for Risk' : 'Waiting for FinOps', canDecide: true };
  }
  if (role === 'sales') {
    const ours = (i: ApprovalItem) => i.requestedRole === 'sales';
    return { pending: pendingOf(ours), recent: recentOf(ours), heading: 'Requests from Sales / Operations', canDecide: false };
  }
  return { pending: pendingOf(() => true), recent: recentOf(() => true), heading: 'All pending approvals', canDecide: false };
}
