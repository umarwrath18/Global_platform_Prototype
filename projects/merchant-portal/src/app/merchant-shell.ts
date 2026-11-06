import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '@gp/core/auth/auth.service';
import { Icon, IconName } from '@gp/shared/icon';
import { MobiLogo } from '@gp/shared/mobi-logo';

/** Merchant navigation is exactly these two screens. */
const NAV: { label: string; icon: IconName; link: string }[] = [
  { label: 'Dashboard', icon: 'grid', link: '/dashboard' },
  { label: 'My Transactions', icon: 'swap', link: '/transactions' },
];

/**
 * Signed-in layout for merchant users. Same look as the internal portal (it shares its styles),
 * but no internal modules, team switcher, global filters, search or staff notifications.
 */
@Component({
  selector: 'app-merchant-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MobiLogo, Icon],
  styleUrl: '../../../../src/app/shared/portal-shell.scss',
  host: {
    '[class.mobile-open]': 'mobileOpen()',
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'menuOpen.set(false); mobileOpen.set(false)',
  },
  template: `
    @if (session(); as s) {
      <aside class="sidebar" aria-label="Main navigation">
        <div class="brand">
          <a routerLink="/dashboard" class="home-link" aria-label="Mobi Merchant Portal home" (click)="mobileOpen.set(false)">
            <img class="mini-logo" src="brand/mobi-mark-white.svg" alt="" aria-hidden="true" />
            <app-mobi-logo class="full-logo" [showProduct]="false" style="--logo-size: 34px" />
          </a>
          <button type="button" class="close-mobile" (click)="mobileOpen.set(false)" aria-label="Close navigation"><app-icon name="x" [size]="20" /></button>
        </div>

        <div class="account" [title]="merchantName()">
          <span class="acc-avatar" aria-hidden="true">{{ initials(merchantName()) }}</span>
          <span class="acc-text">
            <span class="acc-name">{{ merchantName() }}</span>
            <span class="acc-id">{{ s.merchant?.id }}</span>
          </span>
        </div>

        <nav class="nav">
          <ul>
            @for (item of nav; track item.link) {
              <li>
                <a [routerLink]="item.link" routerLinkActive="active" [title]="item.label" (click)="mobileOpen.set(false)">
                  <app-icon [name]="item.icon" [size]="18" />
                  <span class="nav-label">{{ item.label }}</span>
                </a>
              </li>
            }
          </ul>
        </nav>

        <div class="user">
          <button type="button" class="user-card" (click)="menuOpen.set(!menuOpen())" [attr.aria-expanded]="menuOpen()" aria-haspopup="menu">
            <span class="avatar" aria-hidden="true">{{ initials(s.user.name) }}</span>
            <span class="user-text">
              <span class="user-name">{{ s.user.name }}</span>
              <span class="user-role">{{ s.role.name }}</span>
            </span>
            <app-icon name="more" [size]="18" class="more" />
          </button>
          @if (menuOpen()) {
            <div class="menu" role="menu">
              <div class="menu-head">
                <strong>{{ s.user.name }}</strong>
                <span>{{ s.user.email }}</span>
              </div>
              <a role="menuitem" routerLink="/account-security" (click)="menuOpen.set(false); mobileOpen.set(false)"><app-icon name="shield" [size]="16" />Account security</a>
              <button type="button" role="menuitem" (click)="logout()"><app-icon name="logout" [size]="16" />Sign out</button>
            </div>
          }
        </div>
      </aside>

      <div class="scrim" (click)="mobileOpen.set(false)" aria-hidden="true"></div>

      <div class="main-col">
        <header class="topbar">
          <button type="button" class="icon-btn hamburger" (click)="mobileOpen.set(true)" aria-label="Open navigation"><app-icon name="menu" [size]="20" /></button>
          <span class="spacer"></span>
        </header>
        <div class="content">
          <router-outlet />
        </div>
      </div>
    }
  `,
})
export class MerchantShell {
  private readonly auth = inject(AuthService);
  private readonly el = inject(ElementRef<HTMLElement>);

  protected readonly session = this.auth.session;
  protected readonly nav = NAV;
  protected readonly menuOpen = signal(false);
  protected readonly mobileOpen = signal(false);
  protected readonly merchantName = computed(() => this.session()?.merchant?.name ?? this.session()?.account.name ?? '');

  protected initials(name: string) {
    return name
      .split(/\s+/)
      .filter((p) => /^[A-Za-z]/.test(p))
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }

  protected onDocumentClick(e: MouseEvent) {
    if (!(this.el.nativeElement as HTMLElement).querySelector('.user')?.contains(e.target as Node)) this.menuOpen.set(false);
  }

  protected logout() {
    this.menuOpen.set(false);
    void this.auth.logout();
  }
}
