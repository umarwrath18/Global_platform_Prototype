// API contract for Merchant Management & Onboarding (Batch 2).
// The UI depends only on these shapes; the simulated backend can be replaced by Mobi's
// real merchant services without changing the screens.

/** Prototype-only: the internal team the signed-in user is acting as. */
export type StaffRole = 'sales' | 'risk' | 'cs';

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  sales: 'Sales / Operations',
  risk: 'Risk',
  cs: 'Customer Success',
};

// ------------------------------------------------------------------ Global Merchant

/** Derived from the merchant's country applications, never set by hand. */
export type GlobalMerchantStatus = 'onboarding' | 'active' | 'no_active_applications';

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
  /** Batch 1 Global Account used for portal login; created on the first country go-live. */
  linkedAccountId: string | null;
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
  cs_configuration: 'CS configuration',
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

export interface ApplicationData {
  business: {
    tradingName: string;
    businessType: string;
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
  country: string;
  currency: string;
  status: ApplicationStatus;
  data: ApplicationData;
  prefill: PrefillSource[];
  /** Global profile values as they were when the application was last submitted. */
  submittedProfile: Pick<GlobalMerchant, 'legalName' | 'registrationCountry' | 'registrationNumber'> | null;
  corrections: Corrections | null;
  verification: VerificationEvidence | null;
  readiness: Readiness;
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
}

export interface MerchantSummary extends GlobalMerchant {
  applications: ApplicationSummary[];
  lastUpdatedAt: number;
}

export interface MerchantDetail {
  merchant: GlobalMerchant;
  applications: CountryApplication[];
}

export interface ApplicationDetail {
  application: CountryApplication;
  merchant: GlobalMerchant;
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
  | 'go_live';

export interface PortalNotification {
  id: string;
  at: number;
  event: NotificationEvent;
  title: string;
  body: string;
  applicationId: string;
  merchantId: string;
  audience: StaffRole[];
  /** Target behaviour: an automatic email. Not sent; recorded as simulated. */
  email: { to: string[]; subject: string; status: 'simulated' };
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
