// API contract for Merchant Management & Onboarding (Batch 2).
// The UI depends only on these shapes; the simulated backend can be replaced by Mobi's
// real merchant services without changing the screens.

import type { MccAuditEvent, MccChangeRequest, MccRef, MerchantMcc } from './mcc';
import type { CountryOnboardingConfig } from './onboarding-config';
import type { ProductGap } from './products';
import type { ChangeRequest, ProfileEvent } from './change-requests';
import type { SubMerchantView } from './sub-merchants';

/** Prototype-only: the internal team the signed-in user is acting as. */
export type StaffRole = 'sales' | 'risk' | 'cs' | 'finops';

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  sales: 'Sales / Operations',
  risk: 'Risk',
  cs: 'Customer Success',
  /** Prototype only: approves or rejects pricing changes after onboarding, nothing else. */
  finops: 'FinOps',
};

// ------------------------------------------------------------------ Global Merchant

/** Derived from the merchant's country applications, never set by hand. */
export type GlobalMerchantStatus = 'onboarding' | 'active' | 'no_active_applications';

export type MerchantLifecycleStatus = 'active' | 'suspended';
export interface MerchantLifecycleEvent { at: number; action: 'suspended' | 'reactivated'; by: string; role: StaffRole; reason: string; fromStatus: MerchantLifecycleStatus; toStatus: MerchantLifecycleStatus; merchantId?: string; }

export interface PrimaryContact {
  name: string;
  email: string;
  phone: string;
}

export interface GlobalMerchant {
  id: string;
  legalName: string;
  registrationCountry: string;
  registrationNumber: string;
  primaryContact: PrimaryContact;
  globalStatus: GlobalMerchantStatus;
  lifecycleStatus: MerchantLifecycleStatus;
  lifecycleReason?: string | null;
  lifecycleUpdatedAt?: number | null;
  lifecycleUpdatedBy?: string | null;
  /** Batch 1 Global Account used for portal login; created on the first country go-live. */
  linkedAccountId: string | null;
  /** Merchant category code of the parent merchant (sub-merchants use this one). Absent: not captured. */
  mcc?: MerchantMcc | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  demo: boolean;
}

export interface CreateMerchantRequest {
  legalName: string;
  registrationCountry: string;
  registrationNumber: string;
  primaryContact: PrimaryContact;
  /** Set after the user has seen a possible name match and confirmed it is a different organisation. */
  confirmNotDuplicate?: boolean;
}

export type UpdateMerchantRequest = Partial<CreateMerchantRequest>;

// -------------------------------------------------------------- Country Application

export type ApplicationStatus =
  | 'draft'
  | 'pending_risk_review'
  | 'returned'
  | 'rejected'
  | 'risk_approved'
  | 'cs_configuration'
  | 'keys_generated'
  | 'integration'
  | 'go_live_verification'
  | 'operational';

export const REVIEW_STATUSES: ApplicationStatus[] = ['draft', 'pending_risk_review', 'returned', 'rejected'];
export const READINESS_STATUSES: ApplicationStatus[] = [
  'risk_approved',
  'cs_configuration',
  'keys_generated',
  'integration',
  'go_live_verification',
  'operational',
];

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  draft: 'Draft',
  pending_risk_review: 'Pending Risk review',
  returned: 'Returned for correction',
  rejected: 'Rejected',
  risk_approved: 'Risk approved',
  cs_configuration: 'Product & Payment Config',
  keys_generated: 'Production keys generated',
  integration: 'Merchant integration',
  go_live_verification: 'Go-live verification',
  operational: 'Operational',
};

export const GLOBAL_STATUS_LABEL: Record<GlobalMerchantStatus, string> = {
  onboarding: 'Onboarding',
  active: 'Active',
  no_active_applications: 'No active applications',
};

export type SectionKey = 'business' | 'contact' | 'bank' | 'directors' | 'documents' | 'pricing';

export const SECTION_LABEL: Record<SectionKey | 'review', string> = {
  business: 'Business information',
  contact: 'Contact information',
  bank: 'Bank details',
  directors: 'Directors & beneficial owners',
  documents: 'Documents',
  pricing: 'Payment methods & pricing',
  review: 'Review & submit',
};

export interface Director {
  id: string;
  name: string;
  nationality: string;
  idNumber: string;
  role: 'director' | 'beneficial_owner' | 'director_and_owner';
  ownershipPct: number | null;
}

export interface DocumentRecord {
  id: string;
  type: string;
  fileName: string;
  sizeKb: number;
  uploadedAt: number;
  /** Sample record created by the prototype; no file content is stored. */
  sample: boolean;
}

export interface PricingLine {
  code: string;
  enabled: boolean;
  /** Merchant discount rate, percent. */
  mdr: number | null;
}

