import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import {
  FLOW_LABEL,
  fmtDay,
  periodText,
  pricingDetails,
  PRICING_STATUS_LABEL,
  PRICING_STATUS_TONE,
  PricingStatus,
  PricingVersion,
  ProductPricingView,
  secondarySummary,
  techniqueLabel,
  VA_BANKS,
} from '../../core/merchants/products';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { PricingEditor, PricingPreset } from '../products/pricing-editor';
import { MerchantPricingTabs } from './merchant-pricing-tabs';

interface Group {
  status: PricingStatus;
  title: string;
  levels: { key: string; label: string; rows: PricingVersion[] }[];
}

const SECTIONS: { status: PricingStatus; title: string }[] = [
  { status: 'active', title: 'Active' },
  { status: 'scheduled', title: 'Scheduled' },
  { status: 'pending_approval', title: 'Pending' },
];

/**
 * Merchant Pricing – Merchant Detail (§7.2) for one MID: active, scheduled and pending rules at
 * merchant level and per sub-merchant, the version history, and the popup editor (§7.4, §7.7).
 * Changes follow the shared MID rules: Ops submits, FinOps approves.
 */
@Component({
  selector: 'app-merchant-pricing-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, PricingEditor, MerchantPricingTabs],
  templateUrl: './merchant-pricing-detail.html',
  styleUrl: './pricing.scss',
})
export class MerchantPricingDetail {
  private readonly api = inject(MerchantApi);
  private readonly route = inject(ActivatedRoute);
  protected readonly roles = inject(StaffRoleService);

  /** Bound from the `:id` route parameter (the country application = the MID). */
  readonly id = input.required<string>();
  protected readonly view = signal<ProductPricingView | null>(null);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly editor = signal<PricingPreset | null>(null);
  protected readonly picker = signal(false);
  protected readonly selected = signal<PricingVersion | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly toast = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly flowLabel = FLOW_LABEL;
  protected readonly technique = techniqueLabel;
  protected readonly details = pricingDetails;
  protected readonly secondary = secondarySummary;
  protected readonly period = periodText;
  protected readonly day = fmtDay;
  protected readonly statusLabel = PRICING_STATUS_LABEL;
  protected readonly tone = PRICING_STATUS_TONE;

  protected readonly maker = computed(() => !!this.view()?.can.editPricing);
  protected readonly anyRules = computed(() => (this.view()?.versions.length ?? 0) > 0);
  protected readonly groups = computed<Group[]>(() => {
    const v = this.view();
    if (!v) return [];
    return SECTIONS.map((s) => {
      const rows = v.versions.filter((x) => x.status === s.status);
      const merchant = rows.filter((x) => !x.subMerchantId);
      const subs = v.subMerchants.map((sm) => ({ key: sm.id, label: sm.name, rows: rows.filter((x) => x.subMerchantId === sm.id) })).filter((g) => g.rows.length);
      return { ...s, levels: [...(merchant.length ? [{ key: 'merchant', label: 'Master Merchant', rows: merchant }] : []), ...subs] };
    }).filter((g) => g.levels.length);
  });
  /** Sub-merchant rules exist but no merchant-level rule (§7.2 warning). */
  protected readonly noMerchantLevel = computed(() => {
    const live = (this.view()?.versions ?? []).filter((x) => ['active', 'scheduled', 'pending_approval'].includes(x.status));
    return live.some((x) => x.subMerchantId) && !live.some((x) => !x.subMerchantId);
  });
  protected readonly history = computed(() => [...(this.view()?.versions ?? [])].sort((a, b) => b.createdAt - a.createdAt));

  constructor() {
    effect(() => {
      this.roles.role();
      void this.load(this.id());
    });
  }

  protected async load(id = this.id()) {
    this.error.set(null);
    try {
      const v = await this.api.getProducts(id);
      this.view.set(v);
      if (this.route.snapshot.queryParamMap.get('configure') && v.can.editPricing && !this.editor()) this.configure();
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }

  protected methodName(x: PricingVersion) {
    return this.view()?.methods.find((m) => m.code === x.methodCode)?.name ?? x.methodCode;
  }

  protected subName(x: PricingVersion) {
    return x.subMerchantId ? (this.view()?.subMerchants.find((s) => s.id === x.subMerchantId)?.name ?? x.subMerchantId) : 'Master Merchant';
  }

  protected vaText(x: PricingVersion) {
    if (!(this.view()?.country === 'ID' && x.methodCode === 'va')) return '';
    return x.vaBanks.length ? x.vaBanks.map((b) => VA_BANKS.find((v) => v.code === b)?.name ?? b).join(', ') : 'All VA Banks';
  }

  protected canEdit(x: PricingVersion) {
    const v = this.view()!;
    return this.maker() && (x.status === 'active' || x.status === 'scheduled') && !v.versions.some((o) => o.methodCode === x.methodCode && o.flow === x.flow && (o.subMerchantId ?? null) === (x.subMerchantId ?? null) && o.status === 'pending_approval');
  }

  /** Change mode: scheduled or pending only (the shared MID rule; active pricing is never cancelled after onboarding). */
  protected canCancel(x: PricingVersion) {
    return this.maker() && (this.view()!.mode === 'onboarding' ? ['active', 'scheduled', 'pending_approval'] : ['scheduled', 'pending_approval']).includes(x.status);
  }

  protected configure(subMerchantId: string | null = null) {
    this.picker.set(false);
    this.editor.set({ flow: 'payin', methodCode: null, editOf: null, subMerchantId });
  }

  protected edit(x: PricingVersion) {
    this.picker.set(false);
    this.selected.set(null);
    this.editor.set({ flow: x.flow, methodCode: x.methodCode, editOf: x.id, subMerchantId: x.subMerchantId ?? null });
  }

  protected closeEditor() {
    this.editor.set(null);
  }

  protected async cancel(x: PricingVersion) {
    if (!confirm(`Cancel ${techniqueLabel(x.technique)} pricing for ${this.methodName(x)}?`)) return;
    this.busy.set(x.id);
    this.actionError.set(null);
    try {
      const res = await this.api.cancelPricing(this.view()!.applicationId, x.id);
      this.view.set(res.view);
      this.flash(`Cancelled pricing v${x.version}`);
    } catch (e) {
      this.actionError.set(toMerchantError(e).message ?? "We couldn't cancel the pricing.");
    } finally {
      this.busy.set(null);
    }
  }

  protected onSaved(res: { view: ProductPricingView }) {
    this.view.set(res.view);
  }

  private flash(text: string) {
    this.toast.set(text);
    setTimeout(() => this.toast.set(null), 3000);
  }
}
