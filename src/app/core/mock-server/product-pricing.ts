import { CountryApplication, StaffRole } from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../merchants/onboarding-config';
import {
  activateVersion,
  classifyPeriod,
  countryProducts,
  FLOW_LABEL,
  gapCount,
  isIsoDate,
  overlapMessage,
  periodText,
  APPROVAL_STATUS_ORDER,
  CONFIRMED_STATUSES,
  MdrHistoryRow,
  MerchantPricingList,
  MerchantPricingRow,
  PricingApprovalItem,
  PricingApprovalsView,
  ProductFlow,
  resolvePricing,
  sameScope,
  SubMerchantPricingRow,
  subOf,
  PricingAuditEvent,
  PricingDraft,
  pricingInEffect,
  PricingMode,
  pricingMode,
  pricingSummary,
  PricingTechnique,
  PricingVersion,
  ProductConfig,
  productGaps,
  ProductMethod,
  ProductPricingView,
  runStatusJob,
  SETTLEMENT_CYCLES,
  SettlementCycle,
  techniqueLabel,
  TECHNIQUES,
  todayIso,
  USD_RATES,
  usesVaBanks,
  VA_BANKS,
  validatePrimary,
  validateSecondary,
} from '../merchants/products';
import type { Caller, MerchantDb } from './merchant-server';
import { fail } from './server-errors';

// Product & Payment Config rules for the simulated backend (Pricing Engine document §8). Every
// rule is enforced here, whatever the screens allow: the mode (derived from the MID's state on every
// request), who may change what, switch-off rules, versioning, overlap and supersession, FinOps
// approval with maker ≠ checker, and the append-only MDR audit log.

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

/** Who changes products, settlement and pricing in each mode (§2.2; "Ops" is Sales / Operations). */
const MAKER: Record<PricingMode, StaffRole | null> = { onboarding: 'cs', change: 'sales', read_only: null };
const AUDIT_ROLE: Record<string, string> = { cs: 'CS', sales: 'Ops', finops: 'Finance', risk: 'Risk', system: 'System' };

const merchantOf = (db: MerchantDb, app: CountryApplication) => db.merchants.find((m) => m.id === app.merchantId)!;
const suspendedOf = (db: MerchantDb, app: CountryApplication) => merchantOf(db, app).lifecycleStatus === 'suspended';
const midOf = (db: MerchantDb, app: CountryApplication) => (db.mids ?? []).find((m) => m.applicationId === app.id)?.mid ?? null;

export const modeOf = (db: MerchantDb, app: CountryApplication) => pricingMode(app.status, suspendedOf(db, app));

/** Sub-merchants of the merchant in the application's corridor (not rejected). */
export function subMerchantsOf(db: MerchantDb, app: Pick<CountryApplication, 'merchantId' | 'country'>) {
  return (db.entities ?? []).filter((e) => e.kind === 'sub' && e.gmid === app.merchantId && e.country === app.country && e.status !== 'rejected').map((e) => ({ id: e.id, name: e.displayName ?? e.id }));
}

const subName = (db: MerchantDb, id: string | null | undefined) => (id ? ((db.entities ?? []).find((e) => e.id === id)?.displayName ?? id) : null);

/**
 * Products, settlement and pricing for an application. Before products are ever saved, any method
 * with pricing active, scheduled or pending is treated as switched on (§8.2).
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
  const live = (code: string) => versions.some((v) => v.methodCode === code && (v.status === 'active' || v.status === 'scheduled' || v.status === 'pending_approval'));
  const config: ProductConfig = {
    applicationId: app.id,
    products: methods.map((m) => ({ methodCode: m.code, flow: m.flow, enabled: live(m.code) })),
    settlement: {},
    revision: 0,
    savedAt: null,
    savedBy: null,
  };
  return { config, versions, inferred: true, methods };
}

/** Stores the worked-out products the first time anything is saved, exactly as shown. */
function materialise(ctx: ProductContext, state: ProductState): ProductConfig {
  const { db } = ctx;
  db.productConfigs ??= [];
  let stored = db.productConfigs.find((c) => c.applicationId === ctx.app.id);
  if (!stored) {
    stored = structuredClone(state.config);
    db.productConfigs.push(stored);
  }
  return stored;
}

function nextPricingId(db: MerchantDb) {
  db.seq.pricing ??= 1;
  return `PV-${String(db.seq.pricing++).padStart(6, '0')}`;
}

/** The daily status job, simulated: run whenever the data is loaded (§4.2). Returns true if anything changed. */
export function runPricingJob(db: MerchantDb, now: number): boolean {
  return runStatusJob(db.pricingVersions ?? [], todayIso(now)) > 0;
}

// ------------------------------------------------------------------ messages (§8.1–8.3, MP-2/3)

function notice(mode: PricingMode, role: StaffRole, suspended: boolean): string {
  if (suspended) return 'This MID is suspended. Pricing cannot change until it is reactivated.';
  if (mode === 'onboarding') return role === 'cs' ? 'Switch on the products this MID will offer, then set pricing for each one. During onboarding, pricing applies as soon as it is saved – no FinOps approval.' : 'CS sets pricing while reviewing this MID.';
  if (mode === 'change') return role === 'sales' ? 'Onboarding is confirmed. Pricing changes create a new version that needs FinOps approval; the current pricing stays in effect until then.' : 'Onboarding is confirmed. Ops changes pricing from Merchant List → Merchant Pricing, with FinOps approval.';
  return 'Pricing is set by CS once the MID is submitted for CS review.';
}

