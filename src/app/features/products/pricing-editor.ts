import { AfterViewInit, ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, OnInit, output, signal } from '@angular/core';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import {
  addDays,
  calculateFee,
  classifyPeriod,
  DraftIssue,
  FLOW_LABEL,
  fmtSlash,
  HistoricalConfig,
  mdrWarnings,
  METRIC_LABEL,
  money,
  overlapMessage,
  periodText,
  PricingDraft,
  pricingSummary,
  PricingTechnique,
  PricingVersion,
  ProductFlow,
  ProductPricingView,
  PromoCondition,
  Promotion,
  REFERENCE_PERIOD_LABEL,
  ReferencePeriod,
  techniqueLabel,
  TECHNIQUES,
  usesVaBanks,
  VA_BANKS,
  validatePrimary,
  validateSecondary,
  VolumeMetric,
  VOLUME_PERIOD_LABEL,
  VolumePeriod,
  VolumeTier,
  groupMethods,
} from '../../core/merchants/products';
import { countryName } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { DecimalPipe } from '@angular/common';

export interface PricingPreset {
  flow: ProductFlow;
  methodCode: string | null;
  /** Editing: the version this replaces. */
  editOf: string | null;
  /** Sub-merchant to start with (Merchant Pricing); null = merchant level. */
  subMerchantId?: string | null;
}

const STEPS = ['Scope', 'Technique', 'Configure Rules', 'Summary'] as const;
const FLAGS: Record<string, string> = { MY: '🇲🇾', ID: '🇮🇩', VN: '🇻🇳' };
const DEFAULT_TIERS: VolumeTier[] = [
  { minVolume: 0, maxVolume: 1_000_000, mdrPct: 1.5, fixedFee: 0 },
  { minVolume: 1_000_000, maxVolume: 5_000_000, mdrPct: 1.2, fixedFee: 0 },
  { minVolume: 5_000_000, maxVolume: null, mdrPct: 1.0, fixedFee: 0 },
];

/** Parses a number field: empty → null, otherwise a number (NaN when not one). */
const n = (v: string): number | null => (v.trim() === '' ? null : Number(v.replace(/,/g, '')));

/**
 * The MID pricing editor (Pricing Engine §7.4 with the §8.5 differences): inline under the pricing
 * table, Scope → Technique → Configure Rules → Summary, then Secondary Charges. Editing keeps the
 * scope and technique of the version it replaces. The server re-checks everything.
 */
