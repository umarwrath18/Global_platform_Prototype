import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { toClientError } from '../../core/api/api-error';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import {
  CurrencyAmount,
  fmtAmount,
  fmtDateTime,
  fmtMoney,
  PAYMENT_TYPE_LABEL,
  PaymentType,
  TXN_FLAG_LABEL,
  TXN_FLOW_LABEL,
  TXN_RANGE_LABEL,
  TXN_STATUS_LABEL,
  TXN_STATUSES,
  TxnFlag,
  TxnFlow,
  TxnListResponse,
  TxnListRow,
  TxnRange,
  TxnStatus,
} from '../../core/transactions/transactions';
import { TransactionsApi, TxnQuery } from '../../core/transactions/transactions-api.service';
import { Icon } from '../../shared/icon';
import { Pager } from '../../shared/pager';
import { TxnStatusBadge } from '../../shared/txn-ui';
import { TransactionSheet } from './transaction-sheet';

/** Filter keys kept in the URL (SF-4), so a reload or a shared link restores the view. */
const FILTER_KEYS = ['type', 'range', 'from', 'to', 'country', 'merchant', 'subMerchant', 'method', 'provider', 'status', 'flag', 'currency', 'amountMin', 'amountMax', 'q', 'sort', 'dir'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/**
 * Transactions (Transaction Management phase 1): PayIn | Payout tabs, each its own API and table;
 * payment type chips; filters kept in the URL; a summary per status and currency; and the details
 * in a side sheet (`?txn=` in the URL). Sample data until the transaction service exists.
 */
@Component({
  selector: 'app-transactions-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Pager, TxnStatusBadge, TransactionSheet],
  templateUrl: './transactions-page.html',
})
export class TransactionsPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(TransactionsApi);
  protected readonly roles = inject(StaffRoleService);

  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  protected readonly flow = computed<TxnFlow>(() => (this.params().get('flow') === 'payout' ? 'payout' : 'payin'));
  protected readonly filters = computed(() => {
    const p = this.params();
    const out = {} as Record<FilterKey, string>;
    for (const k of FILTER_KEYS) out[k] = p.get(k) ?? '';
    if (!out.range) out.range = '24h';
    return out;
  });
  protected readonly pageIndex = computed(() => Math.max(0, (Number(this.params().get('page')) || 1) - 1));
  protected readonly pageSize = computed(() => {
    const n = Number(this.params().get('pageSize'));
    return [10, 25, 50].includes(n) ? n : 25;
  });
  protected readonly openId = computed(() => this.params().get('txn'));

  protected readonly data = signal<TxnListResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly exporting = signal(false);
  protected readonly toast = signal<{ tone: 'info' | 'danger'; text: string } | null>(null);
  protected readonly searchText = signal(this.route.snapshot.queryParamMap.get('q') ?? '');
  protected readonly moreOpen = signal(false);
  private request = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly flows: TxnFlow[] = ['payin', 'payout'];
  protected readonly flowLabel = TXN_FLOW_LABEL;
  protected readonly typeLabel = PAYMENT_TYPE_LABEL;
  protected readonly ranges = Object.entries(TXN_RANGE_LABEL) as [Exclude<TxnRange, 'custom'>, string][];
  protected readonly statuses = TXN_STATUSES;
  protected readonly statusLabel = TXN_STATUS_LABEL;
  protected readonly flagLabel = TXN_FLAG_LABEL;
  protected readonly flags = Object.keys(TXN_FLAG_LABEL) as TxnFlag[];
  protected readonly amount = fmtAmount;
  protected readonly money = fmtMoney;
  protected readonly dateTime = (t: number) => fmtDateTime(t);

  protected readonly methods = computed(() => {
    const d = this.data();
    const type = this.filters().type;
    return (d?.options.methods ?? []).filter((m) => !type || m.type === type);
  });
  protected readonly subMerchants = computed(() => {
    const gmid = this.filters().merchant;
    return (this.data()?.options.subMerchants ?? []).filter((s) => !gmid || s.gmid === gmid);
  });
  protected readonly currencies = computed(() => [...new Set((this.data()?.options.countries ?? []).map((c) => c.currency))]);
  protected readonly hasFilters = computed(() => {
    const f = this.filters();
    return FILTER_KEYS.some((k) => k !== 'range' && k !== 'sort' && k !== 'dir' && !!f[k]) || f.range !== '24h';
  });
  protected readonly moreCount = computed(() => {
    const f = this.filters();
    return [f.currency, f.amountMin || f.amountMax, f.flag].filter(Boolean).length;
  });
  protected readonly pendingSummary = computed(() => {
    const s = this.data()?.summary;
    if (!s) return null;
    return { count: s.byStatus.pending.count + s.byStatus.processing.count, amounts: merge(s.byStatus.pending.amounts, s.byStatus.processing.amounts) };
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.toastTimer));
    if (this.moreCount()) this.moreOpen.set(true);
    // Reload whenever the flow, filters or page change (they all live in the URL).
    // Opening or closing a transaction (?txn=) changes neither, so it doesn't reload the list.
    effect(() => {
      const flow = this.flow();
      const key = this.queryKey();
      untracked(() => void this.load(flow, JSON.parse(key) as TxnQuery));
    });
  }

  private readonly queryKey = computed(() => JSON.stringify(this.query()));

  private query(): TxnQuery {
    const f = this.filters();
    const toIso = (v: string) => (v ? new Date(v).toISOString() : '');
    return {
      ...f,
      from: f.range === 'custom' ? toIso(f.from) : '',
      to: f.range === 'custom' ? toIso(f.to) : '',
      page: this.pageIndex() + 1,
      pageSize: this.pageSize(),
    };
  }

  protected async load(flow = this.flow(), query = this.query()) {
    const f = this.filters();
    if (f.range === 'custom' && (!f.from || !f.to)) return;
    const id = ++this.request;
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.list(flow, query);
      if (id === this.request) this.data.set(res);
    } catch (e) {
      if (id !== this.request) return;
      const err = toClientError(e);
      this.data.set(null);
      this.error.set(err.code === 'NETWORK_ERROR' ? 'You appear to be offline. Check your connection and try again.' : 'message' in err && typeof err.message === 'string' ? err.message : 'Please try again in a moment.');
    } finally {
      if (id === this.request) this.loading.set(false);
    }
  }

  // ------------------------------------------------------------- navigation

  private go(changes: Record<string, string | number | null>, resetPage = true) {
    const params: Record<string, string | number | null> = { ...changes };
    if (resetPage) params['page'] = null;
    for (const [k, v] of Object.entries(params)) if (v === '') params[k] = null;
    void this.router.navigate([], { relativeTo: this.route, queryParams: params, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected setFlow(flow: TxnFlow) {
    if (flow === this.flow()) return;
    this.go({ flow: flow === 'payin' ? null : flow, type: null, method: null, subMerchant: null, provider: null, txn: null });
  }

  protected setType(type: PaymentType | '') {
    this.go({ type, method: null });
  }

  protected set(key: FilterKey, value: string) {
    const extra: Record<string, null> = {};
    if (key === 'country') Object.assign(extra, { method: null, provider: null, subMerchant: null, merchant: null, currency: null, amountMin: null, amountMax: null });
    if (key === 'merchant') extra['subMerchant'] = null;
    if (key === 'range' && value !== 'custom') Object.assign(extra, { from: null, to: null });
    if (key === 'range' && value === 'custom' && !this.filters().from) {
      const to = new Date();
      const from = new Date(to.getTime() - 86_400_000);
      this.go({ range: value, from: localInput(from), to: localInput(to) });
      return;
    }
    this.go({ [key]: value, ...extra });
  }

  protected search() {
    const v = this.searchText().trim().toUpperCase();
    if (v && /[^A-Z0-9-]/.test(v)) {
      this.flash('danger', 'IDs contain only letters, numbers and dashes.');
      return;
    }
    this.go({ q: v });
  }

  protected clearFilters() {
    this.searchText.set('');
    const reset: Record<string, null> = { page: null };
    for (const k of FILTER_KEYS) reset[k] = null;
    this.go(reset);
  }

  protected sortBy(key: 'created' | 'amount') {
    const f = this.filters();
    const current = f.sort || 'created';
    const dir = current === key && (f.dir || 'desc') === 'desc' ? 'asc' : 'desc';
    this.go({ sort: key === 'created' ? null : key, dir: dir === 'desc' ? null : dir });
  }

  protected ariaSort(key: 'created' | 'amount') {
    const f = this.filters();
    if ((f.sort || 'created') !== key) return 'none';
    return (f.dir || 'desc') === 'asc' ? 'ascending' : 'descending';
  }

  protected setPage(i: number) {
    this.go({ page: i + 1 }, false);
  }

  protected setPageSize(n: number) {
    this.go({ pageSize: n === 25 ? null : n });
  }

  protected open(row: TxnListRow) {
    this.go({ txn: row.transactionId }, false);
  }

  protected closeSheet() {
    this.go({ txn: null }, false);
  }

  protected showOtherFlow(flow: TxnFlow) {
    this.go({ flow: flow === 'payin' ? null : flow, type: null, method: null, subMerchant: null, provider: null });
  }

  protected amounts(list: CurrencyAmount[]) {
    return list.map((a) => fmtMoney(a.amount, a.currency));
  }

  // ------------------------------------------------------------- export

  /** Exports every row matching the filters (not just this page). */
  protected async export() {
    if (this.exporting()) return;
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

  protected onChanged(text: string) {
    this.flash('info', text);
    void this.load();
  }

  private flash(tone: 'info' | 'danger', text: string) {
    this.toast.set({ tone, text });
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 5000);
  }
}

function merge(a: CurrencyAmount[], b: CurrencyAmount[]): CurrencyAmount[] {
  const m = new Map<string, number>();
  for (const x of [...a, ...b]) m.set(x.currency, (m.get(x.currency) ?? 0) + x.amount);
  return [...m].map(([currency, amount]) => ({ currency, amount }));
}

const p2 = (n: number) => String(n).padStart(2, '0');
/** Value for a datetime-local input (local time). */
function localInput(d: Date) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