const SUSPENDED = 'This MID is suspended. Pricing cannot change until it is reactivated.';

function productsMessage(mode: PricingMode, role: StaffRole, suspended: boolean, what: 'Products' | 'Settlement'): string | null {
  if (suspended) return SUSPENDED;
  if (mode === 'read_only') return `${what} can be set once the MID is under CS review.`;
  if (role === MAKER[mode]) return null;
  const noun = what.toLowerCase();
  return mode === 'onboarding' ? `Only CS can set ${noun} during onboarding.` : `Only Ops can change ${noun} after onboarding.`;
}

function pricingMessage(mode: PricingMode, role: StaffRole, suspended: boolean): string | null {
  if (suspended) return SUSPENDED;
  if (mode === 'read_only') return 'Pricing can be set once the MID is under CS review, and changed after CS confirms it.';
  if (role === MAKER[mode]) return null;
  return mode === 'onboarding' ? 'Only CS can set pricing during onboarding.' : 'Only Ops can change pricing after onboarding.';
}

const ROLE_ERROR = (message: string) => fail(403, 'ROLE_NOT_PERMITTED', { message });

// ------------------------------------------------------------------ view

const sortVersions = (versions: PricingVersion[], methods: ProductMethod[]) => {
  const order = (c: string) => methods.findIndex((m) => m.code === c);
  return [...versions].sort((a, b) => (a.flow === b.flow ? 0 : a.flow === 'payin' ? -1 : 1) || order(a.methodCode) - order(b.methodCode) || b.version - a.version);
};

export function productView(db: MerchantDb, app: CountryApplication, role: StaffRole, now: number): ProductPricingView {
  const state = productState(db, app);
  const suspended = suspendedOf(db, app);
  const mode = pricingMode(app.status, suspended);
  const today = todayIso(now);
  const cfg = ONBOARDING_COUNTRIES[app.country];
  const gaps = productGaps(state.config, state.versions, state.methods, today);
  const pMsg = productsMessage(mode, role, suspended, 'Products');
  const prMsg = pricingMessage(mode, role, suspended);
  return {
    applicationId: app.id,
    merchantId: app.merchantId,
    merchantName: merchantOf(db, app).legalName,
    mid: midOf(db, app),
    country: app.country,
    countryName: cfg.name,
    currency: cfg.currency,
    status: app.status,
    mode,
    suspended,
    notice: notice(mode, role, suspended),
    inferred: state.inferred,
    methods: state.methods,
    config: state.config,
    versions: sortVersions(state.versions, state.methods),
    subMerchants: subMerchantsOf(db, app),
    gaps,
    gapCount: gapCount(gaps),
    can: { editProducts: !pMsg, editPricing: !prMsg, decidePricing: mode === 'change' && role === 'finops' },
    productsMessage: pMsg,
    pricingMessage: prMsg,
    usdRate: USD_RATES[cfg.currency] ?? 1,
    today,
    now,
  };
}

// ------------------------------------------------------------------ products and settlement (§8.2, §8.3)

