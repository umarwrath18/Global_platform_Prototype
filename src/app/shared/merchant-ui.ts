import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  APPLICATION_STATUS_LABEL,
  ApplicationStatus,
  GLOBAL_STATUS_LABEL,
  GlobalMerchantStatus,
} from '../core/merchants/merchant-models';

export type Tone = 'neutral' | 'info' | 'progress' | 'warning' | 'danger' | 'success';

export const APPLICATION_TONE: Record<ApplicationStatus, Tone> = {
  draft: 'neutral',
  pending_risk_review: 'info',
  returned: 'warning',
  rejected: 'danger',
  risk_approved: 'progress',
  cs_configuration: 'progress',
  keys_generated: 'progress',
  integration: 'progress',
  go_live_verification: 'progress',
  operational: 'success',
};

const GLOBAL_TONE: Record<GlobalMerchantStatus, Tone> = {
  onboarding: 'info',
  active: 'success',
  no_active_applications: 'neutral',
};

/** Status pill for country applications and Global Merchants. */
@Component({
  selector: 'app-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display:inline-flex' },
  template: `<span class="status" [class]="tone()">{{ prefix() ? prefix() + ' · ' : '' }}{{ label() }}</span>`,
})
export class StatusBadge {
  readonly status = input<ApplicationStatus | null>(null);
  readonly globalStatus = input<GlobalMerchantStatus | null>(null);
  readonly prefix = input<string>('');

  protected readonly label = computed(() => {
    const g = this.globalStatus();
    return g ? GLOBAL_STATUS_LABEL[g] : APPLICATION_STATUS_LABEL[this.status() ?? 'draft'];
  });
  protected readonly tone = computed(() => {
    const g = this.globalStatus();
    return 'status ' + (g ? GLOBAL_TONE[g] : APPLICATION_TONE[this.status() ?? 'draft']);
  });
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const fmtDate = (t: number) => DATE.format(t);
export const fmtDateTime = (t: number) => DATE_TIME.format(t);

export function fmtRelative(t: number, now = Date.now()): string {
  const diff = now - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return fmtDate(t);
}
