import { CountryApplication, READINESS_STATUSES, StaffRole } from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../merchants/onboarding-config';
import {
  activePricing,
  countryProducts,
  effectiveFromDate,
  pricingStatus,
  pricingViews,
  PricingVersion,
  ProductConfig,
  productGaps,
  ProductMethod,
  productPhase,
  ProductPhase,
  ProductPricingView,
  riskApproval,
  SETTLEMENT_CYCLES,
  SettlementCycle,
} from '../merchants/products';
import type { Caller, MerchantDb } from './merchant-server';
import { fail } from './server-errors';

// Product & Payment Config rules for the simulated backend. Every rule is enforced here, whatever
// the screens allow: who may change what at each stage, switch-off rules, pricing versions and
// FinOps approval. Product, settlement and pricing changes are recorded in the application history.

export interface ProductContext {
  db: MerchantDb;
  app: CountryApplication;
  caller: Caller;
  role: StaffRole;
  now: number;
  /** Adds an entry to the application history (by the caller, or by System). */
  record: (text: string, opts?: { comment?: string; system?: boolean }) => void;
  /** In-app notification about this application (no email). */
  notify: (event: 'pricing_approval_requested' | 'pricing_decided', audience: StaffRole[], title: string, body: string) => void;
}

interface ProductState {
  config: ProductConfig;
  versions: PricingVersion[];
  inferred: boolean;
  methods: ProductMethod[];
}

const EDITOR: Record<ProductPhase, StaffRole | null> = { proposal: null, onboarding: 'cs', post_handoff: 'sales' };
const pct = (n: number) => `${Number(n.toFixed(2))}%`;
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * Products, settlement and pricing for an application. Until products are first saved they are
 * worked out from the application: methods enabled in its pricing section are switched on, and the
 * Risk-approved MDR becomes a legacy pricing version only where the history records the approval
 * and the MDR is within the country's range. No settlement cycle is ever assumed.
 */
export function productState(db: MerchantDb, app: CountryApplication): ProductState {
  const methods = countryProducts(ONBOARDING_COUNTRIES[app.country]);
  const stored = (db.productConfigs ?? []).find((c) => c.applicationId === app.id);
  const versions = (db.pricingVersions ?? []).filter((v) => v.applicationId === app.id);
  if (stored) {
    // A payment method added to the country later appears switched off.
    const products = methods.map((m) => stored.products.find((p) => p.methodCode === m.code) ?? { methodCode: m.code, flow: m.flow, enabled: false });
    return { config: { ...stored, products }, versions, inferred: false, methods };
  }
  const config: ProductConfig = {
    applicationId: app.id,
    products: methods.map((m) => ({ methodCode: m.code, flow: m.flow, enabled: app.data.pricing.some((p) => p.code === m.code && p.enabled) })),
    settlement: {},
    revision: 0,
    savedAt: null,
    savedBy: null,
  };
  return { config, versions: READINESS_STATUSES.includes(app.status) ? legacyVersions(app, methods) : [], inferred: true, methods };
}

function legacyVersions(app: CountryApplication, methods: ProductMethod[]): PricingVersion[] {
  const approval = riskApproval(app);
  if (!approval) return [];
  return app.data.pricing
    .filter((line) => line.enabled && line.mdr !== null)
    .flatMap((line) => {
      const m = methods.find((x) => x.code === line.code);
      if (!m || line.mdr! < m.minMdr || line.mdr! > m.maxMdr) return [];
      return [
        {
          id: `LEGACY-${app.id}-${m.code}`,
          applicationId: app.id,
          methodCode: m.code,
          flow: m.flow,
          mdrPct: line.mdr!,
          effectiveFrom: approval.at,
          state: 'approved' as const,
          settlementCycleAtCreation: null,
          source: 'legacy_application' as const,
          createdBy: approval.by,
          createdRole: 'risk',
          createdAt: approval.at,
          decidedBy: approval.by,
          decidedRole: 'risk',
          decidedAt: approval.at,
          decisionComment: 'Risk-approved MDR from the country application',
          cancelledBy: null,
          cancelledAt: null,
          cancelReason: null,
        },
      ];
    });
}

