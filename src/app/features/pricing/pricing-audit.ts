import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { GlobalFilters } from '../../core/merchants/global-filters.service';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { countryName } from '../../core/merchants/onboarding-config';
import { PRICING_STATUS_LABEL, PRICING_STATUS_TONE, PricingAuditEvent } from '../../core/merchants/products';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

/** The append-only MDR audit log (§7.10): every pricing create, approve, reject and cancel. */
@Component({
  selector: 'app-pricing-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <main class="page">
      <div class="portal-head">
        <div>
          <h1>MDR audit log</h1>
          <p class="sub">Every pricing change, approval, rejection and cancellation. Entries are never changed.</p>
        </div>
        <span class="tag">{{ filters.country() ? countryName(filters.country()!) : 'All countries' }}</span>
      </div>
      <section class="panel-card">
        <div class="toolbar">
          <input class="f-input grow" type="search" [placeholder]="'Search ' + (filters.country() ? countryName(filters.country()!) + ' ' : '') + 'merchants or payment methods...'" aria-label="Search the audit log" [value]="q()" (input)="q.set($any($event.target).value)" />
          <span class="muted small">{{ rows().length }} entries</span>
        </div>
        @if (error(); as e) {
          <div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e.message ?? "We couldn't load the audit log." }}</div></div>
        } @else if (rows().length) {
          <div class="table-wrap">
            <table class="data-table audit-table">
              <thead><tr><th scope="col">Timestamp</th><th scope="col">User</th><th scope="col">Role</th><th scope="col">Merchant</th><th scope="col">Corridor</th><th scope="col">Payment Method</th><th scope="col">Previous</th><th scope="col">New</th><th scope="col">Effective</th><th scope="col">Status</th></tr></thead>
              <tbody>
                @for (e of rows(); track e.id) {
                  <tr>
                    <td class="nowrap">{{ dateTime(e.at) }}</td>
                    <td>{{ e.user }}</td>
                    <td>{{ e.role }}</td>
                    <td>{{ e.merchantName }}<div class="sub-line">{{ e.applicationId }}</div></td>
                    <td>{{ e.country }}</td>
                    <td>{{ e.methodName }}<div class="sub-line">v{{ e.version }}</div></td>
                    <td class="cfg">{{ e.previous }}</td>
                    <td class="cfg">{{ e.next }}@if (e.reason) {<div class="sub-line">Reason: {{ e.reason }}</div>}</td>
                    <td class="nowrap">{{ e.effective }}</td>
                    <td><span class="status" [class]="'status ' + tone[e.status]">{{ statusLabel[e.status] }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="empty-state"><div class="icon-tile"><app-icon name="list" /></div><h3>No entries match.</h3></div>
        }
      </section>
    </main>
  `,
  styleUrl: './pricing.scss',
})
export class PricingAudit {
  private readonly api = inject(MerchantApi);
  protected readonly filters = inject(GlobalFilters);
  protected readonly entries = signal<PricingAuditEvent[]>([]);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly q = signal('');
  protected readonly dateTime = fmtDateTime;
  protected readonly countryName = countryName;
  protected readonly statusLabel = PRICING_STATUS_LABEL;
  protected readonly tone = PRICING_STATUS_TONE;

  protected readonly rows = computed(() => {
    const q = this.q().trim().toLowerCase();
    const country = this.filters.country();
    const merchant = this.filters.merchantId();
    return this.entries().filter(
      (e) => (!country || e.country === country) && (!merchant || e.merchantId === merchant) && (!q || [e.merchantName, e.merchantId, e.methodName, e.applicationId].join(' ').toLowerCase().includes(q)),
    );
  });

  constructor() {
    void this.load();
  }

  private async load() {
    try {
      this.entries.set(await this.api.pricingAudit());
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }
}
