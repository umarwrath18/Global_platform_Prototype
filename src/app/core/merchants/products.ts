import { ApplicationStatus, CountryApplication } from './merchant-models';
import { CountryOnboardingConfig } from './onboarding-config';

// Product & Payment Config: products, settlement and pricing for one country application (the MID
// it becomes). Shared by the portal and the simulated backend.
//
// - PayIn products are the country's configured payment methods. No PayOut methods have been
//   approved for any country, so PayOut is always empty and disabled.
// - Settlement is a product setting. Saving it never creates or changes a pricing version.
// - Pricing is an MDR percentage only, in versions with an effective date.

export const SETTLEMENT_CYCLES = ['T+0', 'T+1', 'T+2', 'T+3', 'T+4', 'T+5'] as const;
export type SettlementCycle = (typeof SETTLEMENT_CYCLES)[number];

export type ProductFlow = 'payin' | 'payout';
export const FLOW_LABEL: Record<ProductFlow, string> = { payin: 'PayIn', payout: 'PayOut' };

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

/** Stored state of a pricing version. Scheduled, active and superseded are worked out from dates. */
export type PricingState = 'pending_approval' | 'approved' | 'rejected' | 'cancelled';
export type PricingStatus = 'pending_approval' | 'scheduled' | 'active' | 'superseded' | 'rejected' | 'cancelled';

