import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { FLOW_LABEL, MdrHistoryRow, periodText, pricingDetails, PRICING_STATUS_LABEL, PRICING_STATUS_TONE, secondarySummary, techniqueLabel } from '../../core/merchants/products';
import { Icon } from '../../shared/icon';
import { CorridorSelect, CorridorService } from './corridor';
import { MerchantPricingTabs } from './merchant-pricing-tabs';

/** Merchant Pricing – MDR History (§7.11): every rule in the corridor, grouped by merchant. */
@Component({
  selector: 'app-mdr-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, CorridorSelect, MerchantPricingTabs],
  template: `
    <main class="page">
      <div class="portal-head">
        <div>
          <h1>MDR History</h1>
          <p class="sub">Every pricing rule in {{ corridor.name() }}, current and past.</p>
        </div>
        <div class="head-tools"><app-corridor-select /></div>
      </div>
      <app-merchant-pricing-tabs />
      <section class="panel-card">
        <div class="toolbar">
          <select class="f-input sm" aria-label="Merchant" (change)="merchant.set($any($event.target).value)">
            <option value="" [selected]="!merchant()">All Merchants</option>
            @for (m of merchants(); track m.id) {<option [value]="m.id" [selected]="m.id === merchant()">{{ m.name }}</option>}
          </select>
          <input class="f-input grow" type="search" placeholder="Search merchant, sub-merchant, payment method..." aria-label="Search MDR history" [value]="q()" (input)="q.set($any($event.target).value)" />
          <span class="muted small">{{ filtered().length }} rules</span>
        </div>
        @if (error(); as e) {
          <div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e.message ?? "We couldn't load the MDR history." }}</div></div>
        } @else if (filtered().length) {
          <div class="table-wrap">
            <table class="data-table mp-table">
              <thead><tr><th scope="col">Merchant</th><th scope="col">Sub-Merchant</th><th scope="col">Payment Method</th><th scope="col">Flow</th><th scope="col">Technique</th><th scope="col">Pricing Details</th><th scope="col">Secondary Charges</th><th scope="col">Effective Period</th><th scope="col">Status</th><th scope="col">Ver</th><th scope="col">Created By</th></tr></thead>
              <tbody>
                @for (r of filtered(); track r.version.id; let i = $index) {
                  <tr [class.group-start]="i > 0 && filtered()[i - 1].merchantId !== r.merchantId">
                    <td><a class="row-link" [routerLink]="['/merchant-pricing', r.applicationId]">{{ r.merchantName }}</a></td>
                    <td>{{ r.subMerchantName ?? 'Master Merchant' }}</td>
                    <td>{{ r.methodName }}</td>
                    <td>{{ flowLabel[r.version.flow] }}</td>
                    <td>{{ technique(r.version.technique) }}</td>
                    <td class="cfg">{{ details(r.version) }}</td>
                    <td>{{ secondary(r.version) || '—' }}</td>
                    <td class="nowrap">{{ period(r.version) }}</td>
                    <td><span class="status" [class]="'status ' + tone[r.version.status]">{{ statusLabel[r.version.status] }}</span></td>
                    <td>v{{ r.version.version }}</td>
                    <td>{{ r.version.createdBy }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="empty-state"><div class="icon-tile"><app-icon name="list" /></div><h3>No rules match.</h3></div>
        }
      </section>
    </main>
  `,
  styleUrl: './pricing.scss',
})
export class MdrHistory {
  private readonly api = inject(MerchantApi);
  protected readonly corridor = inject(CorridorService);
  protected readonly rows = signal<MdrHistoryRow[]>([]);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly merchant = signal('');
  protected readonly q = signal('');
  protected readonly flowLabel = FLOW_LABEL;
  protected readonly technique = techniqueLabel;
  protected readonly details = pricingDetails;
  protected readonly secondary = secondarySummary;
  protected readonly period = periodText;
  protected readonly statusLabel = PRICING_STATUS_LABEL;
  protected readonly tone = PRICING_STATUS_TONE;

  protected readonly merchants = computed(() => [...new Map(this.rows().map((r) => [r.merchantId, { id: r.merchantId, name: r.merchantName }])).values()]);
  protected readonly filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.rows().filter((r) => (!this.merchant() || r.merchantId === this.merchant()) && (!q || [r.merchantName, r.subMerchantName ?? '', r.methodName, techniqueLabel(r.version.technique)].join(' ').toLowerCase().includes(q)));
  });

  constructor() {
    effect(() => void this.load(this.corridor.code()));
  }

  private async load(country: string) {
    this.error.set(null);
    try {
      this.rows.set(await this.api.mdrHistory(country));
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }
}
