import { ApplicationStatus } from './merchant-models';
import { CountryOnboardingConfig } from './onboarding-config';

// Product & Payment Config (Pricing Engine build document §8): products, settlement and pricing for
// one country application (the MID it becomes). Shared by the portal and the simulated backend, so
// the screens and the server apply the same rules. The server always re-checks everything.
//
// - Products come from the country's catalog (§3.3), PayIn and PayOut.
// - Settlement is a PayIn product setting; saving it never creates a pricing version.
// - Pricing is versioned per scope (MID + flow + payment method, + VA banks for Indonesia VA), with
//   one of six primary methods (or subscription only), optional secondary charges, and effective
//   periods with overlap and supersession rules (§4.2).

// ------------------------------------------------------------------ catalog

export const SETTLEMENT_CYCLES = ['T+0', 'T+1', 'T+2', 'T+3', 'T+4', 'T+5'] as const;
export type SettlementCycle = (typeof SETTLEMENT_CYCLES)[number];

export type ProductFlow = 'payin' | 'payout';
export const FLOW_LABEL: Record<ProductFlow, string> = { payin: 'PayIn', payout: 'PayOut' };
export const FLOW_ROW_LABEL: Record<ProductFlow, string> = { payin: 'PayIn – Collections', payout: 'PayOut – Disbursements' };

export interface ProductMethod {
  code: string;
  name: string;
  flow: ProductFlow;
  /** Usual maximum MDR %: above it the editor warns (the hard limit is MDR_HARD_LIMIT). */
  typicalMaxMdr: number;
  /** Option group in pickers (§3.1), e.g. "E-Wallets". */
  group?: string;
}

/** Hard upper limit for every MDR % (decision: 10%). */
export const MDR_HARD_LIMIT = 10;

/** Indonesia VA banks (§3.2), for the `va` pricing scope. */
export const VA_BANKS: { code: string; name: string }[] = [
  { code: 'va_bri', name: 'VA BRI' },
  { code: 'va_bca', name: 'VA BCA' },
  { code: 'va_bsi', name: 'VA BSI' },
  { code: 'va_bni', name: 'VA BNI' },
  { code: 'va_cimb', name: 'VA CIMB' },
  { code: 'va_maybank', name: 'VA Maybank' },
  { code: 'va_muamalat', name: 'VA Muamalat' },
  { code: 'va_permata', name: 'VA Permata' },
  { code: 'va_mandiri', name: 'VA Mandiri' },
  { code: 'va_sinarmas', name: 'VA Sinarmas' },
  { code: 'va_bnc', name: 'VA BNC' },
  { code: 'va_ocbc', name: 'VA OCBC' },
  { code: 'va_danamon', name: 'VA Danamon' },
  { code: 'va_btn', name: 'VA BTN' },
];

/** True when the scope uses VA banks (Indonesia Virtual Account). */
export const usesVaBanks = (country: string, methodCode: string) => country === 'ID' && methodCode === 'va';

export function countryProducts(cfg: CountryOnboardingConfig): ProductMethod[] {
  return cfg.paymentMethods.map((m) => ({ code: m.code, name: m.name, flow: m.flow, typicalMaxMdr: m.typicalMaxMdr, ...(m.group ? { group: m.group } : {}) }));
}

/** Methods grouped for pickers: ungrouped ones stand alone, grouped ones sit under their label, in catalog order. */
export function groupMethods<T extends { group?: string }>(methods: T[]): { label: string | null; items: T[] }[] {
  const out: { label: string | null; items: T[] }[] = [];
  for (const m of methods) {
    const label = m.group ?? null;
    const existing = label ? out.find((g) => g.label === label) : null;
    if (existing) existing.items.push(m);
    else out.push({ label, items: [m] });
  }
  return out;
}

// ------------------------------------------------------------------ currency

/** USD/local rates for the prototype only (USD-7). Production uses the previous day's closing rate (USD-5). */
export const USD_RATES: Record<string, number> = { MYR: 4.2, IDR: 16000, INR: 83, VND: 25000, PHP: 56, AED: 3.67 };

/** Decimal places of the currency's smallest unit. */
export const minorUnits = (currency: string) => (currency === 'IDR' || currency === 'VND' ? 0 : 2);

/** Rounds half up to the currency's smallest unit (no tax on fees). */
export function roundFee(value: number, currency: string): number {
  const f = 10 ** minorUnits(currency);
  return Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
}

