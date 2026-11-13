import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { toClientError } from '@gp/core/api/api-error';
import { TransactionPage } from '@gp/core/merchants/merchant-portal';
import { MerchantPortalApi } from '@gp/core/merchants/merchant-portal-api.service';
import { CurrencyAmount, fmtAmount, fmtDateTime, fmtMoney, PAYMENT_TYPE_LABEL, PaymentType, TXN_FLOW_LABEL, TXN_RANGE_LABEL, TXN_STATUS_LABEL, TXN_STATUSES, TxnFlow, TxnRange, TxnStatus } from '@gp/core/transactions/transactions';
import { TxnQuery } from '@gp/core/transactions/transactions-api.service';
import { Icon } from '@gp/shared/icon';
import { Pager } from '@gp/shared/pager';
import { TxnStatusBadge } from '@gp/shared/txn-ui';
import { MerchantTransactionSheet } from './transaction-sheet';
import { MERCHANT_REVIEW_MESSAGE, MERCHANT_REVIEW_TITLE } from '@gp/core/merchants/suspensions';

/**
 * My Transactions: PayIn | Payout tabs, payment type chips, filters, a summary per currency, the
 * list with Fee and Net amount, CSV export, and the details in a side sheet. The records are the
 * same ones the Global Platform shows (sample data until the transaction service exists).
 */
