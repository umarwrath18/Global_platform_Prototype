/**
 * Host Management (Batch 5A): the technical payment-processing providers Mobi connects to.
 *
 * A host is not a partner: a Partner is the commercial relationship, a Host is the technical
 * provider. A host may be linked to one partner; a partner may have several hosts. Pricing (MDR)
 * stays in pricing configuration and is not part of a host.
 *
 * The data is kept apart on purpose (host, capabilities, integration, health, activity) so the
 * future Routing Management and Smart Routing modules can read capabilities, availability and
 * operational status without knowing any provider's API. Provider-specific request and response
 * handling belongs in the integration adapter the host points to, never here or in routing.
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

/** How far the technical integration is (separate from whether the host may be used). */
export type IntegrationStatus = 'not_configured' | 'incomplete' | 'configured' | 'testing' | 'verified' | 'error';
export const INTEGRATION_STATUS_LABEL: Record<IntegrationStatus, string> = {
  not_configured: 'Not Configured',
  incomplete: 'Configuration Incomplete',
  configured: 'Configured',
  testing: 'Testing',
  verified: 'Verified',
  error: 'Integration Error',
};

/** Whether the host may be used (future routing). Attention Required is derived, never set by hand. */
export type OperationalStatus = 'active' | 'disabled' | 'maintenance' | 'attention';
export const OPERATIONAL_STATUS_LABEL: Record<OperationalStatus, string> = {
  active: 'Active',
  disabled: 'Disabled',
  maintenance: 'Maintenance',
  attention: 'Attention Required',
};
/** What an authorised user sets; `attention` is derived from it. */
export type OperationalState = 'active' | 'disabled' | 'maintenance';

export type AvailabilityStatus = 'available' | 'unavailable' | 'disabled';
export const AVAILABILITY_LABEL: Record<AvailabilityStatus, string> = { available: 'Available', unavailable: 'Unavailable', disabled: 'Disabled' };

export type HealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'unknown';
export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = { healthy: 'Healthy', degraded: 'Degraded', unreachable: 'Unreachable', unknown: 'Unknown' };

export type PaymentFlow = 'payin' | 'payout';
export const PAYMENT_FLOW_LABEL: Record<PaymentFlow, string> = { payin: 'PayIn', payout: 'Payout' };

export type ValidationResult = 'valid' | 'incomplete' | 'failed';
export const VALIDATION_RESULT_LABEL: Record<ValidationResult, string> = { valid: 'Configuration Valid', incomplete: 'Configuration Incomplete', failed: 'Validation Failed' };

// ------------------------------------------------------------------ entities

/** Commercial relationship (reference list only until the Partner module exists in this app). */
export interface Partner {
  id: string;
  name: string;
  country: string;
  sample: true;
}

export interface Host {
  id: string;
  hostCode: string;
  name: string;
  description: string;
  hostType: HostType;
  associatedPartnerId: string | null;
  registrationCountry: string;
  ownerTeam: string;
  notes: string;
  /** Saved with Save as Draft: incomplete, never operational. */
  draft: boolean;
  /** Set by authorised users; the effective status adds Attention Required. */
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
  /** Opaque reference to where the credential lives; generated by Mobi, never the secret itself. */
  credentialReference: string | null;
  credentialUpdatedAt: number | null;
  credentialUpdatedBy: string | null;
  timeoutSeconds: number | null;
  connectionConfig: string;
  notes: string;
  lastValidation: { result: ValidationResult; at: number; by: string; messages: string[]; fingerprint: string } | null;
  updatedAt: number;
}