export const PRICING_STATUS_LABEL: Record<PricingStatus, string> = {
  pending_approval: 'Pending approval',
  scheduled: 'Scheduled',
  active: 'Active',
  superseded: 'Superseded',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export interface PricingVersion {
  id: string;
  applicationId: string;
  methodCode: string;
  flow: ProductFlow;
  /** Merchant discount rate, percent. */
  mdrPct: number;
  effectiveFrom: number;
  state: PricingState;
  /** Settlement cycle in effect when this version was created. History only; never changed later. */
  settlementCycleAtCreation: SettlementCycle | null;
  /** `legacy_application`: the Risk-approved MDR from the country application. */
  source: 'onboarding' | 'post_onboarding' | 'legacy_application';
  createdBy: string;
  createdRole: string;
  createdAt: number;
  decidedBy: string | null;
  decidedRole: string | null;
  decidedAt: number | null;
  decisionComment: string | null;
  cancelledBy: string | null;
  cancelledAt: number | null;
  cancelReason: string | null;
}

export interface PricingVersionView extends PricingVersion {
  status: PricingStatus;
  /** When a later version took over (superseded), or null. */
  effectiveTo: number | null;
}

/**
 * Who works on products at each stage. `onboarding`: CS, changes apply when saved. `post_handoff`:
 * after "Issue production keys"; Sales / Operations change products and settlement, and pricing
 * changes need FinOps approval. `proposal`: before setup starts; read only.
 */
export type ProductPhase = 'proposal' | 'onboarding' | 'post_handoff';

export function productPhase(status: ApplicationStatus): ProductPhase {
  if (status === 'cs_configuration') return 'onboarding';
  if (status === 'keys_generated' || status === 'integration' || status === 'go_live_verification' || status === 'operational') return 'post_handoff';
  return 'proposal';
}

export interface ProductMethod {
  code: string;
  name: string;
  flow: ProductFlow;
  minMdr: number;
  maxMdr: number;
}

/** PayIn products from the country's configured payment methods. There are no approved PayOut methods. */
export function countryProducts(cfg: CountryOnboardingConfig): ProductMethod[] {
  return cfg.paymentMethods.map((m) => ({ code: m.code, name: m.name, flow: 'payin', minMdr: m.minMdr, maxMdr: m.maxMdr }));
}

export function pricingStatus(v: PricingVersion, all: PricingVersion[], now: number): PricingStatus {
  if (v.state !== 'approved') return v.state;
  if (v.effectiveFrom > now) return 'scheduled';
  return supersededBy(v, all, now) ? 'superseded' : 'active';
}

/** The approved version, already in effect, that replaced this one (latest effective date wins; ties: the newer). */
function supersededBy(v: PricingVersion, all: PricingVersion[], now: number): PricingVersion | undefined {
  return all
    .filter((o) => o.id !== v.id && o.methodCode === v.methodCode && o.state === 'approved' && o.effectiveFrom <= now)
    .filter((o) => o.effectiveFrom > v.effectiveFrom || (o.effectiveFrom === v.effectiveFrom && o.createdAt > v.createdAt))
    .sort((a, b) => a.effectiveFrom - b.effectiveFrom || a.createdAt - b.createdAt)[0];
}

export function pricingViews(all: PricingVersion[], now: number): PricingVersionView[] {
  return all.map((v) => {
    const status = pricingStatus(v, all, now);
    return { ...v, status, effectiveTo: status === 'superseded' ? (supersededBy(v, all, now)?.effectiveFrom ?? null) : null };
  });
}

export function activePricing(all: PricingVersion[], methodCode: string, now: number): PricingVersion | undefined {
  return all.find((v) => v.methodCode === methodCode && pricingStatus(v, all, now) === 'active');
}

export interface ProductGap {
  methodCode: string | null;
  name: string;
  issue: 'no_products' | 'pricing' | 'settlement';
  message: string;
}

/**
 * What still stops onboarding being confirmed: no product switched on, a switched-on product
 * without pricing in effect, or a switched-on PayIn product without a settlement cycle.
 */
export function productGaps(config: ProductConfig, versions: PricingVersion[], methods: ProductMethod[], now: number): ProductGap[] {
  const enabled = config.products.filter((p) => p.enabled);
  if (!enabled.length) return [{ methodCode: null, name: 'Products', issue: 'no_products', message: 'Switch on at least one product.' }];
  const gaps: ProductGap[] = [];
  for (const p of enabled) {
    const name = methods.find((m) => m.code === p.methodCode)?.name ?? p.methodCode;
    if (!activePricing(versions, p.methodCode, now)) gaps.push({ methodCode: p.methodCode, name, issue: 'pricing', message: `${name}: set pricing.` });
    if (p.flow === 'payin' && !config.settlement[p.methodCode]) gaps.push({ methodCode: p.methodCode, name, issue: 'settlement', message: `${name}: choose a settlement cycle.` });
  }
  return gaps;
}

/** The Risk approval of an application, if its history records one (time and approver). */
export function riskApproval(app: Pick<CountryApplication, 'history'>) {
  const e = [...app.history].reverse().find((h) => h.toStatus === 'risk_approved' && h.at && h.by);
  return e ? { at: e.at, by: e.by } : null;
}

/** Day the version takes effect, from a YYYY-MM-DD date: today or earlier means now. */
export function effectiveFromDate(date: string | undefined | null, now: number): number | null {
  if (!date) return now;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  return at <= now ? now : at;
}

export function todayIso(now: number) {
  return new Date(now).toISOString().slice(0, 10);
}

export interface ProductPricingView {
  applicationId: string;
  country: string;
  countryName: string;
  status: ApplicationStatus;
  phase: ProductPhase;
  /** True until products are saved for the first time (shown from the application's pricing). */
  inferred: boolean;
  methods: ProductMethod[];
  config: ProductConfig;
  versions: PricingVersionView[];
  gaps: ProductGap[];
  can: { editProducts: boolean; editPricing: boolean; decidePricing: boolean };
  /** Why the current team can't make changes, if it can't. */
  readOnlyReason: string | null;
  /** Server time the statuses were worked out at. */
  now: number;
}

export interface SaveProductsRequest {
  products: { methodCode: string; enabled: boolean }[];
  settlement: Record<string, string>;
  revision: number;
  /** During onboarding: the user confirmed that switching products off cancels their pricing. */
  confirmCancelPricing?: boolean;
}

export interface SetPricingRequest {
  methodCode: string;
  mdrPct: number;
  /** YYYY-MM-DD; today when omitted. */
  effectiveDate?: string;
}