/** "MYR 1,500.00", "IDR 1.500", "VND 25,000". */
export function money(value: number, currency: string): string {
  const d = minorUnits(currency);
  const n = new Intl.NumberFormat(currency === 'IDR' ? 'id-ID' : 'en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }).format(value);
  return `${currency} ${n}`;
}

const num = (n: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n);
const pct = (n: number | null | undefined) => `${Number((n ?? 0).toFixed(4))}%`;

// ------------------------------------------------------------------ dates

const DAY_MS = 24 * 60 * 60_000;

/** Today's calendar date (YYYY-MM-DD, UTC) for a server time. */
export function todayIso(now: number) {
  return new Date(now).toISOString().slice(0, 10);
}

export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** DD MMM YYYY, for tables (e.g. 04 Nov 2026). */
export function fmtDay(date: string | null | undefined): string {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00Z`);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** DD/MM/YYYY, for effective-period sentences. */
export function fmtSlash(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// ------------------------------------------------------------------ pricing model

export type PricingTechnique = 'variable_rate' | 'fixed_fee' | 'variable_plus_fixed' | 'higher_of' | 'volume_based' | 'historical_volume';

export const TECHNIQUES: { id: PricingTechnique; label: string; description: string }[] = [
  { id: 'variable_rate', label: 'Percentage', description: 'Charge a percentage of the transaction amount' },
  { id: 'fixed_fee', label: 'Fixed Fee', description: 'Charge a fixed amount per transaction' },
  { id: 'variable_plus_fixed', label: 'Percentage + Fixed Fee', description: 'Charge a MDR % plus a fixed fee per transaction' },
  { id: 'higher_of', label: 'Higher of Percentage or Fixed Fee', description: 'Charge the higher of the calculated percentage fee or the configured fixed fee' },
  { id: 'volume_based', label: 'Volume-Based (Waterfall)', description: 'Apply different MDRs based on transaction volume during a defined period' },
  { id: 'historical_volume', label: 'Historical Volume', description: 'Future period pricing based on previous period transaction volume' },
];

/** Label for a stored technique; null = no primary method (subscription only). */
export const techniqueLabel = (t: PricingTechnique | null) => (t ? (TECHNIQUES.find((x) => x.id === t)?.label ?? t) : 'Subscription only');

export type VolumePeriod = 'monthly' | 'quarterly' | 'annual';
export const VOLUME_PERIOD_LABEL: Record<VolumePeriod, string> = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' };

export interface VolumeTier {
  minVolume: number;
  /** Null = no limit. */
  maxVolume: number | null;
  mdrPct: number;
  fixedFee: number;
}

export type ReferencePeriod = 'previous_month' | 'previous_quarter' | 'previous_3_months';
export const REFERENCE_PERIOD_LABEL: Record<ReferencePeriod, string> = { previous_month: 'Previous Month', previous_quarter: 'Previous Quarter', previous_3_months: 'Previous 3 Months' };
export const REFERENCE_PERIOD_SHORT: Record<ReferencePeriod, string> = { previous_month: 'Prev Month', previous_quarter: 'Prev Quarter', previous_3_months: 'Prev 3 Months' };
export type VolumeMetric = 'gmv' | 'gpv' | 'transaction_count';
export const METRIC_LABEL: Record<VolumeMetric, string> = { gmv: 'GMV (Gross Merchandise Value)', gpv: 'GPV (Gross Payment Volume)', transaction_count: 'Transaction Count' };
export const METRIC_SHORT: Record<VolumeMetric, string> = { gmv: 'GMV', gpv: 'GPV', transaction_count: 'Transaction Count' };

export interface HistoricalConfig {
  referencePeriod: ReferencePeriod;
  evaluationMetric: VolumeMetric;
  volumeThreshold: number;
  thresholdDirection: '>=' | '<';
  resultingMdr: number;
  resultingFixedFee: 0;
  defaultMdr: number;
  defaultFixedFee: 0;
  targetPeriod: 'current_month';
}

export interface UsdFee {
  /** USD per transaction. */
  fixedFeeUsd: number;
  usdExchangeRate: number;
  localEquivalent: number;
  localEquivalentCurrency: string;
}

export interface Subscription {
  monthlyFee: number;
  currency: string;
}

export interface PromoCondition {
  op: '>=' | '>';
  value: number;
  mdrPct: number;
}

export interface Promotion {
  type: 'unconditional' | 'conditional';
  mdrPct: number;
  startDate: string;
  endDate: string | null;
  /** Conditional only. */
  evaluationPeriod?: 'monthly' | 'weekly';
  metric?: VolumeMetric;
  conditions?: PromoCondition[];
}

export const PROMO_TYPE_LABEL: Record<Promotion['type'], string> = { unconditional: 'Unconditional', conditional: 'Conditional' };

/** What the editor sends: everything that defines a pricing version except its scope state. */
export interface PricingDraft {
  flow: ProductFlow;
  methodCode: string;
  /** Sub-merchant (entity ID) the rule is for; null or absent = merchant level (§7.4 Scope, §7.9). */
  subMerchantId?: string | null;
  /** Indonesia VA only; empty = all banks. */
  vaBanks: string[];
  /** Null = no primary method; a subscription fee is then required. */
  technique: PricingTechnique | null;
  /** Local currency, or USD for Fixed Fee. */
  currency: string;
  mdrPct: number | null;
  fixedFee: number | null;
  minimumFee: number | null;
  volumePeriod: VolumePeriod | null;
  tiers: VolumeTier[] | null;
  historical: HistoricalConfig | null;
  subscription: Subscription | null;
  promotion: Promotion | null;
  startDate: string;
  endDate: string | null;
}

export type PricingStatus = 'pending_approval' | 'active' | 'scheduled' | 'expired' | 'rejected' | 'cancelled';

/** §4.1. Pending approval reads "Pending FinOps approval" on MID pricing. */
export const PRICING_STATUS_LABEL: Record<PricingStatus, string> = {
  pending_approval: 'Pending FinOps approval',
  active: 'Active',
  scheduled: 'Scheduled',
  expired: 'Expired',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const PRICING_STATUS_TONE: Record<PricingStatus, string> = { pending_approval: 'warning', active: 'success', scheduled: 'info', expired: '', rejected: 'danger', cancelled: '' };

export interface PricingVersion extends PricingDraft {
  id: string;
  applicationId: string;
  /** Highest version in the same scope + 1 (MP-4). */
  version: number;
  status: PricingStatus;
  /** USD Fixed Fee only (USD-4). */
  usd: UsdFee | null;
  /** Mode the version was created in. */
  source: 'onboarding' | 'change';
  /** Settlement cycle in effect when created (history only). */
  settlementSnapshot: SettlementCycle | null;
  /** The version this one was edited from, if any. */
  editOf: string | null;
  createdBy: string;
  createdById: string;
  createdRole: string;
  createdAt: number;
  approvedBy: string | null;
  approvedAt: number | null;
  rejectedBy: string | null;
  rejectedAt: number | null;
  rejectionReason: string | null;
  cancelledBy: string | null;
  cancelledAt: number | null;
}

// ------------------------------------------------------------------ summaries (§4.4, §7.11)

/** Configuration summary used in the pricing table, history and audit "Previous / New". */
export function pricingSummary(v: Pick<PricingDraft, 'technique' | 'currency' | 'mdrPct' | 'fixedFee' | 'minimumFee' | 'tiers' | 'historical'> & { usd?: UsdFee | null }): string {
  const cur = v.currency;
  switch (v.technique) {
    case null:
      return 'No primary pricing (subscription only)';
    case 'fixed_fee':
      return v.usd ? `Fixed Fee: USD ${num(v.usd.fixedFeeUsd)} (Rate ${num(v.usd.usdExchangeRate)} → ${v.usd.localEquivalentCurrency} ${num(v.usd.localEquivalent)})` : `Fixed Fee: ${cur} ${num(v.fixedFee ?? 0)}`;
    case 'volume_based':
      return `${techniqueLabel(v.technique)}: ${(v.tiers ?? []).map((t) => `${num(t.minVolume)}-${t.maxVolume === null ? '∞' : num(t.maxVolume)}: ${pct(t.mdrPct)}`).join(' | ')}`;
    case 'historical_volume': {
      const h = v.historical!;
      return `${techniqueLabel(v.technique)}: Resulting: ${pct(h.resultingMdr)} | Default: ${pct(h.defaultMdr)} | ${REFERENCE_PERIOD_SHORT[h.referencePeriod]} ${METRIC_SHORT[h.evaluationMetric]} ${h.thresholdDirection} ${num(h.volumeThreshold)}`;
    }
    case 'higher_of':
      return `${techniqueLabel(v.technique)}: ${pct(v.mdrPct)} + Min: ${cur} ${num(v.minimumFee ?? 0)}`;
    default: {
      const fixed = v.fixedFee && v.fixedFee > 0 ? ` + ${cur} ${num(v.fixedFee)}` : '';
      const min = v.technique === 'variable_rate' && v.minimumFee && v.minimumFee > 0 ? ` (min ${cur} ${num(v.minimumFee)})` : '';
      return `${techniqueLabel(v.technique)}: ${pct(v.mdrPct)}${fixed}${min}`;
    }
  }
}

/** Short pricing text for the table's Pricing column. */
export function pricingShort(v: PricingVersion): string {
  switch (v.technique) {
    case null:
      return 'Subscription only';
    case 'fixed_fee':
      return v.usd ? `USD ${num(v.usd.fixedFeeUsd)} (≈ ${v.usd.localEquivalentCurrency} ${num(v.usd.localEquivalent)})` : `${v.currency} ${num(v.fixedFee ?? 0)} per transaction`;
    case 'volume_based':
      return (v.tiers ?? []).map((t) => `${num(t.minVolume)}-${t.maxVolume === null ? '∞' : num(t.maxVolume)}: ${pct(t.mdrPct)}`).join(' | ');
    case 'historical_volume':
      return `Resulting: ${pct(v.historical!.resultingMdr)} | Default: ${pct(v.historical!.defaultMdr)}`;
    case 'higher_of':
      return `Percentage: ${pct(v.mdrPct)} + Min: ${v.currency} ${num(v.minimumFee ?? 0)}`;
    case 'variable_plus_fixed':
      return `MDR: ${pct(v.mdrPct)} + Fixed: ${v.currency} ${num(v.fixedFee ?? 0)}`;
    default:
      return `MDR: ${pct(v.mdrPct)}${v.minimumFee ? ` · Min: ${v.currency} ${num(v.minimumFee)}` : ''}`;
  }
}

/** "Sub: MYR 100/mo | Promo (Conditional): 1%". */
export function secondarySummary(v: Pick<PricingDraft, 'subscription' | 'promotion'>): string {
  const parts: string[] = [];
  if (v.subscription) parts.push(`Sub: ${v.subscription.currency} ${num(v.subscription.monthlyFee)}/mo`);
  if (v.promotion) parts.push(`Promo (${PROMO_TYPE_LABEL[v.promotion.type]}): ${pct(v.promotion.mdrPct)}`);
  return parts.join(' | ');
}

/** "{start} – {end|Ongoing}" in DD MMM YYYY. */
export const periodText = (v: Pick<PricingDraft, 'startDate' | 'endDate'>) => `${fmtDay(v.startDate)} – ${v.endDate ? fmtDay(v.endDate) : 'Ongoing'}`;

/**
 * Subscription billing (decision): charged on the 1st for the previous month. Returns the next
 * charge after `today` while the version is live.
 */
export function nextSubscriptionCharge(v: Pick<PricingDraft, 'subscription' | 'startDate' | 'endDate'>, today: string): { date: string; forMonth: string; amount: number; currency: string } | null {
  if (!v.subscription || v.subscription.monthlyFee <= 0) return null;
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // 1st of next month
  const prev = new Date(Date.UTC(y, m - 1, 1));
  if (v.startDate > addDays(first, -1)) return null; // starts after the month being charged
  if (v.endDate && v.endDate < prev.toISOString().slice(0, 10)) return null;
  return { date: first, forMonth: `${MONTHS[prev.getUTCMonth()]} ${prev.getUTCFullYear()}`, amount: v.subscription.monthlyFee, currency: v.subscription.currency };
}

// ------------------------------------------------------------------ effective periods (§4.2)

/** Sub-merchant of a rule; null = merchant level. */
export const subOf = (v: Pick<PricingDraft, 'subMerchantId'>) => v.subMerchantId ?? null;

/**
 * Same scope: flow + payment method + sub-merchant (the MID is the application). VA banks are
 * checked separately (§7.6).
 */
export const sameScope = (a: Pick<PricingVersion, 'flow' | 'methodCode' | 'subMerchantId'>, b: Pick<PricingVersion, 'flow' | 'methodCode' | 'subMerchantId'>) =>
  a.flow === b.flow && a.methodCode === b.methodCode && subOf(a) === subOf(b);

/** §7.6: VA rules are compared only when their bank sets intersect (empty = all banks). */
export function vaBanksIntersect(a: string[], b: string[]) {
  return !a.length || !b.length || a.some((x) => b.includes(x));
}

export function periodsOverlap(a: { startDate: string; endDate: string | null }, b: { startDate: string; endDate: string | null }) {
  return a.startDate <= (b.endDate ?? '9999-12-31') && b.startDate <= (a.endDate ?? '9999-12-31');
}

/** In effect on `day`: active or scheduled, and start ≤ day ≤ end. */
export function inEffect(v: Pick<PricingVersion, 'status' | 'startDate' | 'endDate'>, day: string) {
  return (v.status === 'active' || v.status === 'scheduled') && v.startDate <= day && (!v.endDate || day <= v.endDate);
}

export type PeriodConflict = { kind: 'none' } | { kind: 'supersession'; existing: PricingVersion; message: string } | { kind: 'overlap'; existing: PricingVersion };

/**
 * Classifies a new period against the same-scope versions (§4.2). `excludeId`: the version being
 * edited, which the check ignores (§7.7). A hard overlap wins over a supersession.
 */
export function classifyPeriod(draft: Pick<PricingDraft, 'flow' | 'methodCode' | 'subMerchantId' | 'vaBanks' | 'startDate' | 'endDate'>, versions: PricingVersion[], excludeId?: string | null): PeriodConflict {
  let supersession: PeriodConflict | null = null;
  for (const e of versions) {
    if (e.id === excludeId || !sameScope(e, draft)) continue;
    if (e.status === 'rejected' || e.status === 'cancelled' || e.status === 'expired') continue;
    if (!vaBanksIntersect(e.vaBanks ?? [], draft.vaBanks ?? [])) continue;
    if (!periodsOverlap(e, draft)) continue;
    if (e.endDate === null && draft.startDate > e.startDate) {
      supersession ??= {
        kind: 'supersession',
        existing: e,
        message: `This new pricing configuration will supersede the existing pricing from ${fmtSlash(draft.startDate)}. The existing pricing will remain effective until ${fmtSlash(addDays(draft.startDate, -1))}.`,
      };
      continue;
    }
    return { kind: 'overlap', existing: e };
  }
  return supersession ?? { kind: 'none' };
}

/** "Pricing period overlaps…" detail line (§7.4 step 3). */
export function overlapMessage(existing: PricingVersion, merchantName: string, methodName: string, subMerchantName?: string | null): string {
  return `${techniqueLabel(existing.technique)} pricing is already configured for ${merchantName}${subMerchantName ? ` → ${subMerchantName}` : ''} → ${methodName} from ${fmtDay(existing.startDate)} to ${existing.endDate ? fmtDay(existing.endDate) : 'Ongoing'}. Please select a non-overlapping effective period.`;
}

export const statusOnActivation = (startDate: string, today: string): PricingStatus => (startDate > today ? 'scheduled' : 'active');

/**
 * Activates a version (onboarding save or FinOps approval) and supersedes other same-scope live
 * versions exactly as §4.2 describes. Mutates the versions. Returns the versions it changed.
 */
export function activateVersion(target: PricingVersion, all: PricingVersion[], today: string): PricingVersion[] {
  target.status = statusOnActivation(target.startDate, today);
  const changed: PricingVersion[] = [];
  const dayBefore = addDays(target.startDate, -1);
  for (const e of all) {
    if (e === target || e.id === target.id || !sameScope(e, target) || !vaBanksIntersect(e.vaBanks ?? [], target.vaBanks ?? [])) continue;
    if (e.status !== 'active' && e.status !== 'scheduled') continue;
    if (target.startDate > e.startDate) {
      if (e.endDate === null || e.endDate >= target.startDate) {
        e.endDate = dayBefore;
        if (target.status === 'active') e.status = 'expired';
        changed.push(e);
      }
    } else if (target.status === 'active' && periodsOverlap(e, target)) {
      e.endDate = dayBefore;
      e.status = 'expired';
      changed.push(e);
    }
  }
  return changed;
}

/** The daily status job (§4.2 [BUILD]): scheduled → active on the start date, active → expired after the end date. */
export function runStatusJob(versions: PricingVersion[], today: string): number {
  let n = 0;
  for (const v of versions) {
    if (v.status === 'scheduled' && v.startDate <= today) {
      v.status = v.endDate && v.endDate < today ? 'expired' : 'active';
      n++;
    } else if (v.status === 'active' && v.endDate && v.endDate < today) {
      v.status = 'expired';
      n++;
    }
  }
  return n;
}

/**
 * The rule in effect for `methodCode` on `day` at one level (merchant level by default): latest
 * start date first, then the highest version (§7.9).
 */
export function pricingInEffect(versions: PricingVersion[], methodCode: string, day: string, flow?: ProductFlow, subMerchantId: string | null = null): PricingVersion | undefined {
  return versions
    .filter((v) => v.methodCode === methodCode && (!flow || v.flow === flow) && subOf(v) === subMerchantId && inEffect(v, day))
    .sort((a, b) => b.startDate.localeCompare(a.startDate) || b.version - a.version)[0];
}

/**
 * Price resolution (§7.9): a sub-merchant's own rule in effect, else the merchant-level rule, else
 * no pricing (no fee; the caller raises an alert).
 */
export function resolvePricing(versions: PricingVersion[], methodCode: string, day: string, flow: ProductFlow, subMerchantId: string | null): { version: PricingVersion; level: 'sub_merchant' | 'merchant' } | null {
  const own = subMerchantId ? pricingInEffect(versions, methodCode, day, flow, subMerchantId) : undefined;
  if (own) return { version: own, level: 'sub_merchant' };
  const merchant = pricingInEffect(versions, methodCode, day, flow, null);
  return merchant ? { version: merchant, level: 'merchant' } : null;
}

// ------------------------------------------------------------------ validation (§4.2, §5, §7.4, §7.5)

export interface DraftIssue {
  field: string;
  message: string;
}

const neg = (n: number | null | undefined) => n !== null && n !== undefined && n < 0;
const bad = (n: unknown) => typeof n !== 'number' || !Number.isFinite(n);

export function validateDates(d: Pick<PricingDraft, 'startDate' | 'endDate'>, endChecked: boolean): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!d.startDate) out.push({ field: 'startDate', message: 'Start date is required' });
  if (endChecked && !d.endDate) out.push({ field: 'endDate', message: 'End date is required when Set End Date is checked' });
  if (d.startDate && d.endDate && !(d.endDate > d.startDate)) out.push({ field: 'endDate', message: 'End date must be after start date' });
  return out;
}

const mdrLimit = (value: number | null | undefined, field: string, out: DraftIssue[]) => {
  if (value !== null && value !== undefined && value > MDR_HARD_LIMIT) out.push({ field, message: `MDR % cannot be more than ${MDR_HARD_LIMIT}%` });
};

export function validateTiers(tiers: VolumeTier[]): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!tiers.length) return [{ field: 'tiers', message: 'At least one volume tier is required' }];
  const sorted = [...tiers].sort((a, b) => a.minVolume - b.minVolume);
  for (const t of sorted) {
    if (t.minVolume < 0) out.push({ field: 'tiers', message: 'Tier min volume cannot be negative' });
    if (t.maxVolume !== null && !(t.maxVolume > t.minVolume)) out.push({ field: 'tiers', message: `Tier starting at ${num(t.minVolume)} must end above its start volume` });
    if (t.mdrPct < 0) out.push({ field: 'tiers', message: 'Tier MDR % cannot be negative' });
    mdrLimit(t.mdrPct, 'tiers', out);
    if (t.fixedFee < 0) out.push({ field: 'tiers', message: 'Tier fixed fee cannot be negative' });
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const t = sorted[i];
    if (prev.maxVolume === null) out.push({ field: 'tiers', message: `Tier starting at ${num(t.minVolume)} overlaps with the open-ended tier starting at ${num(prev.minVolume)}` });
    else if (t.minVolume < prev.maxVolume) out.push({ field: 'tiers', message: `Volume tiers overlap: tier starting at ${num(t.minVolume)} begins before the previous tier ends (${num(prev.maxVolume)})` });
    else if (t.minVolume > prev.maxVolume) out.push({ field: 'tiers', message: `Gap between volume tiers: previous ends at ${num(prev.maxVolume)}, next starts at ${num(t.minVolume)}` });
  }
  return out;
}

/** Primary rule checks (§7.4 step 3), in the document's wording. */
export function validatePrimary(d: PricingDraft, endChecked: boolean): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!d.methodCode) out.push({ field: 'methodCode', message: 'Payment method is required' });
  out.push(...validateDates(d, endChecked));
  switch (d.technique) {
    case null:
      break;
    case 'variable_rate':
    case 'variable_plus_fixed':
    case 'higher_of':
      if (bad(d.mdrPct) || neg(d.mdrPct)) out.push({ field: 'mdrPct', message: 'MDR % cannot be negative' });
      mdrLimit(d.mdrPct, 'mdrPct', out);
      if (d.technique === 'variable_plus_fixed' && (bad(d.fixedFee) || neg(d.fixedFee))) out.push({ field: 'fixedFee', message: 'Fixed fee cannot be negative' });
      if (d.technique !== 'variable_plus_fixed' && neg(d.minimumFee)) out.push({ field: 'minimumFee', message: 'Minimum fee cannot be negative' });
      break;
    case 'fixed_fee':
      if (bad(d.fixedFee) || neg(d.fixedFee)) out.push({ field: 'fixedFee', message: 'Fixed fee cannot be negative' });
      else if (!(d.fixedFee! > 0)) out.push({ field: 'fixedFee', message: d.currency === 'USD' ? 'Fixed fee in USD must be greater than 0' : 'Fixed fee must be greater than 0' });
      break;
    case 'volume_based':
      out.push(...validateTiers(d.tiers ?? []));
      break;
    case 'historical_volume': {
      const h = d.historical;
      if (!h || bad(h.resultingMdr) || neg(h.resultingMdr)) out.push({ field: 'historical.resultingMdr', message: 'MDR % cannot be negative' });
      if (!h || bad(h.defaultMdr) || neg(h.defaultMdr)) out.push({ field: 'historical.defaultMdr', message: 'Default MDR cannot be negative' });
      mdrLimit(h?.resultingMdr, 'historical.resultingMdr', out);
      mdrLimit(h?.defaultMdr, 'historical.defaultMdr', out);
      if (h && (bad(h.volumeThreshold) || h.volumeThreshold < 0)) out.push({ field: 'historical.volumeThreshold', message: 'Volume threshold cannot be negative' });
      break;
    }
  }
  return out;
}

/** Secondary charge checks (§5.4) and the subscription-only rule. */
export function validateSecondary(d: PricingDraft): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (d.subscription && (bad(d.subscription.monthlyFee) || d.subscription.monthlyFee < 0)) out.push({ field: 'subscription', message: 'Subscription fee cannot be negative' });
  if (d.technique === null && !(d.subscription && d.subscription.monthlyFee > 0)) out.push({ field: 'subscription', message: 'If the Primary Pricing Method is not configured, Subscription Fees must be configured.' });
  const p = d.promotion;
  if (p) {
    if (bad(p.mdrPct) || p.mdrPct < 0) out.push({ field: 'promotion', message: 'Promotional MDR cannot be negative' });
    mdrLimit(p.mdrPct, 'promotion', out);
    if (!isIsoDate(p.startDate)) out.push({ field: 'promotion', message: 'Start date is required' });
    if (p.endDate && p.startDate && !(p.endDate > p.startDate)) out.push({ field: 'promotion', message: 'End date must be after start date' });
    if (p.type === 'conditional') {
      if (!p.conditions?.length) out.push({ field: 'promotion', message: 'Add at least one condition' });
      for (const c of p.conditions ?? []) {
        if (bad(c.value) || c.value < 0) out.push({ field: 'promotion', message: 'Condition values cannot be negative' });
        if (bad(c.mdrPct) || c.mdrPct < 0) out.push({ field: 'promotion', message: 'Promotional MDR cannot be negative' });
        mdrLimit(c.mdrPct, 'promotion', out);
      }
    }
  }
  return out;
}

/** Non-blocking: an MDR above the method's usual maximum. */
export function mdrWarnings(d: PricingDraft, method: ProductMethod | undefined): string[] {
  if (!method) return [];
  const rates: (number | null | undefined)[] =
    d.technique === 'volume_based' ? (d.tiers ?? []).map((t) => t.mdrPct)
    : d.technique === 'historical_volume' ? [d.historical?.resultingMdr, d.historical?.defaultMdr]
    : d.technique === 'fixed_fee' || d.technique === null ? []
    : [d.mdrPct];
  const high = rates.some((r) => typeof r === 'number' && r > method.typicalMaxMdr && r <= MDR_HARD_LIMIT);
  return high ? [`${method.name} is usually priced at up to ${method.typicalMaxMdr}%. Check the MDR before saving.`] : [];
}

// ------------------------------------------------------------------ fee engine (§5.2, §5.3)

export interface FeeInput {
  amount: number;
  /** Volume in the current period (Volume-Based: month-to-date at transaction time; also the promo metric). */
  periodVolume?: number;
  /** Previous-period volume (Historical Volume). Null = no history: the default MDR applies. */
  previousPeriodVolume?: number | null;
  /** Calendar date of the transaction. */
  date?: string;
}

export interface FeeResult {
  fee: number;
  currency: string;
  explanation: string;
  breakdown: [string, string][];
  /** Set when no tier matches (Volume-Based). */
  warning?: string;
}

/** Promotional MDR applying to a transaction, if any (decisions: after the condition is met; highest matching threshold wins). */
export function promoMdr(p: Promotion | null, date: string, periodVolume: number): number | null {
  if (!p || date < p.startDate || (p.endDate && date > p.endDate)) return null;
  if (p.type === 'unconditional') return p.mdrPct;
  const met = (p.conditions ?? []).filter((c) => (c.op === '>=' ? periodVolume >= c.value : periodVolume > c.value)).sort((a, b) => b.value - a.value)[0];
  return met ? met.mdrPct : null;
}

/** Fee for one transaction in the pricing currency (local; USD fixed fees are charged in local at the rate). */
export function calculateFee(v: Pick<PricingVersion, 'technique' | 'currency' | 'mdrPct' | 'fixedFee' | 'minimumFee' | 'tiers' | 'historical' | 'promotion' | 'usd'> & { localCurrency: string }, input: FeeInput): FeeResult {
  const cur = v.localCurrency;
  const a = input.amount;
  const r = (n: number) => roundFee(n, cur);
  const m = (n: number) => money(n, cur);
  const date = input.date ?? '0000-01-01';
  const promo = promoMdr(v.promotion ?? null, date, input.periodVolume ?? 0);
  if (promo !== null) {
    const fee = r((a * promo) / 100);
    return { fee, currency: cur, explanation: `Promotional MDR ${pct(promo)} replaces the primary pricing.`, breakdown: [['Transaction Amount', m(a)], ['Promotional MDR', pct(promo)], ['Fee', m(fee)]] };
  }
  switch (v.technique) {
    case null:
      return { fee: 0, currency: cur, explanation: 'No per-transaction fee; only the subscription fee applies.', breakdown: [['Transaction Amount', m(a)], ['Fee', m(0)]] };
    case 'variable_rate': {
      const raw = (a * (v.mdrPct ?? 0)) / 100;
      const floor = v.minimumFee ?? 0;
      const fee = r(Math.max(raw, floor));
      const rows: [string, string][] = [['Transaction Amount', m(a)], ['MDR Rate', pct(v.mdrPct)]];
      if (floor > 0) rows.push(['Minimum Fee', m(floor)]);
      rows.push(['Fee', m(fee)]);
      return { fee, currency: cur, explanation: floor > 0 && floor > raw ? `${pct(v.mdrPct)} of the amount is below the minimum fee, so the minimum applies.` : `${pct(v.mdrPct)} of the transaction amount.`, breakdown: rows };
    }
    case 'variable_plus_fixed': {
      const p = r((a * (v.mdrPct ?? 0)) / 100);
      const fee = r(p + (v.fixedFee ?? 0));
      return { fee, currency: cur, explanation: `${pct(v.mdrPct)} of the amount plus a fixed fee.`, breakdown: [['Transaction Amount', m(a)], ['MDR Rate', pct(v.mdrPct)], ['Percentage Fee', m(p)], ['Fixed Fee', m(v.fixedFee ?? 0)], ['Total Fee', m(fee)]] };
    }
    case 'fixed_fee': {
      if (v.usd) {
        const fee = r(v.usd.localEquivalent);
        return {
          fee,
          currency: cur,
          explanation: `USD ${num(v.usd.fixedFeeUsd)} at ${num(v.usd.usdExchangeRate)} ${cur}/USD.`,
          breakdown: [['Fixed Fee (USD)', `USD ${num(v.usd.fixedFeeUsd)}`], ['Exchange Rate', `${num(v.usd.usdExchangeRate)} ${cur}/USD`], [`${cur} Equivalent`, m(v.usd.localEquivalent)], ['Transaction Amount', m(a)], ['Fee', m(fee)]],
        };
      }
      const fee = r(v.fixedFee ?? 0);
      return { fee, currency: cur, explanation: 'A fixed fee per transaction.', breakdown: [['Fixed Fee', m(v.fixedFee ?? 0)], ['Transaction Amount', m(a)], ['Fee', m(fee)]] };
    }
    case 'higher_of': {
      const p = r((a * (v.mdrPct ?? 0)) / 100);
      const min = v.minimumFee ?? 0;
      const winner = p >= min ? 'percentage' : 'minimum';
      const fee = r(Math.max(p, min));
      return { fee, currency: cur, explanation: `The higher of ${pct(v.mdrPct)} or the minimum fee.`, breakdown: [['Transaction Amount', m(a)], ['MDR Rate', pct(v.mdrPct)], ['Percentage Fee', m(p)], ['Minimum Fee', m(min)], ['Winner', winner]] };
    }
    case 'volume_based': {
      const vol = input.periodVolume ?? 0;
      const tier = (v.tiers ?? []).find((t) => t.minVolume <= vol && (t.maxVolume === null || vol < t.maxVolume));
      if (!tier) return { fee: 0, currency: cur, explanation: 'No matching tier found for the given volume.', breakdown: [['Monthly Volume', m(vol)], ['Fee', m(0)]], warning: 'No matching tier found for the given volume.' };
      const p = r((a * tier.mdrPct) / 100);
      const fee = r(p + tier.fixedFee);
      const rows: [string, string][] = [['Monthly Volume', m(vol)], ['Applicable Tier', `${num(tier.minVolume)} – ${tier.maxVolume === null ? 'No limit' : num(tier.maxVolume)}`], ['Tier MDR', pct(tier.mdrPct)], ['Transaction Amount', m(a)], ['Percentage Fee', m(p)]];
      if (tier.fixedFee > 0) rows.push(['Fixed Fee', m(tier.fixedFee)]);
      rows.push(['Total Fee', m(fee)]);
      return { fee, currency: cur, explanation: `Month-to-date volume falls in the ${num(tier.minVolume)} – ${tier.maxVolume === null ? 'No limit' : num(tier.maxVolume)} tier.`, breakdown: rows };
    }
    case 'historical_volume': {
      const h = v.historical!;
      const prev = input.previousPeriodVolume;
      const met = prev === null || prev === undefined ? false : h.thresholdDirection === '>=' ? prev >= h.volumeThreshold : prev < h.volumeThreshold;
      const applied = met ? h.resultingMdr : h.defaultMdr;
      const fee = r((a * applied) / 100);
      return {
        fee,
        currency: cur,
        explanation: prev === null || prev === undefined ? 'No previous-period data, so the default MDR applies.' : met ? 'The threshold was met, so the resulting MDR applies.' : 'The threshold was not met, so the default MDR applies.',
        breakdown: [
          ['Previous Period Volume', prev === null || prev === undefined ? 'No data' : m(prev)],
          ['Threshold', `${h.thresholdDirection} ${m(h.volumeThreshold)}`],
          ['Threshold Met', met ? 'Yes' : 'No'],
          ['Applied MDR', pct(applied)],
          ['Transaction Amount', m(a)],
          ['Fee', m(fee)],
        ],
      };
    }
  }
}

// ------------------------------------------------------------------ products and modes

export interface ProductSetting {
  methodCode: string;
  flow: ProductFlow;
  enabled: boolean;
}

export interface ProductConfig {
  applicationId: string;
  products: ProductSetting[];
  /** Settlement cycle per PayIn product. */
  settlement: Record<string, SettlementCycle>;
  /** Increases on every save; saves must quote the revision they were based on. */
  revision: number;
  savedAt: number | null;
  savedBy: string | null;
}

/**
 * §2.2, derived on every request: onboarding = Product & Payment Config stage and not suspended;
 * change = onboarding confirmed and not suspended; read only otherwise.
 */
export type PricingMode = 'onboarding' | 'change' | 'read_only';

/** Stage of the application for Product & Payment Config screens: before setup, during onboarding, or after it's confirmed. */
export type ProductPhase = 'proposal' | 'onboarding' | 'post_handoff';

export function productPhase(status: ApplicationStatus): ProductPhase {
  if (status === 'cs_configuration') return 'onboarding';
  if (CONFIRMED_STATUSES.includes(status)) return 'post_handoff';
  return 'proposal';
}

export const CONFIRMED_STATUSES: ApplicationStatus[] = ['keys_generated', 'integration', 'go_live_verification', 'operational'];

export function pricingMode(status: ApplicationStatus, suspended: boolean): PricingMode {
  if (suspended) return 'read_only';
  if (status === 'cs_configuration') return 'onboarding';
  if (CONFIRMED_STATUSES.includes(status)) return 'change';
  return 'read_only';
}

export interface ProductGap {
  issue: 'no_products' | 'pricing' | 'settlement';
  /** Products concerned (empty for no_products). */
  methodCodes: string[];
  message: string;
}

/** §8.8: what still stops "Confirm onboarding", with the document's messages. */
export function productGaps(config: ProductConfig, versions: PricingVersion[], methods: ProductMethod[], today: string): ProductGap[] {
  const enabled = config.products.filter((p) => p.enabled);
  if (!enabled.length) return [{ issue: 'no_products', methodCodes: [], message: 'Switch on at least one product before confirming.' }];
  const name = (c: string) => methods.find((m) => m.code === c)?.name ?? c;
  const unpriced = enabled.filter((p) => !pricingInEffect(versions, p.methodCode, today, p.flow)).map((p) => p.methodCode);
  const noCycle = enabled.filter((p) => p.flow === 'payin' && !config.settlement[p.methodCode]).map((p) => p.methodCode);
  const gaps: ProductGap[] = [];
  if (unpriced.length) gaps.push({ issue: 'pricing', methodCodes: unpriced, message: `Set pricing for every product before confirming: ${unpriced.map(name).join(', ')}.` });
  if (noCycle.length) gaps.push({ issue: 'settlement', methodCodes: noCycle, message: `Set a settlement cycle for every PayIn product before confirming: ${noCycle.map(name).join(', ')}.` });
  return gaps;
}

/** Stage 4 badge: products not priced + PayIn products without a cycle, or 1 if no products are on. */
export const gapCount = (gaps: ProductGap[]) => gaps.reduce((n, g) => n + (g.issue === 'no_products' ? 1 : g.methodCodes.length), 0);

// ------------------------------------------------------------------ API shapes

export interface PricingAuditEvent {
  id: string;
  at: number;
  user: string;
  /** "Ops", "CS", "Finance". */
  role: string;
  applicationId: string;
  merchantId: string;
  merchantName: string;
  country: string;
  methodCode: string;
  methodName: string;
  /** Sub-merchant name; null = merchant level. */
  subMerchantName?: string | null;
  flow: ProductFlow;
  versionId: string;
  version: number;
  previous: string;
  next: string;
  effective: string;
  status: PricingStatus;
  reason: string | null;
}

export interface ProductPricingView {
  applicationId: string;
  merchantId: string;
  merchantName: string;
  /** Live MID, once issued at go-live. */
  mid: string | null;
  country: string;
  countryName: string;
  currency: string;
  status: ApplicationStatus;
  mode: PricingMode;
  suspended: boolean;
  /** §8.1 stage notice for the mode and acting team. */
  notice: string;
  /** True until products are saved for the first time. */
  inferred: boolean;
  methods: ProductMethod[];
  config: ProductConfig;
  versions: PricingVersion[];
  /** Sub-merchants of the merchant in this corridor (not rejected), for sub-merchant pricing. */
  subMerchants: { id: string; name: string }[];
  gaps: ProductGap[];
  gapCount: number;
  can: { editProducts: boolean; editPricing: boolean; decidePricing: boolean };
  /** Why the acting team can't change products / pricing, if it can't. */
  productsMessage: string | null;
  pricingMessage: string | null;
  /** USD/local rate used for USD fixed fees (prototype static rate). */
  usdRate: number;
  /** Calendar date the statuses were worked out for. */
  today: string;
  now: number;
}

export interface SaveProductsRequest {
  products: { methodCode: string; enabled: boolean }[];
  settlement: Record<string, string>;
  revision: number;
  /** The user confirmed that switching products off cancels their pricing. */
  confirmCancelPricing?: boolean;
}

export interface SetPricingRequest {
  draft: PricingDraft;
  /** Editing: the active or scheduled version this replaces (technique and scope stay the same). */
  editOf?: string | null;
}

export interface PricingDecisionRequest {
  decision: 'approve' | 'reject';
  reason?: string;
  /** Current code from the approver's authenticator (re-authentication). */
  code: string;
}

/** An item in the FinOps Pricing Approvals queue (§8.7). */
export interface PricingApprovalItem {
  version: PricingVersion;
  applicationId: string;
  merchantId: string;
  merchantName: string;
  mid: string | null;
  country: string;
  countryName: string;
  methodName: string;
  subMerchantName: string | null;
  /** Summary of the pricing in effect now (null: none). */
  current: string | null;
  proposed: string;
  /** True when the signed-in user submitted it (they can't approve it). */
  ownSubmission: boolean;
}

/** §7.8: every pricing change submitted by Ops (all statuses, for the filter chips). */
export interface PricingApprovalsView {
  items: PricingApprovalItem[];
  canDecide: boolean;
}

/** Sort order of the approvals list (§7.8). */
export const APPROVAL_STATUS_ORDER: PricingStatus[] = ['pending_approval', 'active', 'scheduled', 'cancelled', 'rejected', 'expired'];

// ------------------------------------------------------------------ Merchant Pricing (§7)

export const CORRIDORS = ['MY', 'ID', 'VN'] as const;

/** One row of the Merchant Pricing list (§7.1): a merchant's MID in the corridor. */
export interface MerchantPricingRow {
  applicationId: string;
  merchantId: string;
  merchantName: string;
  /** Master MID; null until issued at go-live. */
  mid: string | null;
  country: string;
  subMerchantCount: number;
  /** The merchant's status in the app: onboarding, active, no_active_applications, or suspended. */
  status: 'onboarding' | 'active' | 'no_active_applications' | 'suspended';
  updatedAt: number;
  activeRules: number;
  totalRules: number;
  /** MDR range of active rules, e.g. "0.7%–2.2%"; null when none uses an MDR. */
  mdr: string | null;
  flows: ProductFlow[];
  pendingCount: number;
}

export interface MerchantPricingList {
  rows: MerchantPricingRow[];
  activeRules: number;
  pendingApprovals: number;
  canConfigure: boolean;
}

/** One row of the Sub-Merchant View (§7.3): resolved pricing for a sub-merchant and payment method. */
export interface SubMerchantPricingRow {
  applicationId: string;
  merchantId: string;
  merchantName: string;
  mid: string | null;
  subMerchantId: string;
  subMerchantName: string;
  methodCode: string | null;
  methodName: string | null;
  /** Where the pricing comes from; null = no pricing. */
  level: 'sub_merchant' | 'merchant' | null;
  technique: string | null;
  pricing: string | null;
  currency: string | null;
  startDate: string | null;
  endDate: string | null;
  status: PricingStatus | null;
}

/** One row of MDR History (§7.11). */
export interface MdrHistoryRow {
  version: PricingVersion;
  applicationId: string;
  merchantId: string;
  merchantName: string;
  subMerchantName: string | null;
  methodName: string;
}

/** "MDR: 1.5% + Fixed: 0.5", "Resulting: 1% | Default: 2% | Prev Month GMV >= 10,000,000"… (§7.11 Pricing Details). */
export function pricingDetails(v: PricingVersion): string {
  switch (v.technique) {
    case null:
      return 'No primary pricing';
    case 'fixed_fee':
      return v.usd ? `Fixed: USD ${num(v.usd.fixedFeeUsd)} (Rate ${num(v.usd.usdExchangeRate)} → ${v.usd.localEquivalentCurrency} ${num(v.usd.localEquivalent)})` : `Fixed: ${v.currency} ${num(v.fixedFee ?? 0)}`;
    case 'historical_volume': {
      const h = v.historical!;
      return `Resulting: ${pct(h.resultingMdr)} | Default: ${pct(h.defaultMdr)} | ${REFERENCE_PERIOD_SHORT[h.referencePeriod]} ${METRIC_SHORT[h.evaluationMetric]} ${h.thresholdDirection} ${num(h.volumeThreshold)}`;
    }
    case 'volume_based':
      return (v.tiers ?? []).map((t) => `${num(t.minVolume)}-${t.maxVolume === null ? '∞' : num(t.maxVolume)}: ${pct(t.mdrPct)}`).join(' | ');
    case 'higher_of':
      return `Percentage: ${pct(v.mdrPct)} + Min: ${v.currency} ${num(v.minimumFee ?? 0)}`;
    case 'variable_plus_fixed':
      return `MDR: ${pct(v.mdrPct)} + Fixed: ${v.currency} ${num(v.fixedFee ?? 0)}`;
    default:
      return `MDR: ${pct(v.mdrPct)}${v.minimumFee ? ` · Min: ${v.currency} ${num(v.minimumFee)}` : ''}`;
  }
}
