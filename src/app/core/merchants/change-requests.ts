import { ApplicationData, Director, DocumentRecord, GlobalMerchant, merchantCategoryLabel, StaffRole } from './merchant-models';
import { CountryOnboardingConfig, countryName } from './onboarding-config';

// Changes after Risk approval. Once Risk has approved a merchant, anything Risk reviewed (legal
// identity, and each country's business details, bank / settlement account, directors and
// beneficial owners, and documents) changes only through a request that Risk approves. Contact
// details stay directly editable and are recorded. MCC, products and pricing keep their own flows.

export type ChangeScope = 'merchant_profile' | 'country_details';
export type ChangeSection = 'identity' | 'business' | 'bank' | 'directors' | 'documents';
export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export const CHANGE_SECTION_LABEL: Record<ChangeSection, string> = {
  identity: 'Legal identity',
  business: 'Business details',
  bank: 'Bank / settlement account',
  directors: 'Directors & beneficial owners',
  documents: 'Documents',
};

export const CHANGE_STATUS_LABEL: Record<ChangeStatus, string> = { pending: 'Waiting for Risk', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' };

/** One field's change as shown and recorded. Sensitive values (bank account numbers) are masked here. */
export interface FieldChange {
  field: string;
  label: string;
  from: string;
  to: string;
}

export type IdentityValue = Pick<GlobalMerchant, 'legalName' | 'registrationCountry' | 'registrationNumber'>;
export type SectionValue = IdentityValue | ApplicationData['business'] | ApplicationData['bank'] | Director[] | DocumentRecord[];

/** A change request as the server stores it. `proposed` (the full new value) is never sent to the browser. */
export interface ChangeRequestRecord {
  id: string;
  scope: ChangeScope;
  section: ChangeSection;
  merchantId: string;
  applicationId: string | null;
  country: string | null;
  changes: FieldChange[];
  proposed: SectionValue;
  reason: string;
  requestedBy: string;
  requestedById: string;
  requestedRole: StaffRole;
  requestedAt: number;
  status: ChangeStatus;
  decidedBy: string | null;
  decidedRole: StaffRole | null;
  decidedAt: number | null;
  decisionComment: string | null;
}

export type ChangeRequest = Omit<ChangeRequestRecord, 'proposed' | 'requestedById'>;

/** Merchant profile history: direct edits and profile change requests. */
export interface ProfileEvent {
  at: number;
  merchantId: string;
  action: 'contact_updated' | 'identity_updated' | 'change_requested' | 'change_approved' | 'change_rejected' | 'change_withdrawn';
  changes: FieldChange[];
  reason: string | null;
  by: string;
  role: StaffRole;
  requestId: string | null;
  comment: string | null;
}

export const PROFILE_ACTION_LABEL: Record<ProfileEvent['action'], string> = {
  contact_updated: 'Contact details updated',
  identity_updated: 'Legal identity updated',
  change_requested: 'Identity change requested',
  change_approved: 'Identity change approved',
  change_rejected: 'Identity change rejected',
  change_withdrawn: 'Identity change withdrawn',
};

export interface CreateChangeRequest {
  section: ChangeSection;
  value: unknown;
  reason: string;
}

/** Bank fields shown masked everywhere outside the edit form. */
export const SENSITIVE_BANK_FIELDS = ['accountNumber'];

export function maskValue(value: string): string {
  const v = value.replace(/\s+/g, '');
  return v ? `•••• ${v.slice(-4)}` : '';
}

const shown = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? 'Not set' : String(v));

const BUSINESS_LABEL: Record<keyof ApplicationData['business'], string> = {
  tradingName: 'Trading name',
  businessType: 'Business type',
  merchantCategory: 'Merchant category',
  industry: 'Industry',
  website: 'Website',
  address: 'Business address',
  localRegistrationNumber: 'Local registration number',
  taxId: 'Tax ID',
  expectedMonthlyVolume: 'Expected monthly volume',
};

