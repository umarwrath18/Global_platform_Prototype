import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ClientError, toClientError } from '../../core/api/api-error';
import { CountryStatus, WorkspaceContext } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import { DATE_RANGE_LABEL, GlobalFilters } from '../../core/merchants/global-filters.service';
import { Icon } from '../../shared/icon';

const STATUS_LABEL: Record<CountryStatus, string> = {
  active: 'Active',
  pending: 'Activating',
  failed: 'Activation failed',
};

/** Transaction KPIs. No transaction data exists yet, so every value shows as "—". */
const TRANSACTION_KPIS = ['Total transactions', 'Successful', 'Failed', 'Success rate', 'Volume'];

/**
 * Operations overview. Batch 1 workspace/country access rules are unchanged (the Workspace
 * selector still routes to /dashboard/:country and is authorised by the server). Transaction KPIs
 * show "—" until transaction data exists; merchant onboarding figures are on the Applications page.
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
  protected readonly filters = inject(GlobalFilters);

  /** Bound from the `:country` route parameter. */
  readonly country = input<string>();

  protected readonly session = this.auth.session;
  protected readonly context = signal<WorkspaceContext | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<ClientError | null>(null);
  protected readonly statusLabel = STATUS_LABEL;

  protected readonly activeCountries = computed(() => this.session()?.countries.filter((c) => c.status === 'active') ?? []);
  protected readonly rangeLabel = computed(() => DATE_RANGE_LABEL[this.filters.range()]);
  protected readonly kpis = TRANSACTION_KPIS;
  /** Volume is shown in the workspace currency (the base currency for all countries). */
  protected readonly volumeCurrency = computed(() => this.context()?.country?.currency ?? this.session()?.baseCurrency ?? 'USD');

  constructor() {
    effect(() => {
      const code = this.country() ?? null;
      void this.loadContext(code);
    });
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

  protected switchCountry(code: string) {
    this.router.navigate(code ? ['/dashboard', code] : ['/dashboard']);
  }

  protected retry() {
    void this.loadContext(this.country() ?? null);
  }
}
