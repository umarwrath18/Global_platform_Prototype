/**
 * Host Management: the payment providers (hosts) Mobi connects to. Two jobs: register a provider
 * with the countries and payment methods it handles, and switch the host, or one of its methods,
 * on and off. Pricing (MDR) stays in pricing configuration and is not part of a host.
 *
 * One status per host: Draft · Active · Disabled · Maintenance. Setup completeness is a checklist,
 * not a second status. No credentials are kept here and no health or connection data is shown:
 * monitoring comes when real provider data exists.
 *
 * The data is kept apart on purpose (host, capabilities, integration, activity) so the future
 * Routing Management module can read capabilities, availability and status without knowing any
 * provider's API. Provider-specific handling belongs in the integration adapter, never here.
 */

import { CORRIDORS } from '../merchants/products';
import { ONBOARDING_COUNTRIES, REGISTRATION_COUNTRIES, countryName } from '../merchants/onboarding-config';

// ------------------------------------------------------------------ reference lists

export type HostType = 'bank' | 'payment_gateway' | 'payment_aggregator' | 'ewallet_provider' | 'other';
/** Initial list, not an approved taxonomy: add entries here. */
export const HOST_TYPES: { id: HostType; label: string }[] = [
  { id: 'bank', label: 'Bank' },
  { id: 'payment_gateway', label: 'Payment Gateway' },
  { id: 'payment_aggregator', label: 'Payment Aggregator' },
  { id: 'ewallet_provider', label: 'E-wallet Provider' },
  { id: 'other', label: 'Other' },
];
export const hostTypeLabel = (t: HostType) => HOST_TYPES.find((x) => x.id === t)?.label ?? t;

/** Integration adapter profiles of Mobi's integration layer (sample list). */
export const HOST_ADAPTERS: { id: string; label: string; description: string }[] = [
  { id: 'mobi_rest_v1', label: 'Mobi Standard REST adapter', description: 'JSON over HTTPS, mapped to the Mobi payment interface.' },
  { id: 'mobi_iso8583', label: 'Mobi ISO 8583 adapter', description: 'Card and bank switch messages.' },
  { id: 'mobi_h2h_file', label: 'Mobi bank host-to-host (file) adapter', description: 'Batch files over SFTP, e.g. bulk payouts.' },
  { id: 'custom', label: 'Custom adapter (to be built)', description: 'Provider needs its own adapter in the integration layer.' },
];
export const adapterLabel = (id: string) => HOST_ADAPTERS.find((a) => a.id === id)?.label ?? id;

export type HostEnvironment = 'sandbox' | 'production';
export const HOST_ENVIRONMENT_LABEL: Record<HostEnvironment, string> = { sandbox: 'Sandbox', production: 'Production' };

export type AuthMethod = 'api_key' | 'api_key_secret' | 'oauth2' | 'mtls' | 'other';
export const AUTH_METHOD_LABEL: Record<AuthMethod, string> = {
  api_key: 'API Key',
  api_key_secret: 'API Key + Secret',
  oauth2: 'OAuth 2.0',
  mtls: 'Mutual TLS',
  other: 'Other',
};

// ------------------------------------------------------------------ statuses

