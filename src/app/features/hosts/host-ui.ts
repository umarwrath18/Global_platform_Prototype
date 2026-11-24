import { AvailabilityStatus, HealthStatus, IntegrationStatus, OperationalStatus } from '../../core/hosts/hosts';

/** Badge tones (global `.status` classes): one colour language for every host status. */
export function integrationTone(s: IntegrationStatus): string {
  return { not_configured: 'status', incomplete: 'status warning', configured: 'status info', testing: 'status info', verified: 'status success', error: 'status danger' }[s];
}

export function operationalTone(s: OperationalStatus): string {
  return { active: 'status success', disabled: 'status', maintenance: 'status warning', attention: 'status danger' }[s];
}

export function healthTone(s: HealthStatus): string {
  return { healthy: 'status success', degraded: 'status warning', unreachable: 'status danger', unknown: 'status' }[s];
}

export function availabilityTone(s: AvailabilityStatus): string {
  return { available: 'status success', unavailable: 'status warning', disabled: 'status' }[s];
}

export function fmtWhen(t: number | null | undefined): string {
  if (!t) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
}
