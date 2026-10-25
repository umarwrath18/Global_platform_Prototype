import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from '../core/auth/auth.service';
import { MerchantApi } from '../core/merchants/merchant-api.service';
import { PortalNotification, STAFF_ROLE_LABEL, StaffRole } from '../core/merchants/merchant-models';
import { StaffRoleService } from '../core/merchants/staff-role.service';
import { Icon } from './icon';
import { fmtRelative } from './merchant-ui';
import { MobiLogo } from './mobi-logo';

const NOTIFICATION_POLL_MS = 30_000;

/** Signed-in layout: top bar with navigation, notifications, the prototype role switcher and the user menu. */
@Component({
  selector: 'app-portal-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MobiLogo, Icon],
  templateUrl: './portal-shell.html',
  styleUrl: './portal-shell.scss',
  host: { '(document:click)': 'onDocumentClick($event)', '(document:keydown.escape)': 'closeMenus()' },
})
export class PortalShell {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly el = inject(ElementRef<HTMLElement>);
  protected readonly api = inject(MerchantApi);
  protected readonly roles = inject(StaffRoleService);

  protected readonly session = this.auth.session;
  protected readonly menuOpen = signal(false);
  protected readonly bellOpen = signal(false);
  protected readonly roleOptions = Object.entries(STAFF_ROLE_LABEL) as [StaffRole, string][];
  protected readonly roleLabel = STAFF_ROLE_LABEL;
  protected readonly rel = fmtRelative;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** The country switcher belongs to the Batch 1 dashboard workspace only. */
  protected readonly onDashboard = computed(() => this.url().startsWith('/dashboard'));
  protected readonly dashboardCountry = computed(() => /^\/dashboard\/([^/?#]+)/.exec(this.url())?.[1]?.toUpperCase() ?? '');
  protected readonly activeCountries = computed(() => this.session()?.countries.filter((c) => c.status === 'active') ?? []);
  protected readonly latest = computed(() => this.api.myNotifications().slice(0, 6));
  protected readonly initials = computed(() =>
    (this.session()?.user.name ?? '')
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );

  constructor() {
    effect(() => {
      this.roles.role();
      void this.api.refreshNotifications();
    });
    const timer = setInterval(() => void this.api.refreshNotifications(), NOTIFICATION_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected isUnread(n: PortalNotification) {
    return !n.readBy.includes(this.roles.role());
  }

  protected switchCountry(code: string) {
    this.router.navigate(code ? ['/dashboard', code] : ['/dashboard']);
  }

  protected switchRole(role: StaffRole) {
    this.roles.set(role);
  }

  protected toggleBell() {
    this.bellOpen.set(!this.bellOpen());
    this.menuOpen.set(false);
  }

  protected toggleMenu() {
    this.menuOpen.set(!this.menuOpen());
    this.bellOpen.set(false);
  }

  protected openNotification(n: PortalNotification) {
    this.bellOpen.set(false);
    if (this.isUnread(n)) void this.api.markRead([n.id]);
    this.router.navigate(['/applications', n.applicationId]);
  }

  protected markAllRead() {
    void this.api.markRead();
  }

  protected closeMenus() {
    this.menuOpen.set(false);
    this.bellOpen.set(false);
  }

  protected onDocumentClick(e: MouseEvent) {
    const host = this.el.nativeElement as HTMLElement;
    const target = e.target as Node;
    if (!host.querySelector('.bell-wrap')?.contains(target)) this.bellOpen.set(false);
    if (!host.querySelector('.user')?.contains(target)) this.menuOpen.set(false);
  }

  protected logout() {
    this.menuOpen.set(false);
    void this.auth.logout();
  }
}
