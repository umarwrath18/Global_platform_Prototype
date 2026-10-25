import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { MerchantDetail, MerchantSummary } from '../../core/merchants/merchant-models';
import { countryName } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { StatusBadge, fmtDate } from '../../shared/merchant-ui';
import { CountryPicker } from './country-picker';

/** Flow B: find an existing Global Merchant and open a new country application for it. */
@Component({
  selector: 'app-add-country',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, StatusBadge, CountryPicker],
  templateUrl: './add-country.html',
  styleUrl: './merchant-forms.scss',
})
export class AddCountry {
  private readonly api = inject(MerchantApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly roles = inject(StaffRoleService);

  protected readonly all = signal<MerchantSummary[]>([]);
  protected readonly q = signal('');
  protected readonly detail = signal<MerchantDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadingDetail = signal(false);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly countryName = countryName;
  protected readonly date = fmtDate;

  protected readonly results = computed(() => {
    const q = this.q().trim().toLowerCase();
    if (q.length < 2) return [];
    return this.all()
      .filter((m) => [m.id, m.legalName, m.registrationNumber, m.primaryContact.email].join(' ').toLowerCase().includes(q))
      .slice(0, 8);
  });

  constructor() {
    void this.init();
  }

  private async init() {
    try {
      this.all.set(await this.api.listMerchants());
      const id = this.route.snapshot.queryParamMap.get('merchant');
      if (id) await this.select(id);
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected async select(id: string) {
    this.loadingDetail.set(true);
    this.error.set(null);
    try {
      this.detail.set(await this.api.getMerchant(id));
      this.router.navigate([], { queryParams: { merchant: id }, replaceUrl: true });
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.loadingDetail.set(false);
    }
  }

  protected change() {
    this.detail.set(null);
    this.q.set('');
    this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }

  protected opened(applicationId: string) {
    this.router.navigate(['/applications', applicationId]);
  }
}
