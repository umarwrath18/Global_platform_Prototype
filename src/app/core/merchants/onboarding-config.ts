import { COUNTRY_CATALOGUE } from '../mock-server/seed';
import { ReadinessStage } from './merchant-models';

// Per-country onboarding rules. NOTE: these values are illustrative and have NOT been
// approved by Mobi Risk, Legal or Product. They are the defaults for Country Configuration:
// at runtime `ONBOARDING_COUNTRIES` holds the live configuration (see applyCountryConfigs).
// Currency and the product catalog (Pricing Engine §3.3) are fixed here.

export interface FieldRule {
  key: string;
  label: string;
  required: boolean;
  /** Optional format check with a user-facing hint. */
  pattern?: string;
  hint?: string;
}

export interface DocumentRule {
  type: string;
  label: string;
  required: boolean;
  hint?: string;
}

/** A product in the country catalog (Pricing Engine §3.3). */
export interface PaymentMethodRule {
  code: string;
  name: string;
  flow: 'payin' | 'payout';
  /** Usual maximum MDR %: the pricing editor warns above it (hard limit 10%). */
  typicalMaxMdr: number;
}

export interface DirectorRules {
  required: boolean;
  minCount: number;
  note: string;
  /** Label of the ID / passport field, e.g. "NRIC / Passport No.". */
  idLabel: string;
}

export interface CountryOnboardingConfig {
  code: string;
  name: string;
  currency: string;
  /** Preset for phone numbers, e.g. +60. It can be changed per number. */
  dialCode: string;
  /** Company types. */
  businessTypes: string[];
  localRegistration: FieldRule;
  taxId: FieldRule;
  /** A second tax registration, where the country has one (Malaysia: SST). */
  secondaryTaxId?: FieldRule;
  bankFields: FieldRule[];
  directors: DirectorRules;
  documents: DocumentRule[];
  paymentMethods: PaymentMethodRule[];
  /** False pauses new country applications. Existing applications continue. Default: true. */
  onboardingEnabled?: boolean;
  /** Permitted ways to create sub-merchants in this country. Absent: see subMerchantRoutes(). */
  subMerchantCreation?: SubMerchantRoutes;
}

export interface SubMerchantRoutes {
  /** Sales / Operations create sub-merchants in the portal. */
  opsInitiated: boolean;
  /** The parent merchant creates them (needs a merchant-facing portal, which doesn't exist yet). */
  parentInitiated: boolean;
}

/** Routes in force for a country. Default: Ops-initiated only, because no merchant-facing portal exists. */
export function subMerchantRoutes(cfg: Pick<CountryOnboardingConfig, 'subMerchantCreation'> | undefined): SubMerchantRoutes {
  return { opsInitiated: cfg?.subMerchantCreation?.opsInitiated ?? true, parentInitiated: cfg?.subMerchantCreation?.parentInitiated ?? false };
}

const pm = (code: string, name: string, flow: PaymentMethodRule['flow'], typicalMaxMdr: number): PaymentMethodRule => ({ code, name, flow, typicalMaxMdr });
/** Bank Transfer payout, in every corridor. */
const PAYOUT = pm('bank_transfer_payout', 'Bank Transfer', 'payout', 5);

