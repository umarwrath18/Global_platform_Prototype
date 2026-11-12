import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { MerchantApi } from '../../core/merchants/merchant-api.service';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { CorridorSelect, CorridorService } from './corridor';

/**
 * The header shared by the Merchant Pricing screens: title, corridor, the three tabs (Merchants ·
 * Sub-merchants · History) and a link to pricing waiting in the Approvals inbox. One place, so the
 * screens never repeat a control.
 */
@Component({
  selector: 'app-merchant-pricing-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, CorridorSelect, Icon],
  template: `
    <div class="portal-head">
      <div>
        <h1>Merchant Pricing</h1>
        <p class="sub">Pricing rules for merchants and sub-merchants in {{ corridor.name() }}.</p>
      </div>
      <div class="head-tools"><app-corridor-select /></div>
    </div>
    <div class="mp-nav">
      <nav class="mp-tabs" aria-label="Merchant Pricing">
        <a routerLink="/merchant-pricing" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }">Merchants</a>
        <a routerLink="/merchant-pricing/sub-merchants" routerLinkActive="on">Sub-merchants</a>
        <a routerLink="/merchant-pricing/history" routerLinkActive="on">History</a>
      </nav>
      @if (waiting(); as n) {
        <a class="mp-waiting" routerLink="/approvals" [queryParams]="{ type: 'pricing' }">
          <span class="dot" aria-hidden="true"></span>{{ n }} waiting for FinOps<app-icon name="arrow-right" [size]="14" />
        </a>
      }
    </div>
  `,
  styles: `
    .mp-nav { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 16px; margin: 0 0 16px; border-bottom: 1px solid var(--border); }
    .mp-tabs { display: flex; gap: 4px; }
    .mp-tabs a { padding: 10px 12px; margin-bottom: -1px; border-bottom: 2px solid transparent; font-size: 14px; font-weight: 500; color: var(--text-muted); text-decoration: none; white-space: nowrap; }
    .mp-tabs a:hover { color: var(--text); }
    .mp-tabs a.on { border-bottom-color: var(--mobi-blue); color: var(--text); font-weight: 600; }
    .mp-tabs a:focus-visible { outline: none; box-shadow: inset var(--focus-ring); border-radius: 6px; }
    .mp-waiting { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 6px 12px; border-radius: 999px; background: var(--warning-bg); color: #b54708; font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; }
    .mp-waiting:hover { background: #fef0c7; }
    .mp-waiting .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  `,
})
export class MerchantPricingTabs {
  private readonly api = inject(MerchantApi);
  private readonly roles = inject(StaffRoleService);
  protected readonly corridor = inject(CorridorService);
  /** Pricing changes in this corridor waiting for FinOps. */
  protected readonly waiting = signal(0);

  constructor() {
    effect(() => {
      const country = this.corridor.code();
      this.roles.role();
      void this.api.pricingApprovals(country).then(
        (v) => this.waiting.set(v.items.filter((i) => i.version.status === 'pending_approval').length),
        () => this.waiting.set(0),
      );
    });
  }
}
