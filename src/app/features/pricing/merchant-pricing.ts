import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { GLOBAL_STATUS_LABEL } from '../../core/merchants/merchant-models';
import { fmtDay, MerchantPricingList, MerchantPricingRow, todayIso } from '../../core/merchants/products';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { CorridorSelect, CorridorService } from './corridor';
import { MerchantPricingTabs } from './merchant-pricing-tabs';

const STATUS_LABEL: Record<MerchantPricingRow['status'], string> = { ...GLOBAL_STATUS_LABEL, suspended: 'Suspended' };
const STATUS_TONE: Record<MerchantPricingRow['status'], string> = { active: 'success', onboarding: 'info', no_active_applications: '', suspended: 'danger' };

/** Merchant Pricing – Merchant List (§7.1), scoped to the corridor. */
@Component({
  selector: 'app-merchant-pricing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, CorridorSelect, MerchantPricingTabs],
  templateUrl: './merchant-pricing.html',
  styleUrl: './pricing.scss',
})
export class MerchantPricing {
  private readonly api = inject(MerchantApi);
  private readonly router = inject(Router);
  protected readonly roles = inject(StaffRoleService);
  protected readonly corridor = inject(CorridorService);

  protected readonly list = signal<MerchantPricingList | null>(null);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly q = signal('');
  protected readonly showFilters = signal(false);
  protected readonly flow = signal<'' | 'payin' | 'payout'>('');
  protected readonly status = signal<'' | MerchantPricingRow['status']>('');
  protected readonly pageSize = signal(10);
  protected readonly page = signal(0);

  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusTone = STATUS_TONE;
  protected readonly statuses = Object.keys(STATUS_LABEL) as MerchantPricingRow['status'][];
  protected readonly date = (t: number) => fmtDay(todayIso(t));

  protected readonly filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    return (this.list()?.rows ?? []).filter(
      (r) => (!q || r.merchantName.toLowerCase().includes(q) || (r.mid ?? '').toLowerCase().includes(q)) && (!this.flow() || r.flows.includes(this.flow() as 'payin')) && (!this.status() || r.status === this.status()),
    );
  });
  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.pageSize())));
  protected readonly rows = computed(() => this.filtered().slice(this.page() * this.pageSize(), (this.page() + 1) * this.pageSize()));
  /** Ops (Sales / Operations) configure; FinOps and others view. */
  protected readonly maker = computed(() => this.roles.role() === 'sales');

  constructor() {
    effect(() => {
      this.roles.role();
      void this.load(this.corridor.code());
    });
  }

  protected async load(country = this.corridor.code()) {
    this.error.set(null);
    this.page.set(0);
    try {
      this.list.set(await this.api.merchantPricing(country));
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }

  protected clear() {
    this.flow.set('');
    this.status.set('');
  }

  protected setPageSize(n: number) {
    this.pageSize.set(n);
    this.page.set(0);
  }

  protected configure(r: MerchantPricingRow) {
    void this.router.navigate(['/merchant-pricing', r.applicationId], { queryParams: { configure: 1 } });
  }
}