/** Stores worked-out products and legacy pricing the first time anything is saved, exactly as shown. */
function materialise(ctx: ProductContext, state: ProductState): ProductState {
  if (!state.inferred) return state;
  const { db } = ctx;
  db.productConfigs ??= [];
  db.pricingVersions ??= [];
  const config = structuredClone(state.config);
  db.productConfigs.push(config);
  const versions = state.versions.map((v) => ({ ...v, id: nextPricingId(db) }));
  db.pricingVersions.push(...versions);
  return { ...state, config, versions, inferred: false };
}

function nextPricingId(db: MerchantDb) {
  db.seq.pricing ??= 1;
  return `PV-${String(db.seq.pricing++).padStart(6, '0')}`;
}

export function productView(db: MerchantDb, app: CountryApplication, role: StaffRole, now: number): ProductPricingView {
  const state = productState(db, app);
  const phase = productPhase(app.status);
  const editor = EDITOR[phase];
  const can = { editProducts: role === editor, editPricing: role === editor, decidePricing: phase === 'post_handoff' && role === 'finops' };
  return {
    applicationId: app.id,
    country: app.country,
    countryName: ONBOARDING_COUNTRIES[app.country].name,
    status: app.status,
    phase,
    inferred: state.inferred,
    methods: state.methods,
    config: state.config,
    versions: pricingViews(state.versions, now).sort((a, b) => b.effectiveFrom - a.effectiveFrom || b.createdAt - a.createdAt),
    gaps: productGaps(state.config, state.versions, state.methods, now),
    can,
    readOnlyReason: can.editProducts ? null : readOnlyReason(phase, role),
    now,
  };
}

function readOnlyReason(phase: ProductPhase, role: StaffRole): string {
  if (phase === 'proposal') return 'Customer Success sets up products and pricing once Risk has approved the application and setup has started.';
  if (phase === 'onboarding') return 'Customer Success sets up products, settlement and pricing during onboarding.';
  if (role === 'finops') return 'FinOps approves or rejects pricing changes. Sales / Operations manage products and settlement.';
  return 'After onboarding, Sales / Operations manage products and settlement; pricing changes need FinOps approval.';
}

function requireEditor(ctx: ProductContext): ProductPhase {
  const phase = productPhase(ctx.app.status);
  const editor = EDITOR[phase];
  if (!editor) fail(409, 'INVALID_TRANSITION', { message: 'Products and pricing can be set once Risk has approved the application and setup has started.' });
  if (ctx.role !== editor) fail(403, 'ROLE_NOT_PERMITTED', { message: readOnlyReason(phase, ctx.role) });
  return phase;
}