/** The one host status. Draft = saved incomplete; never set by hand otherwise. */
export type HostStatus = 'draft' | 'active' | 'disabled' | 'maintenance';
export const HOST_STATUS_LABEL: Record<HostStatus, string> = { draft: 'Draft', active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance' };
/** What Tech Ops sets with Enable / Disable / Maintenance. */
export type OperationalState = 'active' | 'disabled' | 'maintenance';

export type AvailabilityStatus = 'available' | 'unavailable' | 'disabled';
export const AVAILABILITY_LABEL: Record<AvailabilityStatus, string> = { available: 'Available', unavailable: 'Unavailable', disabled: 'Disabled' };

export type PaymentFlow = 'payin' | 'payout';
export const PAYMENT_FLOW_LABEL: Record<PaymentFlow, string> = { payin: 'PayIn', payout: 'Payout' };

// ------------------------------------------------------------------ entities

export interface Host {
  id: string;
  hostCode: string;
  name: string;
  description: string;
  hostType: HostType;
  registrationCountry: string;
  ownerTeam: string;
  notes: string;
  /** Saved with Save as Draft: incomplete, never operational. */
  draft: boolean;
  /** Set by Tech Ops; the host's status is Draft while `draft`, otherwise this. */
  operationalState: OperationalState;
  maintenance: { reason: string; until: number | null; since: number; by: string } | null;
  disabledReason: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  /** Prototype sample record (not a live integration). */
  sample: boolean;
}

export interface HostCapability {
  id: string;
  hostId: string;
  countryCode: string;
  /** From the country's payment-method catalogue (onboarding configuration). */
  paymentMethodCode: string;
  /** Follows the method: a method is PayIn or Payout; a provider doing both has two rows. */
  paymentFlow: PaymentFlow;
  supportedCurrencies: string[];
  availabilityStatus: AvailabilityStatus;
  createdAt: number;
  updatedAt: number;
}

/** Auth details that are not secrets (header names, client IDs, token URLs). Secrets are never entered. */
export interface HostAuthConfig {
  keyHeader?: string;
  signature?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  description?: string;
}

export interface HostIntegration {
  id: string;
  hostId: string;
  integrationName: string;
  adapterType: string;
  apiBaseUrl: string;
  apiVersion: string;
  environment: HostEnvironment;
  authenticationType: AuthMethod | null;
  authConfig: HostAuthConfig;
  timeoutSeconds: number | null;
  connectionConfig: string;
  notes: string;
  updatedAt: number;
}

export interface HostActivity {
  id: string;
  hostId: string;
  hostName: string;
  action: string;
  performedBy: string;
  timestamp: number;
  details: string;
}

// ------------------------------------------------------------------ views (API responses)

export interface HostCapabilityView extends HostCapability {
  countryName: string;
  paymentMethodName: string;
}

export interface HostIntegrationView extends HostIntegration {
  /** Required integration details still empty (labels as on screen). */
  missing: string[];
}

/** One line of the setup checklist. */
export interface SetupItem {
  id: 'basic' | 'methods' | 'integration' | 'production';
  label: string;
  done: boolean;
}

export interface HostView extends Host {
  status: HostStatus;
  markets: string[];
  paymentMethods: string[];
  checklist: SetupItem[];
}

export interface HostListResponse {
  hosts: HostView[];
  summary: { total: number; active: number; disabled: number; maintenance: number; draft: number };
  can: { manage: boolean };
  sampleData: true;
}

export interface HostDetailResponse {
  host: HostView;
  capabilities: HostCapabilityView[];
  integration: HostIntegrationView | null;
  activity: HostActivity[];
  /** Why Enable is not possible yet (empty when it is). */
  enableBlockers: string[];
  can: { manage: boolean };
  sampleData: true;
}

/** Add / Edit host (the steps of the editor). */
export interface HostDraftInput {
  draft: boolean;
  basic: Pick<Host, 'name' | 'hostCode' | 'description' | 'hostType' | 'registrationCountry' | 'ownerTeam' | 'notes'>;
  capabilities: Pick<HostCapability, 'countryCode' | 'paymentMethodCode' | 'availabilityStatus'>[];
  integration: Pick<HostIntegration, 'integrationName' | 'adapterType' | 'apiBaseUrl' | 'apiVersion' | 'environment' | 'authenticationType' | 'authConfig' | 'timeoutSeconds' | 'connectionConfig' | 'notes'> | null;
}

export interface HostFieldError {
  field: string;
  message: string;
}

// ------------------------------------------------------------------ catalogue (shared, not a second list)

/** Countries hosts can serve: the launched corridors of the onboarding configuration. */
export function hostCountries(): { code: string; name: string; currency: string }[] {
  return CORRIDORS.filter((c) => ONBOARDING_COUNTRIES[c]).map((c) => ({ code: c, name: ONBOARDING_COUNTRIES[c].name, currency: ONBOARDING_COUNTRIES[c].currency }));
}

/** Payment methods configured for a country (same catalogue as products and pricing). */
export function hostMethods(country: string): { code: string; name: string; flow: PaymentFlow; group?: string }[] {
  return (ONBOARDING_COUNTRIES[country]?.paymentMethods ?? []).map((m) => ({ code: m.code, name: m.name, flow: m.flow, ...(m.group ? { group: m.group } : {}) }));
}

export function methodName(country: string, code: string): string {
  return hostMethods(country).find((m) => m.code === code)?.name ?? code;
}

export const registrationCountries = () => REGISTRATION_COUNTRIES;
export const hostCountryName = countryName;

// ------------------------------------------------------------------ rules

/** Required integration details that are empty (labels as on screen). Nothing secret is asked for. */
export function integrationMissing(i: Pick<HostIntegration, 'integrationName' | 'adapterType' | 'apiBaseUrl' | 'environment' | 'authenticationType' | 'authConfig'> | null): string[] {
  if (!i) return ['Integration'];
  const out: string[] = [];
  if (!i.integrationName?.trim()) out.push('Integration Name');
  if (!i.adapterType) out.push('Integration Adapter');
  if (!i.apiBaseUrl?.trim()) out.push('API Base URL');
  if (!i.environment) out.push('Environment');
  if (!i.authenticationType) out.push('Authentication Method');
  const a = i.authConfig ?? {};
  if ((i.authenticationType === 'api_key' || i.authenticationType === 'api_key_secret') && !a.keyHeader?.trim()) out.push('API key header');
  if (i.authenticationType === 'oauth2' && !a.tokenUrl?.trim()) out.push('Token URL');
  if (i.authenticationType === 'oauth2' && !a.clientId?.trim()) out.push('Client ID');
  if (i.authenticationType === 'other' && !a.description?.trim()) out.push('Authentication details');
  return out;
}

export const statusOf = (h: Pick<Host, 'draft' | 'operationalState'>): HostStatus => (h.draft ? 'draft' : h.operationalState);

/** Setup checklist: what a host needs before it can be enabled. */
export function checklistOf(host: Pick<Host, 'name' | 'hostCode' | 'hostType' | 'registrationCountry' | 'ownerTeam' | 'draft'>, capabilities: Pick<HostCapability, 'availabilityStatus'>[], integration: HostIntegration | null): SetupItem[] {
  return [
    { id: 'basic', label: 'Basic information complete', done: !host.draft && !!(host.name && host.hostCode && host.hostType && host.registrationCountry && host.ownerTeam) },
    { id: 'methods', label: 'At least one payment method Available', done: capabilities.some((c) => c.availabilityStatus === 'available') },
    { id: 'integration', label: 'Integration details complete', done: !!integration && !integrationMissing(integration).length },
    { id: 'production', label: 'Production endpoint set', done: integration?.environment === 'production' },
  ];
}

/** Why a host can't be enabled yet (empty = it can): the open checklist items. */
export function enableBlockers(checklist: SetupItem[]): string[] {
  const text: Record<SetupItem['id'], string> = {
    basic: 'Finish the basic information (the host is saved as a draft).',
    methods: 'Make at least one payment method Available.',
    integration: 'Complete the integration details.',
    production: 'Set the Production endpoint: a Sandbox endpoint cannot take live payments.',
  };
  return checklist.filter((c) => !c.done).map((c) => text[c.id]);
}

/** Host Code: 2–20 letters, digits, dashes or underscores, stored in capitals. */
export const HOST_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;
