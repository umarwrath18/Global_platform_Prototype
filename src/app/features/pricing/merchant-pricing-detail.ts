import { SideSheet } from '../../shared/side-sheet';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { DeactivateSheet } from '../products/deactivate-sheet';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import {
  Deactivation,
  DEACTIVATION_STATUS_LABEL,
  FLOW_LABEL,
  fmtDay,
  ProductFlow,
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
 * Master Merchant level and per sub-merchant, the version history and deactivated payment methods.
 * Details, the editor (§7.4, §7.7) and deactivation open in side sheets.
 * Changes follow the shared MID rules: Ops submits, FinOps approves.
 */
@Component({
  selector: 'app-merchant-pricing-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, PricingEditor, MerchantPricingTabs, SideSheet, CodePrompt, DeactivateSheet],
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
  /** Inline "Cancel Rule?" in the details sheet. */
  protected readonly cancelAsk = signal(false);
  protected readonly cancelReason = signal('');
  /** Deactivation sheet for a method (scope preset). */
  protected readonly deactivating = signal<{ methodCode: string; flow: ProductFlow; subMerchantId: string | null } | null>(null);
  /** Cancel a scheduled deactivation, or reactivate a sub-merchant. */
  protected readonly deactivationAsk = signal<{ d: Deactivation; action: 'cancel' | 'reactivate' } | null>(null);
  protected readonly codeAsk = signal(false);
  protected readonly codeError = signal<string | null>(null);
  private readonly codePrompt = viewChild(CodePrompt);
  protected readonly deactivationLabel = DEACTIVATION_STATUS_LABEL;
  protected readonly deactivationTone: Record<Deactivation['status'], string> = { scheduled: 'warning', done: 'danger', cancelled: '', reactivated: 'success' };

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
  protected readonly canDeactivate = computed(() => !!this.view()?.can.deactivate);
  /** Newest first. */
  protected readonly deactivations = computed(() => [...(this.view()?.config.deactivations ?? [])].reverse());
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

  protected methodOf(code: string, flow: ProductFlow) {
    return this.view()?.methods.find((m) => m.code === code && m.flow === flow)?.name ?? code;
  }

  protected subNameOf(id: string) {
    return this.view()?.subMerchants.find((s) => s.id === id)?.name ?? id;
  }

  protected open(x: PricingVersion) {
    this.actionError.set(null);
    this.cancelAsk.set(false);
    this.cancelReason.set('');
    this.selected.set(x);
  }

  protected closeDetails() {
    if (this.cancelAsk()) return this.cancelAsk.set(false);
    this.selected.set(null);
  }

  /** The version this one replaces (edit), else the previous version in the same scope. */
  protected previousOf(x: PricingVersion): PricingVersion | null {
    const all = this.view()?.versions ?? [];
    const byEdit = x.editOf ? all.find((o) => o.id === x.editOf) : undefined;
    if (byEdit) return byEdit;
    return all.filter((o) => o.id !== x.id && o.methodCode === x.methodCode && o.flow === x.flow && (o.subMerchantId ?? null) === (x.subMerchantId ?? null) && o.version < x.version).sort((a, b) => b.version - a.version)[0] ?? null;
  }

  protected activity(x: PricingVersion): { title: string; meta: string; waiting?: boolean; bad?: boolean }[] {
    const when = (t: number) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const out: { title: string; meta: string; waiting?: boolean; bad?: boolean }[] = [{ title: x.source === 'change' ? 'Submitted for approval' : 'Set during onboarding', meta: `${x.createdBy} · ${when(x.createdAt)}` }];
    if (x.approvedBy && x.approvedAt) out.push({ title: 'Approved by FinOps', meta: `${x.approvedBy} · ${when(x.approvedAt)}` });
    if (x.rejectedBy && x.rejectedAt) out.push({ title: 'Rejected by FinOps', meta: `${x.rejectedBy} · ${when(x.rejectedAt)}`, bad: true });
    if (x.cancelledBy && x.cancelledAt) out.push({ title: 'Cancelled', meta: `${x.cancelledBy} · ${when(x.cancelledAt)}`, bad: true });
    if (x.status === 'pending_approval') out.push({ title: 'Waiting for FinOps', meta: 'The current pricing stays in effect until FinOps decides.', waiting: true });
    return out;
  }

  protected startDeactivate(x: PricingVersion) {
    this.selected.set(null);
    this.deactivating.set({ methodCode: x.methodCode, flow: x.flow, subMerchantId: x.subMerchantId ?? null });
  }

  protected async deactivationAction(d: Deactivation, action: 'cancel' | 'reactivate', code?: string) {
    this.busy.set(d.id);
    this.actionError.set(null);
    this.codeError.set(null);
    try {
      const res = await this.api.deactivationAction(this.view()!.applicationId, d.id, action, code);
      this.view.set(res.view);
      this.codeAsk.set(false);
      this.deactivationAsk.set(null);
      this.flash(action === 'cancel' ? 'Deactivation cancelled' : `${this.methodOf(d.methodCode, d.flow)} reactivated`);
    } catch (e) {
      const err = toMerchantError(e) as { code?: string; message?: string; attemptsRemaining?: number };
      const mfa = this.codeAsk() ? codeProblem(err.code, err.attemptsRemaining) : null;
      if (err.code === 'MFA_CODE_REQUIRED') this.codeAsk.set(true);
      else if (mfa) {
        this.codeError.set(mfa);
        this.codePrompt()?.reset();
      } else {
        this.codeAsk.set(false);
        this.actionError.set(err.message ?? "We couldn't do that.");
      }
    } finally {
      this.busy.set(null);
    }
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
    this.busy.set(x.id);
    this.actionError.set(null);
    try {
      const res = await this.api.cancelPricing(this.view()!.applicationId, x.id, this.cancelReason().trim());
      this.view.set(res.view);
      this.cancelAsk.set(false);
      this.selected.set(null);
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
