import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ClientError, toClientError } from '../../core/api/api-error';
import { CountryStatus, WorkspaceContext } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import { DATE_RANGE_LABEL, GlobalFilters } from '../../core/merchants/global-filters.service';
import { MerchantApi } from '../../core/merchants/merchant-api.service';
import { ApplicationStatus, ApplicationSummary, MerchantSummary, READINESS_STATUSES } from '../../core/merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { Icon, IconName } from '../../shared/icon';
import { fmtRelative } from '../../shared/merchant-ui';

const STATUS_LABEL: Record<CountryStatus, string> = {
  active: 'Active',
  pending: 'Activating',
  failed: 'Activation failed',
};

const WEEK = 7 * 24 * 60 * 60_000;
const IN_READINESS = READINESS_STATUSES.filter((s) => s !== 'operational');

type Segment = 'draft' | 'review' | 'returned' | 'readiness' | 'operational' | 'rejected';
const SEGMENT_OF: Record<ApplicationStatus, Segment> = {
  draft: 'draft',
  pending_risk_review: 'review',
  returned: 'returned',
  rejected: 'rejected',
  risk_approved: 'readiness',
  cs_configuration: 'readiness',
  keys_generated: 'readiness',
  integration: 'readiness',
  go_live_verification: 'readiness',
  operational: 'operational',
};

interface Kpi {
  label: string;
  value: number;
  delta: string;
  trend: 'up' | 'down' | 'flat';
  note: string;
  spark: number[] | null;
  link: string;
  queue?: string;
}

interface Attention {
  tone: 'warning' | 'info' | 'progress';
  icon: IconName;
  title: string;
  meta: string;
  impact: string;
  app: ApplicationSummary;
}

