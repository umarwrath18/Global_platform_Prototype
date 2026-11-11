import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { FLOW_ROW_LABEL, groupMethods, pricingInEffect, ProductFlow, ProductPricingView, SETTLEMENT_CYCLES, SettlementCycle } from '../../core/merchants/products';
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
  protected readonly flowRow = FLOW_ROW_LABEL;
  protected readonly flows: ProductFlow[] = ['payin', 'payout'];
  protected readonly enabled = signal<Record<string, boolean>>({});
  protected readonly settlement = signal<Record<string, string>>({});
  /** Products the user agreed to switch off although they have pricing (onboarding). */
  private readonly confirmedOff = signal<Set<string>>(new Set());
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly payin = computed(() => this.view().methods.filter((m) => m.flow === 'payin'));
  protected methodsOf(flow: ProductFlow) {
    return this.view().methods.filter((m) => m.flow === flow);
  }
  protected groupsOf(flow: ProductFlow) {
    return groupMethods(this.methodsOf(flow));
  }
  protected readonly savedOn = computed(() => new Set(this.view().config.products.filter((p) => p.enabled).map((p) => p.methodCode)));
  protected readonly onCount = computed(() => this.view().methods.filter((m) => this.enabled()[m.code]).length);
  protected readonly productChanges = computed(() => this.view().methods.filter((m) => !!this.enabled()[m.code] !== this.savedOn().has(m.code)).length);
  /** Settlement boxes: saved PayIn products that are still switched on in the draft. */
  protected readonly settled = computed(() => this.payin().filter((m) => this.savedOn().has(m.code) && this.enabled()[m.code]));
  protected readonly settlementChanges = computed(() => this.settled().filter((m) => (this.settlement()[m.code] ?? '') !== (this.view().config.settlement[m.code] ?? '')).length);
  protected readonly dirty = computed(() => this.productChanges() + this.settlementChanges() > 0);
  protected readonly saveLabel = computed(() => (this.productChanges() && this.settlementChanges() ? 'Save changes' : this.productChanges() ? 'Save products' : 'Save settlement'));
  protected readonly footText = computed(() =>
    this.productChanges() ? 'Save products before setting their settlement and pricing.' : `${this.settlementChanges()} settlement change(s) not saved.`,
  );

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
    return this.savedOn().has(code) && !!pricingInEffect(this.view().versions, code, this.view().today);
  }

  /** After onboarding a product with active pricing can't be switched off. */
  protected lockedOn(code: string) {
    return this.view().mode === 'change' && this.savedOn().has(code) && this.view().versions.some((v) => v.methodCode === code && v.status === 'active');
  }

  protected chipTitle(code: string) {
    return this.lockedOn(code) ? 'Has active pricing – cannot be switched off after onboarding.' : '';
  }

  /** Pricing that switching off cancels: onboarding – active, scheduled, pending; change – scheduled, pending. */
  private cancelledBySwitchOff(code: string) {
    const statuses = this.view().mode === 'onboarding' ? ['active', 'scheduled', 'pending_approval'] : ['scheduled', 'pending_approval'];
    return this.view().versions.some((v) => v.methodCode === code && statuses.includes(v.status));
  }

  protected toggle(code: string) {
    this.enabled.update((e) => ({ ...e, [code]: !e[code] }));
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
    const off = v.methods.filter((m) => this.savedOn().has(m.code) && !this.enabled()[m.code] && this.cancelledBySwitchOff(m.code));
    if (off.length && !confirm(`Switching off ${off.map((m) => m.name).join(', ')} will cancel its pricing. Continue?`)) return;
    this.confirmedOff.set(new Set(off.map((m) => m.code)));
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