/** Mobi's internal merchant classification. Not the same as Industry or MCC. */
export type MerchantCategory = 'pgbe' | 'psp' | 'merchant';

export const MERCHANT_CATEGORY_LABEL: Record<MerchantCategory, string> = {
  pgbe: 'Payment Gateway & Business Entity (PGBE)',
  psp: 'Payment Service Provider',
  merchant: 'Merchant',
};

export const MERCHANT_CATEGORIES = Object.keys(MERCHANT_CATEGORY_LABEL) as MerchantCategory[];

/** The label for a stored category, or null when it is empty or not one of the categories. */
export const merchantCategoryLabel = (c: string | null | undefined): string | null => MERCHANT_CATEGORY_LABEL[c as MerchantCategory] ?? null;

export interface ApplicationData {
  business: {
    tradingName: string;
    businessType: string;
    /** Absent on applications saved before the category was collected. */
    merchantCategory?: MerchantCategory | '';
    industry: string;
    website: string;
    address: string;
    localRegistrationNumber: string;
    taxId: string;
    expectedMonthlyVolume: number | null;
  };
  contact: PrimaryContact & { supportEmail: string };
  bank: Record<string, string>;
  directors: Director[];
  documents: DocumentRecord[];
  pricing: PricingLine[];
}

/** Where a field value was copied from when the application was created. */
export type PrefillSource = { field: string; from: 'global_profile' | 'application'; applicationId?: string; country?: string };

export interface Corrections {
  reason: string;
  sections: SectionKey[];
}

export type VerificationResult = 'pass' | 'review' | 'fail';

export interface VerificationCheck {
  name: string;
  result: VerificationResult;
  detail: string;
}

/** Simulated evidence from a not-yet-selected verification provider. Never decides on its own. */
export interface VerificationEvidence {
  provider: string;
  simulated: true;
  ranAt: number;
  checks: VerificationCheck[];
}

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  doneAt: number | null;
  doneBy: string | null;
}

export type ReadinessStage = 'configuration' | 'integration' | 'go_live';

export interface Readiness {
  configuration: ChecklistItem[];
  integration: ChecklistItem[];
  go_live: ChecklistItem[];
  /** Sample key-set reference only; no credentials exist. */
  keySet: { reference: string; generatedAt: number; environment: 'production'; simulated: true } | null;
}

export interface HistoryEvent {
  at: number;
  action: string;
  by: string;
  role: StaffRole | 'system';
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus | null;
  comment?: string;
  sections?: SectionKey[];
}

export interface CountryApplication {
  id: string;
  merchantId: string;
  /** Internal merchant entity (ME) the application is for. Absent on older records: the merchant's parent entity. Never shown. */
  entityId?: string;
  country: string;
  /** Region for the live MID, stored when the application is created. Never derived from an MID string. */
  regionCode?: string;
  currency: string;
  status: ApplicationStatus;
  data: ApplicationData;
  prefill: PrefillSource[];
  /** Global profile values as they were when the application was last submitted. */
  submittedProfile: (Pick<GlobalMerchant, 'legalName' | 'registrationCountry' | 'registrationNumber'> & { mcc?: MccRef | null }) | null;
  corrections: Corrections | null;
  verification: VerificationEvidence | null;
  readiness: Readiness;
  /** Country rules in force at the last submission. Drafts and returned applications follow the live configuration. */
  rulesSnapshot?: CountryOnboardingConfig;
  previousApplicationId: string | null;
  submissionCount: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  history: HistoryEvent[];
  demo: boolean;
}

export interface ApplicationSummary {
  id: string;
  merchantId: string;
  merchantName: string;
  country: string;
  currency: string;
  status: ApplicationStatus;
  submissionCount: number;
  createdAt: number;
  updatedAt: number;
  /** Live MID issued for this application, if any. */
  liveMid: Pick<RegionalMidView, 'mid' | 'source'> | null;
}

export interface MerchantSummary extends GlobalMerchant {
  applications: ApplicationSummary[];
  lastUpdatedAt: number;
  /** Sub-merchants under this (parent) merchant. */
  subMerchantCount: number;
}

/** A live regional MID as staff see it. Region and country come from the record, never from the MID string. */
export interface RegionalMidView {
  mid: string;
  regionCode: string;
  country: string;
  environment: 'live';
  /** `migrated`: assigned by the data upgrade from recorded go-live evidence, not at go-live itself. */
  source: 'go_live' | 'migrated';
  issuedAt: number;
  /** For migrated MIDs: when the recorded go-live happened. */
  goLiveEvidenceAt: number | null;
  applicationId: string | null;
}