/** Saves product switches and settlement cycles together. Settlement never touches pricing versions. */
export function saveProducts(ctx: ProductContext, body: any): string {
  const phase = requireEditor(ctx);
  let state = productState(ctx.db, ctx.app);
  if (body?.revision !== state.config.revision) fail(409, 'CONFIG_CONFLICT', { message: 'These products were changed by someone else after you opened them. Reload to see the latest.' });
  const cname = ONBOARDING_COUNTRIES[ctx.app.country].name;
  const requested: { methodCode: string; enabled: boolean }[] = Array.isArray(body?.products) ? body.products : [];
  const unknown = requested.filter((p) => !state.methods.some((m) => m.code === p?.methodCode));
  if (unknown.length) fail(422, 'VALIDATION_FAILED', { message: `${unknown.map((p) => String(p?.methodCode)).join(', ')} is not a product offered in ${cname}. No payout methods are configured yet.` });

  const next = state.methods.map((m) => ({ methodCode: m.code, flow: m.flow, enabled: requested.find((p) => p.methodCode === m.code)?.enabled === true }));
  const nextSettlement: Record<string, SettlementCycle> = {};
  const errors: { section: 'pricing'; field: string; message: string }[] = [];
  for (const [code, cycle] of Object.entries(body?.settlement ?? {})) {
    if (!next.some((p) => p.methodCode === code && p.enabled && p.flow === 'payin')) continue; // only switched-on PayIn products settle
    if (!SETTLEMENT_CYCLES.includes(cycle as SettlementCycle)) errors.push({ section: 'pricing', field: `settlement.${code}`, message: 'Choose a settlement cycle from T+0 to T+5.' });
    else nextSettlement[code] = cycle as SettlementCycle;
  }
  if (errors.length) fail(422, 'VALIDATION_FAILED', { errors });

  const name = (code: string) => state.methods.find((m) => m.code === code)?.name ?? code;
  const switchedOff = state.config.products.filter((p) => p.enabled && !next.find((n) => n.methodCode === p.methodCode)!.enabled).map((p) => p.methodCode);
  const productsChanged = next.some((n) => n.enabled !== state.config.products.find((p) => p.methodCode === n.methodCode)?.enabled);
  const settlementChanges = [...new Set([...Object.keys(state.config.settlement), ...Object.keys(nextSettlement)])].filter((c) => state.config.settlement[c] !== nextSettlement[c]);
  if (!productsChanged && !settlementChanges.length) fail(422, 'VALIDATION_FAILED', { message: 'There are no changes to save.' });
  const settlementText = settlementChanges.map((c) => `${name(c)}: ${state.config.settlement[c] ?? 'not set'} → ${nextSettlement[c] ?? 'not set'}`);

  // Switching off: pricing that hasn't ended is cancelled, but after onboarding never active pricing.
  const live = (code: string) => state.versions.filter((v) => v.methodCode === code && (v.state === 'approved' || v.state === 'pending_approval') && pricingStatus(v, state.versions, ctx.now) !== 'superseded');
  if (phase === 'post_handoff') {
    const blocked = switchedOff.filter((c) => activePricing(state.versions, c, ctx.now));
    if (blocked.length) {
      fail(409, 'PRODUCT_HAS_ACTIVE_PRICING', { message: `${blocked.map(name).join(', ')} ${blocked.length === 1 ? 'has' : 'have'} active pricing, so ${blocked.length === 1 ? 'it' : 'they'} can't be switched off after onboarding.` });
    }
  } else {
    const priced = switchedOff.filter((c) => live(c).length);
    if (priced.length && body?.confirmCancelPricing !== true) {
      fail(409, 'PRICING_WILL_BE_CANCELLED', { message: `Switching off ${priced.map(name).join(', ')} cancels ${priced.length === 1 ? 'its' : 'their'} pricing. Confirm to continue.` });
    }
  }

  state = materialise(ctx, state);
  // Update the stored record itself (productState returns a copy with any new country methods added).
  const stored = ctx.db.productConfigs!.find((c) => c.applicationId === ctx.app.id)!;
  const at = ctx.now;
  for (const code of switchedOff) {
    for (const v of state.versions.filter((x) => x.methodCode === code && (x.state === 'approved' || x.state === 'pending_approval') && pricingStatus(x, state.versions, at) !== 'superseded')) {
      Object.assign(v, { state: 'cancelled', cancelledBy: ctx.caller.name, cancelledAt: at, cancelReason: 'Product switched off' });
      ctx.record(`Pricing cancelled – ${name(code)}: ${pct(v.mdrPct)} (product switched off)`);
    }
  }
  stored.products = next;
  stored.settlement = nextSettlement;
  stored.revision += 1;
  stored.savedAt = at;
  stored.savedBy = ctx.caller.name;

  const list = (flow: 'payin' | 'payout') => next.filter((p) => p.enabled && p.flow === flow).map((p) => name(p.methodCode)).join(', ') || 'none';
  if (productsChanged) ctx.record(`Updated products – PayIn: ${list('payin')}; PayOut: ${list('payout')}`);
  for (const text of settlementText) ctx.record(`Changed settlement cycle – ${text}`);
  syncDerivedChecklist(ctx);
  if (productsChanged && settlementChanges.length) return 'Changes saved';
  if (productsChanged) return 'Products saved';
  return `Settlement saved – ${settlementText.join('; ')}`;
}

