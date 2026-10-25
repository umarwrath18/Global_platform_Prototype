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
  { key: 'sales', label: 'To complete', statuses: ['draft', 'returned'], owner: 'sales', empty: 'No drafts or returned applications.' },
  { key: 'risk', label: 'Risk review', statuses: ['pending_risk_review'], owner: 'risk', empty: 'Nothing is waiting for Risk review.' },
  { key: 'cs', label: 'Setup & go-live', statuses: ['risk_approved', 'cs_configuration', 'keys_generated', 'integration', 'go_live_verification'], owner: 'cs', empty: 'Nothing is waiting for setup.' },
  { key: 'operational', label: 'Operational', statuses: ['operational'], empty: 'No countries are live yet.' },
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
    .tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--border-soft); }
    .tabs button { position: relative; display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 10px; border: 0; border-bottom: 2px solid transparent; background: none; font-size: 13px; font-weight: 500; color: var(--text-muted); cursor: pointer; }
    .tabs button:hover { color: var(--text); }
    .tabs button.on { border-bottom-color: var(--mobi-blue); color: var(--text); font-weight: 600; }
    .tabs button:focus-visible { outline: none; box-shadow: inset var(--focus-ring); border-radius: 6px; }
    .n { min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--surface-muted); font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; color: var(--text-muted); }
    .on .n { background: var(--mobi-blue-tint); color: var(--mobi-blue); }
    .mine { width: 6px; height: 6px; border-radius: 50%; background: var(--mobi-blue); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border-soft); }
    .toolbar .grow { flex: 1 1 260px; height: 36px; font-size: 13px; }
    .meta { margin-top: 2px; font-size: 12px; color: var(--text-muted); }
    .cur { margin-left: 4px; font-size: 12px; color: var(--text-muted); }
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
