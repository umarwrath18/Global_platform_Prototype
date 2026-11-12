import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { FLOW_LABEL, MdrHistoryRow, periodText, pricingDetails, PRICING_STATUS_LABEL, PRICING_STATUS_TONE, PricingAuditEvent, secondarySummary, techniqueLabel } from '../../core/merchants/products';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';
import { Pager, pageOf } from '../../shared/pager';
import { CorridorService } from './corridor';
import { MerchantPricingTabs } from './merchant-pricing-tabs';

type HistoryView = 'versions' | 'audit';
type Period = '7' | '30' | '90' | 'all';
const DAY = 86_400_000;

/**
 * Merchant Pricing – History, for the corridor. Two views of the past:
 * - Versions (§7.11): every pricing rule, current and past, with its version number.
 * - Audit log (§7.10): who did what and when (append-only), with filters and CSV export.
 */
@Component({
  selector: 'app-mdr-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, MerchantPricingTabs, Pager],
  template: `
    <main class="page">
      <app-merchant-pricing-tabs />
      <section class="panel-card">
        <div class="hist-top">
          <div class="seg-switch" role="tablist" aria-label="History view">
            <button type="button" role="tab" [attr.aria-selected]="view() === 'versions'" [class.on]="view() === 'versions'" (click)="setView('versions')">Versions</button>
            <button type="button" role="tab" [attr.aria-selected]="view() === 'audit'" [class.on]="view() === 'audit'" (click)="setView('audit')">Audit log</button>
          </div>
          @if (view() === 'audit') {
            <button type="button" class="btn sm" (click)="exportCsv()" [disabled]="!auditRows().length"><app-icon name="download" [size]="14" />Export CSV</button>
          }
        </div>
        <div class="toolbar hist-toolbar">
          <select class="f-input sm fit" aria-label="Merchant" (change)="merchant.set($any($event.target).value); page.set(0)">
            <option value="" [selected]="!merchant()">All merchants</option>
            @for (m of merchants(); track m.id) {<option [value]="m.id" [selected]="m.id === merchant()">{{ m.name }}</option>}
          </select>
          @if (view() === 'audit') {
            <select class="f-input sm fit" aria-label="Period" (change)="range.set($any($event.target).value); page.set(0)">
              <option value="7" [selected]="range() === '7'">Last 7 days</option>
              <option value="30" [selected]="range() === '30'">Last 30 days</option>
              <option value="90" [selected]="range() === '90'">Last 90 days</option>
              <option value="all" [selected]="range() === 'all'">All time</option>
            </select>
            <select class="f-input sm fit" aria-label="Person" (change)="person.set($any($event.target).value); page.set(0)">
              <option value="" [selected]="!person()">Everyone</option>
              @for (u of people(); track u) {<option [value]="u" [selected]="u === person()">{{ u }}</option>}
            </select>
          }
          <input class="f-input grow" type="search" placeholder="Search merchant, sub-merchant, payment method…" [attr.aria-label]="'Search ' + (view() === 'audit' ? 'the audit log' : 'versions')" [value]="q()" (input)="q.set($any($event.target).value); page.set(0)" />
        </div>

        @if (error(); as e) {
          <div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e.message ?? "We couldn't load the history." }}</div></div>
        } @else if (view() === 'versions') {
          @if (versionRows().length) {
            <div class="table-wrap">
              <table class="data-table mp-table">
                <thead><tr><th scope="col">Merchant</th><th scope="col">Applies to</th><th scope="col">Payment method</th><th scope="col">Technique</th><th scope="col">Pricing</th><th scope="col">Secondary charges</th><th scope="col">Effective</th><th scope="col">Status</th><th scope="col">Version</th><th scope="col">Created by</th></tr></thead>
                <tbody>
                  @for (r of versionPage(); track r.version.id) {
                    <tr>
                      <td><a class="row-link" [routerLink]="['/merchant-pricing', r.applicationId]">{{ r.merchantName }}</a></td>
                      <td>{{ r.subMerchantName ?? 'Master Merchant' }}</td>
                      <td>{{ r.methodName }}<div class="sub-line">{{ flowLabel[r.version.flow] }}</div></td>
                      <td>{{ technique(r.version.technique) }}</td>
                      <td class="cfg">{{ details(r.version) }}</td>
                      <td>{{ secondary(r.version) || '—' }}</td>
                      <td>{{ effective(r.version) }}</td>
                      <td><span class="status" [class]="'status ' + tone[r.version.status]">{{ statusLabel[r.version.status] }}</span></td>
                      <td>v{{ r.version.version }}</td>
                      <td>{{ r.version.createdBy }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <app-pager [total]="versionRows().length" [(page)]="page" [(pageSize)]="pageSize" />
          } @else {
            <div class="empty-state"><div class="icon-tile"><app-icon name="list" /></div><h3>No versions match.</h3></div>
          }
        } @else {
          @if (auditRows().length) {
            <div class="table-wrap">
              <table class="data-table audit-table">
                <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Merchant</th><th scope="col">Payment method</th><th scope="col">Change</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  @for (e of auditPage(); track e.id) {
                    <tr>
                      <td>{{ dateTime(e.at) }}</td>
                      <td>{{ e.user }}<div class="sub-line">{{ e.role }}</div></td>
                      <td>{{ e.merchantName }}<div class="sub-line">{{ e.subMerchantName ?? 'Master Merchant' }}</div></td>
                      <td>{{ e.methodName }}<div class="sub-line">{{ flowLabel[e.flow] }} · v{{ e.version }}</div></td>
                      <td class="cfg wrap"><span class="muted">{{ e.previous }}</span><span class="arrow" aria-label="changed to">→</span>{{ e.next }}<div class="sub-line">Effective {{ e.effective }}</div>@if (e.reason) {<div class="sub-line">Reason: {{ e.reason }}</div>}</td>
                      <td><span class="status" [class]="'status ' + tone[e.status]">{{ statusLabel[e.status] }}</span></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <app-pager [total]="auditRows().length" [(page)]="page" [(pageSize)]="pageSize" />
          } @else {
            <div class="empty-state"><div class="icon-tile"><app-icon name="list" /></div><h3>No entries match.</h3><p>Try a longer period or clear the filters.</p></div>
          }
        }
      </section>
      <p class="hist-note">The audit log is append-only: entries are never changed or deleted.</p>
    </main>
  `,
  styleUrl: './pricing.scss',
})
export class MdrHistory {
  private readonly api = inject(MerchantApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly corridor = inject(CorridorService);
  protected readonly versions = signal<MdrHistoryRow[]>([]);
  protected readonly entries = signal<PricingAuditEvent[]>([]);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly view = signal<HistoryView>(this.route.snapshot.queryParamMap.get('view') === 'audit' ? 'audit' : 'versions');
  protected readonly merchant = signal(this.route.snapshot.queryParamMap.get('merchant') ?? '');
  protected readonly person = signal('');
  protected readonly range = signal<Period>('30');
  protected readonly q = signal('');
  protected readonly page = signal(0);
  protected readonly pageSize = signal(25);

  protected readonly flowLabel = FLOW_LABEL;
  protected readonly technique = techniqueLabel;
  protected readonly details = pricingDetails;
  protected readonly secondary = secondarySummary;
  protected readonly effective = periodText;
  protected readonly statusLabel = PRICING_STATUS_LABEL;
  protected readonly tone = PRICING_STATUS_TONE;
  protected readonly dateTime = fmtDateTime;

  private readonly corridorEntries = computed(() => this.entries().filter((e) => e.country === this.corridor.code()));
  protected readonly merchants = computed(() => {
    const src = this.view() === 'audit' ? this.corridorEntries().map((e) => [e.merchantId, e.merchantName] as const) : this.versions().map((r) => [r.merchantId, r.merchantName] as const);
    return [...new Map(src).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });
  protected readonly people = computed(() => [...new Set(this.corridorEntries().map((e) => e.user))].sort());

  protected readonly versionRows = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.versions().filter((r) => (!this.merchant() || r.merchantId === this.merchant()) && (!q || [r.merchantName, r.subMerchantName ?? '', r.methodName, techniqueLabel(r.version.technique)].join(' ').toLowerCase().includes(q)));
  });
  protected readonly versionPage = computed(() => pageOf(this.versionRows(), this.page(), this.pageSize()));