@Component({
  selector: 'app-merchant-transactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Pager, TxnStatusBadge, MerchantTransactionSheet],
  styleUrl: './merchant-portal.scss',
  template: `
    <main class="page">
      <div class="portal-head">
        <div>
          <h1>My Transactions</h1>
          <p class="sub">Your payments and payouts. Amounts are in each transaction's own currency.</p>
        </div>
        <div class="actions">
          @if (page()?.sampleData) {
            <span class="sample-tag" title="No live transaction service is connected yet. Records are generated sample data.">Sample data · not live</span>
          }
          <button type="button" class="btn primary" (click)="export()" [disabled]="exporting() || loading() || !!error() || !!page()?.underReview" [title]="page()?.underReview ? 'Not available while your account is under review' : ''">
            @if (exporting()) {<span class="spinner" aria-hidden="true"></span>} @else {<app-icon name="download" [size]="16" />}
            Export CSV
          </button>
        </div>
      </div>

      @if (page()?.underReview) {
        <div class="review-banner" role="status"><strong>{{ reviewTitle }}</strong>{{ reviewMessage }}</div>
      }

      @if (notice(); as n) {
        <div class="alert compact" [class]="n.tone" role="status"><app-icon [name]="n.tone === 'danger' ? 'alert-circle' : 'info'" /><div>{{ n.text }}</div></div>
      }

      <div class="txn-tabs" role="tablist" aria-label="Flow">
        @for (f of flows; track f) {
          <button type="button" role="tab" [attr.aria-selected]="flow() === f" [class.on]="flow() === f" (click)="setFlow(f)">{{ flowLabel[f] }}</button>
        }
      </div>

      @let opts = page()?.options;
      <div class="txn-chips" role="group" aria-label="Payment type">
        <span class="txn-chips-label">Payment type</span>
        <button type="button" [class.on]="!type()" [attr.aria-pressed]="!type()" (click)="setType('')">All</button>
        @for (t of opts?.paymentTypes ?? []; track t) {
          <button type="button" [class.on]="type() === t" [attr.aria-pressed]="type() === t" (click)="setType(t)">{{ typeLabel[flow()][t] }}</button>
        }
      </div>

      <section class="panel-card">
        <form class="txn-filters" (submit)="$event.preventDefault(); applySearch()" role="search" aria-label="Filter transactions">
          <label class="fld search">
            Search
            <span class="search-row">
              <input class="f-input" type="search" placeholder="Transaction ID or Invoice ID" maxlength="64" [value]="search()" (input)="search.set($any($event.target).value)" />
              <button type="submit" class="btn" aria-label="Search"><app-icon name="search" [size]="16" /></button>
            </span>
          </label>
          <label class="fld">
            Date range
            <select class="f-input" (change)="setRange($any($event.target).value)">
              @for (r of ranges; track r[0]) {<option [value]="r[0]" [selected]="range() === r[0]">{{ r[1] }}</option>}
              <option value="custom" [selected]="range() === 'custom'">Custom range</option>
            </select>
          </label>
          @if (range() === 'custom') {
            <label class="fld">From<input class="f-input" type="date" [value]="from()" [max]="to() || today" (change)="setDate('from', $any($event.target).value)" /></label>
            <label class="fld">To<input class="f-input" type="date" [value]="to()" [min]="from()" [max]="today" (change)="setDate('to', $any($event.target).value)" /></label>
          }
          @if ((opts?.countries?.length ?? 0) > 1) {
            <label class="fld">
              Country
              <select class="f-input" (change)="setFilter('country', $any($event.target).value)">
                <option value="" [selected]="!country()">All countries</option>
                @for (c of opts!.countries; track c.code) {<option [value]="c.code" [selected]="country() === c.code">{{ c.name }}</option>}
              </select>
            </label>
          }
          @if (opts?.subMerchants?.length) {
            <label class="fld">
              Sub-merchant
              <select class="f-input" (change)="setFilter('subMerchant', $any($event.target).value)">
                <option value="" [selected]="!subMerchant()">All</option>
                <option value="master" [selected]="subMerchant() === 'master'">Master Merchant</option>
                @for (s of opts!.subMerchants; track s.id) {<option [value]="s.id" [selected]="subMerchant() === s.id">{{ s.name }}</option>}
              </select>
            </label>
          }
          <label class="fld">
            Payment method
            <select class="f-input" (change)="setFilter('method', $any($event.target).value)">
              <option value="" [selected]="!method()">All methods</option>
              @for (m of methods(); track m.code) {<option [value]="m.code" [selected]="method() === m.code">{{ m.name }}</option>}
            </select>
          </label>
          <label class="fld">
            Status
            <select class="f-input" (change)="setFilter('status', $any($event.target).value)">
              <option value="" [selected]="!status()">All statuses</option>
              @for (s of statuses; track s) {<option [value]="s" [selected]="status() === s">{{ statusLabel[s] }}</option>}
            </select>
          </label>
          @if (hasFilters()) {<button type="button" class="btn ghost" (click)="clearFilters()">Clear filters</button>}
        </form>

        @if (dateError()) {
          <p class="f-error pad"><app-icon name="alert-circle" [size]="14" />{{ dateError() }}</p>
        }

        @if (error()) {
          <div class="empty-state" role="alert">
            <div class="icon-tile"><app-icon name="alert-circle" /></div>
            <h3>We couldn’t load your transactions</h3>
            <p>{{ error() }}</p>
            <button type="button" class="btn" (click)="load()">Try again</button>
          </div>
        } @else if (!page() && loading()) {
          <div class="skeleton-rows" aria-busy="true"><span></span><span></span><span></span><span></span><span></span></div>
        } @else if (page(); as p) {
          <div class="txn-strip" aria-label="Summary for these filters">
            <div class="txn-kpi"><div class="txn-kl">Transactions</div><div class="txn-kv">{{ p.summary.total.toLocaleString('en-US') }}</div></div>
            <div class="txn-kpi"><div class="txn-kl">Successful</div><div class="txn-kv success">{{ p.summary.successful.toLocaleString('en-US') }}</div></div>
            <div class="txn-kpi"><div class="txn-kl">Gross volume</div>@for (a of amounts(p.summary.gross); track a) {<div class="txn-ka strong">{{ a }}</div>} @empty {<div class="txn-kv">—</div>}</div>
            <div class="txn-kpi"><div class="txn-kl">Fees</div>@for (a of amounts(p.summary.fees); track a) {<div class="txn-ka strong">{{ a }}</div>} @empty {<div class="txn-kv">—</div>}</div>
            <div class="txn-kpi"><div class="txn-kl">{{ flow() === 'payin' ? 'Net amount' : 'Total debited' }}</div>@for (a of amounts(p.summary.net); track a) {<div class="txn-ka strong">{{ a }}</div>} @empty {<div class="txn-kv">—</div>}</div>
          </div>
          @if (p.total === 0) {
            <div class="empty-state">
              <div class="icon-tile"><app-icon name="swap" /></div>
              <h3>No transactions match these filters.</h3>
              <p>{{ hasFilters() ? 'Try a different date range or clear the filters.' : 'Try a longer date range.' }}</p>
              @if (hasFilters()) {<button type="button" class="btn" (click)="clearFilters()">Clear filters</button>}
            </div>
          } @else {
            <div class="table-wrap" [class.dim]="loading()" [attr.aria-busy]="loading()">
              <table class="data-table txn-table">
                <thead>
                  <tr>
                    <th scope="col">Date &amp; time</th>
                    <th scope="col">Invoice ID</th>
                    <th scope="col">Transaction ID</th>
                    @if (showSub()) {<th scope="col">Sub-merchant</th>}
                    <th scope="col">Payment method</th>
                    <th scope="col" class="num">Amount</th>
                    <th scope="col" class="num">Fee</th>
                    <th scope="col" class="num">{{ flow() === 'payin' ? 'Net amount' : 'Total debited' }}</th>
                    <th scope="col">Currency</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of p.items; track t.transactionId) {
                    <tr class="clickable" [class.selected]="openId() === t.transactionId" (click)="openId.set(t.transactionId)">
                      <td class="muted">{{ dateTime(t.createdAt) }}</td>
                      <td class="mono">{{ t.invoiceId }}</td>
                      <td><a class="txn-id" href="" (click)="$event.preventDefault(); $event.stopPropagation(); openId.set(t.transactionId)">{{ t.transactionId }}</a></td>
                      @if (showSub()) {<td>{{ t.subMerchantName ?? 'Master Merchant' }}</td>}
                      <td>{{ t.methodName }}</td>
                      <td class="num mono">{{ amount(t.amount, t.currency) }}</td>
                      <td class="num mono" [class.muted]="t.fee === null">{{ t.fee === null ? '—' : amount(t.fee, t.currency) }}</td>
                      <td class="num mono" [class.muted]="t.net === null">{{ t.net === null ? '—' : amount(t.net, t.currency) }}</td>
                      <td>{{ t.currency }}</td>
                      <td><app-txn-status [status]="t.status" />@if (t.note) {<div class="sub-line">{{ t.note }}</div>}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <app-pager [total]="p.total" [page]="pageIndex()" (pageChange)="go($event)" [pageSize]="pageSize()" (pageSizeChange)="setPageSize($event)" />
          }
        }
      </section>

      @if (openId(); as id) {
        <app-merchant-transaction-sheet [flow]="flow()" [id]="id" (closed)="openId.set(null)" />
      }
    </main>
  `,
})
export class MerchantTransactions {
  private readonly api = inject(MerchantPortalApi);

