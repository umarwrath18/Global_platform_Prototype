// Merchant and sub-merchant suspension (fraud, compliance, commercial). Shared by the Global
// Platform, the Merchant Portal and the simulated backend; the server re-checks every rule.
// Decisions: docs/merchant-suspension.md.

export type SuspensionType = 'suspected_fraud' | 'confirmed_fraud' | 'compliance' | 'commercial' | 'merchant_request';
export const SUSPENSION_TYPES: SuspensionType[] = ['suspected_fraud', 'confirmed_fraud', 'compliance', 'commercial', 'merchant_request'];
export const SUSPENSION_TYPE_LABEL: Record<SuspensionType, string> = {
  suspected_fraud: 'Suspected fraud',
  confirmed_fraud: 'Confirmed fraud',
  compliance: 'Compliance / KYC',
  commercial: 'Commercial (e.g. unpaid fees)',
  merchant_request: 'Merchant request',
};

/** Fraud types: Risk only, need a second Risk review within 24 hours and a second Risk approval to reactivate. */
export const isFraudType = (t: SuspensionType) => t === 'suspected_fraud' || t === 'confirmed_fraud';
/** Types Sales / Operations may raise; Risk may raise any type. */
export const SALES_SUSPENSION_TYPES: SuspensionType[] = ['commercial', 'merchant_request'];
/** Types that need a case reference. */
export const needsCaseRef = (t: SuspensionType) => isFraudType(t) || t === 'compliance';
/** Merchant Portal is read only (no exports) under these types. */
export const portalReadOnly = (t: SuspensionType) => isFraudType(t) || t === 'compliance';

export type SuspensionScope = 'merchant' | 'country' | 'sub_merchant';
export const SUSPENSION_SCOPE_LABEL: Record<SuspensionScope, string> = { merchant: 'Whole merchant', country: 'One country', sub_merchant: 'One sub-merchant' };

export interface PaymentControls {
  payins: boolean;
  payouts: boolean;
  settlement: boolean;
  refunds: boolean;
}
export const CONTROL_KEYS: (keyof PaymentControls)[] = ['payins', 'payouts', 'settlement', 'refunds'];
export const CONTROL_LABEL: Record<keyof PaymentControls, string> = { payins: 'Block new pay-ins', payouts: 'Block payouts', settlement: 'Hold settlement', refunds: 'Block refunds' };
export const CONTROL_HINT: Record<keyof PaymentControls, string> = {
  payins: 'New pay-ins fail with "Merchant suspended". Pay-ins already in progress finish.',
  payouts: 'No new payouts. Payouts already sent to the provider finish.',
  settlement: 'Funds stay with Mobi until FinOps releases them.',
  refunds: 'No refunds while suspended.',
};
/** Chips on the merchant page while a control is on. */
export const CONTROL_CHIP: Record<keyof PaymentControls, string> = { payins: 'New pay-ins blocked', payouts: 'Payouts blocked', settlement: 'Settlement on hold', refunds: 'Refunds blocked' };

/** Defaults per type (Risk can change any switch). */
export const DEFAULT_CONTROLS: Record<SuspensionType, PaymentControls> = {
  suspected_fraud: { payins: true, payouts: true, settlement: true, refunds: true },
  confirmed_fraud: { payins: true, payouts: true, settlement: true, refunds: true },
  compliance: { payins: true, payouts: true, settlement: false, refunds: false },
  merchant_request: { payins: true, payouts: true, settlement: false, refunds: false },
  commercial: { payins: false, payouts: false, settlement: false, refunds: false },
};

export const DETECTED_BY = ['Transaction monitoring', 'Chargeback ratio', 'Scheme / bank alert', 'Law enforcement request', 'Internal review', 'Merchant request'] as const;
export const REACTIVATION_OUTCOMES = ['No fraud found', 'Resolved with the merchant', 'Suspended in error'] as const;

/** The neutral message merchants see (never mentions fraud or suspension). */
export const MERCHANT_REVIEW_TITLE = 'Your account is under review';
export const MERCHANT_REVIEW_MESSAGE = 'Some services are paused while we complete a routine review. Contact support@mobi.xyz if you have questions.';

/** Second Risk review window for fraud suspensions. */
export const REVIEW_WINDOW_MS = 24 * 60 * 60_000;

export type SettlementHoldStatus = 'not_held' | 'held' | 'release_pending' | 'released';

export interface Suspension {
  id: string;
  gmid: string;
  scope: SuspensionScope;
  /** Country scope: the country; sub-merchant scope: the sub-merchant's country. */
  country: string | null;
  subMerchantId: string | null;
  type: SuspensionType;
  controls: PaymentControls;
  caseRef: string;
  detectedBy: string;
  reason: string;
  linkedTransactions: string[];
  status: 'active' | 'lifted';
  createdBy: string;
  createdById: string;
  createdRole: string;
  createdAt: number;
  /** Fraud only: a second Risk person confirms or lifts within 24 hours. */
  review: { required: boolean; status: 'pending' | 'confirmed' | 'lifted' | 'not_required'; dueAt: number | null; by: string | null; byId: string | null; at: number | null; note: string | null };
  /** Fraud: a second Risk person approves the reactivation; other types reactivate at once. */
  reactivation: {
    status: 'pending' | 'approved' | 'rejected';
    requestedBy: string;
    requestedById: string;
    requestedAt: number;
    outcome: string;
    reason: string;
    releaseSettlement: boolean;
    decidedBy: string | null;
    decidedAt: number | null;
    note: string | null;
  } | null;
  /** Held settlement is released only by FinOps. */
  settlement: { status: SettlementHoldStatus; requestedBy: string | null; requestedAt: number | null; decidedBy: string | null; decidedAt: number | null; note: string | null };
  liftedAt: number | null;
  liftedBy: string | null;
  /** Prototype upgrade: created through the earlier simple Suspend / Reactivate. */
  legacy?: boolean;
}

/** A suspension as the merchant page shows it. */
export interface SuspensionView extends Suspension {
  merchantName: string;
  countryName: string | null;
  subMerchantName: string | null;
  /** MIDs and sub-merchants it covers, e.g. "3 MIDs and 2 sub-merchants". */
  coverage: string;
}

/** What a country MID or sub-merchant is under right now. */
export interface SuspensionEffect {
  suspended: boolean;
  /** Why: the merchant, its country, or its own suspension. */
  via: SuspensionScope | null;
  suspensionId: string | null;
  type: SuspensionType | null;
  controls: PaymentControls;
}

export const NO_CONTROLS: PaymentControls = { payins: false, payouts: false, settlement: false, refunds: false };

/** "Suspended – With the merchant" etc. */
export const VIA_LABEL: Record<SuspensionScope, string> = { merchant: 'With the merchant', country: 'With the country', sub_merchant: 'Own suspension' };
