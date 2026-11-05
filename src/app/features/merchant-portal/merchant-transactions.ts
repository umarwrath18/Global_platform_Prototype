import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { toClientError } from '../../core/api/api-error';
import {
  DATE_PRESET_LABEL,
  DatePreset,
  formatAmount,
  MerchantPortalOverview,
  TRANSACTION_STATUS_LABEL,
  TransactionPage,
  TransactionQuery,
  TransactionStatus,
} from '../../core/merchants/merchant-portal';
import { MerchantPortalApi } from '../../core/merchants/merchant-portal-api.service';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

const STATUS_TONE: Record<TransactionStatus, string> = { successful: 'success', failed: 'danger', pending: 'warning', refunded: 'info' };
const PAGE_SIZE = 25;

/** My Transactions: payment-method-level records with filters, search and CSV export. */
@Component({
  selector: 'app-merchant-transactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  styleUrl: './merchant-portal.scss',
  template: `
    <main class="page">
      <div class="portal-head">
        <div>
          <h1>My Transactions</h1>
          <p class="sub">Payments received through each of your payment methods.</p>
        </div>
        <div class="actions">
          @if (page()?.sampleData) {
            <span class="sample-tag" title="No live transaction service is connected yet. Records are generated sample data.">Sample data · not live</span>
          }
          <button type="button" class="btn primary" (click)="export()" [disabled]="exporting() || loading() || !!error()">
            @if (exporting()) {<span class="spinner" aria-hidden="true"></span>} @else {<app-icon name="download" [size]="16" />}
            Export CSV
          </button>
        </div>
      </div>

      @if (notice(); as n) {
        <div class="alert compact" [class]="n.tone" role="status"><app-icon [name]="n.tone === 'danger' ? 'alert-circle' : 'info'" /><div>{{ n.text }}</div></div>
      }

      <section class="panel-card">
        <form class="filters-bar" (submit)="$event.preventDefault(); applySearch()" role="search" aria-label="Filter transactions">
          <label class="fld">
            <span class="f-label">Date range</span>
            <select class="f-input" (change)="setRange($any($event.target).value)" aria-label="Date range">
              @for (p of presets; track p) {
                <option [value]="p" [selected]="range() === p">{{ presetLabel[p] }}</option>
              }
              <option value="custom" [selected]="range() === 'custom'">Custom range</option>
            </select>
          </label>
          @if (range() === 'custom') {
            <label class="fld">
              <span class="f-label">From</span>
              <input class="f-input" type="date" [value]="from()" [max]="to() || today" (change)="setDate('from', $any($event.target).value)" />
            </label>
            <label class="fld">
              <span class="f-label">To</span>
              <input class="f-input" type="date" [value]="to()" [min]="from()" [max]="today" (change)="setDate('to', $any($event.target).value)" />
            </label>
          }
          <label class="fld">
            <span class="f-label">Payment method</span>
            <select class="f-input" (change)="setFilter('method', $any($event.target).value)" aria-label="Payment method">
              <option value="" [selected]="!method()">All methods</option>
              @for (m of methods(); track m.code) {
                <option [value]="m.code" [selected]="method() === m.code">{{ m.name }}{{ multiCountry() ? ' (' + m.country + ')' : '' }}</option>
              }
            </select>
          </label>
          <label class="fld">
            <span class="f-label">Status</span>
            <select class="f-input" (change)="setFilter('status', $any($event.target).value)" aria-label="Status">
              <option value="" [selected]="!status()">All statuses</option>
              @for (s of statuses; track s) {
                <option [value]="s" [selected]="status() === s">{{ statusLabel[s] }}</option>
              }
            </select>
          </label>
          <label class="fld grow">
            <span class="f-label">Transaction ID</span>
            <span class="search-box">
              <app-icon name="search" [size]="16" />
              <input class="f-input" type="search" placeholder="Search by transaction ID" maxlength="64" [value]="search()" (input)="search.set($any($event.target).value)" (search)="applySearch()" />
            </span>
          </label>
          <button type="submit" class="btn">Search</button>
          @if (hasFilters()) {
            <button type="button" class="btn ghost" (click)="clearFilters()">Clear</button>
          }
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
          @if (p.total === 0) {
            <div class="empty-state">
              <div class="icon-tile"><app-icon name="swap" /></div>
              <h3>No transactions found</h3>
              <p>{{ hasFilters() || range() !== '30d' ? 'Try a different date range or clear the filters.' : 'Transactions will appear here once you start receiving payments.' }}</p>
              @if (hasFilters()) {
                <button type="button" class="btn" (click)="clearFilters()">Clear filters</button>
              }
            </div>
          } @else {
            <div class="table-wrap" [class.dim]="loading()" [attr.aria-busy]="loading()">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Invoice ID</th>
                    <th>Transaction ID</th>
                    <th>Payment method</th>
                    <th>Date &amp; time</th>
                    <th class="num">Amount</th>
                    <th>Currency</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of p.items; track t.transactionId) {
                    <tr>
                      <td class="mono">{{ t.invoiceId }}</td>
                      <td class="mono">{{ t.transactionId }}</td>
                      <td>{{ t.paymentMethod.name }}</td>
                      <td class="muted">{{ dateTime(t.createdAt) }}</td>
                      <td class="num mono">{{ amount(t.amount, t.currency) }}</td>
                      <td>{{ t.currency }}</td>
                      <td><span class="status" [class]="tone[t.status]">{{ statusLabel[t.status] }}</span></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <div class="pager">
              <span class="muted">{{ rangeText() }}</span>
              <div class="actions">
                <button type="button" class="btn sm" (click)="go(p.page - 1)" [disabled]="p.page <= 1 || loading()">Previous</button>
                <span class="muted">Page {{ p.page }} of {{ pages() }}</span>
                <button type="button" class="btn sm" (click)="go(p.page + 1)" [disabled]="p.page >= pages() || loading()">Next</button>
              </div>
            </div>
          }
        }
      </section>
    </main>
  `,
})
export class MerchantTransactions {
  private readonly api = inject(MerchantPortalApi);