  protected readonly reviewTitle = MERCHANT_REVIEW_TITLE;
  protected readonly reviewMessage = MERCHANT_REVIEW_MESSAGE;
  protected readonly flows: TxnFlow[] = ['payin', 'payout'];
  protected readonly flowLabel = TXN_FLOW_LABEL;
  protected readonly typeLabel = PAYMENT_TYPE_LABEL;
  protected readonly ranges = Object.entries(TXN_RANGE_LABEL) as [Exclude<TxnRange, 'custom'>, string][];
  protected readonly statuses = TXN_STATUSES;
  protected readonly statusLabel = TXN_STATUS_LABEL;
  protected readonly amount = fmtAmount;
  protected readonly dateTime = (t: number) => fmtDateTime(t);
  protected readonly today = isoDate(new Date());

  protected readonly flow = signal<TxnFlow>('payin');
  protected readonly type = signal<PaymentType | ''>('');
  protected readonly range = signal<TxnRange>('24h');
  protected readonly from = signal(isoDate(daysAgo(6)));
  protected readonly to = signal(this.today);
  protected readonly country = signal('');
  protected readonly subMerchant = signal('');
  protected readonly method = signal('');
  protected readonly status = signal<TxnStatus | ''>('');
  protected readonly search = signal('');
  private readonly appliedSearch = signal('');
  protected readonly pageIndex = signal(0);
  protected readonly pageSize = signal(25);
  protected readonly openId = signal<string | null>(null);

