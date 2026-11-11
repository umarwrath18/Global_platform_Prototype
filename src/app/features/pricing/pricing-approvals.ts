import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import {
  APPROVAL_STATUS_ORDER,
  FLOW_LABEL,
  fmtDay,
  METRIC_SHORT,
  money,
  PRICING_STATUS_LABEL,
  PRICING_STATUS_TONE,
  PricingApprovalItem,
  PricingApprovalsView,
  PricingStatus,
  PROMO_TYPE_LABEL,
  REFERENCE_PERIOD_LABEL,
  secondarySummary,
  techniqueLabel,
  VA_BANKS,
  pricingShort,
} from '../../core/merchants/products';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { DemoAuthenticatorService } from '../../shared/demo-authenticator';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';
import { fmtDateTime } from '../../shared/merchant-ui';
import { CorridorSelect, CorridorService } from './corridor';
import { MerchantPricingTabs } from './merchant-pricing-tabs';

type Decision = { item: PricingApprovalItem; decision: 'approve' | 'reject' };
type Chip = 'all' | PricingStatus;

const CHIPS: { key: Chip; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending_approval', label: 'Pending Approval' },
  { key: 'active', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'expired', label: 'Expired' },
];

/**
 * Pricing Approvals (§7.8, §8.7), scoped to a corridor: pricing changes submitted by Ops. FinOps
 * approves or rejects; each decision asks for a current authenticator code, and the person who
 * submitted a change can't decide it (maker ≠ checker, enforced by the server).
 */
@Component({
  selector: 'app-pricing-approvals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, CorridorSelect, MerchantPricingTabs, SideSheet],
  templateUrl: './pricing-approvals.html',
  styleUrl: './pricing.scss',
})
export class PricingApprovals {
  private readonly api = inject(MerchantApi);
  private readonly demo = inject(DemoAuthenticatorService);
  protected readonly roles = inject(StaffRoleService);
  protected readonly corridor = inject(CorridorService);

  protected readonly view = signal<PricingApprovalsView | null>(null);
  protected readonly loadError = signal<MerchantClientError | null>(null);
  protected readonly chip = signal<Chip>('pending_approval');
  protected readonly detail = signal<PricingApprovalItem | null>(null);
  protected readonly dialog = signal<Decision | null>(null);
  protected readonly reason = signal('');
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly dialogError = signal<string | null>(null);
  protected readonly toast = signal<{ tone: 'success' | 'danger'; text: string } | null>(null);

  protected readonly chips = CHIPS;
  protected readonly flowLabel = FLOW_LABEL;
  protected readonly technique = techniqueLabel;
  protected readonly statusLabel = { ...PRICING_STATUS_LABEL, pending_approval: 'Pending Approval' } as Record<PricingStatus, string>;
  protected readonly tone = PRICING_STATUS_TONE;
  protected readonly secondary = secondarySummary;
  protected readonly short = pricingShort;
  protected readonly day = fmtDay;
  protected readonly dateTime = fmtDateTime;
  protected readonly money = money;
  protected readonly refLabel = REFERENCE_PERIOD_LABEL;
  protected readonly metricLabel = METRIC_SHORT;
  protected readonly promoLabel = PROMO_TYPE_LABEL;

  protected readonly counts = computed(() => {
    const out: Record<string, number> = { all: 0 };
    for (const i of this.view()?.items ?? []) {
      out['all']++;
      out[i.version.status] = (out[i.version.status] ?? 0) + 1;
    }
    return out;
  });
  protected readonly rows = computed(() => {
    const c = this.chip();
    const items = (this.view()?.items ?? []).filter((i) => c === 'all' || i.version.status === c);
    return [...items].sort((a, b) => APPROVAL_STATUS_ORDER.indexOf(a.version.status) - APPROVAL_STATUS_ORDER.indexOf(b.version.status));
  });

