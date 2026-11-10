import { APPROVAL_PRIORITIES, ApplicationData, connectionTypeLabel, FieldIssue, GlobalMerchant, MAX_SETTLEMENT_EMAILS, merchantCategoryLabel, SectionKey } from './merchant-models';
import { CountryOnboardingConfig, FieldRule, INDUSTRIES, ONBOARDING_COUNTRIES } from './onboarding-config';

// Validation shared by the portal (field-level feedback) and the simulated backend
// (submission gate). The server always re-runs it; the UI check is for convenience only.

export const SECTION_ORDER: SectionKey[] = ['business', 'contact', 'bank', 'transaction', 'directors', 'documents'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const URL_RE = /^https?:\/\/[^\s.]+\.[^\s]+$/i;
const HTTPS_RE = /^https:\/\/[^\s.]+\.[^\s]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isEmail = (v: string) => EMAIL_RE.test(v.trim());
export const isPhone = (v: string) => PHONE_RE.test(v.trim());
export const isUrl = (v: string) => URL_RE.test(v.trim());
export const isHttpsUrl = (v: string) => HTTPS_RE.test(v.trim());

/** True when the Global profile's registration number already covers this country. */
export function registeredInCountry(merchant: Pick<GlobalMerchant, 'registrationCountry'>, country: string) {
  return merchant.registrationCountry === country;
}

function checkRule(rule: FieldRule, value: string | undefined, section: FieldIssue['section'], field: string, out: FieldIssue[]) {
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

/** Today's date as YYYY-MM-DD in local time. */
export function todayIso(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function validDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function validateApplication(country: string, data: ApplicationData, merchant: Pick<GlobalMerchant, 'registrationCountry'>, now = Date.now()): FieldIssue[] {
  const cfg = ONBOARDING_COUNTRIES[country];
  if (!cfg) return [{ section: 'business', field: 'country', message: 'This country is not available for onboarding.' }];
  const out: FieldIssue[] = [];
  validateBusiness(cfg, data, merchant, now, out);
  validateContact(data, out);
  cfg.bankFields.forEach((rule) => checkRule(rule, data.bank[rule.key], 'bank', `bank.${rule.key}`, out));
  validateTransaction(cfg, data, out);
  validateDirectors(cfg, data, out);
  for (const doc of cfg.documents) {
    if (doc.required && !data.documents.some((d) => d.type === doc.type)) {
      out.push({ section: 'documents', field: `documents.${doc.type}`, message: `${doc.label} is required.` });
    }
  }
  return out;
}

function validateBusiness(cfg: CountryOnboardingConfig, data: ApplicationData, merchant: Pick<GlobalMerchant, 'registrationCountry'>, now: number, out: FieldIssue[]) {
  const b = data.business;
  if (!APPROVAL_PRIORITIES.includes(b.approvalPriority)) out.push({ section: 'business', field: 'business.approvalPriority', message: 'Select the approval priority.' });
  if (!b.tradingName.trim()) out.push({ section: 'business', field: 'business.tradingName', message: 'Enter the merchant trading name.' });
  else if (b.tradingName.length > 120) out.push({ section: 'business', field: 'business.tradingName', message: 'Use 120 characters or fewer.' });
  if (!registeredInCountry(merchant, cfg.code)) checkRule(cfg.localRegistration, b.localRegistrationNumber, 'business', 'business.localRegistrationNumber', out);
  const date = b.incorporationDate.trim();
  if (!date) out.push({ section: 'business', field: 'business.incorporationDate', message: 'Enter the date of incorporation.' });
  else if (!validDate(date)) out.push({ section: 'business', field: 'business.incorporationDate', message: 'Enter a valid date of incorporation.' });
  else if (date > todayIso(now)) out.push({ section: 'business', field: 'business.incorporationDate', message: "The date of incorporation can't be in the future." });
  if (!cfg.businessTypes.includes(b.businessType)) out.push({ section: 'business', field: 'business.businessType', message: 'Select the company type.' });
  checkRule(cfg.taxId, b.taxId, 'business', 'business.taxId', out);
  if (cfg.secondaryTaxId) checkRule(cfg.secondaryTaxId, b.secondaryTaxId, 'business', 'business.secondaryTaxId', out);
  if (b.website.trim() && !URL_RE.test(b.website.trim())) out.push({ section: 'business', field: 'business.website', message: 'Enter a full website address starting with https://' });
  if (!INDUSTRIES.includes(b.industry)) out.push({ section: 'business', field: 'business.industry', message: 'Select the nature of business.' });
  if (!b.address.trim()) out.push({ section: 'business', field: 'business.address', message: 'Enter the registered address.' });
}

function validateContact(data: ApplicationData, out: FieldIssue[]) {
  const c = data.contact;
  if (!c.phone.trim()) out.push({ section: 'contact', field: 'contact.phone', message: 'Enter the phone number.' });
  else if (!isPhone(c.phone)) out.push({ section: 'contact', field: 'contact.phone', message: 'Enter a valid phone number, e.g. +60 12 345 6789' });
  if (!c.email.trim()) out.push({ section: 'contact', field: 'contact.email', message: 'Enter the email address.' });
  else if (!isEmail(c.email)) out.push({ section: 'contact', field: 'contact.email', message: 'Enter a valid email address, e.g. name@company.com' });
  if (!c.sameAsRegistered && !c.currentAddress.trim()) out.push({ section: 'contact', field: 'contact.currentAddress', message: 'Enter the current address.' });
  const emails = c.settlementEmails.map((e) => e.trim());
  if (!emails.some(Boolean)) out.push({ section: 'contact', field: 'contact.settlementEmails', message: 'Enter at least one settlement email.' });
  if (emails.length > MAX_SETTLEMENT_EMAILS) out.push({ section: 'contact', field: 'contact.settlementEmails', message: `Add up to ${MAX_SETTLEMENT_EMAILS} settlement emails.` });
  const seen = new Set<string>();
  emails.forEach((e, i) => {
    if (!e) return;
    if (!isEmail(e)) out.push({ section: 'contact', field: `contact.settlementEmails.${i}`, message: 'Enter a valid email address, e.g. finance@company.com' });
    else if (seen.has(e.toLowerCase())) out.push({ section: 'contact', field: `contact.settlementEmails.${i}`, message: 'This email is already listed.' });
    seen.add(e.toLowerCase());
  });
}

function validateTransaction(cfg: CountryOnboardingConfig, data: ApplicationData, out: FieldIssue[]) {
  const t = data.transaction;
  if (t.dailyLimit === null || !(t.dailyLimit > 0)) out.push({ section: 'transaction', field: 'transaction.dailyLimit', message: `Enter the daily transaction limit in ${cfg.currency}.` });
  if (t.minTransactionValue !== null) {
    if (!(t.minTransactionValue > 0)) out.push({ section: 'transaction', field: 'transaction.minTransactionValue', message: 'Enter an amount greater than 0, or leave it empty.' });
    else if (t.dailyLimit !== null && t.dailyLimit > 0 && t.minTransactionValue > t.dailyLimit) {
      out.push({ section: 'transaction', field: 'transaction.minTransactionValue', message: "The minimum transaction value can't be more than the daily transaction limit." });
    }
  }
  if (!merchantCategoryLabel(t.merchantCategory)) out.push({ section: 'transaction', field: 'transaction.merchantCategory', message: 'Select the merchant category.' });
  if (!connectionTypeLabel(t.connectionType)) out.push({ section: 'transaction', field: 'transaction.connectionType', message: 'Select the merchant connection type.' });
  const ipn = ipnIssue(t.ipnCallbackUrl);
  if (ipn) out.push({ section: 'transaction', field: 'transaction.ipnCallbackUrl', message: ipn });
}

/** The IPN callback URL is optional at submission, but must be https when given. */
export function ipnIssue(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > 500) return 'Use 500 characters or fewer.';
  return HTTPS_RE.test(v) ? null : 'Enter a full https:// URL, e.g. https://example.com/payments/notify';
}

function validateDirectors(cfg: CountryOnboardingConfig, data: ApplicationData, out: FieldIssue[]) {
  if (!cfg.directors.required) return;
  if (data.directors.length < cfg.directors.minCount) {
    out.push({ section: 'directors', field: 'directors', message: `Add at least ${cfg.directors.minCount} director.` });
  }
  const idLabel = cfg.directors.idLabel.replace(/\.$/, '');
  data.directors.forEach((d, i) => {
    const p = `directors.${i}`;
    if (!d.name.trim()) out.push({ section: 'directors', field: `${p}.name`, message: `Director ${i + 1}: enter the director name.` });
    if (!d.contactNumber.trim()) out.push({ section: 'directors', field: `${p}.contactNumber`, message: `Director ${i + 1}: enter the contact number.` });
    else if (!isPhone(d.contactNumber)) out.push({ section: 'directors', field: `${p}.contactNumber`, message: `Director ${i + 1}: enter a valid contact number.` });
    if (!d.nationality.trim()) out.push({ section: 'directors', field: `${p}.nationality`, message: `Director ${i + 1}: enter the nationality.` });
    if (d.profileUrl.trim() && !URL_RE.test(d.profileUrl.trim())) out.push({ section: 'directors', field: `${p}.profileUrl`, message: `Director ${i + 1}: enter a full address starting with https://` });
    if (!d.idNumber.trim()) out.push({ section: 'directors', field: `${p}.idNumber`, message: `Director ${i + 1}: enter the ${idLabel}.` });
  });
}

export function emptyApplicationData(country: string): ApplicationData {
  const cfg = ONBOARDING_COUNTRIES[country];
  return {
    business: { approvalPriority: 'medium', tradingName: '', localRegistrationNumber: '', incorporationDate: '', businessType: '', taxId: '', secondaryTaxId: '', website: '', industry: '', address: '' },
    contact: { phone: '', email: '', currentAddress: '', sameAsRegistered: false, settlementEmails: [''] },
    bank: Object.fromEntries(cfg.bankFields.map((f) => [f.key, ''])),
    transaction: { dailyLimit: null, minTransactionValue: null, merchantCategory: '', connectionType: '', ipnCallbackUrl: '', sendReceipts: false },
    directors: [],
    documents: [],
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
