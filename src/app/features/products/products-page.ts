import { ChangeDetectionStrategy, Component, effect, inject, input, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { ApplicationDetail } from '../../core/merchants/merchant-models';
import { countryName } from '../../core/merchants/onboarding-config';
import { HasUnsavedChanges } from '../applications/unsaved-changes.guard';
import { Icon } from '../../shared/icon';
import { StatusBadge } from '../../shared/merchant-ui';
import { ProductPaymentConfig } from './product-payment-config';

/** Products and pricing for one country, outside the onboarding page (used after onboarding). */
@Component({
  selector: 'app-products-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, StatusBadge, ProductPaymentConfig],
  template: `
    <main class="page">
      @if (detail(); as d) {
        <ol class="crumbs">
          <li><a routerLink="/merchants">Merchants</a></li>
          <li><a [routerLink]="['/merchants', d.merchant.id]">{{ d.merchant.legalName }}</a></li>
          <li><a [routerLink]="['/applications', d.application.id]">{{ d.application.id }}</a></li>
          <li aria-current="page">Products &amp; pricing</li>
        </ol>
        <div class="portal-head">
          <div>
            <h1>Products &amp; pricing · {{ countryName(d.application.country) }}</h1>
            <p class="sub meta"><app-status [status]="d.application.status" /> <span>{{ d.merchant.legalName }}</span>@if (d.mid; as mid) { <span>· Live MID {{ mid.mid }}</span>}</p>
          </div>
        </div>
        <app-product-payment-config [applicationId]="d.application.id" />
      } @else if (error(); as e) {
        <section class="panel-card"><div class="empty-state" role="alert"><div class="icon-tile"><app-icon name="alert-circle" /></div><h3>{{ e.code === 'NOT_FOUND' ? 'Application not found' : "We couldn't load this page" }}</h3><p>{{ e.message }}</p><a class="btn" routerLink="/merchants">Back to merchants</a></div></section>
      } @else {
        <section class="panel-card"><div class="skeleton-rows" aria-busy="true" aria-label="Loading"><span></span><span></span><span></span></div></section>
      }
    </main>
  `,
})
export class ProductsPage implements HasUnsavedChanges {
  private readonly api = inject(MerchantApi);
  private readonly config = viewChild(ProductPaymentConfig);

  /** Bound from the `:id` route parameter. */
  readonly id = input.required<string>();
  protected readonly detail = signal<ApplicationDetail | null>(null);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly countryName = countryName;

  constructor() {
    effect(() => void this.load(this.id()));
  }

  hasUnsavedChanges() {
    return this.config()?.hasUnsavedChanges() ?? false;
  }

  unsavedChangesMessage() {
    return 'You have unsaved product, settlement or pricing changes. Leave without saving?';
  }

  private async load(id: string) {
    this.error.set(null);
    try {
      this.detail.set(await this.api.getApplication(id));
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }
}