  protected readonly auditRows = computed(() => {
    const q = this.q().trim().toLowerCase();
    const since = this.range() === 'all' ? 0 : Date.now() - Number(this.range()) * DAY;
    return this.corridorEntries().filter(
      (e) => e.at >= since && (!this.merchant() || e.merchantId === this.merchant()) && (!this.person() || e.user === this.person()) && (!q || [e.merchantName, e.subMerchantName ?? '', e.methodName, e.applicationId].join(' ').toLowerCase().includes(q)),
    );
  });
  protected readonly auditPage = computed(() => pageOf(this.auditRows(), this.page(), this.pageSize()));

  constructor() {
    effect(() => void this.load(this.corridor.code()));
  }

  protected setView(v: HistoryView) {
    this.view.set(v);
    this.merchant.set('');
    this.page.set(0);
    void this.router.navigate([], { queryParams: { view: v === 'audit' ? 'audit' : null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  private async load(country: string) {
    this.error.set(null);
    this.page.set(0);
    try {
      const [versions, entries] = await Promise.all([this.api.mdrHistory(country), this.api.pricingAudit()]);
      this.versions.set(versions);
      this.entries.set(entries);
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }

  /** Every matching entry (not only this page), as a CSV file. */
  protected exportCsv() {
    const head = ['When', 'Who', 'Role', 'Merchant', 'Merchant ID', 'Applies to', 'Country', 'Payment method', 'Flow', 'Version', 'Previous', 'New', 'Reason', 'Effective', 'Status'];
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = this.auditRows().map((e) => [new Date(e.at).toISOString(), e.user, e.role, e.merchantName, e.merchantId, e.subMerchantName ?? 'Master Merchant', e.country, e.methodName, FLOW_LABEL[e.flow], `v${e.version}`, e.previous, e.next, e.reason ?? '', e.effective, PRICING_STATUS_LABEL[e.status]].map(cell).join(','));
    const blob = new Blob([[head.map(cell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mobi-pricing-audit-${this.corridor.code().toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
