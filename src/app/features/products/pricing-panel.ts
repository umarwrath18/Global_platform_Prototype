import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { FLOW_LABEL, PRICING_STATUS_LABEL, PricingStatus, PricingVersionView, ProductMethod, ProductPricingView } from '../../core/merchants/products';
import { Icon } from '../../shared/icon';
import { fmtDate } from '../../shared/merchant-ui';
import { PricingEditor, PricingPreset } from './pricing-editor';

const TONE: Record<PricingStatus, string> = { active: 'success', scheduled: 'info', pending_approval: 'warning', superseded: '', rejected: 'danger', cancelled: '' };

/** Step 2: pricing versions for the application's switched-on products, with an inline editor. */
@Component({
  selector: 'app-pricing-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PricingEditor],
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
  protected readonly tone = TONE;
  protected readonly date = fmtDate;
  protected readonly history = signal(false);
  protected readonly editor = signal<PricingPreset | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  /** Row whose reject comment box is open (FinOps). */
  protected readonly rejecting = signal<string | null>(null);
  protected readonly comment = signal('');

  private readonly enabledSaved = computed(() => new Set(this.view().config.products.filter((p) => p.enabled).map((p) => p.methodCode)));
  protected readonly rows = computed(() => {
    const v = this.view();
    const shown = this.history() ? v.versions : v.versions.filter((x) => x.status === 'active' || x.status === 'scheduled' || x.status === 'pending_approval');
    return shown.map((x) => ({ ...x, method: this.method(x.methodCode) }));
  });
  /** Switched-on products with no pricing in effect. */
  protected readonly unpriced = computed(() =>
    this.view()
      .methods.filter((m) => this.enabledSaved().has(m.code) && !this.view().versions.some((x) => x.methodCode === m.code && x.status === 'active'))
      .map((m) => ({ ...m, pending: this.view().versions.find((x) => x.methodCode === m.code && x.status === 'pending_approval') ?? null })),
  );
  protected readonly anyEnabled = computed(() => this.enabledSaved().size > 0);
  protected readonly open = computed(() => this.editor() !== null);

  hasUnsavedChanges() {
    return this.editorRef()?.hasProgress() ?? false;
  }

  protected method(code: string): ProductMethod | undefined {
    return this.view().methods.find((m) => m.code === code);
  }

  protected range(x: PricingVersionView) {
    return x.effectiveTo ? `${this.date(x.effectiveFrom)} – ${this.date(x.effectiveTo)}` : `From ${this.date(x.effectiveFrom)}`;
  }

  protected openEditor(preset: PricingPreset) {
    this.error.set(null);
    this.editor.set(preset);
    this.editing.emit(true);
  }

  protected closeEditor() {
    this.editor.set(null);
    this.editing.emit(false);
  }

  protected onSaved(res: { view: ProductPricingView }) {
    this.changed.emit({ view: res.view, message: '' });
  }

  protected async cancelVersion(x: PricingVersionView & { method?: ProductMethod }) {
    if (!confirm(`Cancel ${x.method?.name ?? x.methodCode} pricing ${x.mdrPct}% (${this.statusLabel[x.status].toLowerCase()})?`)) return;
    await this.act(x.id, () => this.api.cancelPricing(this.view().applicationId, x.id), 'Pricing cancelled');
  }

  protected async decide(x: PricingVersionView, decision: 'approve' | 'reject') {
    if (decision === 'reject' && this.comment().trim().length < 10) {
      this.error.set('Give the reason for rejecting (at least 10 characters).');
      return;
    }
    await this.act(x.id, () => this.api.decidePricing(this.view().applicationId, x.id, decision, this.comment().trim()), decision === 'approve' ? 'Pricing approved' : 'Pricing rejected');
    this.rejecting.set(null);
    this.comment.set('');
  }

  private async act(id: string, run: () => Promise<{ view: ProductPricingView }>, message: string) {
    this.busy.set(id);
    this.error.set(null);
    try {
      const res = await run();
      this.changed.emit({ view: res.view, message });
    } catch (e) {
      this.error.set(toMerchantError(e).message ?? "We couldn't update the pricing.");
    } finally {
      this.busy.set(null);
    }
  }
}
