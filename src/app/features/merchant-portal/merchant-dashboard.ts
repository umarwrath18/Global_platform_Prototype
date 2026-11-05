import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DATE_PRESET_LABEL, DatePreset, formatAmount, MerchantPortalOverview, TransactionSummary } from '../../core/merchants/merchant-portal';
import { MerchantPortalApi } from '../../core/merchants/merchant-portal-api.service';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

/** Merchant Dashboard: available balance and a minimal transaction summary. Nothing else. */
@Component({
  selector: 'app-merchant-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  styleUrl: './merchant-portal.scss',
  template: `
    <main class="page">
      <div class="portal-head">
        <div>
          <h1>Dashboard</h1>
          <p class="sub">{{ overview()?.merchant?.name ?? '' }}</p>
        </div>
        @if (overview()?.sampleData || summary()?.sampleData) {
          <span class="sample-tag" title="No live transaction or balance service is connected yet. Figures are generated sample data.">Sample data · not live</span>
        }
      </div>

      <!-- ---------------------------------------- Available balance -->
      <section class="panel-card" aria-labelledby="balance-h">
        <div class="panel-head">
          <div>
            <h2 id="balance-h">Available balance</h2>
            @if (overview(); as o) {
              <p>As of {{ dateTime(o.asOf) }}</p>
            }
          </div>
        </div>
        <div class="panel-body">
          @if (overviewError()) {
            <div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>We couldn’t load your balance. <button type="button" class="link-button" (click)="loadOverview()">Try again</button></div></div>
          } @else if (!overview()) {
            <div class="balances"><span class="skel big"></span></div>
          } @else if (!overview()!.balances.length) {
            <p class="empty-line">No balance yet. Your balance appears once a country is live.</p>
          } @else {
            <div class="balances">
              @for (b of overview()!.balances; track b.currency) {
                <div class="balance">
                  <span class="cur">{{ b.currency }}</span>
                  <span class="amt">{{ amount(b.available, b.currency) }}</span>
                </div>
              }
            </div>
          }
        </div>
      </section>

      <!-- ---------------------------------------- Transaction summary -->
      <section class="panel-card" aria-labelledby="summary-h">
        <div class="panel-head">
          <div><h2 id="summary-h">Transactions</h2><p>{{ presetLabel[range()] }}</p></div>
          <div class="seg" role="radiogroup" aria-label="Date range">
            @for (p of presets; track p) {
              <button type="button" role="radio" [attr.aria-checked]="range() === p" [class.on]="range() === p" (click)="setRange(p)">{{ presetLabel[p] }}</button>
            }
          </div>
        </div>
        <div class="panel-body">
          @if (summaryError()) {
            <div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>We couldn’t load the transaction summary. <button type="button" class="link-button" (click)="loadSummary()">Try again</button></div></div>
          } @else {
            <div class="stats" [class.loading]="summaryLoading()" [attr.aria-busy]="summaryLoading()">
              <div class="stat">
                <span class="label">Total transactions</span>
                <span class="value">{{ summary()?.total ?? '—' }}</span>
              </div>
              <div class="stat ok">
                <span class="label"><i class="dot"></i>Successful</span>
                <span class="value">{{ summary()?.successful ?? '—' }}</span>
              </div>
              <div class="stat bad">
                <span class="label"><i class="dot"></i>Failed</span>
                <span class="value">{{ summary()?.failed ?? '—' }}</span>
              </div>
            </div>
            @if (summary()?.total === 0) {
              <p class="empty-line">No transactions in this period.</p>
            }
            <a class="link-button view-all" routerLink="/merchant/transactions">View my transactions <app-icon name="arrow-right" [size]="14" /></a>
          }
        </div>
      </section>
    </main>
  `,
})
export class MerchantDashboard {
  private readonly api = inject(MerchantPortalApi);

  protected readonly presets: DatePreset[] = ['today', '7d', '30d'];
  protected readonly presetLabel = DATE_PRESET_LABEL;
  protected readonly range = signal<DatePreset>('today');
  protected readonly overview = signal<MerchantPortalOverview | null>(null);
  protected readonly overviewError = signal(false);
  protected readonly summary = signal<TransactionSummary | null>(null);
  protected readonly summaryLoading = signal(false);
  protected readonly summaryError = signal(false);
  protected readonly amount = formatAmount;
  protected readonly dateTime = fmtDateTime;
  private summaryRequest = 0;

  constructor() {
    void this.loadOverview();
    void this.loadSummary();
  }

  protected async loadOverview() {
    this.overviewError.set(false);
    this.overview.set(null);
    try {
      this.overview.set(await this.api.overview());
    } catch {
      this.overviewError.set(true);
    }
  }

  protected setRange(p: DatePreset) {
    if (p === this.range()) return;
    this.range.set(p);
    void this.loadSummary();
  }

  protected async loadSummary() {
    // Only the latest range's answer is shown if the user switches quickly.
    const id = ++this.summaryRequest;
    this.summaryLoading.set(true);
    this.summaryError.set(false);
    try {
      const s = await this.api.summary(this.range());
      if (id === this.summaryRequest) this.summary.set(s);
    } catch {
      if (id === this.summaryRequest) this.summaryError.set(true);
    } finally {
      if (id === this.summaryRequest) this.summaryLoading.set(false);
    }
  }
}
