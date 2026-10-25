import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { ApplicationStatus, ApplicationSummary, StaffRole } from '../../core/merchants/merchant-models';
import { countryName } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { GlobalFilters } from '../../core/merchants/global-filters.service';
import { Icon } from '../../shared/icon';
import { StatusBadge, fmtDate, fmtRelative } from '../../shared/merchant-ui';

type QueueKey = 'sales' | 'risk' | 'cs' | 'rejected' | 'operational' | 'all';

const QUEUES: { key: QueueKey; label: string; statuses: ApplicationStatus[] | null; owner?: StaffRole; empty: string }[] = [
  { key: 'sales', label: 'Drafts & returned', statuses: ['draft', 'returned'], owner: 'sales', empty: 'No drafts or returned applications.' },
  { key: 'risk', label: 'Risk review queue', statuses: ['pending_risk_review'], owner: 'risk', empty: 'Nothing is waiting for Risk review.' },
  { key: 'cs', label: 'CS readiness', statuses: ['risk_approved', 'cs_configuration', 'keys_generated', 'integration', 'go_live_verification'], owner: 'cs', empty: 'No approved applications are waiting for CS.' },
  { key: 'operational', label: 'Operational', statuses: ['operational'], empty: 'No operational countries yet.' },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'], empty: 'No rejected applications.' },
  { key: 'all', label: 'All', statuses: null, empty: 'No applications yet.' },
];

/** Work queues for each team; opens on the queue for the acting role. */
@Component({
  selector: 'app-application-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, StatusBadge],
  templateUrl: './application-list.html',
  styles: `
    .tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 10px 14px 0; border-bottom: 1px solid var(--border); }
    .tabs button { display: inline-flex; align-items: center; gap: 8px; padding: 10px 12px; border: 0; border-bottom: 2px solid transparent; background: none; font-size: 14px; font-weight: 600; color: var(--text-muted); cursor: pointer; }
    .tabs button:hover { color: var(--text); }
    .tabs button.on { border-bottom-color: var(--mobi-blue); color: var(--mobi-blue); }
    .tabs button:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: 6px; }
    .n { min-width: 22px; padding: 0 6px; border-radius: 999px; background: var(--surface-muted); font-size: 12px; line-height: 20px; text-align: center; }
    .on .n { background: var(--mobi-blue-tint); }
    .mine { font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--brand-teal); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--surface-muted); }
    .toolbar .f-input { width: auto; min-width: 180px; }
    .toolbar .grow { flex: 1 1 260px; }
    .meta { margin-top: 2px; font-size: 13px; color: var(--text-muted); }
  `,
})
export class ApplicationList {
  private readonly api = inject(MerchantApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly roles = inject(StaffRoleService);
  protected readonly filters = inject(GlobalFilters);

  protected readonly apps = signal<ApplicationSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly queue = signal<QueueKey>((this.route.snapshot.queryParamMap.get('queue') as QueueKey) || this.roles.role());
  protected readonly q = signal('');

  protected readonly queues = QUEUES;
  protected readonly countryName = countryName;
  protected readonly date = fmtDate;
  protected readonly rel = fmtRelative;

  protected readonly current = computed(() => QUEUES.find((x) => x.key === this.queue()) ?? QUEUES[0]);
  protected readonly scoped = computed(() => this.apps().filter((a) => this.filters.matches(a)));
  protected readonly counts = computed(() => Object.fromEntries(QUEUES.map((x) => [x.key, this.scoped().filter((a) => !x.statuses || x.statuses.includes(a.status)).length])) as Record<QueueKey, number>);
  protected readonly rows = computed(() => {
    const qd = this.current();
    const q = this.q().trim().toLowerCase();
    return this.scoped().filter(
      (a) =>
        (!qd.statuses || qd.statuses.includes(a.status)) &&
        (!q || [a.id, a.merchantId, a.merchantName].join(' ').toLowerCase().includes(q)),
    );
  });

  constructor() {
    void this.load();
    // Follow the prototype role switcher to that team's queue.
    let first = true;
    effect(() => {
      const role = this.roles.role();
      if (first) {
        first = false;
        return;
      }
      this.select(role);
    });
  }

  protected async load() {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.apps.set(await this.api.listApplications());
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected select(key: QueueKey) {
    this.queue.set(key);
    this.router.navigate([], { queryParams: { queue: key }, replaceUrl: true });
  }
}