/**
 * Global overview. Batch 1 workspace/country access rules are unchanged (the Workspace
 * selector still routes to /dashboard/:country and is authorised by the server). The KPI,
 * pipeline and attention sections are computed from the prototype's merchant onboarding data
 * and follow the top-bar filters.
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly api = inject(MerchantApi);
  protected readonly filters = inject(GlobalFilters);

  /** Bound from the `:country` route parameter. */
  readonly country = input<string>();

  protected readonly session = this.auth.session;
  protected readonly context = signal<WorkspaceContext | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<ClientError | null>(null);
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly merchants = signal<MerchantSummary[]>([]);
  protected readonly dataLoading = signal(true);
  protected readonly dataError = signal(false);
  protected readonly loadedAt = signal(Date.now());
  protected readonly rel = fmtRelative;
  protected readonly countryName = (code: string) => ONBOARDING_COUNTRIES[code]?.name ?? code;

  protected readonly activeCountries = computed(() => this.session()?.countries.filter((c) => c.status === 'active') ?? []);
  protected readonly rangeLabel = computed(() => DATE_RANGE_LABEL[this.filters.range()]);

  /** Applications that pass the top-bar filters. */
  protected readonly apps = computed(() => this.merchants().flatMap((m) => m.applications).filter((a) => this.filters.matches(a)));

  protected readonly scopedMerchants = computed(() => {
    const f = this.filters;
    const appFilter = !!(f.country() || f.currency() || f.range() !== 'all');
    return this.merchants().filter(
      (m) => (!f.merchantId() || m.id === f.merchantId()) && (!appFilter || m.applications.some((a) => f.matches(a)) || (!f.country() && !f.currency() && m.createdAt >= f.since())),
    );
  });

  protected readonly kpis = computed<Kpi[]>(() => {
    const apps = this.apps();
    const recent = (list: { createdAt: number }[]) => list.filter((x) => x.createdAt >= Date.now() - 30 * 24 * 60 * 60_000).length;
    const count = (statuses: ApplicationStatus[]) => apps.filter((a) => statuses.includes(a.status)).length;
    const merchants = this.scopedMerchants();
    const newMerchants = recent(merchants);
    const newApps = recent(apps);
    const resubmitted = apps.filter((a) => a.status === 'pending_risk_review' && a.submissionCount > 1).length;
    return [
      { label: 'Merchants', value: merchants.length, delta: `+${newMerchants}`, trend: newMerchants ? 'up' : 'flat', note: 'in the last 30 days', spark: this.weekly(merchants.map((m) => m.createdAt), true), link: '/merchants' },
      { label: 'Applications', value: apps.length, delta: `+${newApps}`, trend: newApps ? 'up' : 'flat', note: 'in the last 30 days', spark: this.weekly(apps.map((a) => a.createdAt), true), link: '/applications', queue: 'all' },
      { label: 'Pending review', value: count(['pending_risk_review']), delta: '', trend: 'flat', note: resubmitted ? `${resubmitted} resubmitted` : 'No resubmissions', spark: null, link: '/applications', queue: 'risk' },
      { label: 'Returned', value: count(['returned']), delta: '', trend: 'flat', note: 'With Sales / Ops', spark: null, link: '/applications', queue: 'sales' },
      { label: 'In readiness', value: count(IN_READINESS), delta: '', trend: 'flat', note: `${count(['go_live_verification'])} in go-live checks`, spark: null, link: '/applications', queue: 'cs' },
      { label: 'Operational', value: count(['operational']), delta: '', trend: 'flat', note: `${count(['rejected'])} rejected`, spark: null, link: '/applications', queue: 'operational' },
    ];
  });

  /** Share of Risk decisions that were approvals (returns are not decisions). */
  protected readonly approvalRate = computed(() => {
    const apps = this.apps();
    const approved = apps.filter((a) => READINESS_STATUSES.includes(a.status)).length;
    const rejected = apps.filter((a) => a.status === 'rejected').length;
    return approved + rejected ? Math.round((approved / (approved + rejected)) * 1000) / 10 : null;
  });

  protected readonly stages = computed(() => {
    const apps = this.apps();
    const n = (s: Segment) => apps.filter((a) => SEGMENT_OF[a.status] === s).length;
    return [
      { label: 'Drafts', value: n('draft'), icon: 'edit' as IconName, tone: 'neutral', queue: 'sales' },
      { label: 'Pending review', value: n('review'), icon: 'shield' as IconName, tone: 'info', queue: 'risk' },
      { label: 'Returned', value: n('returned'), icon: 'alert-circle' as IconName, tone: 'warning', queue: 'sales' },
      { label: 'In readiness', value: n('readiness'), icon: 'clock' as IconName, tone: 'progress', queue: 'cs' },
    ];
  });

  protected readonly segments: { key: Segment; label: string }[] = [
    { key: 'operational', label: 'Operational' },
    { key: 'readiness', label: 'In readiness' },
    { key: 'review', label: 'Risk review' },
    { key: 'returned', label: 'Returned' },
    { key: 'draft', label: 'Draft' },
    { key: 'rejected', label: 'Rejected' },
  ];

  protected readonly byCountry = computed(() => {
    const apps = this.apps();
    return Object.values(ONBOARDING_COUNTRIES)
      .map((c) => {
        const own = apps.filter((a) => a.country === c.code);
        const parts = this.segments.map((s) => ({ ...s, value: own.filter((a) => SEGMENT_OF[a.status] === s.key).length }));
        return { code: c.code, name: c.name, currency: c.currency, total: own.length, parts };
      })
      .filter((r) => r.total > 0);
  });

  protected readonly maxCountry = computed(() => Math.max(1, ...this.byCountry().map((r) => r.total)));

  protected readonly attention = computed<Attention[]>(() => {
    const items: Attention[] = [];
    for (const a of this.apps()) {
      const c = this.countryName(a.country);
      if (a.status === 'returned') {
        items.push({ tone: 'warning', icon: 'alert-circle', title: `${a.merchantName} was returned for correction`, meta: `${c} · returned ${fmtRelative(a.updatedAt)}`, impact: 'Sales / Ops to update and resubmit', app: a });
      } else if (a.status === 'pending_risk_review') {
        items.push({ tone: 'info', icon: 'shield', title: `${a.merchantName} is waiting for Risk`, meta: `${c} · ${a.submissionCount > 1 ? 'resubmitted' : 'submitted'} ${fmtRelative(a.updatedAt)}`, impact: 'Risk to review', app: a });
      } else if (a.status === 'go_live_verification' || a.status === 'risk_approved') {
        items.push({ tone: 'progress', icon: 'clock', title: a.status === 'risk_approved' ? `${a.merchantName} is approved and ready for setup` : `${a.merchantName} is in go-live checks`, meta: `${c} · updated ${fmtRelative(a.updatedAt)}`, impact: 'Customer Success to continue', app: a });
      }
    }
    return items.sort((x, y) => x.app.updatedAt - y.app.updatedAt);
  });

  constructor() {
    effect(() => {
      const code = this.country() ?? null;
      void this.loadContext(code);
    });
    void this.loadData();
  }

  private async loadContext(code: string | null) {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.context.set(await this.auth.workspaceContext(code));
    } catch (e) {
      this.context.set(null);
      this.error.set(toClientError(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected async loadData() {
    this.dataLoading.set(true);
    this.dataError.set(false);
    try {
      this.merchants.set(await this.api.listMerchants());
      this.loadedAt.set(Date.now());
    } catch {
      this.dataError.set(true);
    } finally {
      this.dataLoading.set(false);
    }
  }

  /** Counts per week for the last 8 weeks (optionally cumulative), for sparklines. */
  private weekly(times: number[], cumulative: boolean): number[] {
    const now = Date.now();
    const buckets = Array.from({ length: 8 }, (_, i) => {
      const end = now - (7 - i) * WEEK;
      return cumulative ? times.filter((t) => t <= end).length : times.filter((t) => t > end - WEEK && t <= end).length;
    });
    return buckets;
  }

  protected sparkPath(values: number[], w = 140, h = 36): string {
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)}`).join(' ');
  }

  protected switchCountry(code: string) {
    this.router.navigate(code ? ['/dashboard', code] : ['/dashboard']);
  }

  protected retry() {
    void this.loadContext(this.country() ?? null);
  }
}