const ROLE_LABEL: Record<Director['role'], string> = { director: 'Director', beneficial_owner: 'Beneficial owner', director_and_owner: 'Director & owner' };
const person = (d: Director) => `${d.name || 'Unnamed'} (${ROLE_LABEL[d.role]}${d.ownershipPct !== null ? `, ${d.ownershipPct}%` : ''})`;

/** Field-by-field description of a change, with bank account numbers masked. */
export function describeChange(section: ChangeSection, before: SectionValue, after: SectionValue, cfg?: CountryOnboardingConfig): FieldChange[] {
  const out: FieldChange[] = [];
  const add = (field: string, label: string, from: string, to: string) => from !== to && out.push({ field, label, from, to });
  if (section === 'identity') {
    const a = before as IdentityValue;
    const b = after as IdentityValue;
    add('legalName', 'Legal name', a.legalName, b.legalName);
    add('registrationCountry', 'Registration country', countryName(a.registrationCountry), countryName(b.registrationCountry));
    add('registrationNumber', 'Registration number', a.registrationNumber, b.registrationNumber);
  } else if (section === 'business') {
    const a = before as ApplicationData['business'];
    const b = after as ApplicationData['business'];
    for (const key of Object.keys(BUSINESS_LABEL) as (keyof ApplicationData['business'])[]) {
      const label = key === 'localRegistrationNumber' && cfg ? cfg.localRegistration.label : key === 'taxId' && cfg ? cfg.taxId.label : BUSINESS_LABEL[key];
      const value = (v: (typeof a)[typeof key]) => (key === 'merchantCategory' ? (merchantCategoryLabel(v as string) ?? shown(v)) : shown(v));
      add(`business.${key}`, label, value(a[key]), value(b[key]));
    }
  } else if (section === 'bank') {
    const a = before as ApplicationData['bank'];
    const b = after as ApplicationData['bank'];
    const keys = cfg ? cfg.bankFields.map((f) => f.key) : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const label = cfg?.bankFields.find((f) => f.key === key)?.label ?? key;
      const mask = SENSITIVE_BANK_FIELDS.includes(key);
      if ((a[key] ?? '') === (b[key] ?? '')) continue;
      out.push({ field: `bank.${key}`, label, from: mask ? maskValue(a[key] ?? '') || 'Not set' : shown(a[key]), to: mask ? maskValue(b[key] ?? '') || 'Not set' : shown(b[key]) });
    }
  } else if (section === 'directors') {
    const a = (before as Director[]).map(person).join('; ');
    const b = (after as Director[]).map(person).join('; ');
    const idsChanged = JSON.stringify((before as Director[]).map(({ id: _, ...d }) => d)) !== JSON.stringify((after as Director[]).map(({ id: _, ...d }) => d));
    if (idsChanged) out.push({ field: 'directors', label: 'Directors & beneficial owners', from: a || 'None', to: b || 'None' });
  } else {
    const list = (docs: DocumentRecord[]) => docs.map((d) => `${cfg?.documents.find((r) => r.type === d.type)?.label ?? d.type}: ${d.fileName}`).join('; ');
    const a = list(before as DocumentRecord[]);
    const b = list(after as DocumentRecord[]);
    if (a !== b) out.push({ field: 'documents', label: 'Documents', from: a || 'None', to: b || 'None' });
  }
  return out;
}

/** An item on the shared Approvals page. Decisions happen on the linked page. */
export interface ApprovalItem {
  kind: 'change' | 'mcc' | 'pricing' | 'sub_merchant';
  id: string;
  title: string;
  merchantId: string;
  merchantName: string;
  applicationId: string | null;
  country: string | null;
  summary: string;
  requestedBy: string;
  requestedRole: string;
  requestedAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  approverTeam: StaffRole;
  decidedAt: number | null;
  link: string[];
  /** Query parameters for the link (e.g. which sub-merchant to open). */
  query?: Record<string, string>;
}

export interface ApprovalsView {
  /** Waiting for the acting team (Risk, FinOps), the team's own open requests (Sales / Operations), or all (CS, read only). */
  pending: ApprovalItem[];
  /** Recent decisions relevant to the acting team. */
  recent: ApprovalItem[];
  heading: string;
  canDecide: boolean;
}