/** Saves product switches and settlement cycles together. Settlement never touches pricing versions. */
export function saveProducts(ctx: ProductContext, body: any): string {
  const mode = modeOf(ctx.db, ctx.app);
  const suspended = suspendedOf(ctx.db, ctx.app);
  const state = productState(ctx.db, ctx.app);
  const cname = ONBOARDING_COUNTRIES[ctx.app.country].name;
  const requested: { methodCode: string; enabled: boolean }[] = Array.isArray(body?.products) ? body.products : [];
  const unknown = requested.filter((p) => !state.methods.some((m) => m.code === p?.methodCode));
  if (unknown.length) fail(422, 'VALIDATION_FAILED', { message: `${unknown.map((p) => String(p?.methodCode)).join(', ')} is not a product offered in ${cname}.` });
  const next = state.methods.map((m) => ({ methodCode: m.code, flow: m.flow, enabled: requested.find((p) => p.methodCode === m.code)?.enabled === true }));
  const productsChanged = next.some((n) => n.enabled !== state.config.products.find((p) => p.methodCode === n.methodCode)?.enabled);

  // Settlement: only saved PayIn products that stay on; cycles for products being switched off are dropped.
  const nextSettlement: Record<string, SettlementCycle> = {};
  const errors: { section: 'pricing'; field: string; message: string }[] = [];
  for (const [code, cycle] of Object.entries(body?.settlement ?? {})) {
    if (!cycle) continue;
    if (!next.some((p) => p.methodCode === code && p.enabled && p.flow === 'payin')) continue;
    if (!state.config.products.find((p) => p.methodCode === code)?.enabled) fail(422, 'VALIDATION_FAILED', { message: 'Switch on and save the product first.' });
    if (!SETTLEMENT_CYCLES.includes(cycle as SettlementCycle)) errors.push({ section: 'pricing', field: `settlement.${code}`, message: 'Choose a settlement cycle from T+0 to T+5.' });
    else nextSettlement[code] = cycle as SettlementCycle;
  }
  const settlementChanges = [...new Set([...Object.keys(state.config.settlement), ...Object.keys(nextSettlement)])].filter((c) => state.config.settlement[c] !== nextSettlement[c]);
  const explicitSettlement = settlementChanges.filter((c) => next.find((p) => p.methodCode === c)?.enabled);

  if (productsChanged) {
    const msg = productsMessage(mode, ctx.role, suspended, 'Products');
    if (msg) mode === 'read_only' ? fail(409, 'INVALID_TRANSITION', { message: msg }) : ROLE_ERROR(msg);
  }
  if (explicitSettlement.length) {
    const msg = productsMessage(mode, ctx.role, suspended, 'Settlement');
    if (msg) mode === 'read_only' ? fail(409, 'INVALID_TRANSITION', { message: msg }) : ROLE_ERROR(msg);
  }
  if (!productsChanged && !settlementChanges.length) fail(422, 'VALIDATION_FAILED', { message: 'There are no changes to save.' });
  if (body?.revision !== state.config.revision) fail(409, 'CONFIG_CONFLICT', { message: 'Pricing changed – reload' });
  if (errors.length) fail(422, 'VALIDATION_FAILED', { errors });
  if (!next.some((p) => p.enabled)) fail(422, 'VALIDATION_FAILED', { message: 'Switch on at least one product.' });

  const name = (code: string) => state.methods.find((m) => m.code === code)?.name ?? code;
  const switchedOff = state.config.products.filter((p) => p.enabled && !next.find((n) => n.methodCode === p.methodCode)!.enabled).map((p) => p.methodCode);
  const open = (code: string, statuses: string[]) => state.versions.filter((v) => v.methodCode === code && statuses.includes(v.status));
  if (mode === 'change') {
    const blocked = switchedOff.filter((c) => open(c, ['active']).length);
    if (blocked.length) fail(409, 'PRODUCT_HAS_ACTIVE_PRICING', { message: `${blocked.map(name).join(', ')} has active pricing and cannot be switched off after onboarding.` });
  }
  const cancelStatuses = mode === 'onboarding' ? ['active', 'scheduled', 'pending_approval'] : ['scheduled', 'pending_approval'];
  const priced = switchedOff.filter((c) => open(c, cancelStatuses).length);
  if (priced.length && body?.confirmCancelPricing !== true) {
    fail(409, 'PRICING_WILL_BE_CANCELLED', { message: `Switching off ${priced.map(name).join(', ')} will cancel its pricing. Continue?` });
  }

  const stored = materialise(ctx, state);
  for (const code of switchedOff) {
    for (const v of open(code, cancelStatuses)) {
      const stale = (ctx.db.pricingVersions ?? []).find((x) => x.id === v.id)!;
      cancelVersion(ctx, stale, 'Product switched off');
    }
  }
  const settlementText = settlementChanges.map((c) => `${name(c)}: ${state.config.settlement[c] ?? 'not set'} → ${nextSettlement[c] ?? 'not set'}`);
  stored.products = next;
  stored.settlement = nextSettlement;
  stored.revision += 1;
  stored.savedAt = ctx.now;
  stored.savedBy = ctx.caller.name;

  const list = (flow: 'payin' | 'payout') => next.filter((p) => p.enabled && p.flow === flow).map((p) => name(p.methodCode)).join(', ') || 'none';
  if (productsChanged) ctx.record(`Updated products – PayIn: ${list('payin')}; Payout: ${list('payout')}`);
  for (const text of settlementText) ctx.record(`Changed settlement cycle – ${text}`);
  syncDerivedChecklist(ctx);
  const on = next.filter((p) => p.enabled).length;
  if (productsChanged && explicitSettlement.length) return `Changes saved – ${on} product(s) switched on.`;
  if (productsChanged) return `Products saved – ${on} product(s) switched on.`;
  return `Settlement saved – ${settlementText.join('; ')}`;
}

// ------------------------------------------------------------------ pricing (§8.5, §8.6)

const str = (v: unknown, max = 40) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10_000) / 10_000 : v === null || v === undefined || v === '' ? null : NaN);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