@Component({
  selector: 'app-pricing-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, DecimalPipe],
  templateUrl: './pricing-editor.html',
  styleUrl: './products.scss',
  // Esc does not close the inline editor (§8.5); in the Merchant Pricing popup it dismisses an overlap error first, then closes (§7.4).
  host: { '(keydown.escape)': 'onEscape($event)' },
})
export class PricingEditor implements OnInit, AfterViewInit {
  private readonly api = inject(MerchantApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly view = input.required<ProductPricingView>();
  readonly preset = input.required<PricingPreset>();
  /** `mid`: inline in Product & Payment Config (§8.5). `merchant`: popup in Merchant Pricing (§7.4). */
  readonly variant = input<'mid' | 'merchant'>('mid');
  readonly saved = output<{ version: PricingVersion; view: ProductPricingView }>();
  readonly closed = output<void>();

  protected readonly steps = STEPS;
  protected readonly techniques = TECHNIQUES;
  protected readonly flowLabel = FLOW_LABEL;
  protected readonly vaBankList = VA_BANKS;
  protected readonly volumePeriods = Object.entries(VOLUME_PERIOD_LABEL) as [VolumePeriod, string][];
  protected readonly referencePeriods = Object.entries(REFERENCE_PERIOD_LABEL) as [ReferencePeriod, string][];
  protected readonly metrics = Object.entries(METRIC_LABEL) as [VolumeMetric, string][];
  protected readonly promoMetrics: [VolumeMetric, string][] = [['gpv', 'GPV'], ['gmv', 'GMV'], ['transaction_count', 'Transaction Count']];
  protected readonly techniqueLabel = techniqueLabel;
  protected readonly slash = fmtSlash;
  protected readonly money = money;

  protected readonly phase = signal<'primary' | 'secondary'>('primary');
  protected readonly step = signal(0);
  protected readonly errors = signal<string[]>([]);
  protected readonly overlap = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly serverError = signal<string | null>(null);
  protected readonly done = signal<PricingVersion | null>(null);

  // Scope
  protected readonly flow = signal<ProductFlow>('payin');
  protected readonly methodCode = signal('');
  /** Merchant Pricing: sub-merchant scope; '' = All Sub-Merchants (Merchant Level). */
  protected readonly subMerchantId = signal('');
  protected readonly vaBanks = signal<string[]>([]);
  protected readonly vaOpen = signal(false);
  // Technique (null = no primary pricing: subscription only)
  protected readonly technique = signal<PricingTechnique | null>('variable_rate');
  // Rules (as typed)
  protected readonly mdr = signal('1.5');
  protected readonly fixedFee = signal('0');
  protected readonly minimumFee = signal('0');
  protected readonly currency = signal('');
  protected readonly volumePeriod = signal<VolumePeriod>('monthly');
  protected readonly tiers = signal<{ min: string; max: string; mdr: string; fee: string }[]>([]);
  protected readonly refPeriod = signal<ReferencePeriod>('previous_month');
  protected readonly metric = signal<VolumeMetric>('gmv');
  protected readonly threshold = signal('10000000');
  protected readonly direction = signal<'>=' | '<'>('>=');
  protected readonly resultingMdr = signal('1.5');
  protected readonly defaultMdr = signal('1.5');
  protected readonly startDate = signal('');
  protected readonly endChecked = signal(false);
  protected readonly endDate = signal('');
  // Calculator
  protected readonly calcAmount = signal('100000');
  protected readonly calcVolume = signal('500000');
  // Secondary charges
  protected readonly subOn = signal(false);
  protected readonly subFee = signal('0');
  protected readonly promoOn = signal(false);
  protected readonly promoType = signal<Promotion['type']>('unconditional');
  protected readonly promoMdr = signal('1.0');
  protected readonly promoStart = signal('');
  protected readonly promoEnd = signal('');
  protected readonly promoPeriod = signal<'monthly' | 'weekly'>('monthly');
  protected readonly promoMetric = signal<VolumeMetric>('gpv');
  protected readonly conditions = signal<{ op: '>=' | '>'; value: string; mdr: string }[]>([{ op: '>=', value: '10000000', mdr: '1.0' }]);

  protected readonly editing = computed<PricingVersion | null>(() => {
    const id = this.preset().editOf;
    return id ? (this.view().versions.find((v) => v.id === id) ?? null) : null;
  });
  protected readonly local = computed(() => this.view().currency);
  protected readonly flag = computed(() => FLAGS[this.view().country] ?? '');
  protected readonly cname = computed(() => countryName(this.view().country));
  protected readonly onboarding = computed(() => this.view().mode === 'onboarding');

  /** Only switched-on (saved) products can be priced. */
  protected readonly options = computed(() => {
    const on = new Set(this.view().config.products.filter((p) => p.enabled).map((p) => p.methodCode));
    return this.view().methods.filter((m) => on.has(m.code));
  });
  protected readonly flowOptions = computed(() => (['payin', 'payout'] as ProductFlow[]).map((f) => ({ flow: f, enabled: this.options().some((m) => m.flow === f) })));
  protected readonly methodsInFlow = computed(() => this.options().filter((m) => m.flow === this.flow()));
  protected readonly methodGroups = computed(() => groupMethods(this.methodsInFlow()));
  protected readonly method = computed(() => this.view().methods.find((m) => m.code === this.methodCode()) ?? null);
  protected readonly showVa = computed(() => usesVaBanks(this.view().country, this.methodCode()));
  protected readonly vaButton = computed(() => (!this.vaBanks().length ? 'Select VA Banks' : this.vaBanks().length === VA_BANKS.length ? 'All VA Banks' : `${this.vaBanks().length} bank(s) selected`));
  protected readonly vaSummary = computed(() => (this.vaBanks().length && this.vaBanks().length < VA_BANKS.length ? this.vaBanks().map((b) => VA_BANKS.find((x) => x.code === b)!.name).join(', ') : 'All'));
  protected readonly subtitle = computed(() => `${this.view().merchantName} - ${this.view().mid ? `MID ${this.view().mid}` : this.view().applicationId}`);
  protected readonly title = computed(() => (this.phase() === 'secondary' ? 'Configure Secondary Charges' : this.editing() ? `Edit Pricing (new version of v${this.editing()!.version})` : 'Configure Primary Pricing'));
  protected readonly settlement = computed(() => (this.flow() === 'payin' ? (this.view().config.settlement[this.methodCode()] ?? null) : null));
  protected readonly usd = computed(() => this.technique() === 'fixed_fee' && this.currency() === 'USD');
  protected readonly localEquivalent = computed(() => (n(this.fixedFee()) ?? 0) * this.view().usdRate);

  /** The draft as the server will receive it. */
  protected readonly draft = computed<PricingDraft>(() => {
    const t = this.technique();
    const historical: HistoricalConfig | null =
      t === 'historical_volume'
        ? { referencePeriod: this.refPeriod(), evaluationMetric: this.metric(), volumeThreshold: n(this.threshold()) ?? NaN, thresholdDirection: this.direction(), resultingMdr: n(this.resultingMdr()) ?? NaN, resultingFixedFee: 0, defaultMdr: n(this.defaultMdr()) ?? NaN, defaultFixedFee: 0, targetPeriod: 'current_month' }
        : null;
    return {
      flow: this.flow(),
      methodCode: this.methodCode(),
      subMerchantId: this.subMerchantId() || null,
      vaBanks: this.showVa() && this.vaBanks().length < VA_BANKS.length ? this.vaBanks() : [],
      technique: t,
      currency: t === 'fixed_fee' ? this.currency() || this.local() : this.local(),
      mdrPct: t === 'variable_rate' || t === 'variable_plus_fixed' || t === 'higher_of' ? (n(this.mdr()) ?? NaN) : null,
      fixedFee: t === 'fixed_fee' || t === 'variable_plus_fixed' ? (n(this.fixedFee()) ?? NaN) : null,
      minimumFee: t === 'variable_rate' || t === 'higher_of' ? (n(this.minimumFee()) ?? 0) : null,
      volumePeriod: t === 'volume_based' ? this.volumePeriod() : null,
      tiers: t === 'volume_based' ? this.tiers().map((x) => ({ minVolume: n(x.min) ?? NaN, maxVolume: n(x.max), mdrPct: n(x.mdr) ?? NaN, fixedFee: n(x.fee) ?? 0 })) : null,
      historical,
      subscription: this.subOn() ? { monthlyFee: n(this.subFee()) ?? NaN, currency: this.local() } : null,
      promotion: this.promoOn()
        ? {
            type: this.promoType(),
            mdrPct: n(this.promoMdr()) ?? NaN,
            startDate: this.promoStart(),
            endDate: this.promoEnd() || null,
            ...(this.promoType() === 'conditional' ? { evaluationPeriod: this.promoPeriod(), metric: this.promoMetric(), conditions: this.conditions().map((c): PromoCondition => ({ op: c.op, value: n(c.value) ?? NaN, mdrPct: n(c.mdr) ?? NaN })) } : {}),
          }
        : null,
      startDate: this.startDate(),
      endDate: this.endChecked() ? this.endDate() || null : null,
    };
  });

  protected readonly subName = computed(() => this.view().subMerchants.find((x) => x.id === this.subMerchantId())?.name ?? null);
  /** Sub-merchant chosen while the merchant has no merchant-level rule in this corridor (§7.4 Step 1). */
  protected readonly noMerchantLevel = computed(() => !!this.subMerchantId() && !this.view().versions.some((v) => !v.subMerchantId && ['active', 'scheduled', 'pending_approval'].includes(v.status)));
  protected readonly scopeText = computed(() => `Scope: ${this.cname()} / ${this.view().merchantName}${this.subName() ? ` / ${this.subName()}` : ' (Merchant Level)'} / ${FLOW_LABEL[this.flow()]} / ${this.method()?.name ?? '–'}${this.showVa() ? ` / VA Banks: ${this.vaSummary()}` : ''}`);
  protected readonly effectiveSentence = computed(() => (this.startDate() && this.endChecked() && this.endDate() ? `Effective: ${fmtSlash(this.startDate())} – ${fmtSlash(this.endDate())}` : null));
  protected readonly supersession = computed(() => {
    const c = classifyPeriod(this.draft(), this.view().versions, this.editing()?.id);
    return c.kind === 'supersession' ? c.message : null;
  });
  protected readonly warnings = computed(() => mdrWarnings(this.draft(), this.method() ?? undefined));
  protected readonly summary = computed(() => pricingSummary({ ...this.draft(), usd: this.usd() ? { fixedFeeUsd: n(this.fixedFee()) ?? 0, usdExchangeRate: this.view().usdRate, localEquivalent: this.localEquivalent(), localEquivalentCurrency: this.local() } : null }));
  protected readonly period = computed(() => periodText(this.draft()).replace('Ongoing', 'Present'));
  protected readonly needsVolume = computed(() => this.technique() === 'volume_based' || this.technique() === 'historical_volume' || (this.promoOn() && this.promoType() === 'conditional'));
  protected readonly calc = computed(() => {
    const d = this.draft();
    const amount = n(this.calcAmount()) ?? 0;
    const volume = n(this.calcVolume()) ?? 0;
    return calculateFee(
      { ...d, usd: this.usd() ? { fixedFeeUsd: d.fixedFee ?? 0, usdExchangeRate: this.view().usdRate, localEquivalent: this.localEquivalent(), localEquivalentCurrency: this.local() } : null, localCurrency: this.local(), promotion: this.phase() === 'secondary' ? d.promotion : null },
      { amount, periodVolume: volume, previousPeriodVolume: volume, date: this.startDate() || this.view().today },
    );
  });

  ngOnInit() {
    const p = this.preset();
    const tomorrow = addDays(this.view().today, 1);
    this.currency.set(this.local());
    this.tiers.set(DEFAULT_TIERS.map((t) => ({ min: String(t.minVolume), max: t.maxVolume === null ? '' : String(t.maxVolume), mdr: String(t.mdrPct), fee: String(t.fixedFee) })));
    this.startDate.set(this.view().today);
    this.promoStart.set(this.view().today);
    this.flow.set(p.flow);
    const e = this.editing();
    if (e) {
      this.prefill(e);
      // Start date: the version's start if in the future, otherwise tomorrow (§7.7).
      this.startDate.set(e.startDate > this.view().today ? e.startDate : tomorrow);
      this.step.set(2);
      return;
    }
    if (!this.flowOptions().find((f) => f.flow === p.flow)?.enabled) this.flow.set(this.flowOptions().find((f) => f.enabled)?.flow ?? 'payin');
    if (p.methodCode && this.options().some((m) => m.code === p.methodCode)) this.methodCode.set(p.methodCode);
    if (p.subMerchantId && this.view().subMerchants.some((x) => x.id === p.subMerchantId)) this.subMerchantId.set(p.subMerchantId);
  }

  ngAfterViewInit() {
    this.host.nativeElement.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>('select, input, button.t-card')?.focus());
  }