  protected readonly page = signal<TransactionPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly exporting = signal(false);
  protected readonly notice = signal<{ tone: 'info' | 'danger'; text: string } | null>(null);
  private request = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly methods = computed(() => (this.page()?.options.methods ?? []).filter((m) => !this.type() || m.type === this.type()));
  /** Live sub-merchants only (they have their own MID); none → no column. */
  protected readonly showSub = computed(() => this.flow() === 'payin' && !!this.page()?.options.subMerchants.length);
  protected readonly hasFilters = computed(() => !!(this.type() || this.country() || this.subMerchant() || this.method() || this.status() || this.appliedSearch()) || this.range() !== '24h');
  protected readonly dateError = computed(() => (this.range() === 'custom' && (!this.from() || !this.to() || this.from() > this.to()) ? 'Choose a start date on or before the end date.' : null));

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.noticeTimer));
    void this.load();
  }

  private query(): TxnQuery {
    const custom = this.range() === 'custom';
    return {
      range: this.range(),
      from: custom ? new Date(`${this.from()}T00:00:00`).toISOString() : '',
      to: custom ? new Date(`${this.to()}T23:59:59`).toISOString() : '',
      type: this.type(),
      country: this.country(),
      subMerchant: this.subMerchant(),
      method: this.method(),
      status: this.status(),
      q: this.appliedSearch(),
      page: this.pageIndex() + 1,
      pageSize: this.pageSize(),
    };
  }

  protected async load() {
    if (this.dateError()) return;
    const id = ++this.request;
    this.loading.set(true);
    this.error.set(null);
    try {
      const p = await this.api.transactions(this.flow(), this.query());
      if (id === this.request) this.page.set(p);
    } catch (e) {
      if (id !== this.request) return;
      const err = toClientError(e);
      this.page.set(null);
      this.error.set(err.code === 'NETWORK_ERROR' ? 'You appear to be offline. Check your connection and try again.' : 'message' in err && typeof err.message === 'string' ? err.message : 'Please try again in a moment.');
    } finally {
      if (id === this.request) this.loading.set(false);
    }
  }

  private reload() {
    this.pageIndex.set(0);
    void this.load();
  }

  protected setFlow(f: TxnFlow) {
    if (f === this.flow()) return;
    this.flow.set(f);
    this.type.set('');
    this.method.set('');
    this.subMerchant.set('');
    this.openId.set(null);
    this.reload();
  }

  protected setType(t: PaymentType | '') {
    this.type.set(t);
    this.method.set('');
    this.reload();
  }

  protected setRange(v: TxnRange) {
    this.range.set(v);
    this.reload();
  }

  protected setDate(which: 'from' | 'to', v: string) {
    (which === 'from' ? this.from : this.to).set(v);
    this.reload();
  }

  protected setFilter(which: 'country' | 'subMerchant' | 'method' | 'status', v: string) {
    if (which === 'country') {
      this.country.set(v);
      this.method.set('');
      this.subMerchant.set('');
    } else if (which === 'subMerchant') this.subMerchant.set(v);
    else if (which === 'method') this.method.set(v);
    else this.status.set(v as TxnStatus | '');
    this.reload();
  }

  protected applySearch() {
    const v = this.search().trim().toUpperCase();
    if (v && /[^A-Z0-9-]/.test(v)) {
      this.flash('danger', 'IDs contain only letters, numbers and dashes.');
      return;
    }
    this.appliedSearch.set(v);
    this.reload();
  }

  protected clearFilters() {
    this.type.set('');
    this.range.set('24h');
    this.country.set('');
    this.subMerchant.set('');
    this.method.set('');
    this.status.set('');
    this.search.set('');
    this.appliedSearch.set('');
    this.reload();
  }

  protected go(i: number) {
    this.pageIndex.set(i);
    void this.load();
  }

  protected setPageSize(n: number) {
    this.pageSize.set(n);
    this.reload();
  }

  protected amounts(list: CurrencyAmount[]) {
    return list.map((a) => fmtMoney(a.amount, a.currency));
  }

  /** Exports every record matching the current filters (not just this page). */
  protected async export() {
    if (this.exporting() || this.dateError()) return;
    this.exporting.set(true);
    try {
      const res = await this.api.exportCsv(this.flow(), this.query());
      if (!res.rows) {
        this.flash('info', 'There are no transactions to export for these filters.');
        return;
      }
      const url = URL.createObjectURL(new Blob(['﻿' + res.csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.flash('info', `Exported ${res.rows} transaction${res.rows === 1 ? '' : 's'} to ${res.filename}.`);
    } catch (e) {
      const err = toClientError(e);
      this.flash('danger', 'message' in err && typeof err.message === 'string' ? err.message : 'The export failed. Please try again.');
    } finally {
      this.exporting.set(false);
    }
  }

  private flash(tone: 'info' | 'danger', text: string) {
    this.notice.set({ tone, text });
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), 6000);
  }
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