/** Accepts only the known draft shape, so stray fields can't be stored. */
export function readDraft(raw: any, localCurrency: string): PricingDraft {
  const technique = raw?.technique === null ? null : oneOf<PricingTechnique>(raw?.technique, TECHNIQUES.map((t) => t.id), 'variable_rate');
  const currency = technique === 'fixed_fee' && raw?.currency === 'USD' ? 'USD' : localCurrency;
  const tiers = Array.isArray(raw?.tiers)
    ? raw.tiers.slice(0, 20).map((t: any) => ({ minVolume: numOrNull(t?.minVolume) ?? 0, maxVolume: numOrNull(t?.maxVolume), mdrPct: numOrNull(t?.mdrPct) ?? NaN, fixedFee: numOrNull(t?.fixedFee) ?? 0 }))
    : null;
  const h = raw?.historical;
  const historical =
    technique === 'historical_volume' && h
      ? {
          referencePeriod: oneOf(h.referencePeriod, ['previous_month', 'previous_quarter', 'previous_3_months'] as const, 'previous_month'),
          evaluationMetric: oneOf(h.evaluationMetric, ['gmv', 'gpv', 'transaction_count'] as const, 'gmv'),
          volumeThreshold: Math.round(numOrNull(h.volumeThreshold) ?? NaN),
          thresholdDirection: oneOf(h.thresholdDirection, ['>=', '<'] as const, '>='),
          resultingMdr: numOrNull(h.resultingMdr) ?? NaN,
          resultingFixedFee: 0 as const,
          defaultMdr: numOrNull(h.defaultMdr) ?? NaN,
          defaultFixedFee: 0 as const,
          targetPeriod: 'current_month' as const,
        }
      : null;
  const sub = raw?.subscription;
  const p = raw?.promotion;
  return {
    flow: raw?.flow === 'payout' ? 'payout' : 'payin',
    methodCode: str(raw?.methodCode),
    subMerchantId: str(raw?.subMerchantId) || null,
    vaBanks: Array.isArray(raw?.vaBanks) ? [...new Set<string>(raw.vaBanks.filter((b: unknown) => VA_BANKS.some((x) => x.code === b)))] : [],
    technique,
    currency,
    mdrPct: technique && ['variable_rate', 'variable_plus_fixed', 'higher_of'].includes(technique) ? numOrNull(raw?.mdrPct) : null,
    fixedFee: technique === 'fixed_fee' || technique === 'variable_plus_fixed' ? numOrNull(raw?.fixedFee) : null,
    minimumFee: technique === 'variable_rate' || technique === 'higher_of' ? (numOrNull(raw?.minimumFee) ?? 0) : null,
    volumePeriod: technique === 'volume_based' ? oneOf(raw?.volumePeriod, ['monthly', 'quarterly', 'annual'] as const, 'monthly') : null,
    tiers: technique === 'volume_based' ? (tiers ?? []) : null,
    historical,
    subscription: sub ? { monthlyFee: numOrNull(sub.monthlyFee) ?? NaN, currency: localCurrency } : null,
    promotion: p
      ? {
          type: p.type === 'conditional' ? 'conditional' : 'unconditional',
          mdrPct: numOrNull(p.mdrPct) ?? NaN,
          startDate: str(p.startDate, 10),
          endDate: str(p.endDate, 10) || null,
          ...(p.type === 'conditional'
            ? {
                evaluationPeriod: p.evaluationPeriod === 'weekly' ? ('weekly' as const) : ('monthly' as const),
                metric: oneOf(p.metric, ['gpv', 'gmv', 'transaction_count'] as const, 'gpv'),
                conditions: (Array.isArray(p.conditions) ? p.conditions : []).slice(0, 10).map((c: any) => ({ op: c?.op === '>' ? ('>' as const) : ('>=' as const), value: numOrNull(c?.value) ?? NaN, mdrPct: numOrNull(c?.mdrPct) ?? NaN })),
              }
            : {}),
        }
      : null,
    startDate: str(raw?.startDate, 10),
    endDate: str(raw?.endDate, 10) || null,
  };
}

/** "{method} ({flow}) – {technique}: {summary}[, {settlement}]" (MP-10). */
function label(v: PricingVersion, methodName: string, sub?: string | null) {
  return `${methodName} (${FLOW_LABEL[v.flow]})${sub ? ` · ${sub}` : ''} – ${pricingSummary(v)}${v.settlementSnapshot ? `, ${v.settlementSnapshot}` : ''}`;
}

/** Adds an append-only MDR audit entry (§7.10). */
function audit(ctx: ProductContext, v: PricingVersion, entry: { role: string; previous: string; next: string; status: PricingVersion['status']; reason?: string | null; user?: string }) {
  const method = productState(ctx.db, ctx.app).methods.find((m) => m.code === v.methodCode);
  ctx.db.pricingAudit ??= [];
  ctx.db.seq.pricingAudit ??= 1;
  ctx.db.pricingAudit.push({
    id: `PA-${String(ctx.db.seq.pricingAudit++).padStart(6, '0')}`,
    at: ctx.now,
    user: entry.user ?? ctx.caller.name,
    role: entry.role,
    applicationId: ctx.app.id,
    merchantId: ctx.app.merchantId,
    merchantName: merchantOf(ctx.db, ctx.app).legalName,
    country: ctx.app.country,
    methodCode: v.methodCode,
    methodName: method?.name ?? v.methodCode,
    subMerchantName: subName(ctx.db, v.subMerchantId),
    flow: v.flow,
    versionId: v.id,
    version: v.version,
    previous: entry.previous,
    next: entry.next,
    effective: periodText(v),
    status: entry.status,
    reason: entry.reason ?? null,
  });
}

/** Summary of the pricing in effect in the scope before this version, or "No pricing configured". */
function previousSummary(versions: PricingVersion[], v: Pick<PricingVersion, 'methodCode' | 'flow' | 'id' | 'subMerchantId'>, today: string) {
  const prev = versions.filter((x) => x.id !== v.id && sameScope(x, v) && (x.status === 'active' || x.status === 'scheduled')).sort((a, b) => b.version - a.version)[0] ?? pricingInEffect(versions, v.methodCode, today, v.flow, subOf(v));
  return prev ? `${pricingSummary(prev)} (v${prev.version})` : 'No pricing configured';
}

