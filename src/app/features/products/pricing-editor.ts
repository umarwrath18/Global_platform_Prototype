import { AfterViewInit, ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, OnInit, output, signal } from '@angular/core';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { FLOW_LABEL, PricingVersion, ProductFlow, ProductPricingView, todayIso } from '../../core/merchants/products';
import { Icon } from '../../shared/icon';

export interface PricingPreset {
  flow: ProductFlow;
  methodCode: string | null;
  mdrPct?: number | null;
}

const STEPS = ['Product', 'MDR', 'Effective date'] as const;

/** Inline pricing editor (a card under the table, not a modal). MDR % only. */
@Component({
  selector: 'app-pricing-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './pricing-editor.html',
  styleUrl: './products.scss',
  host: { '(keydown.escape)': '$event.stopPropagation()' },
})
export class PricingEditor implements OnInit, AfterViewInit {
  private readonly api = inject(MerchantApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly view = input.required<ProductPricingView>();
  readonly preset = input.required<PricingPreset>();
  readonly saved = output<{ version: PricingVersion; view: ProductPricingView }>();
  readonly closed = output<void>();

  protected readonly steps = STEPS;
  protected readonly flowLabel = FLOW_LABEL;
  protected readonly step = signal(0);
  protected readonly flow = signal<ProductFlow>('payin');
  protected readonly methodCode = signal('');
  protected readonly mdr = signal('');
  protected readonly date = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly done = signal<PricingVersion | null>(null);

  /** Only switched-on (saved) products can be priced. */
  protected readonly options = computed(() => {
    const on = new Set(this.view().config.products.filter((p) => p.enabled).map((p) => p.methodCode));
    return this.view().methods.filter((m) => on.has(m.code));
  });
  protected readonly flowOptions = computed(() => (['payin', 'payout'] as ProductFlow[]).map((f) => ({ flow: f, enabled: this.options().some((m) => m.flow === f) })));
  protected readonly methodsInFlow = computed(() => this.options().filter((m) => m.flow === this.flow()));
  protected readonly method = computed(() => this.view().methods.find((m) => m.code === this.methodCode()) ?? null);
  protected readonly mdrNumber = computed(() => (this.mdr().trim() === '' ? NaN : Number(this.mdr())));
  protected readonly mdrError = computed(() => {
    const m = this.method();
    const n = this.mdrNumber();
    if (!m) return null;
    if (Number.isNaN(n)) return 'Enter the MDR.';
    return n < m.minMdr || n > m.maxMdr ? `Enter an MDR between ${m.minMdr}% and ${m.maxMdr}%.` : null;
  });
  protected readonly today = computed(() => todayIso(this.view().now));
  protected readonly settlement = computed<string | null>(() => this.view().config.settlement[this.methodCode()] ?? null);
  protected readonly needsApproval = computed(() => this.view().phase === 'post_handoff');
  protected readonly canNext = computed(() => (this.step() === 0 ? !!this.method() : this.step() === 1 ? !this.mdrError() : true));

  ngOnInit() {
    const p = this.preset();
    this.flow.set(p.flow);
    if (p.methodCode && this.options().some((m) => m.code === p.methodCode)) {
      this.methodCode.set(p.methodCode);
      this.step.set(1);
    }
    if (p.mdrPct !== null && p.mdrPct !== undefined) this.mdr.set(String(p.mdrPct));
    this.date.set(this.today());
  }

  ngAfterViewInit() {
    this.host.nativeElement.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>('select, input')?.focus());
  }

  /** True once the draft holds more than the starting choice, so closing it would lose work. */
  hasProgress() {
    return !this.done() && this.step() > 0 && (this.step() > 1 || this.mdr().trim() !== '' || this.methodCode() !== (this.preset().methodCode ?? ''));
  }

  protected setFlow(f: ProductFlow) {
    this.flow.set(f);
    this.methodCode.set('');
  }

  protected next() {
    if (this.canNext()) this.step.update((s) => Math.min(s + 1, STEPS.length - 1));
  }

  protected back() {
    this.step.update((s) => Math.max(s - 1, 0));
  }

  protected cancel() {
    if (this.hasProgress() && !confirm('Discard this pricing draft?')) return;
    this.closed.emit();
  }

  protected async save() {
    if (this.mdrError() || !this.method()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await this.api.setPricing(this.view().applicationId, { methodCode: this.methodCode(), mdrPct: this.mdrNumber(), effectiveDate: this.date() });
      this.done.set(res.version);
      this.saved.emit(res);
    } catch (e) {
      this.error.set(toMerchantError(e).message ?? "We couldn't save the pricing. Your draft is still here.");
    } finally {
      this.saving.set(false);
    }
  }
}
