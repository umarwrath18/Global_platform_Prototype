import { COUNTRY_CATALOGUE } from '../mock-server/seed';
import { ReadinessStage } from './merchant-models';

// DEMO CONFIGURATION — sample per-country onboarding rules for the prototype.
// These values are illustrative only and have NOT been approved by Mobi Risk, Legal or
// Product. They stand in for the Country, Currency, Payment Method and Pricing
// configuration modules, which are out of scope for Batch 2. Replace this file with
// the real configuration service when it exists.

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

export interface PaymentMethodRule {
  code: string;
  name: string;
  kind: 'card' | 'bank_transfer' | 'qr' | 'ewallet';
  defaultMdr: number;
  minMdr: number;
  maxMdr: number;
}

export interface CountryOnboardingConfig {
  code: string;
  name: string;
  currency: string;
  businessTypes: string[];
  localRegistration: FieldRule;
  taxId: FieldRule;
  bankFields: FieldRule[];
  directors: { required: boolean; minCount: number; ownershipThresholdPct: number | null; note: string };
  documents: DocumentRule[];
  paymentMethods: PaymentMethodRule[];
}

const pm = (code: string, name: string, kind: PaymentMethodRule['kind'], defaultMdr: number, minMdr: number, maxMdr: number): PaymentMethodRule => ({
  code,
  name,
  kind,
  defaultMdr,
  minMdr,
  maxMdr,
});

