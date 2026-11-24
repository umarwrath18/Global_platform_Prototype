import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { toClientError } from '@gp/core/api/api-error';
import { TransactionDetail } from '@gp/core/merchants/merchant-portal';
import { MerchantPortalApi } from '@gp/core/merchants/merchant-portal-api.service';
import { fmtDateTime, fmtMoney, TXN_FLOW_LABEL, TxnFlow } from '@gp/core/transactions/transactions';
import { Icon } from '@gp/shared/icon';
import { downloadReceipt } from '@gp/shared/receipt-download';
import { SideSheet } from '@gp/shared/side-sheet';
import { TxnIpn, TxnSections, TxnStatusBadge, TxnTimeline } from '@gp/shared/txn-ui';

/**
 * Transaction details for the merchant, in a side sheet: the amount with its breakdown (Amount, Fee
 * (MDR), Net amount or Total debited), references, payment or beneficiary, settlement, timeline and
 * IPN, then the Sales slip (successful pay-in) or Payment advice (successful payout) as a PDF.
 * No payment path, provider details, internal references or pricing versions.
 */
@Component({
  selector: 'app-merchant-transaction-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SideSheet, TxnSections, TxnStatusBadge, TxnTimeline, TxnIpn],
  template: `
    <app-side-sheet label="Transaction details" (dismiss)="closed.emit()">
      <header class="sheet-head">
        <div class="sheet-titles">
          @if (d(); as t) {
            <p class="sheet-eyebrow">{{ flowLabel[t.flow] }} · {{ t.methodName }} · {{ t.countryName }}</p>
            <h2 class="sheet-title">{{ t.transactionId }}</h2>
            <p class="sheet-sub">Merchant Ref ID {{ t.invoiceId }} · {{ when(t.createdAt) }}</p>
          } @else {
            <p class="sheet-eyebrow">{{ flowLabel[flow()] }}</p>
            <h2 class="sheet-title">{{ id() }}</h2>
          }
        </div>
        <button type="button" class="sheet-close" (click)="closed.emit()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
      </header>
      <div class="sheet-body">
        @if (d(); as t) {
          <div class="sheet-hero">
            <div class="mp-hero-top">
              <div>
                <span class="hero-label">Amount</span>
                <p class="hero-value">{{ money(t.amount, t.currency) }}</p>
              </div>
              <app-txn-status [status]="t.status" />
            </div>
            <dl class="mp-breakdown">
              <div><dt>Amount</dt><dd>{{ money(t.amount, t.currency) }}</dd></div>
              <div><dt>Fee (MDR)@if (t.feeRate) { · {{ t.feeRate }}}</dt><dd>{{ t.fee === null ? '—' : (t.flow === 'payin' ? '− ' : '+ ') + money(t.fee, t.currency) }}</dd></div>
              <div class="total"><dt>{{ t.flow === 'payin' ? 'Net amount' : 'Total debited' }}</dt><dd>{{ t.net === null ? '—' : money(t.net, t.currency) }}</dd></div>
            </dl>
            @if (t.fee === null) {<p class="hero-sub">Fee and {{ t.flow === 'payin' ? 'net amount' : 'total debited' }} show once the {{ t.flow === 'payin' ? 'payment' : 'payout' }} is successful.</p>}
          </div>
          <app-txn-sections [sections]="t.sections" [flow]="t.flow" />
          <section class="txn-sec"><h3>Timeline</h3><app-txn-timeline [entries]="t.timeline" /></section>
          <section class="txn-sec"><h3>Notification to your server (IPN)</h3><app-txn-ipn [status]="t.ipn.status" [attempts]="t.ipn.attempts" /></section>
          @if (slipError(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
        } @else if (error(); as e) {
          <div class="empty-state" role="alert"><div class="icon-tile"><app-icon name="alert-circle" /></div><h3>We couldn't load this transaction</h3><p>{{ e }}</p></div>
        } @else {
          <div class="skeleton-rows" aria-busy="true" aria-label="Loading transaction"><span></span><span></span><span></span></div>
        }
      </div>
      @if (d(); as t) {
        <footer class="sheet-foot">
          <span class="sheet-foot-note">{{ docNote() }}</span>
          <button type="button" class="btn" (click)="copy(t.transactionId)">@if (copied()) {<app-icon name="check" [size]="14" />Copied} @else {<app-icon name="copy" [size]="14" />Copy Mobi Ref ID}</button>
          <button type="button" class="btn primary" (click)="download(t)" [disabled]="!t.document || busy()">
            @if (busy()) {<span class="spinner" aria-hidden="true"></span>} @else {<app-icon name="download" [size]="16" />}
            {{ t.flow === 'payin' ? 'Download sales slip' : 'Download payment advice' }}
          </button>
        </footer>
      }
    </app-side-sheet>
  `,
  styles: `
    .mp-hero-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .mp-breakdown { margin: 0; padding-top: 12px; border-top: 1px solid var(--border-soft); display: grid; gap: 6px; font-size: 14px; font-variant-numeric: tabular-nums; }
    .mp-breakdown div { display: flex; justify-content: space-between; gap: 12px; }
    .mp-breakdown dt { color: var(--text-muted); }
    .mp-breakdown dd { margin: 0; }
    .mp-breakdown .total { padding-top: 8px; border-top: 1px dashed var(--border); font-weight: 700; }
    .mp-breakdown .total dt { color: var(--text); }
  `,
})
export class MerchantTransactionSheet {
  private readonly api = inject(MerchantPortalApi);

  readonly flow = input.required<TxnFlow>();
  readonly id = input.required<string>();
  readonly closed = output<void>();

  protected readonly d = signal<TransactionDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly busy = signal(false);
  protected readonly slipError = signal<string | null>(null);
  protected readonly flowLabel = TXN_FLOW_LABEL;
  protected readonly money = fmtMoney;
  protected readonly when = (t: number) => fmtDateTime(t);
  protected readonly docNote = computed(() => {
    const t = this.d();
    if (!t || t.document) return '';
    return t.flow === 'payin' ? 'The sales slip is available once the payment is successful.' : 'The payment advice is available once the payout is successful.';
  });

  constructor() {
    effect(() => {
      const flow = this.flow();
      const id = this.id();
      untracked(() => {
        this.d.set(null);
        this.error.set(null);
        this.slipError.set(null);
        this.api
          .transaction(flow, id)
          .then((d) => this.d.set(d))
          .catch((e) => {
            const err = toClientError(e);
            this.error.set('message' in err && typeof err.message === 'string' ? err.message : 'Please try again in a moment.');
          });
      });
    });
  }

  protected async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // Clipboard not available; the ID is on screen.
    }
  }

  /** Sales slip (pay-in) or Payment advice (payout) as a one-page PDF with the Mobi logo. No fee or net. */
  protected async download(t: TransactionDetail) {
    if (!t.document || this.busy()) return;
    this.busy.set(true);
    this.slipError.set(null);
    try {
      await downloadReceipt(t);
    } catch {
      this.slipError.set("We couldn't create the document. Please try again.");
    } finally {
      this.busy.set(false);
    }
  }
}
