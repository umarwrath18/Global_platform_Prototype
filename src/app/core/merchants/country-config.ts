import { FieldIssue, StaffRole } from './merchant-models';
import { CountryOnboardingConfig, DocumentRule, FieldRule } from './onboarding-config';

// Country Configuration (MVP feature 5) contract and validation, shared by the portal and the
// simulated backend. The server always re-runs the validation; the UI check is for convenience.

/** What Sales / Operations can change. Name, code, currency and payment methods are read-only here. */
export interface CountryConfigInput {
  onboardingEnabled: boolean;
  businessTypes: string[];
  localRegistration: FieldRule;
  taxId: FieldRule;
  bankFields: FieldRule[];
  directors: CountryOnboardingConfig['directors'];
  documents: DocumentRule[];
}

export interface CountryConfigView {
  config: CountryOnboardingConfig;
  onboardingEnabled: boolean;
  /** Increases on every change; updates must quote the version they were based on. */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface CountryConfigChange {
  at: number;
  country: string;
  by: string;
  /** Acting team; absent on changes recorded before roles were stored. */
  role?: StaffRole;
  reason: string;
  changes: string[];
  version: number;
}

export interface CountryConfigDetail extends CountryConfigView {
  history: CountryConfigChange[];
  canEdit: boolean;
}

export interface UpdateCountryConfigRequest extends CountryConfigInput {
  version: number;
  reason: string;
}

export function toConfigInput(cfg: CountryOnboardingConfig): CountryConfigInput {
  const copy = JSON.parse(JSON.stringify(cfg)) as CountryOnboardingConfig;
  return {
    onboardingEnabled: copy.onboardingEnabled !== false,
    businessTypes: copy.businessTypes,
    localRegistration: copy.localRegistration,
    taxId: copy.taxId,
    bankFields: copy.bankFields,
    directors: copy.directors,
    documents: copy.documents,
  };
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const BANK_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const DOC_TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;

function readRule(raw: any, key: string): FieldRule {
  const rule: FieldRule = { key, label: str(raw?.label, 60), required: raw?.required === true };
  const pattern = str(raw?.pattern, 200);
  const hint = str(raw?.hint, 120);
  if (pattern) rule.pattern = pattern;
  if (hint) rule.hint = hint;
  return rule;
}

function checkRule(rule: FieldRule, field: string, section: FieldIssue['section'], out: FieldIssue[]) {
  if (!rule.label) out.push({ section, field: `${field}.label`, message: 'Enter a label.' });
  if (rule.pattern) {
    try {
      new RegExp(rule.pattern);
    } catch {
      out.push({ section, field: `${field}.pattern`, message: 'This format pattern is not a valid regular expression.' });
    }
  }
}

/**
 * Normalises an update against the current configuration and lists every problem. Existing bank
 * fields and document types can't be removed (drafts may already hold values for them); make
 * them optional instead.
 */
export function readCountryConfigInput(current: CountryOnboardingConfig, raw: any): { input: CountryConfigInput; errors: FieldIssue[] } {
  const errors: FieldIssue[] = [];

  const businessTypes = (Array.isArray(raw?.businessTypes) ? raw.businessTypes : []).map((t: unknown) => str(t, 80)).filter(Boolean).slice(0, 30);
  if (!businessTypes.length) errors.push({ section: 'business', field: 'businessTypes', message: 'Add at least one business type.' });
  if (new Set(businessTypes.map((t: string) => t.toLowerCase())).size !== businessTypes.length) errors.push({ section: 'business', field: 'businessTypes', message: 'Each business type must be unique.' });

  const localRegistration = readRule(raw?.localRegistration, current.localRegistration.key);
  checkRule(localRegistration, 'localRegistration', 'business', errors);
  const taxId = readRule(raw?.taxId, current.taxId.key);
  checkRule(taxId, 'taxId', 'business', errors);

  const rawBank: any[] = Array.isArray(raw?.bankFields) ? raw.bankFields.slice(0, 20) : [];
  const bankFields = rawBank.map((f) => readRule(f, str(f?.key, 32)));
  bankFields.forEach((f, i) => {
    if (!BANK_KEY_RE.test(f.key)) errors.push({ section: 'bank', field: `bankFields.${i}.key`, message: 'Use a key of letters and digits that starts with a letter, e.g. swiftCode.' });
    checkRule(f, `bankFields.${i}`, 'bank', errors);
  });
  if (new Set(bankFields.map((f) => f.key)).size !== bankFields.length) errors.push({ section: 'bank', field: 'bankFields', message: 'Each bank field key must be unique.' });
  for (const old of current.bankFields) {
    if (!bankFields.some((f) => f.key === old.key)) errors.push({ section: 'bank', field: 'bankFields', message: `${old.label} can't be removed. Make it optional instead.` });
  }
  if (!bankFields.some((f) => f.required)) errors.push({ section: 'bank', field: 'bankFields', message: 'At least one bank field must be required.' });

  const rawDocs: any[] = Array.isArray(raw?.documents) ? raw.documents.slice(0, 30) : [];
  const documents: DocumentRule[] = rawDocs.map((d) => {
    const doc: DocumentRule = { type: str(d?.type, 40), label: str(d?.label, 80), required: d?.required === true };
    const hint = str(d?.hint, 160);
    if (hint) doc.hint = hint;
    return doc;
  });
  documents.forEach((d, i) => {
    if (!DOC_TYPE_RE.test(d.type)) errors.push({ section: 'documents', field: `documents.${i}.type`, message: 'Use a lowercase key with letters, digits or underscores, e.g. bank_statement.' });
    if (!d.label) errors.push({ section: 'documents', field: `documents.${i}.label`, message: 'Enter a label.' });
  });
  if (!documents.length) errors.push({ section: 'documents', field: 'documents', message: 'Add at least one document type.' });
  if (new Set(documents.map((d) => d.type)).size !== documents.length) errors.push({ section: 'documents', field: 'documents', message: 'Each document type must be unique.' });
  for (const old of current.documents) {
    if (!documents.some((d) => d.type === old.type)) errors.push({ section: 'documents', field: 'documents', message: `${old.label} can't be removed. Make it optional instead.` });
  }

  const d = raw?.directors ?? {};
  const minCount = typeof d.minCount === 'number' && Number.isInteger(d.minCount) ? d.minCount : NaN;
  const threshold = d.ownershipThresholdPct === null || d.ownershipThresholdPct === undefined || d.ownershipThresholdPct === '' ? null : Number(d.ownershipThresholdPct);
  const directors = { required: d.required === true, minCount, ownershipThresholdPct: threshold, note: str(d.note, 300) };
  if (!(minCount >= 0 && minCount <= 20)) errors.push({ section: 'directors', field: 'directors.minCount', message: 'Enter a whole number from 0 to 20.' });
  else if (directors.required && minCount < 1) errors.push({ section: 'directors', field: 'directors.minCount', message: 'When directors are required, at least 1 must be listed.' });
  if (threshold !== null && !(threshold > 0 && threshold <= 100)) errors.push({ section: 'directors', field: 'directors.ownershipThresholdPct', message: 'Enter a percentage from 1 to 100, or leave it empty.' });

  return { input: { onboardingEnabled: raw?.onboardingEnabled !== false, businessTypes, localRegistration, taxId, bankFields, directors, documents }, errors };
}

/** Human-readable summary of what an update changes, for the audit history. */
export function describeConfigChanges(before: CountryOnboardingConfig, after: CountryConfigInput): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if ((before.onboardingEnabled !== false) !== after.onboardingEnabled) out.push(after.onboardingEnabled ? 'Onboarding resumed' : 'Onboarding paused');
  if (!same(before.businessTypes, after.businessTypes)) out.push('Business types updated');
  if (!same(before.localRegistration, after.localRegistration)) out.push(`${after.localRegistration.label} rule updated`);
  if (!same(before.taxId, after.taxId)) out.push(`${after.taxId.label} rule updated`);
  for (const f of after.bankFields) {
    const old = before.bankFields.find((x) => x.key === f.key);
    if (!old) out.push(`Bank field added: ${f.label}`);
    else if (!same(old, f)) out.push(`Bank field updated: ${f.label}${old.required !== f.required ? (f.required ? ' (now required)' : ' (now optional)') : ''}`);
  }
  for (const doc of after.documents) {
    const old = before.documents.find((x) => x.type === doc.type);
    if (!old) out.push(`Document added: ${doc.label}${doc.required ? ' (required)' : ''}`);
    else if (!same(old, doc)) out.push(`Document updated: ${doc.label}${old.required !== doc.required ? (doc.required ? ' (now required)' : ' (now optional)') : ''}`);
  }
  if (!same(before.directors, after.directors)) out.push('Director and owner rules updated');
  return out;
}