export interface HostHealthCheck {
  id: string;
  hostId: string;
  status: HealthStatus;
  responseTimeMs: number | null;
  checkedAt: number;
  message: string;
  by: string;
  /** Always true in the prototype: no live connection test exists. */
  simulated: true;
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

export interface HostIntegrationView extends Omit<HostIntegration, 'credentialReference'> {
  /** Masked for display, e.g. "cred_••••7Q2K". */
  credentialReferenceMasked: string | null;
  configurationStatus: IntegrationStatus;
  missing: string[];
}

export interface HostView extends Host {
  integrationStatus: IntegrationStatus;
  operationalStatus: OperationalStatus;
  partnerName: string | null;
  markets: string[];
  paymentMethods: string[];
  lastHealth: HostHealthCheck | null;
  /** 0–100: basic information, capabilities, integration and validation. */
  completion: number;
}

export interface HostListResponse {
  hosts: HostView[];
  partners: Partner[];
  summary: { total: number; active: number; inactive: number; attention: number };
  can: { manage: boolean };
  sampleData: true;
}

export interface HostDetailResponse {
  host: HostView;
  capabilities: HostCapabilityView[];
  integration: HostIntegrationView | null;
  health: HostHealthCheck[];
  activity: HostActivity[];
  partner: Partner | null;
  /** Why Enable is not possible yet (empty when it is). */
  enableBlockers: string[];
  can: { manage: boolean };
  sampleData: true;
}

export interface HostHealthRow {
  hostId: string;
  hostName: string;
  hostCode: string;
  countries: string[];
  paymentMethods: string[];
  status: HealthStatus;
  checkedAt: number | null;
  responseTimeMs: number | null;
  recentError: string | null;
}

/** Add / Edit host (the four steps). */
export interface HostDraftInput {
  draft: boolean;
  basic: Pick<Host, 'name' | 'hostCode' | 'description' | 'hostType' | 'associatedPartnerId' | 'registrationCountry' | 'ownerTeam' | 'notes'>;
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

const URL_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?(\/\S*)?$/i;

/** Required integration fields that are empty (labels as on screen). */
export function integrationMissing(i: Pick<HostIntegration, 'integrationName' | 'adapterType' | 'apiBaseUrl' | 'environment' | 'authenticationType' | 'authConfig' | 'credentialReference'> | null): string[] {
  if (!i) return ['Integration'];
  const out: string[] = [];
  if (!i.integrationName?.trim()) out.push('Integration Name');
  if (!i.adapterType) out.push('Integration Adapter');
  if (!i.apiBaseUrl?.trim()) out.push('API Base URL');
  if (!i.environment) out.push('Environment');
  if (!i.authenticationType) out.push('Authentication Method');
  const a = i.authConfig ?? {};
  if (i.authenticationType === 'api_key' && !a.keyHeader?.trim()) out.push('API key header');
  if (i.authenticationType === 'api_key_secret' && !a.keyHeader?.trim()) out.push('API key header');
  if (i.authenticationType === 'oauth2' && !a.tokenUrl?.trim()) out.push('Token URL');
  if (i.authenticationType === 'oauth2' && !a.clientId?.trim()) out.push('Client ID');
  if (i.authenticationType === 'other' && !a.description?.trim()) out.push('Authentication details');
  if (i.authenticationType && !i.credentialReference) out.push('Credential reference');
  return out;
}

/** What the configuration looks like now; validation is current only while this is unchanged. */
export function integrationFingerprint(i: Pick<HostIntegration, 'adapterType' | 'apiBaseUrl' | 'apiVersion' | 'environment' | 'authenticationType' | 'authConfig' | 'credentialReference' | 'timeoutSeconds'>): string {
  return JSON.stringify([i.adapterType, i.apiBaseUrl.trim(), i.apiVersion.trim(), i.environment, i.authenticationType, i.authConfig, i.credentialReference, i.timeoutSeconds]);
}

/** Not Configured → Configuration Incomplete → Configured → Testing (sandbox) / Verified (production), or Integration Error. */
export function integrationStatusOf(i: HostIntegration | null): IntegrationStatus {
  if (!i) return 'not_configured';
  if (integrationMissing(i).length) return 'incomplete';
  const v = i.lastValidation;
  if (!v || v.fingerprint !== integrationFingerprint(i)) return 'configured';
  if (v.result === 'failed') return 'error';
  if (v.result === 'incomplete') return 'incomplete';
  return i.environment === 'production' ? 'verified' : 'testing';
}

/** Simulated validation: checks the saved configuration only. It never contacts the provider. */
export function validateIntegration(i: HostIntegration): { result: ValidationResult; messages: string[] } {
  const missing = integrationMissing(i);
  if (missing.length) return { result: 'incomplete', messages: missing.map((m) => `${m} is missing.`) };
  const problems: string[] = [];
  const url = i.apiBaseUrl.trim();
  if (!URL_RE.test(url)) problems.push('API Base URL is not a valid URL.');
  else if (i.environment === 'production' && !url.toLowerCase().startsWith('https://')) problems.push('Production endpoints must use https.');
  else if (i.environment === 'production' && /sandbox|staging|test|uat/i.test(url)) problems.push('The production endpoint looks like a test URL (contains sandbox, staging, test or UAT).');
  if (i.timeoutSeconds !== null && (i.timeoutSeconds < 5 || i.timeoutSeconds > 120)) problems.push('Request timeout must be between 5 and 120 seconds.');
  const a = i.authConfig ?? {};
  if (i.authenticationType === 'oauth2' && a.tokenUrl && !URL_RE.test(a.tokenUrl.trim())) problems.push('Token URL is not a valid URL.');
  if (problems.length) return { result: 'failed', messages: problems };
  return { result: 'valid', messages: ['All required fields are set and the endpoint format is valid. Simulated check: no request was sent to the provider.'] };
}

/**
 * Effective operational status: an Active host needs attention when its last check was Unreachable
 * or its integration is no longer Verified (an error, or changed since it was validated).
 */
export function operationalStatusOf(host: Pick<Host, 'operationalState'>, integration: IntegrationStatus, lastHealth: HostHealthCheck | null): OperationalStatus {
  if (host.operationalState !== 'active') return host.operationalState;
  if (integration !== 'verified' || lastHealth?.status === 'unreachable') return 'attention';
  return 'active';
}

/** Why a host can't be enabled yet (empty = it can). */
export function enableBlockers(host: Pick<Host, 'draft'>, integration: IntegrationStatus, capabilities: Pick<HostCapability, 'availabilityStatus'>[]): string[] {
  const out: string[] = [];
  if (host.draft) out.push('Finish the host: it is saved as a draft.');
  if (integration !== 'verified') out.push(`The integration must be Verified (validated with the Production environment); it is ${INTEGRATION_STATUS_LABEL[integration]}.`);
  if (!capabilities.some((c) => c.availabilityStatus === 'available')) out.push('At least one payment capability must be Available.');
  return out;
}

/** Share of setup done: basic information, a capability, a complete integration, a passed validation. */
export function completionOf(host: Pick<Host, 'name' | 'hostCode' | 'hostType' | 'registrationCountry' | 'ownerTeam'>, capabilities: unknown[], integration: IntegrationStatus): number {
  let n = 0;
  if (host.name && host.hostCode && host.hostType && host.registrationCountry && host.ownerTeam) n += 25;
  if (capabilities.length) n += 25;
  if (integration !== 'not_configured' && integration !== 'incomplete') n += 25;
  if (integration === 'testing' || integration === 'verified') n += 25;
  return n;
}

/** Host Code: 2–20 letters, digits, dashes or underscores, stored in capitals. */
export const HOST_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;

export function maskReference(ref: string | null): string | null {
  if (!ref) return null;
  return `${ref.slice(0, 5)}••••${ref.slice(-4)}`;
}
