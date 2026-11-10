import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { FLOW_LABEL, periodText, PRICING_STATUS_LABEL, PRICING_STATUS_TONE, PricingApprovalItem, PricingApprovalsView, secondarySummary, techniqueLabel } from '../../core/merchants/products';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { DemoAuthenticatorService } from '../../shared/demo-authenticator';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

type Decision = { item: PricingApprovalItem; decision: 'approve' | 'reject' };

/**
 * Pricing Approvals (§8.7): Merchant Pricing changes submitted by Ops after onboarding. FinOps
 * approves or rejects; each decision asks for a current authenticator code, and the person who
 * submitted a change can't decide it (maker ≠ checker, enforced by the server).
 */
@Component({
  selector: 'app-pricing-approvals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  templateUrl: './pricing-approvals.html',
  styleUrl: './pricing.scss',
})
export class PricingApprovals {
  private readonly api = inject(MerchantApi);
  private readonly demo = inject(DemoAuthenticatorService);
  protected readonly roles = inject(StaffRoleService);

  protected readonly view = signal<PricingApprovalsView | null>(null);
  protected readonly loadError = signal<MerchantClientError | null>(null);
  protected readonly tab = signal<'pending' | 'decided'>('pending');
  protected readonly dialog = signal<Decision | null>(null);
  protected readonly reason = signal('');
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly dialogError = signal<string | null>(null);
  protected readonly toast = signal<{ tone: 'success' | 'danger'; text: string } | null>(null);

  protected readonly flowLabel = FLOW_LABEL;
  protected readonly technique = techniqueLabel;
  protected readonly statusLabel = PRICING_STATUS_LABEL;
  protected readonly tone = PRICING_STATUS_TONE;
  protected readonly period = periodText;
  protected readonly secondary = secondarySummary;
  protected readonly dateTime = fmtDateTime;

  constructor() {
    // The demo authenticator shows the signed-in user's code, for the re-authentication step.
    this.demo.sessionWanted.set(true);
    inject(DestroyRef).onDestroy(() => this.demo.sessionWanted.set(false));
    effect(() => {
      this.roles.role();
      void this.load();
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.view.set(await this.api.pricingApprovals());
    } catch (e) {
      this.loadError.set(toMerchantError(e));
    }
  }

  protected open(item: PricingApprovalItem, decision: 'approve' | 'reject') {
    this.dialog.set({ item, decision });
    this.reason.set('');
    this.code.set('');
    this.dialogError.set(null);
    queueMicrotask(() => document.querySelector<HTMLElement>('.pa-modal textarea, .pa-modal input')?.focus());
  }

  protected close() {
    if (!this.busy()) this.dialog.set(null);
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