/** Adds a pricing version. During onboarding it applies at once; after handoff it waits for FinOps. */
export function setPricing(ctx: ProductContext, body: any): PricingVersion {
  const phase = requireEditor(ctx);
  let state = productState(ctx.db, ctx.app);
  const code = typeof body?.methodCode === 'string' ? body.methodCode : '';
  const method = state.methods.find((m) => m.code === code) ?? fail(422, 'VALIDATION_FAILED', { message: `${code || 'That product'} is not offered in ${ONBOARDING_COUNTRIES[ctx.app.country].name}.` });
  if (!state.config.products.find((p) => p.methodCode === code)?.enabled) {
    fail(422, 'VALIDATION_FAILED', { message: `Switch on ${method.name} and save products before pricing it.` });
  }
  const mdr = typeof body?.mdrPct === 'number' && Number.isFinite(body.mdrPct) ? Math.round(body.mdrPct * 100) / 100 : NaN;
  if (Number.isNaN(mdr) || mdr < method.minMdr || mdr > method.maxMdr) {
    fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'pricing', field: 'mdrPct', message: `Enter an MDR between ${method.minMdr}% and ${method.maxMdr}%.` }] });
  }
  const effectiveFrom = effectiveFromDate(body?.effectiveDate, ctx.now) ?? fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'pricing', field: 'effectiveDate', message: 'Enter a valid date.' }] });
  if (phase === 'post_handoff') {
    const pending = state.versions.find((v) => v.methodCode === code && v.state === 'pending_approval');
    if (pending) fail(409, 'PRICING_PENDING', { message: `${method.name} already has a pricing change waiting for FinOps (${pending.id}). Wait for that decision or cancel it first.` });
  }

  state = materialise(ctx, state);
  const version: PricingVersion = {
    id: nextPricingId(ctx.db),
    applicationId: ctx.app.id,
    methodCode: code,
    flow: method.flow,
    mdrPct: mdr,
    effectiveFrom,
    state: phase === 'onboarding' ? 'approved' : 'pending_approval',
    settlementCycleAtCreation: state.config.settlement[code] ?? null,
    source: phase === 'onboarding' ? 'onboarding' : 'post_onboarding',
    createdBy: ctx.caller.name,
    createdRole: ctx.role,
    createdAt: ctx.now,
    decidedBy: null,
    decidedRole: null,
    decidedAt: null,
    decisionComment: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
  };
  ctx.db.pricingVersions!.push(version);
  const what = `${method.name}: ${pct(mdr)} from ${day(effectiveFrom)}`;
  if (phase === 'onboarding') {
    ctx.record(`Pricing set – ${what}`);
    syncDerivedChecklist(ctx);
  } else {
    ctx.record(`Pricing change submitted for FinOps approval – ${what}`);
    ctx.notify('pricing_approval_requested', ['finops'], `Pricing to approve: ${ctx.app.id} · ${method.name}`, `${ctx.caller.name} proposed ${what} (${version.id}).`);
  }
  return version;
}

/** Cancels pricing that is waiting for approval or scheduled for later. Active pricing can't be cancelled. */
export function cancelPricing(ctx: ProductContext, versionId: string, body: any): PricingVersion {
  requireEditor(ctx);
  // Includes legacy versions shown before the first save (always active, so never cancellable).
  const all = productState(ctx.db, ctx.app).versions;
  const v = all.find((x) => x.id === versionId) ?? fail(404, 'NOT_FOUND', { message: `No pricing version ${versionId}.` });
  const status = pricingStatus(v, all, ctx.now);
  if (status !== 'pending_approval' && status !== 'scheduled') fail(409, 'INVALID_TRANSITION', { message: 'Only pricing that is waiting for approval or scheduled can be cancelled.' });
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  Object.assign(v, { state: 'cancelled', cancelledBy: ctx.caller.name, cancelledAt: ctx.now, cancelReason: reason || 'Cancelled' });
  const name = productState(ctx.db, ctx.app).methods.find((m) => m.code === v.methodCode)?.name ?? v.methodCode;
  ctx.record(`Pricing cancelled – ${name}: ${pct(v.mdrPct)} from ${day(v.effectiveFrom)}`, { comment: reason || undefined });
  syncDerivedChecklist(ctx);
  return v;
}

