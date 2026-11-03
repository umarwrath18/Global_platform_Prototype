import { FieldIssue } from './merchant-models';
import { ONBOARDING_COUNTRIES } from './onboarding-config';

// Merchant category codes (MCC), shared by the portal and the simulated backend.
//
// The MCC belongs to the parent merchant (GMID) only; sub-merchants use their parent's. Codes come
// from one catalogue with per-country availability. An MCC is required before any country
// application can be submitted. No approved catalogue has been supplied yet, so the catalogue is
// empty by default and applications can't be submitted until one covers their country. A clearly
// labelled test fixture can be loaded on request for testing (see mcc-test-fixture.ts); it is never
// approved data.

/** `restricted`: may be selected, but is flagged for Risk review. Countries not listed: not available. */
export type MccAvailability = 'available' | 'restricted';

export interface MccCatalogueEntry {
  /** Four-digit code. */
  code: string;
  /** Official description as supplied by the catalogue source. */
  description: string;
  countries: Record<string, MccAvailability>;
}

export interface MccCatalogueSource {
  kind: 'approved' | 'test_fixture';
  name: string;
  version: string;
  loadedAt: number;
}

export interface MccCatalogue {
  /** Null while no catalogue has been loaded. */
  source: MccCatalogueSource | null;
  entries: MccCatalogueEntry[];
}

export const EMPTY_MCC_CATALOGUE: MccCatalogue = { source: null, entries: [] };

export interface MccRef {
  code: string;
  description: string;
}

/** The MCC assigned to a parent merchant. */
export interface MerchantMcc extends MccRef {
  catalogueVersion: string;
  catalogueKind: MccCatalogueSource['kind'];
  setAt: number;
  setBy: string;
}

export interface MccOption extends MccRef {
  availability: MccAvailability;
}

export type MccRequestStatus = 'pending' | 'approved' | 'rejected';

/** A change to an approved merchant's MCC. It takes effect only when Risk approves it. */
export interface MccChangeRequest {
  id: string;
  merchantId: string;
  previous: MccRef | null;
  proposed: MccRef;
  reason: string;
  /** Countries (with open or live applications) where the proposed MCC is restricted. */
  restrictedIn: string[];
  requestedBy: string;
  requestedRole: string;
  requestedAt: number;
  status: MccRequestStatus;
  decidedBy: string | null;
  decidedRole: string | null;
  decidedAt: number | null;
  decisionComment: string | null;
}

/**
 * MCC audit history. `set_before_approval`: changed directly before the merchant's first Risk
 * approval. The other outcomes follow a change request through Risk's decision.
 */
export type MccAuditOutcome = 'set_before_approval' | 'change_requested' | 'change_approved' | 'change_rejected';

export interface MccAuditEvent {
  at: number;
  merchantId: string;
  outcome: MccAuditOutcome;
  previous: MccRef | null;
  next: MccRef | null;
  reason: string;
  requestId: string | null;
  requestedBy: string;
  requestedRole: string;
  requestedAt: number;
  decidedBy: string | null;
  decidedRole: string | null;
  decidedAt: number | null;
  comment: string | null;
  restrictedIn: string[];
}

export const MCC_OUTCOME_LABEL: Record<MccAuditOutcome, string> = {
  set_before_approval: 'MCC set',
  change_requested: 'MCC change requested',
  change_approved: 'MCC change approved',
  change_rejected: 'MCC change rejected',
};

export const mccLabel = (m: MccRef | null | undefined) => (m ? `${m.code} – ${m.description}` : 'None');

/** True when the catalogue has rules for the country, so an MCC can be selected there. */
export function catalogueCovers(catalogue: MccCatalogue, country: string): boolean {
  return catalogue.entries.some((e) => !!e.countries[country]);
}

export function mccAvailability(catalogue: MccCatalogue, code: string, country: string): MccAvailability | null {
  return catalogue.entries.find((e) => e.code === code)?.countries[country] ?? null;
}

export function mccOptionsFor(catalogue: MccCatalogue, country: string): MccOption[] {
  return catalogue.entries
    .filter((e) => e.countries[country])
    .map((e) => ({ code: e.code, description: e.description, availability: e.countries[country] }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Checks an MCC against the countries it must work in. Countries the catalogue doesn't cover
 * impose no rule. Returns the countries where it is unavailable and where it is restricted.
 */
export function mccCountryCheck(catalogue: MccCatalogue, code: string, countries: string[]): { unavailable: string[]; restricted: string[] } {
  const unavailable: string[] = [];
  const restricted: string[] = [];
  for (const c of new Set(countries)) {
    if (!catalogueCovers(catalogue, c)) continue;
    const a = mccAvailability(catalogue, code, c);
    if (!a) unavailable.push(c);
    else if (a === 'restricted') restricted.push(c);
  }
  return { unavailable, restricted };
}

/**
 * The MCC rule for one country application: an MCC available in the country is always required.
 * Without a catalogue for the country none can be selected, so the application can't be submitted.
 */
export function mccIssue(catalogue: MccCatalogue, country: string, mcc: MccRef | null | undefined): FieldIssue | null {
  const name = ONBOARDING_COUNTRIES[country]?.name ?? country;
  if (!catalogueCovers(catalogue, country)) return { section: 'business', field: 'business.mcc', message: `No MCC catalogue is configured for ${name}, so an MCC can't be selected yet. The application can be submitted once one is.` };
  if (!mcc) return { section: 'business', field: 'business.mcc', message: 'Select the merchant category code (MCC).' };
  if (!mccAvailability(catalogue, mcc.code, country)) return { section: 'business', field: 'business.mcc', message: `MCC ${mcc.code} is not available in ${name}.` };
  return null;
}

/** Validates a catalogue before it is loaded. Rejects the whole catalogue if anything is wrong. */
export function readMccCatalogueEntries(raw: unknown): { entries: MccCatalogueEntry[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { entries: [], errors: ['The catalogue must be a list of entries.'] };
  const entries: MccCatalogueEntry[] = [];
  const seen = new Set<string>();
  raw.forEach((e: any, i) => {
    const at = `Entry ${i + 1}`;
    const code = typeof e?.code === 'string' ? e.code.trim() : '';
    const description = typeof e?.description === 'string' ? e.description.trim() : '';
    if (!/^\d{4}$/.test(code)) errors.push(`${at}: the code must be four digits.`);
    else if (seen.has(code)) errors.push(`${at}: code ${code} appears more than once.`);
    seen.add(code);
    if (!description) errors.push(`${at}: the description is missing.`);
    const countries: Record<string, MccAvailability> = {};
    for (const [c, a] of Object.entries(e?.countries ?? {})) {
      if (!/^[A-Z]{2}$/.test(c)) errors.push(`${at}: "${c}" is not a two-letter country code.`);
      else if (a !== 'available' && a !== 'restricted') errors.push(`${at}: availability in ${c} must be "available" or "restricted".`);
      else countries[c] = a;
    }
    entries.push({ code, description: description.slice(0, 200), countries });
  });
  return { entries: errors.length ? [] : entries, errors };
}