export const ONBOARDING_COUNTRIES: Record<string, CountryOnboardingConfig> = {
  MY: {
    ...COUNTRY_CATALOGUE['MY'],
    businessTypes: ['Sdn Bhd (private limited)', 'Berhad (public limited)', 'Sole proprietorship', 'Partnership', 'LLP'],
    localRegistration: { key: 'localRegistrationNumber', label: 'SSM registration number', required: true, pattern: '^\\d{12}$', hint: '12-digit SSM number, e.g. 201901012345' },
    taxId: { key: 'taxId', label: 'SST registration number', required: false, hint: 'Required only if the business is SST-registered' },
    bankFields: [
      { key: 'bankName', label: 'Bank name', required: true },
      { key: 'accountName', label: 'Account holder name', required: true, hint: 'Must match the registered company name' },
      { key: 'accountNumber', label: 'Account number', required: true, pattern: '^\\d{10,16}$', hint: '10–16 digits' },
      { key: 'swiftCode', label: 'SWIFT / BIC', required: false, pattern: '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$', hint: '8 or 11 characters' },
    ],
    directors: { required: true, minCount: 1, ownershipThresholdPct: 25, note: 'List all directors and anyone owning 25% or more.' },
    documents: [
      { type: 'ssm_profile', label: 'SSM company profile (Section 14 / e-Info)', required: true },
      { type: 'director_id', label: 'Director NRIC / passport copies', required: true },
      { type: 'bank_statement', label: 'Bank statement (latest 3 months)', required: true },
      { type: 'sst_certificate', label: 'SST registration certificate', required: false },
    ],
    paymentMethods: [
      pm('MY_CARDS', 'Visa / Mastercard', 'card', 2.2, 1.5, 3.5),
      pm('MY_FPX', 'FPX online banking', 'bank_transfer', 1.0, 0.6, 1.8),
      pm('MY_DUITNOW', 'DuitNow QR', 'qr', 0.8, 0.5, 1.5),
      pm('MY_TNG', "Touch 'n Go eWallet", 'ewallet', 1.5, 1.0, 2.5),
    ],
  },
  ID: {
    ...COUNTRY_CATALOGUE['ID'],
    businessTypes: ['PT (Perseroan Terbatas)', 'PT PMA (foreign-owned)', 'CV (limited partnership)', 'Sole proprietorship'],
    localRegistration: { key: 'localRegistrationNumber', label: 'NIB (business identification number)', required: true, pattern: '^\\d{13}$', hint: '13 digits' },
    taxId: { key: 'taxId', label: 'NPWP (tax ID)', required: true, pattern: '^\\d{15,16}$', hint: '15 or 16 digits, no punctuation' },
    bankFields: [
      { key: 'bankName', label: 'Bank name', required: true },
      { key: 'accountName', label: 'Account holder name', required: true },
      { key: 'accountNumber', label: 'Account number', required: true, pattern: '^\\d{8,16}$', hint: '8–16 digits' },
    ],
    directors: { required: true, minCount: 1, ownershipThresholdPct: 25, note: 'List the President Director and anyone owning 25% or more.' },
    documents: [
      { type: 'nib_certificate', label: 'NIB certificate (OSS)', required: true },
      { type: 'deed_of_establishment', label: 'Deed of establishment (Akta Pendirian)', required: true },
      { type: 'npwp_card', label: 'Company NPWP card', required: true },
      { type: 'director_id', label: 'Director KTP / passport copies', required: true },
      { type: 'bank_statement', label: 'Bank account proof', required: true },
    ],
    paymentMethods: [
      pm('ID_QRIS', 'QRIS', 'qr', 0.7, 0.3, 1.0),
      pm('ID_VA', 'Bank virtual account', 'bank_transfer', 0.9, 0.5, 1.5),
      pm('ID_OVO', 'OVO', 'ewallet', 1.5, 1.0, 2.5),
      pm('ID_DANA', 'DANA', 'ewallet', 1.5, 1.0, 2.5),
      pm('ID_CARDS', 'Visa / Mastercard', 'card', 2.5, 1.8, 3.5),
    ],
  },
  VN: {
    ...COUNTRY_CATALOGUE['VN'],
    businessTypes: ['LLC (one member)', 'LLC (two or more members)', 'Joint stock company (JSC)', 'Private enterprise'],
    localRegistration: { key: 'localRegistrationNumber', label: 'Enterprise registration number', required: true, pattern: '^\\d{10}(-\\d{3})?$', hint: '10 digits (branch: 10 digits + -XXX)' },
    taxId: { key: 'taxId', label: 'Tax code', required: true, pattern: '^\\d{10}(-\\d{3})?$', hint: 'Usually the same as the enterprise registration number' },
    bankFields: [
      { key: 'bankName', label: 'Bank name', required: true },
      { key: 'branch', label: 'Bank branch', required: true, hint: 'Required for VND settlement in Vietnam' },
      { key: 'accountName', label: 'Account holder name', required: true },
      { key: 'accountNumber', label: 'Account number', required: true, pattern: '^\\d{6,19}$', hint: '6–19 digits' },
    ],
    directors: { required: false, minCount: 0, ownershipThresholdPct: null, note: 'Not required for Vietnam in this demo configuration. The legal representative is captured under Contact information.' },
    documents: [
      { type: 'erc', label: 'Enterprise registration certificate (ERC)', required: true },
      { type: 'legal_rep_id', label: 'Legal representative ID / passport', required: true },
      { type: 'bank_confirmation', label: 'Bank account confirmation letter', required: true },
    ],
    paymentMethods: [
      pm('VN_VIETQR', 'VietQR', 'qr', 0.6, 0.3, 1.2),
      pm('VN_NAPAS', 'Napas domestic ATM cards', 'card', 1.1, 0.7, 1.8),
      pm('VN_MOMO', 'MoMo', 'ewallet', 1.6, 1.0, 2.5),
      pm('VN_CARDS', 'International cards', 'card', 2.4, 1.8, 3.5),
    ],
  },
  TH: {
    ...COUNTRY_CATALOGUE['TH'],
    businessTypes: ['Company limited', 'Public company limited', 'Limited partnership', 'Sole proprietorship'],
    localRegistration: { key: 'localRegistrationNumber', label: 'DBD registration number', required: true, pattern: '^\\d{13}$', hint: '13 digits' },
    taxId: { key: 'taxId', label: 'Tax ID', required: true, pattern: '^\\d{13}$', hint: '13 digits' },
    bankFields: [
      { key: 'bankName', label: 'Bank name', required: true },
      { key: 'branch', label: 'Bank branch', required: true },
      { key: 'accountName', label: 'Account holder name', required: true },
      { key: 'accountNumber', label: 'Account number', required: true, pattern: '^\\d{10,12}$', hint: '10–12 digits' },
    ],
    directors: { required: true, minCount: 1, ownershipThresholdPct: 25, note: 'List authorised directors and anyone owning 25% or more.' },
    documents: [
      { type: 'dbd_certificate', label: 'DBD company affidavit (issued within 6 months)', required: true },
      { type: 'vat_registration', label: 'VAT registration (Por Por 20)', required: true },
      { type: 'director_id', label: 'Director ID / passport copies', required: true },
      { type: 'bank_book', label: 'Bank book first page', required: true },
    ],
    paymentMethods: [
      pm('TH_PROMPTPAY', 'PromptPay QR', 'qr', 0.8, 0.4, 1.5),
      pm('TH_CARDS', 'Visa / Mastercard', 'card', 2.3, 1.6, 3.5),
      pm('TH_TRUEMONEY', 'TrueMoney Wallet', 'ewallet', 1.7, 1.0, 2.5),
    ],
  },
  PH: {
    ...COUNTRY_CATALOGUE['PH'],
    businessTypes: ['Stock corporation', 'One person corporation', 'Partnership', 'Sole proprietorship (DTI)'],
    localRegistration: { key: 'localRegistrationNumber', label: 'SEC / DTI registration number', required: true },
    taxId: { key: 'taxId', label: 'TIN', required: true, pattern: '^\\d{9}(\\d{3})?$', hint: '9 or 12 digits, no dashes' },
    bankFields: [
      { key: 'bankName', label: 'Bank name', required: true },
      { key: 'accountName', label: 'Account holder name', required: true },
      { key: 'accountNumber', label: 'Account number', required: true, pattern: '^\\d{10,16}$', hint: '10–16 digits' },
    ],
    directors: { required: true, minCount: 1, ownershipThresholdPct: 25, note: 'List directors as shown in the General Information Sheet and anyone owning 25% or more.' },
    documents: [
      { type: 'sec_certificate', label: 'SEC certificate of incorporation / DTI', required: true },
      { type: 'bir_2303', label: 'BIR certificate of registration (Form 2303)', required: true },
      { type: 'mayors_permit', label: "Mayor's / business permit", required: true },
      { type: 'gis', label: 'General Information Sheet (GIS)', required: true },
      { type: 'director_id', label: 'Director government ID copies', required: false },
    ],
    paymentMethods: [
      pm('PH_GCASH', 'GCash', 'ewallet', 2.0, 1.5, 3.0),
      pm('PH_MAYA', 'Maya', 'ewallet', 2.0, 1.5, 3.0),
      pm('PH_QRPH', 'QR Ph', 'qr', 1.0, 0.5, 1.5),
      pm('PH_CARDS', 'Visa / Mastercard', 'card', 2.8, 2.0, 3.8),
    ],
  },
};

/** Registration countries a Global Merchant may be incorporated in (onboarding is limited to the list above). */
export const REGISTRATION_COUNTRIES: { code: string; name: string }[] = [
  ...Object.values(ONBOARDING_COUNTRIES).map(({ code, name }) => ({ code, name })),
  { code: 'SG', name: 'Singapore' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'AU', name: 'Australia' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
];

export function countryName(code: string): string {
  return REGISTRATION_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

export const INDUSTRIES = [
  'Retail & e-commerce',
  'Food & beverage',
  'Travel & hospitality',
  'Education',
  'Digital goods & gaming',
  'Professional services',
  'Health & wellness',
  'Logistics',
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

/** Verification is represented generically; no provider has been confirmed. */
export const VERIFICATION_PROVIDER_LABEL = 'Verification provider (to be confirmed)';