/** Creates a pricing version. Onboarding: active or scheduled at once (MP-5). Change: pending FinOps (MP-6). */
export function setPricing(ctx: ProductContext, body: any): PricingVersion {
  const mode = modeOf(ctx.db, ctx.app);
  const suspended = suspendedOf(ctx.db, ctx.app);
  if (mode === 'read_only') fail(409, 'INVALID_TRANSITION', { message: suspended ? SUSPENDED : 'Pricing can be set once the MID is under CS review, and changed after CS confirms it.' });
  const msg = pricingMessage(mode, ctx.role, suspended);
  if (msg) ROLE_ERROR(msg);
  const state = productState(ctx.db, ctx.app);
  const cfg = ONBOARDING_COUNTRIES[ctx.app.country];
  const today = todayIso(ctx.now);
  const draft = readDraft(body?.draft, cfg.currency);

  // Editing keeps the technique and scope of the version it replaces (decision: technique locked).
  const editOf = typeof body?.editOf === 'string' && body.editOf ? (state.versions.find((v) => v.id === body.editOf) ?? fail(404, 'NOT_FOUND', { message: 'Pricing version not found.' })) : null;
  if (editOf) {
    if (editOf.status !== 'active' && editOf.status !== 'scheduled') fail(409, 'INVALID_TRANSITION', { message: 'Only active or scheduled pricing can be edited.' });
    if (state.versions.some((v) => sameScope(v, editOf) && v.status === 'pending_approval')) fail(409, 'PRICING_PENDING', { message: 'This pricing has a change waiting for FinOps approval.' });
    if (draft.technique !== editOf.technique) fail(422, 'VALIDATION_FAILED', { message: `The pricing method (${techniqueLabel(editOf.technique)}) cannot be changed.` });
    if (!sameScope(draft, editOf) || JSON.stringify([...draft.vaBanks].sort()) !== JSON.stringify([...(editOf.vaBanks ?? [])].sort())) fail(422, 'VALIDATION_FAILED', { message: 'The scope of an edited version cannot change.' });
  }

  const method = state.methods.find((m) => m.code === draft.methodCode && m.flow === draft.flow);
  if (!draft.methodCode) fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'pricing', field: 'methodCode', message: 'Payment method is required' }], message: 'Payment method is required' });
  if (!method) fail(422, 'VALIDATION_FAILED', { message: `${draft.methodCode} is not a product offered in ${cfg.name}.` });
  if (!state.config.products.find((p) => p.methodCode === draft.methodCode)?.enabled) fail(422, 'VALIDATION_FAILED', { message: `Switch on ${method!.name} and save products before pricing it.` });
  if (!usesVaBanks(ctx.app.country, draft.methodCode)) draft.vaBanks = [];
  // Sub-merchant pricing (§7.4, §8.9): after onboarding, for the merchant's own sub-merchants in
  // this corridor, and only for products switched on at the MID.
  if (draft.subMerchantId) {
    if (!subMerchantsOf(ctx.db, ctx.app).some((x) => x.id === draft.subMerchantId)) fail(422, 'VALIDATION_FAILED', { message: `That sub-merchant isn't part of ${merchantOf(ctx.db, ctx.app).legalName} in ${cfg.name}.` });
    if (mode !== 'change') fail(409, 'INVALID_TRANSITION', { message: 'Sub-merchant pricing can be set once onboarding is confirmed.' });
  }
  const issues = [...validatePrimary(draft, draft.endDate !== null), ...validateSecondary(draft)];
  if (!isIsoDate(draft.startDate)) issues.unshift({ field: 'startDate', message: 'Start date is required' });
  if (draft.endDate && !isIsoDate(draft.endDate)) issues.push({ field: 'endDate', message: 'End date is required when Set End Date is checked' });
  if (draft.startDate && draft.startDate < today) issues.push({ field: 'startDate', message: "Start date can't be in the past" });
  if (issues.length) fail(422, 'VALIDATION_FAILED', { errors: issues.map((i) => ({ section: 'pricing', field: i.field, message: i.message })), message: issues.map((i) => i.message).join(' ') });

  const conflict = classifyPeriod(draft, state.versions, editOf?.id);
  if (conflict.kind === 'overlap') {
    fail(409, 'PRICING_OVERLAP', { message: `Pricing period overlaps with an existing configuration. ${overlapMessage(conflict.existing, merchantOf(ctx.db, ctx.app).legalName, method!.name, subName(ctx.db, draft.subMerchantId))}` });
  }
  if (mode === 'change' && state.versions.some((v) => sameScope(v, draft) && v.status === 'pending_approval')) {
    fail(409, 'PRICING_PENDING', { message: `${method!.name} already has a pricing change waiting for FinOps approval. Wait for that decision or cancel it first.` });
  }

  materialise(ctx, state);
  ctx.db.pricingVersions ??= [];
  const all = ctx.db.pricingVersions.filter((v) => v.applicationId === ctx.app.id);
  const version: PricingVersion = {
    ...draft,
    id: nextPricingId(ctx.db),
    applicationId: ctx.app.id,
    version: Math.max(0, ...all.filter((v) => sameScope(v, draft)).map((v) => v.version)) + 1,
    status: 'pending_approval',
    usd: draft.technique === 'fixed_fee' && draft.currency === 'USD' ? { fixedFeeUsd: draft.fixedFee!, usdExchangeRate: USD_RATES[cfg.currency], localEquivalent: Math.round(draft.fixedFee! * USD_RATES[cfg.currency] * 100) / 100, localEquivalentCurrency: cfg.currency } : null,
    source: mode === 'onboarding' ? 'onboarding' : 'change',
    settlementSnapshot: draft.flow === 'payin' ? (state.config.settlement[draft.methodCode] ?? null) : null,
    editOf: editOf?.id ?? null,
    createdBy: ctx.caller.name,
    createdById: ctx.caller.userId,
    createdRole: ctx.role,
    createdAt: ctx.now,
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    cancelledBy: null,
    cancelledAt: null,
  };
  const previous = previousSummary(all, version, today);
  ctx.db.pricingVersions.push(version);
  const text = label(version, method!.name, subName(ctx.db, version.subMerchantId));
  if (mode === 'onboarding') {
    activateVersion(version, ctx.db.pricingVersions.filter((v) => v.applicationId === ctx.app.id), today);
    ctx.record(`Set merchant pricing v${version.version} – ${text}`);
    audit(ctx, version, { role: AUDIT_ROLE[ctx.role], previous, next: pricingSummary(version), status: version.status });
    syncDerivedChecklist(ctx);
  } else {
    ctx.record(`Submitted pricing change v${version.version} for FinOps approval`, { comment: text });
    audit(ctx, version, { role: AUDIT_ROLE[ctx.role], previous, next: pricingSummary(version), status: 'pending_approval' });
    ctx.notify('pricing_approval_requested', ['finops'], `Pricing to approve: ${merchantOf(ctx.db, ctx.app).legalName} · ${method!.name}`, `${ctx.caller.name} submitted pricing change v${version.version} for ${ctx.app.id}: ${pricingSummary(version)}.`);
  }
  return version;
}

