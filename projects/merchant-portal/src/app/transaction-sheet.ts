import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { toClientError } from '@gp/core/api/api-error';
import { TransactionDetail } from '@gp/core/merchants/merchant-portal';
import { MerchantPortalApi } from '@gp/core/merchants/merchant-portal-api.service';
import { fmtDateTime, fmtMoney, TXN_FLOW_LABEL, TxnFlow } from '@gp/core/transactions/transactions';
import { Icon } from '@gp/shared/icon';
import { SideSheet } from '@gp/shared/side-sheet';
import { PaymentPath, TxnIpn, TxnSections, TxnStatusBadge, TxnTimeline } from '@gp/shared/txn-ui';

/**
 * Transaction details for the merchant, in a side sheet: a short payment path (Customer → Mobi →
 * Bank), payment, amount and fees, customer, bank reference, settlement, IPN attempts and a simple
 * timeline. No provider details, internal references or pricing versions.
 */
@Component({
  selector: 'app-merchant-transaction-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SideSheet, PaymentPath, TxnSections, TxnStatusBadge, TxnTimeline, TxnIpn],
  template: `
    <app-side-sheet label="Transaction details" (dismiss)="closed.emit()">
      <header class="sheet-head">
        <div class="sheet-titles">
          @if (d(); as t) {
            <p class="sheet-eyebrow">{{ flowLabel[t.flow] }} · {{ t.methodName }} · {{ t.countryName }}</p>
            <div class="txn-id-row">
              <span>{{ t.transactionId }}</span>
              <button type="button" class="copy" (click)="copy(t.transactionId)" [attr.aria-label]="copied() ? 'Copied' : 'Copy transaction ID'" [title]="copied() ? 'Copied' : 'Copy transaction ID'"><app-icon [name]="copied() ? 'check' : 'copy'" [size]="14" /></button>
            </div>
            <div class="txn-sheet-amount"><span class="amt">{{ money(t.amount, t.currency) }}</span><app-txn-status [status]="t.status" /></div>
            <p class="sheet-sub">{{ when(t.createdAt) }} · Invoice {{ t.invoiceId }}</p>
          } @else {
            <p class="sheet-eyebrow">{{ flowLabel[flow()] }}</p>
            <div class="txn-id-row">{{ id() }}</div>
          }
        </div>
        <button type="button" class="sheet-close" (click)="closed.emit()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
      </header>
      <div class="sheet-body">
        @if (d(); as t) {
          <app-payment-path [steps]="t.path" [flow]="t.flow" />
          <app-txn-sections [sections]="t.sections" [flow]="t.flow" />
          <section class="txn-sec"><h3>IPN</h3><app-txn-ipn [status]="t.ipn.status" [attempts]="t.ipn.attempts" /></section>
          <section class="txn-sec"><h3>Timeline</h3><app-txn-timeline [entries]="t.timeline" /></section>
        } @else if (error(); as e) {
          <div class="empty-state" role="alert"><div class="icon-tile"><app-icon name="alert-circle" /></div><h3>We couldn't load this transaction</h3><p>{{ e }}</p></div>
        } @else {
          <div class="skeleton-rows" aria-busy="true" aria-label="Loading transaction"><span></span><span></span><span></span></div>
        }
      </div>
    </app-side-sheet>
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
  protected readonly flowLabel = TXN_FLOW_LABEL;
  protected readonly money = fmtMoney;
  protected readonly when = (t: number) => fmtDateTime(t);

  constructor() {
    effect(() => {
      const flow = this.flow();
      const id = this.id();
      untracked(() => {
        this.d.set(null);
        this.error.set(null);
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
}