  private prefill(e: PricingVersion) {
    this.flow.set(e.flow);
    this.methodCode.set(e.methodCode);
    this.subMerchantId.set(e.subMerchantId ?? '');
    this.vaBanks.set(e.vaBanks.length ? [...e.vaBanks] : usesVaBanks(this.view().country, e.methodCode) ? VA_BANKS.map((b) => b.code) : []);
    this.technique.set(e.technique);
    this.currency.set(e.currency);
    if (e.mdrPct !== null) this.mdr.set(String(e.mdrPct));
    if (e.fixedFee !== null) this.fixedFee.set(String(e.usd ? e.usd.fixedFeeUsd : e.fixedFee));
    if (e.minimumFee !== null) this.minimumFee.set(String(e.minimumFee));
    if (e.volumePeriod) this.volumePeriod.set(e.volumePeriod);
    if (e.tiers) this.tiers.set(e.tiers.map((t) => ({ min: String(t.minVolume), max: t.maxVolume === null ? '' : String(t.maxVolume), mdr: String(t.mdrPct), fee: String(t.fixedFee) })));
    if (e.historical) {
      this.refPeriod.set(e.historical.referencePeriod);
      this.metric.set(e.historical.evaluationMetric);
      this.threshold.set(String(e.historical.volumeThreshold));
      this.direction.set(e.historical.thresholdDirection);
      this.resultingMdr.set(String(e.historical.resultingMdr));
      this.defaultMdr.set(String(e.historical.defaultMdr));
    }
    if (e.endDate) {
      this.endChecked.set(true);
      this.endDate.set(e.endDate);
    }
    if (e.subscription) {
      this.subOn.set(true);
      this.subFee.set(String(e.subscription.monthlyFee));
    }
    if (e.promotion) {
      this.promoOn.set(true);
      this.promoType.set(e.promotion.type);
      this.promoMdr.set(String(e.promotion.mdrPct));
      this.promoStart.set(e.promotion.startDate);
      this.promoEnd.set(e.promotion.endDate ?? '');
      if (e.promotion.evaluationPeriod) this.promoPeriod.set(e.promotion.evaluationPeriod);
      if (e.promotion.metric) this.promoMetric.set(e.promotion.metric);
      if (e.promotion.conditions) this.conditions.set(e.promotion.conditions.map((c) => ({ op: c.op, value: String(c.value), mdr: String(c.mdrPct) })));
    }
  }