function cancelVersion(ctx: ProductContext, v: PricingVersion, why: string | null) {
  const previous = pricingSummary(v);
  v.status = 'cancelled';
  v.cancelledBy = ctx.caller.name;
  v.cancelledAt = ctx.now;
  ctx.record(`Cancelled pricing v${v.version}`, { comment: why ?? undefined });
  audit(ctx, v, { role: AUDIT_ROLE[ctx.role] ?? ctx.role, previous, next: 'Cancelled', status: 'cancelled', reason: why });
}

/** MP-9. Onboarding (CS): active, scheduled or pending. Change (Ops): scheduled or pending only. */
export function cancelPricing(ctx: ProductContext, versionId: string, body: any): PricingVersion {
  const mode = modeOf(ctx.db, ctx.app);
  const suspended = suspendedOf(ctx.db, ctx.app);
  const v = (ctx.db.pricingVersions ?? []).find((x) => x.id === versionId && x.applicationId === ctx.app.id) ?? fail(404, 'NOT_FOUND', { message: 'Pricing version not found.' });
  if (mode === 'read_only') fail(409, 'INVALID_TRANSITION', { message: 'You cannot cancel this pricing at this stage.' });
  const msg = pricingMessage(mode, ctx.role, suspended);
  if (msg) ROLE_ERROR(msg);
  if (!['active', 'scheduled', 'pending_approval'].includes(v.status)) fail(409, 'INVALID_TRANSITION', { message: 'Only active, scheduled or pending pricing can be cancelled.' });
  if (mode === 'change' && v.status === 'active') fail(409, 'INVALID_TRANSITION', { message: 'You cannot cancel this pricing at this stage.' });
  cancelVersion(ctx, v, str(body?.reason, 500) || null);
  syncDerivedChecklist(ctx);
  return v;
}

/**
 * Checks a FinOps decision before anything changes (and before asking for the re-authentication
 * code): FinOps only, change mode, pending, maker ≠ checker, reason for a rejection.
 */
export function checkDecision(ctx: ProductContext, versionId: string, body: any): PricingVersion {
  if (ctx.role !== 'finops') ROLE_ERROR('Only FinOps can approve pricing changes.');
  const v = (ctx.db.pricingVersions ?? []).find((x) => x.id === versionId && x.applicationId === ctx.app.id) ?? fail(404, 'NOT_FOUND', { message: 'MID not found.' });
  if (v.status !== 'pending_approval') fail(409, 'INVALID_TRANSITION', { message: 'This pricing change is not awaiting approval.' });
  if (modeOf(ctx.db, ctx.app) !== 'change') fail(409, 'INVALID_TRANSITION', { message: suspendedOf(ctx.db, ctx.app) ? SUSPENDED : 'This MID is not in the stage for that kind of pricing change.' });
  if (body?.decision !== 'approve' && body?.decision !== 'reject') fail(400, 'VALIDATION_FAILED', { message: 'Choose approve or reject.' });
  if (v.createdById === ctx.caller.userId) ROLE_ERROR('You submitted this pricing change, so someone else must approve or reject it.');
  if (body.decision === 'reject' && !str(body?.reason, 1000)) fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'pricing', field: 'reason', message: 'A rejection reason is required.' }], message: 'A rejection reason is required.' });
  return v;
}

