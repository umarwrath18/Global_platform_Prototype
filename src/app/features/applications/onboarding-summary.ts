import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { APPROVAL_PRIORITY_LABEL, ApplicationStatus, ApplicationSummary, priorityRank } from '../../core/merchants/merchant-models';
import { countryName } from '../../core/merchants/onboarding-config';
import { Icon, IconName } from '../../shared/icon';
import { fmtRelative } from '../../shared/merchant-ui';

export type SummaryQueue = 'sales' | 'risk' | 'cs' | 'operational';

interface Stat {
  key: string;
  label: string;
  icon: IconName;
  statuses: ApplicationStatus[];
  queue: SummaryQueue;
  note: (apps: ApplicationSummary[]) => string;
}

const IN_READINESS: ApplicationStatus[] = ['risk_approved', 'cs_configuration', 'keys_generated', 'integration', 'go_live_verification'];

const STATS: Stat[] = [
  { key: 'draft', label: 'Drafts', icon: 'edit', statuses: ['draft'], queue: 'sales', note: () => 'With Sales / Ops' },
  { key: 'review', label: 'Pending review', icon: 'shield', statuses: ['pending_risk_review'], queue: 'risk', note: (a) => (a.some((x) => x.submissionCount > 1) ? `${a.filter((x) => x.submissionCount > 1).length} resubmitted` : 'With Risk') },
  { key: 'returned', label: 'Returned', icon: 'alert-circle', statuses: ['returned'], queue: 'sales', note: () => 'With Sales / Ops' },
  { key: 'readiness', label: 'In readiness', icon: 'clock', statuses: IN_READINESS, queue: 'cs', note: (a) => `${a.filter((x) => x.status === 'go_live_verification').length} in go-live checks` },
  { key: 'operational', label: 'Operational', icon: 'check-circle', statuses: ['operational'], queue: 'operational', note: () => 'Live' },
];

interface Attention {
  tone: 'warning' | 'info' | 'progress';
  icon: IconName;
  title: string;
  meta: string;
  impact: string;
  app: ApplicationSummary;
}

/** Merchant onboarding figures for the Applications page: a summary strip and what needs attention. */
@Component({
  selector: 'app-onboarding-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  template: `
    <section class="strip" aria-label="Onboarding summary">
      @for (s of stats(); track s.key) {
        <button type="button" class="stat" [class.on]="activeQueue() === s.queue && s.value > 0" (click)="queue.emit(s.queue)" [attr.aria-label]="s.label + ': ' + s.value + '. Show the queue.'">
          <span class="s-label"><app-icon [name]="s.icon" [size]="15" />{{ s.label }}</span>
          <span class="s-value">{{ s.value }}</span>
          <span class="s-note">{{ s.note }}</span>
        </button>
      }
    </section>

    <section class="panel-card attention">
      <div class="panel-head">
        <div>
          <h2>Needs attention</h2>
          <p>{{ attention().length ? attention().length + ' open' : 'Nothing waiting' }}</p>
        </div>
      </div>
      <ul class="att-list">
        @for (a of shown(); track a.app.id) {
          <li>
            <a [routerLink]="['/applications', a.app.id]">
              <span class="att-icon" [class]="'att-icon ' + a.tone"><app-icon [name]="a.icon" [size]="16" /></span>
              <span class="att-text">
                <strong>{{ a.title }}@if (a.app.status === 'pending_risk_review') {<span class="p-tag" [class]="'p-tag ' + a.app.priority">{{ priorityLabel[a.app.priority] }}</span>}</strong>
                <span>{{ a.meta }} · {{ a.impact }}</span>
              </span>
              <app-icon name="chevron-right" [size]="16" class="chev" />
            </a>
          </li>
        } @empty {
          <li class="att-empty"><app-icon name="check-circle" [size]="18" />You're all caught up.</li>
        }
      </ul>
      @if (attention().length > 5) {
        <button type="button" class="att-more" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()">{{ expanded() ? 'Show fewer' : 'Show ' + (attention().length - 5) + ' more' }}</button>
      }
    </section>
  `,
  styleUrl: './onboarding-summary.scss',
})
export class OnboardingSummary {
  /** Applications after the top-bar filters. */
  readonly apps = input.required<ApplicationSummary[]>();
  readonly activeQueue = input<string>('');
  readonly queue = output<SummaryQueue>();

  protected readonly expanded = signal(false);
  protected readonly priorityLabel = APPROVAL_PRIORITY_LABEL;

  protected readonly stats = computed(() =>
    STATS.map((s) => {
      const own = this.apps().filter((a) => s.statuses.includes(a.status));
      return { ...s, value: own.length, note: s.note(own) };
    }),
  );

  protected readonly attention = computed<Attention[]>(() => {
    const items: Attention[] = [];
    for (const a of this.apps()) {
      const c = countryName(a.country);
      if (a.status === 'returned') {
        items.push({ tone: 'warning', icon: 'alert-circle', title: `${a.merchantName} was returned for correction`, meta: `${c} · returned ${fmtRelative(a.updatedAt)}`, impact: 'Sales / Ops to update and resubmit', app: a });
      } else if (a.status === 'pending_risk_review') {
        items.push({ tone: 'info', icon: 'shield', title: `${a.merchantName} is waiting for Risk`, meta: `${c} · ${a.submissionCount > 1 ? 'resubmitted' : 'submitted'} ${fmtRelative(a.updatedAt)}`, impact: 'Risk to review', app: a });
      } else if (a.status === 'go_live_verification' || a.status === 'risk_approved') {
        items.push({ tone: 'progress', icon: 'clock', title: a.status === 'risk_approved' ? `${a.merchantName} is approved and ready for setup` : `${a.merchantName} is in go-live checks`, meta: `${c} · updated ${fmtRelative(a.updatedAt)}`, impact: 'Customer Success to continue', app: a });
      }
    }
    // Highest approval priority first, then the oldest.
    return items.sort((x, y) => priorityRank(x.app.priority) - priorityRank(y.app.priority) || x.app.updatedAt - y.app.updatedAt);
  });

  protected readonly shown = computed(() => (this.expanded() ? this.attention() : this.attention().slice(0, 5)));
}