  protected onEscape(e: Event) {
    e.stopPropagation();
    if (this.variant() !== 'merchant' || this.done()) return;
    if (this.overlap()) this.overlap.set(null);
    else this.cancel();
  }

  /** True once past step 1 or in Phase 2, so closing it would lose work. */
  hasProgress() {
    return !this.done() && (this.step() > 0 || this.phase() === 'secondary');
  }

  // ------------------------------------------------------------ scope

  protected setFlow(f: ProductFlow) {
    this.flow.set(f);
    this.methodCode.set('');
    this.vaBanks.set([]);
  }

  protected setMethod(code: string) {
    this.methodCode.set(code);
    this.vaBanks.set([]);
  }

  protected toggleBank(code: string) {
    this.vaBanks.update((list) => (list.includes(code) ? list.filter((b) => b !== code) : [...list, code]));
  }

  protected selectAllBanks(on: boolean) {
    this.vaBanks.set(on ? VA_BANKS.map((b) => b.code) : []);
  }

  // ------------------------------------------------------------ technique and rules

  /** Selecting any method card resets the currency to local (USD-1). */
  protected setTechnique(t: PricingTechnique | null) {
    this.technique.set(t);
    this.currency.set(this.local());
  }

  protected setEndChecked(on: boolean) {
    this.endChecked.set(on);
    if (!on) this.endDate.set('');
  }