// Launched countries: registration is open here. See PLANNED_COUNTRIES for the roadmap.
export const ONBOARDING_COUNTRIES: Record<string, CountryOnboardingConfig> = {
  MY: {
    ...COUNTRY_CATALOGUE['MY'],
    dialCode: '+60',
    businessTypes: ['Sdn Bhd', 'Berhad', 'Sole proprietorship', 'Partnership', 'LLP'],
    localRegistration: { key: 'localRegistrationNumber', label: 'SSM Registration No.', required: true, pattern: '^\\d{12}$', hint: '12 digits, e.g. 201901012345' },
    taxId: { key: 'taxId', label: 'Tax Identification No. (TIN)', required: true, hint: 'Issued by LHDN' },
    secondaryTaxId: { key: 'secondaryTaxId', label: 'SST Registration No.', required: false, hint: 'Only if the business is SST-registered' },
    bankFields: [
      { key: 'bankName', label: 'Bank name', required: true },
      { key: 'accountName', label: 'Account holder name', required: true, hint: 'Must match the registered company name' },
      { key: 'accountNumber', label: 'Bank account number', required: true, pattern: '^\\d{10,16}$', hint: '10–16 digits' },
      { key: 'swiftCode', label: 'SWIFT / BIC', required: false, pattern: '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$', hint: '8 or 11 characters' },
    ],
    directors: { required: true, minCount: 1, note: 'Add every director of the company.', idLabel: 'NRIC / Passport No.' },
    documents: [
      { type: 'ssm_profile', label: 'SSM company profile (Section 14 / e-Info)', required: true },
      { type: 'director_id', label: 'Director NRIC / passport copies', required: true },
      { type: 'bank_statement', label: 'Bank statement (latest 3 months)', required: true },
      { type: 'sst_certificate', label: 'SST registration certificate', required: false },
    ],
    paymentMethods: [pm('fpx', 'FPX', 'payin', 1.8), pm('duitnow_qr', 'DuitNow QR', 'payin', 1.5), pm('tng', "Touch 'n Go", 'payin', 2.5), pm('grabpay', 'GrabPay', 'payin', 5), pm('cards', 'Cards', 'payin', 3.5), PAYOUT],
  },
  ID: {
    ...COUNTRY_CATALOGUE['ID'],
    dialCode: '+62',
    businessTypes: ['PT', 'PT PMA', 'CV', 'Sole proprietorship'],
    localRegistration: { key: 'localRegistrationNumber', label: 'NIB', required: true, pattern: '^\\d{13}$', hint: '13 digits' },
    taxId: { key: 'taxId', label: 'NPWP', required: true, pattern: '^\\d{15,16}$', hint: '15 or 16 digits, no punctuation' },
    bankFields: [
      { key: 'bankName', label: 'Bank name', required: true },
      { key: 'accountName', label: 'Account holder name', required: true },
      { key: 'accountNumber', label: 'Bank account number', required: true, pattern: '^\\d{8,16}$', hint: '8–16 digits' },
      { key: 'bankCode', label: 'Bank code / SWIFT', required: false, hint: 'Bank code (3 digits) or SWIFT (8 or 11 characters)' },
    ],
    directors: { required: true, minCount: 1, note: 'Add every director, including the President Director.', idLabel: 'KTP / Passport No.' },
    documents: [
      { type: 'nib_certificate', label: 'NIB certificate (OSS)', required: true },
      { type: 'deed_of_establishment', label: 'Deed of establishment (Akta Pendirian)', required: true },
      { type: 'npwp_card', label: 'Company NPWP card', required: true },
      { type: 'director_id', label: 'Director KTP / passport copies', required: true },
      { type: 'bank_statement', label: 'Bank account proof', required: true },
    ],
    paymentMethods: [pm('va', 'Virtual Account', 'payin', 1.5), pm('qris', 'QRIS', 'payin', 1.0), pm('dana', 'DANA', 'payin', 2.5), pm('ovo', 'OVO', 'payin', 2.5), PAYOUT],
  },
  VN: {
    ...COUNTRY_CATALOGUE['VN'],
    dialCode: '+84',
    businessTypes: ['Single-member LLC', 'Multi-member LLC', 'Joint Stock Company', 'Partnership', 'Private enterprise'],
    localRegistration: { key: 'localRegistrationNumber', label: 'Enterprise Registration No. (ERC)', required: true, pattern: '^\\d{10}$', hint: '10 digits' },
    taxId: { key: 'taxId', label: 'Tax Code (MST)', required: true, pattern: '^\\d{10}$', hint: '10 digits, usually the same as the ERC' },
    bankFields: [
      { key: 'bankName', label: 'Bank name', required: true },
      { key: 'branch', label: 'Bank branch', required: true, hint: 'Required for VND settlement in Vietnam' },
      { key: 'accountName', label: 'Account holder name', required: true },
      { key: 'accountNumber', label: 'Bank account number', required: true, pattern: '^\\d{6,19}$', hint: '6–19 digits' },
      { key: 'swiftCode', label: 'SWIFT', required: false, pattern: '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$', hint: '8 or 11 characters' },
    ],
    directors: { required: true, minCount: 1, note: 'Add every director, including the legal representative.', idLabel: 'CCCD / Passport No.' },
    documents: [
      { type: 'erc', label: 'Enterprise registration certificate (ERC)', required: true },
      { type: 'legal_rep_id', label: 'Legal representative ID / passport', required: true },
      { type: 'bank_confirmation', label: 'Bank account confirmation letter', required: true },
    ],
    paymentMethods: [pm('vietqr', 'VietQR', 'payin', 1.2), pm('momo', 'MoMo', 'payin', 2.5), pm('zalopay', 'ZaloPay', 'payin', 5), pm('bank_transfer', 'Bank Transfer', 'payin', 5), PAYOUT],
  },
};

