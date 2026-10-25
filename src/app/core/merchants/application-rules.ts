import { ApplicationData, FieldIssue, GlobalMerchant, SectionKey } from './merchant-models';
import { CountryOnboardingConfig, FieldRule, ONBOARDING_COUNTRIES } from './onboarding-config';

// Validation shared by the portal (field-level feedback) and the simulated backend
// (submission gate). The server always re-runs it; the UI check is for convenience only.

export const SECTION_ORDER: SectionKey[] = ['business', 'contact', 'bank', 'directors', 'documents', 'pricing'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const URL_RE = /^https?:\/\/[^\s.]+\.[^\s]+$/i;

export const isEmail = (v: string) => EMAIL_RE.test(v.trim());
export const isPhone = (v: string) => PHONE_RE.test(v.trim());

/** True when the Global profile's registration number already covers this country. */
export function registeredInCountry(merchant: Pick<GlobalMerchant, 'registrationCountry'>, country: string) {
  return merchant.registrationCountry === country;
}

function checkRule(rule: FieldRule, value: string | undefined, section: SectionKey, field: string, out: FieldIssue[]) {
  const v = (value ?? '').trim();
  if (!v) {
    if (rule.required) out.push({ section, field, message: `Enter the ${rule.label.charAt(0).toLowerCase() + rule.label.slice(1)}.` });
    return;
  }
  if (rule.pattern && !new RegExp(rule.pattern).test(v)) {
    out.push({ section, field, message: `${rule.label} format is not valid${rule.hint ? ` (${rule.hint})` : ''}.` });
  }
}

/** Validates the Global profile's registration number against its country's format, when one is configured. */
export function validateRegistrationNumber(registrationCountry: string, value: string): string | null {
  const v = value.trim();
  if (!v) return 'Enter the business registration number.';
  if (v.length > 40) return 'Use 40 characters or fewer.';
  const rule = ONBOARDING_COUNTRIES[registrationCountry]?.localRegistration;
  if (rule?.pattern && !new RegExp(rule.pattern).test(v)) return `${rule.label} format is not valid${rule.hint ? ` (${rule.hint})` : ''}.`;
  return null;
}

export function validateApplication(country: string, data: ApplicationData, merchant: Pick<GlobalMerchant, 'registrationCountry'>): FieldIssue[] {
  const cfg = ONBOARDING_COUNTRIES[country];
  if (!cfg) return [{ section: 'business', field: 'country', message: 'This country is not available for onboarding.' }];
  const out: FieldIssue[] = [];
  validateBusiness(cfg, data, merchant, out);
  validateContact(data, out);
  cfg.bankFields.forEach((rule) => checkRule(rule, data.bank[rule.key], 'bank', `bank.${rule.key}`, out));
  validateDirectors(cfg, data, out);
  for (const doc of cfg.documents) {
    if (doc.required && !data.documents.some((d) => d.type === doc.type)) {
      out.push({ section: 'documents', field: `documents.${doc.type}`, message: `${doc.label} is required.` });
    }
  }
  validatePricing(cfg, data, out);
  return out;
}

function validateBusiness(cfg: CountryOnboardingConfig, data: ApplicationData, merchant: Pick<GlobalMerchant, 'registrationCountry'>, out: FieldIssue[]) {
  const b = data.business;
  if (!b.tradingName.trim()) out.push({ section: 'business', field: 'business.tradingName', message: 'Enter the trading name used in this country.' });
  else if (b.tradingName.length > 120) out.push({ section: 'business', field: 'business.tradingName', message: 'Use 120 characters or fewer.' });
  if (!cfg.businessTypes.includes(b.businessType)) out.push({ section: 'business', field: 'business.businessType', message: 'Select the business type.' });
  if (!b.industry) out.push({ section: 'business', field: 'business.industry', message: 'Select the industry.' });
  if (b.website.trim() && !URL_RE.test(b.website.trim())) out.push({ section: 'business', field: 'business.website', message: 'Enter a full website address starting with https://' });
  if (!b.address.trim()) out.push({ section: 'business', field: 'business.address', message: `Enter the business address in ${cfg.name}.` });
  if (!registeredInCountry(merchant, cfg.code)) checkRule(cfg.localRegistration, b.localRegistrationNumber, 'business', 'business.localRegistrationNumber', out);
  checkRule(cfg.taxId, b.taxId, 'business', 'business.taxId', out);
  if (b.expectedMonthlyVolume === null || !(b.expectedMonthlyVolume > 0)) {
    out.push({ section: 'business', field: 'business.expectedMonthlyVolume', message: `Enter the expected monthly volume in ${cfg.currency}.` });
  }
}

function validateContact(data: ApplicationData, out: FieldIssue[]) {
  const c = data.contact;
  if (!c.name.trim()) out.push({ section: 'contact', field: 'contact.name', message: 'Enter the contact name.' });
  if (!c.email.trim()) out.push({ section: 'contact', field: 'contact.email', message: 'Enter the contact email.' });
  else if (!isEmail(c.email)) out.push({ section: 'contact', field: 'contact.email', message: 'Enter a valid email address, e.g. name@company.com' });
  if (!c.phone.trim()) out.push({ section: 'contact', field: 'contact.phone', message: 'Enter the contact phone number.' });
  else if (!isPhone(c.phone)) out.push({ section: 'contact', field: 'contact.phone', message: 'Enter a valid phone number including the country code, e.g. +60 12 345 6789' });
  if (c.supportEmail.trim() && !isEmail(c.supportEmail)) out.push({ section: 'contact', field: 'contact.supportEmail', message: 'Enter a valid support email address.' });
}

function validateDirectors(cfg: CountryOnboardingConfig, data: ApplicationData, out: FieldIssue[]) {
  if (!cfg.directors.required) return;
  if (data.directors.length < cfg.directors.minCount) {
    out.push({ section: 'directors', field: 'directors', message: `Add at least ${cfg.directors.minCount} director or beneficial owner.` });
  }
  let total = 0;
  data.directors.forEach((d, i) => {
    const p = `directors.${i}`;
    if (!d.name.trim()) out.push({ section: 'directors', field: `${p}.name`, message: `Person ${i + 1}: enter the full name.` });
    if (!d.nationality.trim()) out.push({ section: 'directors', field: `${p}.nationality`, message: `Person ${i + 1}: enter the nationality.` });
    if (!d.idNumber.trim()) out.push({ section: 'directors', field: `${p}.idNumber`, message: `Person ${i + 1}: enter the ID or passport number.` });
    const owner = d.role !== 'director';
    if (owner && (d.ownershipPct === null || d.ownershipPct <= 0 || d.ownershipPct > 100)) {
      out.push({ section: 'directors', field: `${p}.ownershipPct`, message: `Person ${i + 1}: enter an ownership between 0 and 100%.` });
    }
    total += d.ownershipPct ?? 0;
  });
  if (total > 100) out.push({ section: 'directors', field: 'directors', message: `Total ownership is ${total}%, which is more than 100%.` });
}

function validatePricing(cfg: CountryOnboardingConfig, data: ApplicationData, out: FieldIssue[]) {
  const enabled = data.pricing.filter((p) => p.enabled);
  if (!enabled.length) out.push({ section: 'pricing', field: 'pricing', message: 'Enable at least one payment method.' });
  for (const line of enabled) {
    const rule = cfg.paymentMethods.find((m) => m.code === line.code);
    if (!rule) {
      out.push({ section: 'pricing', field: `pricing.${line.code}`, message: `${line.code} is not offered in ${cfg.name}.` });
    } else if (line.mdr === null || Number.isNaN(line.mdr)) {
      out.push({ section: 'pricing', field: `pricing.${line.code}`, message: `${rule.name}: enter the MDR.` });
    } else if (line.mdr < rule.minMdr || line.mdr > rule.maxMdr) {
      out.push({ section: 'pricing', field: `pricing.${line.code}`, message: `${rule.name}: MDR must be between ${rule.minMdr}% and ${rule.maxMdr}%.` });
    }
  }
}

export function emptyApplicationData(country: string): ApplicationData {
  const cfg = ONBOARDING_COUNTRIES[country];
  return {
    business: { tradingName: '', businessType: '', industry: '', website: '', address: '', localRegistrationNumber: '', taxId: '', expectedMonthlyVolume: null },
    contact: { name: '', email: '', phone: '', supportEmail: '' },
    bank: Object.fromEntries(cfg.bankFields.map((f) => [f.key, ''])),
    directors: [],
    documents: [],
    pricing: cfg.paymentMethods.map((m) => ({ code: m.code, enabled: false, mdr: m.defaultMdr })),
  };
}

/** Accepted file types and size for document records. */
export const DOCUMENT_RULES = { maxSizeKb: 10 * 1024, extensions: ['pdf', 'jpg', 'jpeg', 'png'] } as const;

export function documentFileError(fileName: string, sizeKb: number): string | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!(DOCUMENT_RULES.extensions as readonly string[]).includes(ext)) return 'Use a PDF, JPG or PNG file.';
  if (sizeKb > DOCUMENT_RULES.maxSizeKb) return 'The file is larger than 10 MB.';
  return null;
}