  protected setTier(i: number, key: 'min' | 'max' | 'mdr' | 'fee', value: string) {
    this.tiers.update((list) => list.map((t, j) => (j === i ? { ...t, [key]: value } : t)));
  }

  protected addTier() {
    const last = this.tiers()[this.tiers().length - 1];
    this.tiers.update((list) => [...list, { min: last?.max || '0', max: '', mdr: '1.0', fee: '0' }]);
  }

  protected removeTier(i: number) {
    this.tiers.update((list) => list.filter((_, j) => j !== i));
  }

  protected readonly canAddTier = computed(() => {
    const last = this.tiers()[this.tiers().length - 1];
    return !last || last.max.trim() !== '';
  });

  // ------------------------------------------------------------ secondary

  protected setCondition(i: number, key: 'op' | 'value' | 'mdr', value: string) {
    this.conditions.update((list) => list.map((c, j) => (j === i ? { ...c, [key]: value } : c)) as typeof list);
  }

  protected addCondition() {
    this.conditions.update((list) => [...list, { op: '>=', value: '', mdr: '1.0' }]);
  }

  protected removeCondition(i: number) {
    this.conditions.update((list) => list.filter((_, j) => j !== i));
  }

  // ------------------------------------------------------------ navigation

  protected readonly canNext = computed(() => (this.step() === 0 ? !!this.method() : true));