export interface MerchantDetail {
  merchant: GlobalMerchant;
  applications: CountryApplication[];
  lifecycleEvents: MerchantLifecycleEvent[];
  /** Live regional MIDs of the merchant's entities. */
  mids: RegionalMidView[];
  /** MCC audit history, latest first. */
  mccEvents: MccAuditEvent[];
  /** The pending MCC change request, if any. */
  mccRequest: MccChangeRequest | null;
  /** True once the merchant has been approved by Risk: MCC changes then need Risk approval. */
  mccChangeNeedsRisk: boolean;
  /** Pending change requests for the merchant and its countries. */
  pendingChanges: ChangeRequest[];
  /** Profile history (contact edits, identity edits and requests), latest first. */
  profileEvents: ProfileEvent[];
  /** Sub-merchants under this (parent) merchant. */
  subMerchants: SubMerchantView[];
}

export interface ApplicationDetail {
  application: CountryApplication;
  merchant: GlobalMerchant;
  /** The live MID issued when this application went live, if any. */
  mid: RegionalMidView | null;
  /** Set when the application is operational but no MID could be assigned safely. */
  midIssue: string | null;
  /** True once the merchant has been approved by Risk: MCC changes then need Risk approval. */
  mccChangeNeedsRisk: boolean;
  /** During Product & Payment Config: what still stops "Issue production keys". Null at other stages. */
  productGaps: ProductGap[] | null;
  /** Change requests for this country after Risk approval, latest first. */
  changes: ChangeRequest[];
}

export type ReviewDecision = 'approve' | 'return' | 'reject';

export interface ReviewRequest {
  decision: ReviewDecision;
  comment: string;
  sections?: SectionKey[];
  evidenceReviewed: boolean;
}

export type ReadinessAction =
  | { action: 'start_configuration' }
  | { action: 'set_item'; stage: ReadinessStage; key: string; done: boolean }
  | { action: 'generate_keys' }
  | { action: 'start_integration' }
  | { action: 'request_go_live' }
  | { action: 'confirm_go_live' };

// ------------------------------------------------------------------- notifications

export type NotificationEvent =
  | 'submitted'
  | 'resubmitted'
  | 'returned'
  | 'approved'
  | 'rejected'
  | 'configuration_ready'
  | 'go_live'
  | 'mcc_change_requested'
  | 'mcc_change_decided'
  | 'pricing_approval_requested'
  | 'pricing_decided'
  | 'change_requested'
  | 'change_decided'
  | 'sub_merchant_submitted'
  | 'sub_merchant_decided'
  | 'sub_merchant_live';

export interface PortalNotification {
  id: string;
  at: number;
  event: NotificationEvent;
  title: string;
  body: string;
  /** Empty for merchant-level notifications (MCC changes), which link to the merchant instead. */
  applicationId: string;
  merchantId: string;
  /** Country of the application (absent on records created before this field existed). */
  country?: string;
  audience: StaffRole[];
  /** Target behaviour: an automatic email. Not sent; recorded as simulated. Absent for in-app-only notifications. */
  email?: { to: string[]; subject: string; status: 'simulated' };
  readBy: StaffRole[];
}

export type MerchantApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'DUPLICATE_MERCHANT'
  | 'POSSIBLE_DUPLICATE'
  | 'APPLICATION_EXISTS'
  | 'COUNTRY_NOT_SUPPORTED'
  | 'ROLE_NOT_PERMITTED'
  | 'INVALID_TRANSITION'
  | 'APPLICATION_INCOMPLETE'
  | 'CHECKLIST_INCOMPLETE'
  | 'MERCHANT_SUSPENDED'
  | 'PERMISSION_REQUIRED'
  | 'CONFIG_CONFLICT'
  | 'MID_CONFLICT'
  | 'PARENT_NOT_OPERATIONAL'
  | 'MIGRATION_PENDING'
  | 'DATA_UNREADABLE'
  | 'DATA_VERSION_UNSUPPORTED'
  | 'MCC_NOT_AVAILABLE'
  | 'MCC_CHANGE_PENDING'
  | 'MCC_CHANGE_REQUIRED'
  | 'PRODUCT_CONFIG_INCOMPLETE'
  | 'PRICING_WILL_BE_CANCELLED'
  | 'PRODUCT_HAS_ACTIVE_PRICING'
  | 'PRICING_PENDING'
  | 'CHANGE_REQUEST_REQUIRED'
  | 'CHANGE_PENDING'
  | 'SUB_MERCHANT_ROUTE_NOT_ALLOWED'
  | 'NOT_FOUND';

export interface MerchantApiError {
  code: MerchantApiErrorCode;
  message?: string;
  existingMerchantId?: string;
  existingApplicationId?: string;
  errors?: FieldIssue[];
}

export interface FieldIssue {
  section: SectionKey;
  field: string;
  message: string;
}