/** MP-7 / MP-8. Call after checkDecision and the re-authentication. */
export function decidePricing(ctx: ProductContext, versionId: string, body: any): PricingVersion {
  const v = checkDecision(ctx, versionId, body);
  const today = todayIso(ctx.now);
  const methodName = productState(ctx.db, ctx.app).methods.find((m) => m.code === v.methodCode)?.name ?? v.methodCode;
  if (body.decision === 'approve') {
    // A late approval of a date already passed takes effect today.
    if (v.startDate < today) v.startDate = today;
    activateVersion(v, (ctx.db.pricingVersions ?? []).filter((x) => x.applicationId === ctx.app.id), today);
    v.approvedBy = ctx.caller.name;
    v.approvedAt = ctx.now;
    ctx.record(`FinOps approved pricing change v${v.version}`, { comment: label(v, methodName) });
    audit(ctx, v, { role: 'Finance', previous: 'Pending Approval', next: pricingSummary(v), status: v.status });
  } else {
    const reason = str(body.reason, 1000);
    v.status = 'rejected';
    v.rejectedBy = ctx.caller.name;
    v.rejectedAt = ctx.now;
    v.rejectionReason = reason;
    ctx.record(`FinOps rejected pricing change v${v.version}`, { comment: reason });
    audit(ctx, v, { role: 'Finance', previous: pricingSummary(v), next: 'Rejected', status: 'rejected', reason });
  }
  const verb = body.decision === 'approve' ? 'approved' : 'rejected';
  ctx.notify('pricing_decided', ['sales'], `Pricing ${verb}: ${merchantOf(ctx.db, ctx.app).legalName} · ${methodName}`, `${ctx.caller.name} ${verb} pricing change v${v.version} for ${ctx.app.id}.${v.rejectionReason ? ` Reason: ${v.rejectionReason}` : ''}`);
  return v;
}

// ------------------------------------------------------------------ queues and audit

/** One approvals-list item: current vs proposed pricing for the change (§7.8, §8.7). */
function approvalItem(db: MerchantDb, v: PricingVersion, caller: Caller, today: string): PricingApprovalItem | null {
  const app = db.applications.find((a) => a.id === v.applicationId);
  if (!app) return null;
  const cfg = ONBOARDING_COUNTRIES[app.country];
  const versions = (db.pricingVersions ?? []).filter((x) => x.applicationId === app.id && x.id !== v.id);
  const current = v.status === 'pending_approval' ? pricingInEffect(versions, v.methodCode, today, v.flow, subOf(v)) : undefined;
  return {
    version: v,
    applicationId: app.id,
    merchantId: app.merchantId,
    merchantName: merchantOf(db, app).legalName,
    mid: midOf(db, app),
    country: app.country,
    countryName: cfg?.name ?? app.country,
    methodName: cfg?.paymentMethods.find((m) => m.code === v.methodCode)?.name ?? v.methodCode,
    subMerchantName: subName(db, v.subMerchantId),
    current: current ? `${pricingSummary(current)} (v${current.version})` : null,
    proposed: pricingSummary(v),
    ownSubmission: v.createdById === caller.userId,
  };
}

/** Pricing changes submitted by Ops after onboarding, all statuses (§7.8, §8.7), sorted pending first. */
export function pricingApprovals(db: MerchantDb, role: StaffRole, caller: Caller, now: number, country?: string | null): PricingApprovalsView {
  const today = todayIso(now);
  const rank = (s: PricingVersion['status']) => APPROVAL_STATUS_ORDER.indexOf(s);
  const items = (db.pricingVersions ?? [])
    .filter((v) => v.source === 'change')
    .map((v) => approvalItem(db, v, caller, today))
    .filter((x): x is PricingApprovalItem => !!x && (!country || x.country === country))
    .sort((a, b) => rank(a.version.status) - rank(b.version.status) || (a.version.status === 'pending_approval' ? a.version.createdAt - b.version.createdAt : b.version.createdAt - a.version.createdAt));
  return { items, canDecide: role === 'finops' };
}

// ------------------------------------------------------------------ Merchant Pricing (§7)

/** Applications that Merchant Pricing covers: confirmed MIDs (change mode, or suspended after confirmation). */
const pricedApps = (db: MerchantDb, country: string) => db.applications.filter((a) => a.country === country && CONFIRMED_STATUSES.includes(a.status));

function merchantStatus(db: MerchantDb, merchantId: string): MerchantPricingRow['status'] {
  const m = db.merchants.find((x) => x.id === merchantId)!;
  if (m.lifecycleStatus === 'suspended') return 'suspended';
  const apps = db.applications.filter((a) => a.merchantId === merchantId);
  if (apps.some((a) => a.status === 'operational')) return 'active';
  return apps.some((a) => a.status !== 'rejected') ? 'onboarding' : 'no_active_applications';
}

/** §7.1 Merchant List for a corridor. */
export function merchantPricingList(db: MerchantDb, role: StaffRole, country: string, now: number): MerchantPricingList {
  const rows: MerchantPricingRow[] = pricedApps(db, country).map((app) => {
    const versions = (db.pricingVersions ?? []).filter((v) => v.applicationId === app.id);
    const active = versions.filter((v) => v.status === 'active');
    const rates = active.flatMap((v) => (v.technique === 'volume_based' ? (v.tiers ?? []).map((t) => t.mdrPct) : v.technique === 'historical_volume' ? [v.historical!.resultingMdr, v.historical!.defaultMdr] : v.mdrPct !== null ? [v.mdrPct] : []));
    const lo = Math.min(...rates);
    const hi = Math.max(...rates);
    return {
      applicationId: app.id,
      merchantId: app.merchantId,
      merchantName: merchantOf(db, app).legalName,
      mid: midOf(db, app),
      country,
      subMerchantCount: subMerchantsOf(db, app).length,
      status: merchantStatus(db, app.merchantId),
      updatedAt: Math.max(app.updatedAt, ...versions.map((v) => v.approvedAt ?? v.rejectedAt ?? v.cancelledAt ?? v.createdAt)),
      activeRules: active.length,
      totalRules: versions.length,
      mdr: rates.length ? (lo === hi ? `${lo}%` : `${lo}%–${hi}%`) : null,
      flows: [...new Set(versions.map((v) => v.flow))],
      pendingCount: versions.filter((v) => v.status === 'pending_approval').length,
    };
  });
  return {
    rows: rows.sort((a, b) => a.merchantName.localeCompare(b.merchantName)),
    activeRules: rows.reduce((n, r) => n + r.activeRules, 0),
    pendingApprovals: rows.reduce((n, r) => n + r.pendingCount, 0),
    canConfigure: role === 'sales',
  };
}

