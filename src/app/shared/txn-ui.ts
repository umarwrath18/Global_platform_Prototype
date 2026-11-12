import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DetailSection, fmtDateTime, IpnAttempt, PATH_STEP_LABEL, PathStep, TimelineEntry, TXN_STATUS_LABEL, TXN_STATUS_TONE, TxnFlow, TxnStatus } from '../core/transactions/transactions';

// Transaction pieces shared by the Global Platform and the Merchant Portal (styles: txn-ui.scss).

/** Transaction status pill (same colours in both apps). */
@Component({
  selector: 'app-txn-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display:inline-flex' },
  template: `<span [class]="'status ' + tone[status()]">{{ label[status()] }}</span>`,
})
export class TxnStatusBadge {
  readonly status = input.required<TxnStatus>();
  protected readonly label = TXN_STATUS_LABEL;
  protected readonly tone = TXN_STATUS_TONE;
}

/** The payment path strip: where the transaction is now, or where it stopped. */
@Component({
  selector: 'app-payment-path',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="txn-path" aria-label="Payment path">
      <h3 class="txn-path-title">Payment path</h3>
      <ol class="txn-steps" [style.--n]="steps().length">
        @for (s of steps(); track s.key) {
          <li class="txn-step" [class]="'txn-step ' + s.state">
            <span class="txn-dot" aria-hidden="true">
              @switch (s.state) {
                @case ('done') {✓}
                @case ('failed') {✕}
                @case ('expired') {!}
                @case ('current') {●}
              }
            </span>
            <span class="txn-step-label">{{ label(s) }}</span>
            <span class="txn-step-caption">{{ s.caption }}</span>
            <span class="sr-only">{{ stateText[s.state] }}</span>
          </li>
        }
      </ol>
    </section>
  `,
})
export class PaymentPath {
  readonly steps = input.required<PathStep[]>();
  readonly flow = input<TxnFlow>('payin');
  protected readonly stateText: Record<PathStep['state'], string> = { done: 'Done', current: 'In progress', failed: 'Stopped here', expired: 'Expired here', off: 'Not reached' };
  protected label(s: PathStep) {
    return s.key === 'customer' && this.flow() === 'payout' ? 'Beneficiary' : PATH_STEP_LABEL[s.key];
  }
}

/** Details sections as two-column label / value grids. Internal pages may link merchant and pricing fields. */
@Component({
  selector: 'app-txn-sections',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @for (sec of sections(); track sec.key + sec.title; let i = $index) {
      <section class="txn-sec" [attr.aria-label]="sec.title">
        <h3>
          @if (numbered() && numberOf(sec); as n) {<span class="txn-num" aria-hidden="true">{{ n }}</span>}
          {{ sec.title }}
        </h3>
        @if (sec.key === 'fees') {
          <div class="txn-fees">
            @for (f of sec.fields; track f.label; let last = $last) {
              <div class="txn-fee-row" [class.total]="last"><span>{{ f.label }}</span><span>{{ f.value }}</span></div>
            }
          </div>
        } @else {
          <dl class="txn-dl" [class.boxed]="sec.key === 'method'">
            @for (f of sec.fields; track f.label) {
              <div>
                <dt>{{ f.label }}@if (f.restricted) {<span class="txn-restricted" [title]="'Shown only to ' + f.restricted">{{ f.restricted }}</span>}</dt>
                <dd [class]="f.tone ? 'tone-' + f.tone : ''" [title]="f.value">
                  @if (links() && f.link) {
                    <a [routerLink]="f.link.kind === 'merchant' ? ['/merchants', f.link.id] : ['/merchant-pricing', f.link.id]">{{ f.value }}</a>
                  } @else {
                    {{ f.value }}
                  }
                </dd>
              </div>
            }
          </dl>
        }
      </section>
    }
  `,
})
export class TxnSections {
  readonly sections = input.required<DetailSection[]>();
  /** Number the sections that follow the payment path (Customer 1 … Bank 5). */
  readonly numbered = input(false);
  readonly links = input(false);
  readonly flow = input<TxnFlow>('payin');

  private readonly order = computed<string[]>(() => (this.flow() === 'payout' ? ['merchant', 'mobi', 'provider', 'bank', 'beneficiary'] : ['customer', 'merchant', 'mobi', 'provider', 'bank']));
  protected numberOf(sec: DetailSection) {
    const i = this.order().indexOf(sec.key);
    return i < 0 ? null : i + 1;
  }
}

/** Status timeline (newest first for staff; Created → Paid → Settled for merchants). */
@Component({
  selector: 'app-txn-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="txn-timeline">
      @for (e of entries(); track $index) {
        <li [class.waiting]="future(e)" [class.bad]="e.to === 'failed' || e.title === 'Failed'" [class.warn]="e.to === 'expired' || e.title === 'Expired' || e.title === 'Late success not applied'">
          <div>
            <strong>{{ e.title }}</strong>
            @if (e.from && e.to) {<span class="txn-trans"> · {{ status[e.from] }} → {{ status[e.to] }}</span>}
            @else if (!e.from && e.to) {<span class="txn-trans"> · {{ status[e.to] }}</span>}
          </div>
          <div class="txn-meta">
            @if (!future(e)) {{{ when(e.at) }}}
            @if (e.source) {<span> · {{ e.source }}</span>}
            @if (e.actor) {<span> · {{ e.actor }}</span>}
          </div>
          @if (e.detail) {<div class="txn-meta">{{ e.detail }}</div>}
        </li>
      }
    </ol>
  `,
})
export class TxnTimeline {
  readonly entries = input.required<TimelineEntry[]>();
  protected readonly status = TXN_STATUS_LABEL;
  protected future(e: TimelineEntry) {
    return e.at >= Number.MAX_SAFE_INTEGER || e.at > Date.now();
  }
  protected when(t: number) {
    return fmtDateTime(t, true);
  }
}

/** IPN delivery attempts to the merchant's callback URL. */
@Component({
  selector: 'app-txn-ipn',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="txn-ipn-status">{{ status() }}</p>
    @if (url()) {<p class="txn-meta truncate" [title]="url()">{{ url() }}</p>}
    @if (attempts().length) {
      <div class="table-wrap">
        <table class="data-table txn-mini">
          <thead><tr><th scope="col">Attempt</th><th scope="col">Sent</th><th scope="col">Result</th></tr></thead>
          <tbody>
            @for (a of attempts(); track a.attempt) {
              <tr><td>{{ a.attempt }}</td><td class="muted">{{ when(a.at) }}</td><td [class]="a.ok ? 'tone-success' : 'tone-danger'">{{ a.result }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <p class="txn-meta">No notification has been sent yet. It is sent once the transaction is final.</p>
    }
  `,
})
export class TxnIpn {
  readonly status = input.required<string>();
  readonly url = input('');
  readonly attempts = input.required<IpnAttempt[]>();
  protected when(t: number) {
    return fmtDateTime(t, true);
  }
}
