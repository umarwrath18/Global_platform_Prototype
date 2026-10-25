import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import {
  APPLICATION_STATUS_LABEL,
  ApplicationStatus,
  GLOBAL_STATUS_LABEL,
  GlobalMerchantStatus,
  MerchantSummary,
  READINESS_STATUSES,
} from '../../core/merchants/merchant-models';
import { REGISTRATION_COUNTRIES, countryName } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { GlobalFilters } from '../../core/merchants/global-filters.service';
import { Icon } from '../../shared/icon';
import { StatusBadge, fmtDate, fmtRelative } from '../../shared/merchant-ui';

type StatusFilter = '' | ApplicationStatus | 'in_readiness';

@Component({
  selector: 'app-merchant-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, StatusBadge],
  templateUrl: './merchant-list.html',
  styleUrl: './merchant-list.scss',
})
export class MerchantList {
  private readonly api = inject(MerchantApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly roles = inject(StaffRoleService);
  protected readonly filters = inject(GlobalFilters);

  protected readonly merchants = signal<MerchantSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<MerchantClientError | null>(null);

  private readonly qp = this.route.snapshot.queryParamMap;
  protected readonly q = signal(this.qp.get('q') ?? '');
  protected readonly appStatus = signal<StatusFilter>((this.qp.get('status') as StatusFilter) ?? '');
  protected readonly globalStatus = signal<'' | GlobalMerchantStatus>((this.qp.get('global') as GlobalMerchantStatus) ?? '');
  protected readonly regCountry = signal(this.qp.get('reg') ?? '');

  protected readonly regCountries = REGISTRATION_COUNTRIES;
  protected readonly statusOptions = Object.entries(APPLICATION_STATUS_LABEL) as [ApplicationStatus, string][];
  protected readonly globalOptions = Object.entries(GLOBAL_STATUS_LABEL) as [GlobalMerchantStatus, string][];
  protected readonly countryName = countryName;
  protected readonly date = fmtDate;
  protected readonly rel = fmtRelative;

  protected readonly filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    const f = this.filters;
    const appFilter = !!(f.country() || f.currency() || f.range() !== 'all');
    const status = this.appStatus();
    const global = this.globalStatus();
    const reg = this.regCountry();
    const statusMatch = (s: ApplicationStatus) => !status || (status === 'in_readiness' ? READINESS_STATUSES.includes(s) && s !== 'operational' : s === status);
    return this.merchants().filter((m) => {
      if (q) {
        const hay = [m.id, m.legalName, m.registrationNumber, m.primaryContact.name, m.primaryContact.email, ...m.applications.map((a) => a.id)].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (global && m.globalStatus !== global) return false;
      if (reg && m.registrationCountry !== reg) return false;
      if (f.merchantId() && m.id !== f.merchantId()) return false;
      // Top-bar filters: the merchant must have a matching application (or, for a date-only filter, be new in range).
      const apps = appFilter ? m.applications.filter((a) => f.matches(a)) : m.applications;
      if (appFilter && !apps.length && !(!f.country() && !f.currency() && m.createdAt >= f.since())) return false;
      if (status && !apps.some((a) => statusMatch(a.status))) return false;
      return true;
    });
  });

  protected readonly stats = computed(() => {
    const apps = this.filtered().flatMap((m) => m.applications).filter((a) => this.filters.matches(a));
    return {
      merchants: this.filtered().length,
      pending: apps.filter((a) => a.status === 'pending_risk_review').length,
      returned: apps.filter((a) => a.status === 'returned').length,
      readiness: apps.filter((a) => READINESS_STATUSES.includes(a.status) && a.status !== 'operational').length,
      operational: apps.filter((a) => a.status === 'operational').length,
    };
  });

  protected readonly hasFilters = computed(() => !!(this.q() || this.appStatus() || this.globalStatus() || this.regCountry()) || this.filters.active());

  constructor() {
    void this.load();
  }

  protected async load() {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.merchants.set(await this.api.listMerchants());
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected setFilter(key: 'q' | 'status' | 'global' | 'reg', value: string) {
    ({ q: this.q, status: this.appStatus, global: this.globalStatus, reg: this.regCountry } as const)[key].set(value as never);
    this.syncUrl();
  }

  protected quick(status: StatusFilter) {
    this.appStatus.set(this.appStatus() === status ? '' : status);
    this.syncUrl();
  }

  protected clear() {
    this.q.set('');
    this.filters.clear();
    this.appStatus.set('');
    this.globalStatus.set('');
    this.regCountry.set('');
    this.syncUrl();
  }

  private syncUrl() {
    const queryParams = { q: this.q() || null, status: this.appStatus() || null, global: this.globalStatus() || null, reg: this.regCountry() || null };
    this.router.navigate([], { queryParams, replaceUrl: true });
  }
}