  protected next() {
    if (this.step() === 2 && !this.checkRules()) return;
    if (this.step() < STEPS.length - 1) this.go(this.step() + 1);
  }

  protected back() {
    this.errors.set([]);
    this.overlap.set(null);
    // Editing keeps scope and technique, so it starts at Configure Rules.
    if (this.step() > (this.editing() ? 2 : 0)) this.go(this.step() - 1);
  }

  private go(step: number) {
    this.step.set(step);
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>('.editor-body select, .editor-body input, .editor-body button')?.focus());
  }

  /** Step 3 → 4: validation box, then the overlap check (§7.4). */
  private checkRules(): boolean {
    const issues: DraftIssue[] = validatePrimary(this.draft(), this.endChecked());
    if (this.startDate() && this.startDate() < this.view().today) issues.push({ field: 'startDate', message: "Start date can't be in the past" });
    this.errors.set([...new Set(issues.map((i) => i.message))]);
    if (issues.length) return false;
    const c = classifyPeriod(this.draft(), this.view().versions, this.editing()?.id);
    if (c.kind === 'overlap') {
      this.overlap.set(overlapMessage(c.existing, this.view().merchantName, this.method()?.name ?? this.methodCode(), this.subName()));
      return false;
    }
    this.overlap.set(null);
    return true;
  }

  protected editDates() {
    this.overlap.set(null);
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>('#pe-start')?.focus());
  }

  protected toSecondary() {
    this.errors.set([]);
    this.phase.set('secondary');
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>('.editor-body input')?.focus());
  }

  protected backToPrimary() {
    this.errors.set([]);
    this.phase.set('primary');
    this.step.set(2);
  }

  protected cancel() {
    if (this.hasProgress() && !confirm('Discard this pricing draft?')) return;
    this.closed.emit();
  }

  /** "Skip – No Secondary Charges" submits without them; the main button submits what's configured. */
  protected async submit(skipSecondary = false) {
    if (skipSecondary) {
      this.subOn.set(false);
      this.promoOn.set(false);
    }
    const issues = validateSecondary(this.draft());
    this.errors.set([...new Set(issues.map((i) => i.message))]);
    if (issues.length) return;
    this.saving.set(true);
    this.serverError.set(null);
    try {
      const res = await this.api.setPricing(this.view().applicationId, { draft: this.draft(), editOf: this.editing()?.id ?? null });
      this.done.set(res.version);
      this.saved.emit(res);
    } catch (e) {
      this.serverError.set(toMerchantError(e).message ?? "We couldn't save the pricing. Your draft is still here.");
    } finally {
      this.saving.set(false);
    }
  }
}