  protected readonly presets: DatePreset[] = ['today', '7d', '30d'];
  protected readonly presetLabel = DATE_PRESET_LABEL;
  protected readonly statuses = Object.keys(TRANSACTION_STATUS_LABEL) as TransactionStatus[];
  protected readonly statusLabel = TRANSACTION_STATUS_LABEL;
  protected readonly tone = STATUS_TONE;
  protected readonly amount = formatAmount;
  protected readonly dateTime = fmtDateTime;
  protected readonly today = isoDate(new Date());

  protected readonly range = signal<DatePreset | 'custom'>('30d');
  protected readonly from = signal(isoDate(daysAgo(29)));
  protected readonly to = signal(this.today);
  protected readonly method = signal('');
  protected readonly status = signal<TransactionStatus | ''>('');
  protected readonly search = signal('');
  private readonly appliedSearch = signal('');
  protected readonly pageNo = signal(1);

  protected readonly overview = signal<MerchantPortalOverview | null>(null);
  protected readonly page = signal<TransactionPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly exporting = signal(false);
  protected readonly notice = signal<{ tone: 'info' | 'danger'; text: string } | null>(null);
  private request = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly methods = computed(() => this.overview()?.paymentMethods ?? []);
  protected readonly multiCountry = computed(() => new Set(this.methods().map((m) => m.country)).size > 1);
  protected readonly hasFilters = computed(() => !!(this.method() || this.status() || this.appliedSearch()));
  protected readonly pages = computed(() => Math.max(1, Math.ceil((this.page()?.total ?? 0) / PAGE_SIZE)));
  protected readonly dateError = computed(() => (this.range() === 'custom' && (!this.from() || !this.to() || this.from() > this.to()) ? 'Choose a start date on or before the end date.' : null));
  protected readonly rangeText = computed(() => {
    const p = this.page();
    if (!p || !p.total) return '';
    const start = (p.page - 1) * p.pageSize + 1;
    return `${start}–${Math.min(p.total, start + p.items.length - 1)} of ${p.total} transactions`;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.noticeTimer));
    this.api.overview().then((o) => this.overview.set(o)).catch(() => undefined);
    void this.load();
  }

  private query(): TransactionQuery {
    return {
      range: this.range(),
      ...(this.range() === 'custom' ? { from: this.from(), to: this.to() } : {}),
      method: this.method() || undefined,
      status: this.status() || undefined,
      q: this.appliedSearch() || undefined,
      page: this.pageNo(),
      pageSize: PAGE_SIZE,
    };
  }

  protected async load() {
    if (this.dateError()) return;
    const id = ++this.request;
    this.loading.set(true);
    this.error.set(null);
    try {
      const p = await this.api.transactions(this.query());
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
    this.pageNo.set(1);
    void this.load();
  }

  protected setRange(v: DatePreset | 'custom') {
    this.range.set(v);
    this.reload();
  }

  protected setDate(which: 'from' | 'to', v: string) {
    (which === 'from' ? this.from : this.to).set(v);
    this.reload();
  }

  protected setFilter(which: 'method' | 'status', v: string) {
    if (which === 'method') this.method.set(v);
    else this.status.set(v as TransactionStatus | '');
    this.reload();
  }

  protected applySearch() {
    const v = this.search().trim().toUpperCase();
    if (v && /[^A-Z0-9-]/.test(v)) {
      this.flash('danger', 'Transaction IDs contain only letters, numbers and dashes.');
      return;
    }
    this.appliedSearch.set(v);
    this.reload();
  }

  protected clearFilters() {
    this.method.set('');
    this.status.set('');
    this.search.set('');
    this.appliedSearch.set('');
    this.reload();
  }

  protected go(n: number) {
    this.pageNo.set(n);
    void this.load();
  }

  /** Exports every record matching the current filters (not just this page). */
  protected async export() {
    if (this.exporting() || this.dateError()) return;
    this.exporting.set(true);
    try {
      const res = await this.api.exportCsv(this.query());
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