  constructor() {
    // The demo authenticator shows the signed-in user's code, for the re-authentication step.
    this.demo.sessionWanted.set(true);
    inject(DestroyRef).onDestroy(() => this.demo.sessionWanted.set(false));
    effect(() => {
      this.roles.role();
      void this.load(this.corridor.code());
    });
  }

  protected async load(country = this.corridor.code()) {
    this.loadError.set(null);
    try {
      this.view.set(await this.api.pricingApprovals(country));
    } catch (e) {
      this.loadError.set(toMerchantError(e));
    }
  }

  protected vaText(i: PricingApprovalItem) {
    if (!(i.country === 'ID' && i.version.methodCode === 'va')) return '';
    return i.version.vaBanks.length ? i.version.vaBanks.map((b) => VA_BANKS.find((v) => v.code === b)?.name ?? b).join(', ') : 'All VA Banks';
  }

  /** "New Rate" (§7.8): including USD and secondary charges. */
  protected newRate(i: PricingApprovalItem) {
    const sec = secondarySummary(i.version);
    return `${pricingShort(i.version)}${sec ? ` · ${sec}` : ''}`;
  }

  protected openDetail(item: PricingApprovalItem) {
    this.dialog.set(null);
    this.detail.set(item);
  }

  /** Approve / reject from a row or the sheet: the decision opens in the sheet's footer. */
  protected open(item: PricingApprovalItem, decision: 'approve' | 'reject', e?: Event) {
    e?.stopPropagation();
    this.detail.set(item);
    this.dialog.set({ item, decision });
    this.reason.set('');
    this.code.set('');
    this.dialogError.set(null);
    setTimeout(() => document.querySelector<HTMLElement>('.sheet-confirm textarea, .sheet-confirm input')?.focus());
  }

  protected close() {
    if (!this.busy()) this.dialog.set(null);
  }

  /** Esc / backdrop / close: leave the decision first, then the sheet. */
  protected dismissDetail() {
    if (this.busy()) return;
    if (this.dialog()) this.dialog.set(null);
    else this.detail.set(null);
  }

  protected setCode(value: string, el: HTMLInputElement) {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    if (digits !== value) el.value = digits;
    this.code.set(digits);
    this.dialogError.set(null);
  }

  protected async confirm() {
    const d = this.dialog();
    if (!d || this.busy()) return;
    if (d.decision === 'reject' && !this.reason().trim()) return;
    if (!/^\d{6}$/.test(this.code())) {
      this.dialogError.set('Enter the 6-digit code.');
      return;
    }
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      await this.api.decidePricing(d.item.applicationId, d.item.version.id, { decision: d.decision, reason: this.reason().trim(), code: this.code() });
      this.dialog.set(null);
      this.detail.set(null);
      this.flash('success', d.decision === 'approve' ? `Approved – ${d.item.methodName} v${d.item.version.version} for ${d.item.merchantName}.` : `Rejected – ${d.item.methodName} v${d.item.version.version} for ${d.item.merchantName}.`);
      await this.load();
    } catch (e) {
      const err = toMerchantError(e) as MerchantClientError & { attemptsRemaining?: number };
      const code = String(err.code);
      if (code === 'MFA_CODE_INVALID') this.dialogError.set(`Incorrect code.${err.attemptsRemaining ? ` ${err.attemptsRemaining} attempt${err.attemptsRemaining === 1 ? '' : 's'} left` : ''}`);
      else if (code === 'MFA_CODE_REUSED') this.dialogError.set('Code already used. Wait for a new code.');
      else if (code === 'MFA_BLOCKED') this.dialogError.set('Sign-in blocked. Contact Mobi Support.');
      else {
        this.dialog.set(null);
        this.flash('danger', d.decision === 'approve' ? `Could not approve – ${err.message ?? 'please try again.'}` : `Could not reject – ${err.message ?? 'please try again.'}`);
      }
    } finally {
      this.busy.set(false);
    }
  }

  private flash(tone: 'success' | 'danger', text: string) {
    this.toast.set({ tone, text });
    setTimeout(() => this.toast.set(null), tone === 'success' ? 2000 : 5000);
  }
}