/** Planned expansion: shown in the country picker, but registration isn't open yet. */
export const PLANNED_COUNTRIES: { code: string; name: string; currency: string }[] = [
  { code: 'IN', name: 'India', currency: 'INR' },
  { code: 'PH', name: 'Philippines', currency: 'PHP' },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED' },
];

/** Dial codes offered in phone fields. The country's own code is preset. */
export const DIAL_CODES = ['+60', '+62', '+84', '+65', '+66', '+63', '+91', '+971', '+852', '+86', '+61', '+44', '+1'];

const DEFAULT_COUNTRIES: Record<string, CountryOnboardingConfig> = JSON.parse(JSON.stringify(ONBOARDING_COUNTRIES));

/** The shipped defaults, before any Country Configuration changes. Returns a copy. */
export function defaultCountryConfig(code: string): CountryOnboardingConfig | undefined {
  const cfg = DEFAULT_COUNTRIES[code];
  return cfg ? JSON.parse(JSON.stringify(cfg)) : undefined;
}

/**
 * Replaces the live rules with configuration loaded from the (simulated) backend. Entries are
 * updated in place so existing imports of ONBOARDING_COUNTRIES see the change.
 */
export function applyCountryConfigs(configs: CountryOnboardingConfig[]) {
  for (const cfg of configs) {
    if (!ONBOARDING_COUNTRIES[cfg.code]) continue; // Adding countries is not supported yet.
    const target = ONBOARDING_COUNTRIES[cfg.code];
    for (const key of Object.keys(target)) delete (target as any)[key];
    Object.assign(target, JSON.parse(JSON.stringify(cfg)));
  }
}

/** Rules an application is shown against: its submission snapshot once submitted, otherwise the live configuration. */
export function rulesFor(app: { country: string; status: string; rulesSnapshot?: CountryOnboardingConfig }): CountryOnboardingConfig {
  const editable = app.status === 'draft' || app.status === 'returned';
  return (!editable && app.rulesSnapshot) || ONBOARDING_COUNTRIES[app.country];
}

/** Restores the shipped defaults (used by tests and demo resets). */
export function resetCountryConfigs() {
  applyCountryConfigs(Object.keys(DEFAULT_COUNTRIES).map((code) => defaultCountryConfig(code)!));
}

/** Countries a Global Merchant may be incorporated in (step 1, the Global profile). Country applications are limited to ONBOARDING_COUNTRIES. */
export const REGISTRATION_COUNTRIES: { code: string; name: string }[] = [
  { code: 'MY', name: 'Malaysia' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'TH', name: 'Thailand' },
  { code: 'PH', name: 'Philippines' },
  { code: 'SG', name: 'Singapore' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'AU', name: 'Australia' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
];

export function countryName(code: string): string {
  return REGISTRATION_COUNTRIES.find((c) => c.code === code)?.name ?? PLANNED_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

/** Nature of business. */
export const INDUSTRIES = [
  'Retail & e-commerce',
  'Food & beverage',
  'Travel & hospitality',
  'Education',
  'Healthcare',
  'Professional services',
  'Digital goods & software',
  'Gaming',
  'Financial services',
  'Logistics & transport',
  'Telecoms & utilities',
  'Media & entertainment',
  'Non-profit',
  'Other',
];

/** Sample CS readiness checklists (same in every country for this demo). */
export const READINESS_CHECKLISTS: Record<ReadinessStage, { key: string; label: string }[]> = {
  configuration: [
    { key: 'settlement_account', label: 'Settlement bank account confirmed' },
    { key: 'payment_methods', label: 'Approved payment methods enabled for the country' },
    { key: 'pricing_loaded', label: 'Approved MDR pricing loaded' },
    { key: 'merchant_portal', label: 'Merchant portal access prepared' },
  ],
  integration: [
    { key: 'docs_shared', label: 'Integration guide shared with the merchant' },
    { key: 'sandbox_tests', label: 'Sandbox test transactions passed' },
    { key: 'webhook_verified', label: 'Webhook / callback endpoint verified' },
  ],
  go_live: [
    { key: 'live_transaction', label: 'Live low-value test transaction succeeded' },
    { key: 'settlement_test', label: 'Settlement report reconciled' },
    { key: 'merchant_signoff', label: 'Merchant go-live sign-off received' },
  ],
};

/** Verification is shown generically; no provider has been confirmed (see docs). */
export const VERIFICATION_PROVIDER_LABEL = 'Automated verification';
