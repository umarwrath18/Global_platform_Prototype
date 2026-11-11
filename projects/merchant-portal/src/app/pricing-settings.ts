import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { formatAmount, MerchantSettingsView } from '@gp/core/merchants/merchant-portal';
import { MerchantPortalApi } from '@gp/core/merchants/merchant-portal-api.service';
import { Icon } from '@gp/shared/icon';

/** Pricing & settings (read only): pricing, settlement and integration settings per live country. */
@Component({
  selector: 'app-merchant-pricing-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  styleUrl: './merchant-portal.scss',
  template: `
    <main class="page">
      <div class="portal-head">
        <div>
          <h1>Pricing &amp; settings</h1>
          <p class="sub">What you've agreed with Mobi for each live country. To change anything, contact your Mobi account manager.</p>
        </div>
      </div>

      @if (error()) {
        <div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>We couldn’t load your pricing and settings. <button type="button" class="link-button" (click)="load()">Try again</button></div></div>
      } @else if (view(); as v) {
        @for (c of v.countries; track c.country) {
          <section class="panel-card ps-card" [attr.aria-labelledby]="'ps-' + c.country">
            <div class="panel-head">
              <div>
                <h2 [id]="'ps-' + c.country">{{ c.countryName }}</h2>
                <p>{{ c.mid ? 'MID ' + c.mid : 'MID not issued yet' }} · {{ c.currency }}</p>
              </div>
            </div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th scope="col">Payment method</th><th scope="col">Pricing</th><th scope="col">Effective</th><th scope="col">Settlement</th></tr></thead>
                <tbody>
                  @for (p of c.products; track p.name + p.flow) {
                    <tr>
                      <td>{{ p.name }}<div class="sub-line">{{ p.flow === 'payin' ? 'PayIn' : 'PayOut' }}</div></td>
                      <td>
                        {{ p.pricing ?? 'Not priced yet' }}
                        @if (p.extras) {<div class="sub-line">{{ p.extras }}</div>}
                        @if (p.upcoming) {<div class="sub-line upcoming"><app-icon name="clock" [size]="12" /> Changes to {{ p.upcoming }}</div>}
                      </td>
                      <td class="nowrap">{{ p.effective ?? '—' }}</td>
                      <td>{{ p.flow === 'payin' ? (p.settlement ?? 'Not set') : '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <dl class="kv ps-settings">
              <div><dt>IPN callback URL</dt><dd class="mono">{{ c.ipnCallbackUrl || 'Not set' }}</dd></div>
              <div><dt>Daily transaction limit</dt><dd>{{ c.dailyLimit !== null ? c.currency + ' ' + amount(c.dailyLimit, c.currency) : '—' }}</dd></div>
              <div><dt>Minimum transaction value</dt><dd>{{ c.minTransactionValue !== null ? c.currency + ' ' + amount(c.minTransactionValue, c.currency) : '—' }}</dd></div>
              <div><dt>Payment receipts to customers</dt><dd>{{ c.sendReceipts ? 'On' : 'Off' }}</dd></div>
            </dl>
          </section>
        } @empty {
          <section class="panel-card"><div class="empty-state"><div class="icon-tile"><app-icon name="card" /></div><h3>No live countries yet</h3><p>Pricing and settings appear here once a country goes live.</p></div></section>
        }
      } @else {
        <section class="panel-card"><div class="skeleton-rows" aria-busy="true" aria-label="Loading"><span></span><span></span></div></section>
      }
    </main>
  `,
})
export class MerchantPricingSettings {
  private readonly api = inject(MerchantPortalApi);
  protected readonly view = signal<MerchantSettingsView | null>(null);
  protected readonly error = signal(false);
  protected readonly amount = formatAmount;

  constructor() {
    void this.load();
  }

  protected async load() {
    this.error.set(false);
    try {
      this.view.set(await this.api.settings());
    } catch {
      this.error.set(true);
    }
  }
}
