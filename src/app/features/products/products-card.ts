import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { activePricing, ProductPricingView, SETTLEMENT_CYCLES, SettlementCycle } from '../../core/merchants/products';
import { Icon } from '../../shared/icon';

/** Step 1: switch products on or off and set each PayIn product's settlement cycle. Drafts until saved. */
@Component({
  selector: 'app-products-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './products-card.html',
  styleUrl: './products.scss',
})
export class ProductsCard {
  private readonly api = inject(MerchantApi);

  readonly view = input.required<ProductPricingView>();
  /** True while the pricing editor is open, so products can't change underneath it. */
  readonly locked = input(false);
  readonly saved = output<{ view: ProductPricingView; message: string }>();
  /** Whether there are unsaved product or settlement changes (pricing waits for them). */
  readonly dirtyChange = output<boolean>();

  protected readonly cycles = SETTLEMENT_CYCLES;
  protected readonly enabled = signal<Record<string, boolean>>({});
  protected readonly settlement = signal<Record<string, string>>({});
  /** Products the user agreed to switch off although they have pricing (onboarding). */
  private readonly confirmedOff = signal<Set<string>>(new Set());
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly payin = computed(() => this.view().methods.filter((m) => m.flow === 'payin'));
  protected readonly payout = computed(() => this.view().methods.filter((m) => m.flow === 'payout'));
  protected readonly savedOn = computed(() => new Set(this.view().config.products.filter((p) => p.enabled).map((p) => p.methodCode)));
  protected readonly onCount = computed(() => this.view().methods.filter((m) => this.enabled()[m.code]).length);
  protected readonly productChanges = computed(() => this.view().methods.filter((m) => !!this.enabled()[m.code] !== this.savedOn().has(m.code)).length);
  /** Settlement boxes: saved PayIn products that are still switched on in the draft. */
  protected readonly settled = computed(() => this.payin().filter((m) => this.savedOn().has(m.code) && this.enabled()[m.code]));
  protected readonly settlementChanges = computed(() => this.settled().filter((m) => (this.settlement()[m.code] ?? '') !== (this.view().config.settlement[m.code] ?? '')).length);
  protected readonly dirty = computed(() => this.productChanges() + this.settlementChanges() > 0);
  protected readonly saveLabel = computed(() => (this.productChanges() && this.settlementChanges() ? 'Save changes' : this.productChanges() ? 'Save products' : 'Save settlement'));

  constructor() {
    effect(() => this.reset(this.view()));
    effect(() => this.dirtyChange.emit(this.dirty()));
  }

  hasUnsavedChanges() {
    return this.dirty();
  }

  protected reset(v = this.view()) {
    this.enabled.set(Object.fromEntries(v.config.products.map((p) => [p.methodCode, p.enabled])));
    this.settlement.set({ ...v.config.settlement });
    this.confirmedOff.set(new Set());
    this.error.set(null);
  }

  protected priced(code: string) {
    return this.savedOn().has(code) && !!activePricing(this.view().versions, code, this.view().now);
  }

  /** Pricing that would be cancelled by switching the product off: anything not yet ended. */
  private openPricing(code: string) {
    return this.view().versions.filter((v) => v.methodCode === code && (v.status === 'active' || v.status === 'scheduled' || v.status === 'pending_approval'));
  }

  /** After onboarding a product with active pricing can't be switched off. */
  protected lockedOn(code: string) {
    return this.view().phase === 'post_handoff' && this.savedOn().has(code) && this.priced(code);
  }

  protected chipTitle(code: string, name: string) {
    if (this.lockedOn(code)) return `${name} has active pricing, so it can't be switched off after onboarding.`;
    return '';
  }

  protected toggle(code: string, name: string) {
    const on = !this.enabled()[code];
    if (!on && this.view().phase === 'onboarding' && this.savedOn().has(code) && this.openPricing(code).length) {
      if (!confirm(`Switch off ${name}? Its pricing will be cancelled when you save.`)) return;
      this.confirmedOff.update((s) => new Set(s).add(code));
    }
    this.enabled.update((e) => ({ ...e, [code]: on }));
  }

  protected setCycle(code: string, cycle: string) {
    this.settlement.update((s) => ({ ...s, [code]: cycle as SettlementCycle }));
  }

  protected changed(code: string) {
    return !!this.enabled()[code] !== this.savedOn().has(code);
  }

  protected cycleChanged(code: string) {
    return (this.settlement()[code] ?? '') !== (this.view().config.settlement[code] ?? '');
  }

  protected async save() {
    const v = this.view();
    this.saving.set(true);
    this.error.set(null);
    try {
      const settlement = Object.fromEntries(Object.entries(this.settlement()).filter(([code, c]) => c && this.enabled()[code]));
      const res = await this.api.saveProducts(v.applicationId, {
        products: v.methods.map((m) => ({ methodCode: m.code, enabled: !!this.enabled()[m.code] })),
        settlement,
        revision: v.config.revision,
        confirmCancelPricing: this.confirmedOff().size > 0,
      });
      this.saved.emit({ view: res.view, message: res.message });
    } catch (e) {
      this.error.set(toMerchantError(e).message ?? "We couldn't save the products. Your changes are still here.");
    } finally {
      this.saving.set(false);
    }
  }
}