/** §7.3 Sub-Merchant View: one row per sub-merchant × payment method, with the resolved pricing (§7.9). */
export function subMerchantPricing(db: MerchantDb, country: string, now: number): SubMerchantPricingRow[] {
  const today = todayIso(now);
  const cfg = ONBOARDING_COUNTRIES[country];
  const out: SubMerchantPricingRow[] = [];
  for (const app of pricedApps(db, country)) {
    const versions = (db.pricingVersions ?? []).filter((v) => v.applicationId === app.id);
    const state = productState(db, app);
    for (const sub of subMerchantsOf(db, app)) {
      const codes = new Set([...state.config.products.filter((p) => p.enabled).map((p) => `${p.flow}:${p.methodCode}`), ...versions.filter((v) => subOf(v) === sub.id).map((v) => `${v.flow}:${v.methodCode}`)]);
      const base = { applicationId: app.id, merchantId: app.merchantId, merchantName: merchantOf(db, app).legalName, mid: midOf(db, app), subMerchantId: sub.id, subMerchantName: sub.name };
      let priced = 0;
      for (const key of codes) {
        const [flow, code] = key.split(':') as [ProductFlow, string];
        const r = resolvePricing(versions, code, today, flow, sub.id);
        if (r) priced++;
        out.push({
          ...base,
          methodCode: code,
          methodName: cfg.paymentMethods.find((m) => m.code === code)?.name ?? code,
          level: r?.level ?? null,
          technique: r ? techniqueLabel(r.version.technique) : null,
          pricing: r ? pricingSummary(r.version) : null,
          currency: r?.version.currency ?? null,
          startDate: r?.version.startDate ?? null,
          endDate: r?.version.endDate ?? null,
          status: r?.version.status ?? null,
        });
      }
      // A sub-merchant with no resolved pricing at all gets one placeholder row ("No pricing").
      if (!priced) {
        for (let i = out.length - 1; i >= 0 && out[i].subMerchantId === sub.id; i--) out.splice(i, 1);
        out.push({ ...base, methodCode: null, methodName: null, level: null, technique: null, pricing: null, currency: null, startDate: null, endDate: null, status: null });
      }
    }
  }
  return out;
}

/** §7.11 MDR History: every rule in the corridor, by merchant, sub-merchant, payment method, then version (newest first). */
export function mdrHistory(db: MerchantDb, country: string): MdrHistoryRow[] {
  const cfg = ONBOARDING_COUNTRIES[country];
  return (db.pricingVersions ?? [])
    .map((v) => ({ v, app: db.applications.find((a) => a.id === v.applicationId) }))
    .filter((x) => x.app?.country === country)
    .map(({ v, app }) => ({ version: v, applicationId: app!.id, merchantId: app!.merchantId, merchantName: merchantOf(db, app!).legalName, subMerchantName: subName(db, v.subMerchantId), methodName: cfg.paymentMethods.find((m) => m.code === v.methodCode)?.name ?? v.methodCode }))
    .sort((a, b) => a.merchantName.localeCompare(b.merchantName) || (a.subMerchantName ?? '').localeCompare(b.subMerchantName ?? '') || a.methodName.localeCompare(b.methodName) || b.version.version - a.version.version);
}

/** The MDR audit log, latest first. */
export function pricingAuditLog(db: MerchantDb): PricingAuditEvent[] {
  return [...(db.pricingAudit ?? [])].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}

// ------------------------------------------------------------------ onboarding gate

/** What still stops "Confirm onboarding" (§8.8). */
export function onboardingGaps(db: MerchantDb, app: CountryApplication, now: number) {
  const s = productState(db, app);
  return productGaps(s.config, s.versions, s.methods, todayIso(now));
}

/** Checklist items that follow Product & Payment Config instead of being ticked by hand. */
export const DERIVED_CHECKLIST = ['payment_methods', 'pricing_loaded'];

/** Keeps the two derived configuration checklist items in step with products and pricing (onboarding only). */
export function syncDerivedChecklist(ctx: ProductContext) {
  if (ctx.app.status !== 'cs_configuration') return;
  const gaps = onboardingGaps(ctx.db, ctx.app, ctx.now);
  const anyOn = !gaps.some((g) => g.issue === 'no_products');
  const target: Record<string, boolean> = { payment_methods: anyOn, pricing_loaded: anyOn && !gaps.some((g) => g.issue === 'pricing') };
  for (const item of ctx.app.readiness.configuration) {
    if (!(item.key in target) || item.done === target[item.key]) continue;
    Object.assign(item, { done: target[item.key], doneAt: target[item.key] ? ctx.now : null, doneBy: target[item.key] ? 'System' : null });
    ctx.record(`${target[item.key] ? 'Completed' : 'Reopened'} automatically: ${item.label}`, { system: true });
  }
}

