import { AvailabilityStatus, HostStatus } from '../../core/hosts/hosts';

/** Badge tones (global `.status` classes): one colour language for host and method statuses. */
export function statusTone(s: HostStatus): string {
  return { draft: 'status info', active: 'status success', disabled: 'status', maintenance: 'status warning' }[s];
}

export function availabilityTone(s: AvailabilityStatus): string {
  return { available: 'status success', unavailable: 'status warning', disabled: 'status' }[s];
}

export function fmtWhen(t: number | null | undefined): string {
  if (!t) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
}
