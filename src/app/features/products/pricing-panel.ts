import { SideSheet } from '../../shared/side-sheet';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import {
  FLOW_LABEL,
  money,
  nextSubscriptionCharge,
  periodText,
  pricingInEffect,
  pricingShort,
  PRICING_STATUS_LABEL,
  PRICING_STATUS_TONE,
  PricingVersion,
  ProductFlow,
  ProductMethod,
  ProductPricingView,
  fmtDay,
  techniqueLabel,
  VA_BANKS,
} from '../../core/merchants/products';
import { Icon } from '../../shared/icon';
import { PricingEditor, PricingPreset } from './pricing-editor';

/** Step 2 (§8.4): pricing versions for the MID's switched-on products, with an inline editor. */
@Component({
  selector: 'app-pricing-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PricingEditor, RouterLink, SideSheet],
  templateUrl: './pricing-panel.html',
  styleUrl: './products.scss',
})
export class PricingPanel {
  private readonly api = inject(MerchantApi);
  private readonly editorRef = viewChild(PricingEditor);

  readonly view = input.required<ProductPricingView>();
  /** Unsaved product changes: pricing waits until they are saved or discarded. */
  readonly productsDirty = input(false);
  readonly changed = output<{ view: ProductPricingView; message: string }>();
  readonly editing = output<boolean>();

  protected readonly flowLabel = FLOW_LABEL;
  protected readonly statusLabel = PRICING_STATUS_LABEL;
  protected readonly tone = PRICING_STATUS_TONE;
  protected readonly technique = techniqueLabel;
  protected readonly short = pricingShort;
  protected readonly period = periodText;
  protected readonly history = signal(false);
  protected readonly editor = signal<PricingPreset | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);

  private readonly enabledSaved = computed(() => this.view().config.products.filter((p) => p.enabled));
  protected readonly rows = computed(() => {
    const v = this.view();
    return (this.history() ? v.versions : v.versions.filter((x) => x.status === 'active' || x.status === 'scheduled' || x.status === 'pending_approval')).map((x) => ({ ...x, method: this.method(x.methodCode) }));
  });
  /** Switched-on products with no pricing in effect today (§8.4: light amber rows). */
  protected readonly unpriced = computed(() => {
    const v = this.view();
    return this.enabledSaved()
      .filter((p) => !pricingInEffect(v.versions, p.methodCode, v.today, p.flow))
      .map((p) => ({ ...this.method(p.methodCode)!, pending: v.versions.some((x) => x.methodCode === p.methodCode && x.status === 'pending_approval') }));
  });
  protected readonly anyEnabled = computed(() => this.enabledSaved().length > 0);
  protected readonly flows: ProductFlow[] = ['payin', 'payout'];
  protected unpricedOf(f: ProductFlow) {
    return this.unpriced().filter((u) => u.flow === f);
  }
  protected rowsOf(f: ProductFlow) {
    return this.rows().filter((x) => x.flow === f);
  }
  /** Second line under the method: VA banks and sub-merchant; the version only when history is shown. */
  protected rowNote(x: PricingVersion) {
    return [this.history() ? `v${x.version}` : '', this.vaText(x), this.subLabel(x)].filter(Boolean).join(' · ');
  }
  protected readonly open = computed(() => this.editor() !== null);
  protected readonly maker = computed(() => this.view().can.editPricing);

  hasUnsavedChanges() {
    return this.editorRef()?.hasProgress() ?? false;
  }

  protected method(code: string): ProductMethod | undefined {
    return this.view().methods.find((m) => m.code === code);
  }

  protected vaText(x: PricingVersion) {
    if (!(this.view().country === 'ID' && x.methodCode === 'va')) return '';
    return x.vaBanks.length ? x.vaBanks.map((b) => VA_BANKS.find((v) => v.code === b)?.name ?? b).join(', ') : 'All VA Banks';
  }

  protected subLabel(x: PricingVersion) {
    return x.subMerchantId ? (this.view().subMerchants.find((s) => s.id === x.subMerchantId)?.name ?? x.subMerchantId) : '';
  }

  protected subscriptionText(x: PricingVersion) {
    if (!x.subscription || !x.subscription.monthlyFee) return '';
    const next = nextSubscriptionCharge(x, this.view().today);
    return `+ ${money(x.subscription.monthlyFee, x.subscription.currency)}/month subscription${next && (x.status === 'active' || x.status === 'scheduled') ? ` · next charge ${fmtDay(next.date)} for ${next.forMonth}` : ''}`;
  }

  /** Edit: active / scheduled versions with no pending version in the same scope. */
  protected canEditRow(x: PricingVersion) {
    return (x.status === 'active' || x.status === 'scheduled') && !this.view().versions.some((o) => o.methodCode === x.methodCode && o.flow === x.flow && o.status === 'pending_approval');
  }

  /** Cancel: onboarding – active, scheduled or pending; change – scheduled or pending only. */
  protected canCancelRow(x: PricingVersion) {
    return this.view().mode === 'onboarding' ? ['active', 'scheduled', 'pending_approval'].includes(x.status) : ['scheduled', 'pending_approval'].includes(x.status);
  }

  protected openEditor(preset: PricingPreset) {
    if (this.open()) {
      this.note.set('Pricing editor already open – Save or cancel the pricing below first.');
      return;
    }
    this.note.set(null);
    this.error.set(null);
    this.editor.set(preset);
    this.editing.emit(true);
  }

  protected closeEditor() {
    this.editor.set(null);
    this.note.set(null);
    this.editing.emit(false);
  }

  protected onSaved(res: { view: ProductPricingView }) {
    this.changed.emit({ view: res.view, message: '' });
  }

  /** Inline "Cancel … pricing?" under the table (instead of a browser dialog). */
  protected readonly cancelAsk = signal<(PricingVersion & { method?: ProductMethod }) | null>(null);
  protected readonly cancelQuestion = (x: PricingVersion & { method?: ProductMethod }) => `Cancel ${techniqueLabel(x.technique)} pricing for ${x.method?.name ?? x.methodCode}?`;

  protected async cancelVersion(x: PricingVersion & { method?: ProductMethod }) {
    this.cancelAsk.set(null);
    this.busy.set(x.id);
    this.error.set(null);
    try {
      const res = await this.api.cancelPricing(this.view().applicationId, x.id);
      this.changed.emit({ view: res.view, message: `Cancelled pricing v${x.version}` });
    } catch (e) {
      this.error.set(toMerchantError(e).message ?? "We couldn't cancel the pricing.");
    } finally {
      this.busy.set(null);
    }
  }

  protected presetFor(flow: ProductFlow, methodCode: string | null): PricingPreset {
    return { flow, methodCode, editOf: null };
  }
}
