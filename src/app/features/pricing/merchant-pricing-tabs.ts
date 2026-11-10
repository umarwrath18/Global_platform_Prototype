import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

/** Sub-navigation for the Merchant Pricing screens. */
@Component({
  selector: 'app-merchant-pricing-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav class="mp-tabs" aria-label="Merchant Pricing">
      <a routerLink="/merchant-pricing" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }">Merchants</a>
      <a routerLink="/merchant-pricing/sub-merchants" routerLinkActive="on">Sub-Merchant View</a>
      <a routerLink="/merchant-pricing/history" routerLinkActive="on">MDR History</a>
      <a routerLink="/pricing-approvals" routerLinkActive="on">Approvals</a>
      <a routerLink="/pricing-audit" routerLinkActive="on">MDR audit log</a>
    </nav>
  `,
  styles: `
    .mp-tabs { display: flex; flex-wrap: wrap; gap: 2px; margin: 0 0 16px; border-bottom: 1px solid var(--border); }
    .mp-tabs a { padding: 10px 12px; border-bottom: 2px solid transparent; font-size: 13px; font-weight: 500; color: var(--text-muted); text-decoration: none; }
    .mp-tabs a:hover { color: var(--text); }
    .mp-tabs a.on { border-bottom-color: var(--mobi-blue); color: var(--text); font-weight: 600; }
    .mp-tabs a:focus-visible { outline: none; box-shadow: inset var(--focus-ring); border-radius: 6px; }
  `,
})
export class MerchantPricingTabs {}