/** FinOps decides a pricing change made after onboarding. Late approval takes effect at approval time. */
export function decidePricing(ctx: ProductContext, versionId: string, body: any): PricingVersion {
  if (productPhase(ctx.app.status) !== 'post_handoff') fail(409, 'INVALID_TRANSITION', { message: 'Pricing set during onboarding applies without approval.' });
  if (ctx.role !== 'finops') fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only FinOps can approve or reject pricing changes.' });
  const v = (ctx.db.pricingVersions ?? []).find((x) => x.id === versionId && x.applicationId === ctx.app.id) ?? fail(404, 'NOT_FOUND', { message: `No pricing version ${versionId}.` });
  if (v.state !== 'pending_approval') fail(409, 'INVALID_TRANSITION', { message: `Pricing ${v.id} is not waiting for approval.` });
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'reject') fail(400, 'VALIDATION_FAILED', { message: 'Choose approve or reject.' });
  const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, 1000) : '';
  if (decision === 'reject' && comment.length < 10) fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'pricing', field: 'comment', message: 'Give the reason for rejecting (at least 10 characters).' }] });

  const name = countryProducts(ONBOARDING_COUNTRIES[ctx.app.country]).find((m) => m.code === v.methodCode)?.name ?? v.methodCode;
  Object.assign(v, {
    state: decision === 'approve' ? 'approved' : 'rejected',
    effectiveFrom: decision === 'approve' ? Math.max(v.effectiveFrom, ctx.now) : v.effectiveFrom,
    decidedBy: ctx.caller.name,
    decidedRole: ctx.role,
    decidedAt: ctx.now,
    decisionComment: comment || null,
  });
  const what = `${name}: ${pct(v.mdrPct)} from ${day(v.effectiveFrom)}`;
  ctx.record(decision === 'approve' ? `Pricing approved by FinOps – ${what}` : `Pricing rejected by FinOps – ${what}`, { comment: comment || undefined });
  ctx.notify('pricing_decided', ['sales'], `Pricing ${decision === 'approve' ? 'approved' : 'rejected'}: ${ctx.app.id} · ${name}`, `${ctx.caller.name} ${decision === 'approve' ? 'approved' : 'rejected'} ${what}.${comment ? ` ${comment}` : ''}`);
  return v;
}

/** What still stops "Issue production keys". */
export function onboardingGaps(db: MerchantDb, app: CountryApplication, now: number) {
  const s = productState(db, app);
  return productGaps(s.config, s.versions, s.methods, now);
}

/** Checklist items that follow Product & Payment Config instead of being ticked by hand. */
export const DERIVED_CHECKLIST = ['payment_methods', 'pricing_loaded'];

/** Keeps the two derived configuration checklist items in step with products and pricing (onboarding only). */
export function syncDerivedChecklist(ctx: ProductContext) {
  if (productPhase(ctx.app.status) !== 'onboarding') return;
  const gaps = onboardingGaps(ctx.db, ctx.app, ctx.now);
  const anyOn = !gaps.some((g) => g.issue === 'no_products');
  const target: Record<string, boolean> = { payment_methods: anyOn, pricing_loaded: anyOn && !gaps.some((g) => g.issue === 'pricing') };
  for (const item of ctx.app.readiness.configuration) {
    if (!(item.key in target) || item.done === target[item.key]) continue;
    Object.assign(item, { done: target[item.key], doneAt: target[item.key] ? ctx.now : null, doneBy: target[item.key] ? 'System' : null });
    ctx.record(`${target[item.key] ? 'Completed' : 'Reopened'} automatically: ${item.label}`, { system: true });
  }
}
