import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { fmtDay, PRICING_STATUS_LABEL, PRICING_STATUS_TONE, SubMerchantPricingRow } from '../../core/merchants/products';
import { Icon } from '../../shared/icon';
import { CorridorSelect, CorridorService } from './corridor';
import { MerchantPricingTabs } from './merchant-pricing-tabs';

/** Merchant Pricing – Sub-Merchant View (§7.3): resolved pricing per sub-merchant and payment method (§7.9). */
@Component({
  selector: 'app-sub-merchant-pricing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, CorridorSelect, MerchantPricingTabs],
  template: `
    <main class="page">
      <div class="portal-head">
        <div>
          <h1>Sub-Merchant View</h1>
          <p class="sub">Pricing that applies to each sub-merchant in {{ corridor.name() }}: its own rule, or the merchant-level rule.</p>
        </div>
        <div class="head-tools"><app-corridor-select /></div>
      </div>
      <app-merchant-pricing-tabs />
      <section class="panel-card">
        <div class="toolbar">
          <select class="f-input sm" aria-label="Merchant" (change)="merchant.set($any($event.target).value)">
            <option value="" [selected]="!merchant()">All Merchants</option>
            @for (m of merchants(); track m.id) {<option [value]="m.id" [selected]="m.id === merchant()">{{ m.name }} ({{ m.count }})</option>}
          </select>
          <input class="f-input grow" type="search" placeholder="Search merchant, MID, sub-merchant, payment method..." aria-label="Search sub-merchants" [value]="q()" (input)="q.set($any($event.target).value)" />
        </div>
        @if (error(); as e) {
          <div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e.message ?? "We couldn't load sub-merchant pricing." }}</div></div>
        } @else if (filtered().length) {
          <div class="table-wrap">
            <table class="data-table mp-table">
              <thead><tr><th scope="col">Merchant Name</th><th scope="col">Merchant MID</th><th scope="col">Sub-Merchant Name</th><th scope="col">Sub-Merchant ID</th><th scope="col">Payment Method</th><th scope="col">Current Pricing Method</th><th scope="col">Applicable Pricing / MDR</th><th scope="col">Currency</th><th scope="col">Effective Start Date</th><th scope="col">Effective End Date</th><th scope="col">Pricing Status</th></tr></thead>
              <tbody>
                @for (r of filtered(); track r.subMerchantId + (r.methodCode ?? '')) {
                  <tr>
                    <td><a class="row-link" [routerLink]="['/merchant-pricing', r.applicationId]">{{ r.merchantName }}</a></td>
                    <td class="mono">{{ r.mid ?? '—' }}</td>
                    <td>{{ r.subMerchantName }}</td>
                    <td class="mono">{{ r.subMerchantId }}</td>
                    <td>{{ r.methodName ?? '—' }}</td>
                    <td>{{ r.technique ?? 'No pricing' }}@if (r.level) {<div class="sub-line">{{ r.level === 'sub_merchant' ? 'Sub-merchant rule' : 'Merchant-level rule' }}</div>}</td>
                    <td class="cfg">{{ r.pricing ?? 'No pricing' }}</td>
                    <td>{{ r.currency ?? '—' }}</td>
                    <td class="nowrap">{{ r.startDate ? day(r.startDate) : '—' }}</td>
                    <td class="nowrap">{{ r.startDate ? (r.endDate ? day(r.endDate) : 'Ongoing') : '—' }}</td>
                    <td>@if (r.status; as s) {<span class="status" [class]="'status ' + tone[s]">{{ statusLabel[s] }}</span>} @else {<span class="status warning">No pricing</span>}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="empty-state"><div class="icon-tile"><app-icon name="users" /></div><h3>{{ rows().length ? 'No sub-merchants match.' : 'No sub-merchants in ' + corridor.name() + ' yet.' }}</h3></div>
        }
        <p class="mp-foot">Showing {{ subCount() }} sub-merchant records ({{ withPricing() }} with pricing, {{ subCount() - withPricing() }} without)</p>
      </section>
    </main>
  `,
  styleUrl: './pricing.scss',
})
export class SubMerchantPricing {
  private readonly api = inject(MerchantApi);
  protected readonly corridor = inject(CorridorService);
  protected readonly rows = signal<SubMerchantPricingRow[]>([]);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly merchant = signal('');
  protected readonly q = signal('');
  protected readonly day = fmtDay;
  protected readonly statusLabel = PRICING_STATUS_LABEL;
  protected readonly tone = PRICING_STATUS_TONE;

  protected readonly merchants = computed(() => {
    const map = new Map<string, { id: string; name: string; subs: Set<string> }>();
    for (const r of this.rows()) {
      const m = map.get(r.merchantId) ?? { id: r.merchantId, name: r.merchantName, subs: new Set<string>() };
      m.subs.add(r.subMerchantId);
      map.set(r.merchantId, m);
    }
    return [...map.values()].map((m) => ({ id: m.id, name: m.name, count: m.subs.size }));
  });
  protected readonly filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.rows().filter(
      (r) => (!this.merchant() || r.merchantId === this.merchant()) && (!q || [r.merchantName, r.mid ?? '', r.subMerchantName, r.subMerchantId, r.methodName ?? '', r.technique ?? '', r.currency ?? '', r.pricing ? '' : 'no pricing'].join(' ').toLowerCase().includes(q)),
    );
  });
  protected readonly subCount = computed(() => new Set(this.filtered().map((r) => r.subMerchantId)).size);
  protected readonly withPricing = computed(() => new Set(this.filtered().filter((r) => r.pricing).map((r) => r.subMerchantId)).size);

  constructor() {
    effect(() => void this.load(this.corridor.code()));
  }

  private async load(country: string) {
    this.error.set(null);
    try {
      this.rows.set(await this.api.subMerchantPricing(country));
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }
}
