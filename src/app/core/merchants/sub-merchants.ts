import { ChecklistItem, RegionalMidView, StaffRole } from './merchant-models';

// Sub-merchants: lightweight child records under a parent merchant (same GMID). They don't repeat
// the parent's registration or integration: no documents, directors, bank details, MCC or keys of
// their own. Each one has exactly one parent, can be a separate legal entity (legal name and
// registration number) or trade under the parent, gets a lightweight Risk review, and goes live
// in one country (CS) with its own live MID once the parent is live there and neither is
// suspended. Products, pricing and settlement are the parent's for that country.

export type SubMerchantStatus = 'draft' | 'pending_risk_review' | 'approved' | 'rejected' | 'live';

export const SUB_MERCHANT_STATUS_LABEL: Record<SubMerchantStatus, string> = {
  draft: 'Draft',
  pending_risk_review: 'Pending Risk review',
  approved: 'Approved by Risk',
  rejected: 'Rejected',
  live: 'Live',
};

/** Checks CS completes before a sub-merchant goes live (the parent's integration is reused). */
export const SUB_MERCHANT_CHECKS: { key: string; label: string }[] = [
  { key: 'live_transaction', label: 'Live low-value test transaction succeeded' },
  { key: 'merchant_signoff', label: 'Merchant go-live sign-off received' },
];

export interface SubMerchantEvent {
  at: number;
  action: string;
  by: string;
  role: StaffRole | 'system';
  comment: string | null;
}

export interface SubMerchantView {
  id: string;
  displayName: string;
  /** Set only on sub-merchants registered before the current form; null: trades under the parent. */
  legalEntity: { legalName: string; registrationNumber: string } | null;
  /** Null on sub-merchants registered before these fields were collected. */
  email: string | null;
  website: string | null;
  tradingLicenseUrl: string | null;
  /** Country of jurisdiction: one where the parent has applied; it goes live there. */
  country: string;
  status: SubMerchantStatus;
  createdVia: 'ops' | 'parent';
  createdBy: string;
  createdAt: number;
  lifecycleStatus: 'active' | 'suspended';
  lifecycleReason: string | null;
  goLiveChecks: ChecklistItem[];
  history: SubMerchantEvent[];
  mid: RegionalMidView | null;
  /** Why it can't go live right now (approved sub-merchants only), or null. */
  goLiveBlocker: string | null;
  /** The parent's application in this country, whose products, pricing and settlement apply. */
  parentApplicationId: string | null;
  inherited: { products: { name: string; mdrPct: number | null; settlement: string | null }[] };
}

export interface CreateSubMerchantRequest {
  /** Country of jurisdiction. */
  country: string;
  /** Business name. */
  displayName: string;
  email: string;
  website: string;
  tradingLicenseUrl?: string | null;
  /** Send straight to Risk instead of saving a draft. */
  submit?: boolean;
  route?: 'ops' | 'parent';
}
