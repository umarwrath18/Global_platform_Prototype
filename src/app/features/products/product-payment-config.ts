import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { ProductPricingView } from '../../core/merchants/products';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { PricingPanel } from './pricing-panel';
import { ProductsCard } from './products-card';

/**
 * Product & Payment Config for one country application: step 1 products and settlement, step 2
 * pricing. Used in the onboarding stage (Customer Success) and after handoff (Sales / Operations,
 * with FinOps approving pricing). The server decides who may change what.
 */
@Component({
  selector: 'app-product-payment-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, ProductsCard, PricingPanel],
  templateUrl: './product-payment-config.html',
  styleUrl: './products.scss',
})
export class ProductPaymentConfig {
  private readonly api = inject(MerchantApi);
  private readonly roles = inject(StaffRoleService);
  private readonly productsCard = viewChild(ProductsCard);
  private readonly pricingPanel = viewChild(PricingPanel);

  readonly applicationId = input.required<string>();
  /** Emits after any saved change, so the page can refresh what depends on it (e.g. the onboarding gate). */
  readonly changed = output<void>();

  protected readonly view = signal<ProductPricingView | null>(null);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly editorOpen = signal(false);
  protected readonly productsDirty = signal(false);
  protected readonly toast = signal<string | null>(null);

  constructor() {
    // Reload when the application or the acting team changes (permissions come from the server).
    effect(() => {
      this.roles.role();
      void this.load(this.applicationId());
    });
  }

  hasUnsavedChanges() {
    return (this.productsCard()?.hasUnsavedChanges() ?? false) || (this.pricingPanel()?.hasUnsavedChanges() ?? false);
  }

  protected async load(id = this.applicationId()) {
    this.error.set(null);
    try {
      this.view.set(await this.api.getProducts(id));
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }

  protected onChanged(res: { view: ProductPricingView; message: string }) {
    this.view.set(res.view);
    if (res.message) this.flash(res.message);
    this.changed.emit();
  }

  private flash(message: string) {
    this.toast.set(message);
    setTimeout(() => this.toast.set(null), 3500);
  }
}
