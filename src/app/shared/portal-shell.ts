import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from '../core/auth/auth.service';
import { DATE_RANGE_LABEL, DateRange, GlobalFilters } from '../core/merchants/global-filters.service';
import { MerchantApi } from '../core/merchants/merchant-api.service';
import { MerchantSummary, PortalNotification, STAFF_ROLE_LABEL, StaffRole } from '../core/merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../core/merchants/onboarding-config';
import { StaffRoleService } from '../core/merchants/staff-role.service';
import { Icon, IconName } from './icon';
import { fmtRelative } from './merchant-ui';
import { MobiLogo } from './mobi-logo';

const NOTIFICATION_POLL_MS = 30_000;
const COLLAPSE_KEY = 'mobi.gp.sidebarCollapsed';

interface NavItem {
  label: string;
  icon: IconName;
  link?: string;
}

/** Modules built so far. */
const NAV: NavItem[] = [
  { label: 'Dashboard', icon: 'grid', link: '/dashboard' },
  { label: 'Merchants', icon: 'store', link: '/merchants' },
  { label: 'Applications', icon: 'file', link: '/applications' },
  { label: 'Notifications', icon: 'bell', link: '/notifications' },
];

/** Approved MVP modules not built yet: shown disabled so the roadmap is visible, never clickable. */
const LATER: NavItem[] = [
  { label: 'Pay-ins', icon: 'arrow-down' },
  { label: 'Payouts', icon: 'arrow-up' },
  { label: 'Settlements', icon: 'settle' },
  { label: 'Transactions', icon: 'swap' },
  { label: 'Payment Methods', icon: 'card' },
  { label: 'Hosts & Routing', icon: 'route' },
  { label: 'Reports', icon: 'bar-chart' },
  { label: 'Settings', icon: 'settings' },
];

interface SearchHit {
  kind: 'merchant' | 'application';
  id: string;
  title: string;
  meta: string;
  link: string[];
}

/** Signed-in layout: sidebar navigation, global filter bar, search, notifications and the user menu. */
@Component({
  selector: 'app-portal-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MobiLogo, Icon],
  templateUrl: './portal-shell.html',
  styleUrl: './portal-shell.scss',
  host: {
    '[class.collapsed]': 'collapsed()',
    '[class.mobile-open]': 'mobileOpen()',
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class PortalShell {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly el = inject(ElementRef<HTMLElement>);
  protected readonly api = inject(MerchantApi);
  protected readonly roles = inject(StaffRoleService);
  protected readonly filters = inject(GlobalFilters);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  protected readonly session = this.auth.session;
  protected readonly nav = NAV;
  protected readonly later = LATER;
  protected readonly menuOpen = signal(false);
  protected readonly bellOpen = signal(false);
  protected readonly helpOpen = signal(false);
  protected readonly mobileOpen = signal(false);
  protected readonly collapsed = signal(this.readCollapsed());
  protected readonly query = signal('');
  protected readonly searchOpen = signal(false);
  protected readonly merchants = signal<MerchantSummary[]>([]);

  protected readonly roleOptions = Object.entries(STAFF_ROLE_LABEL) as [StaffRole, string][];
  protected readonly roleLabel = STAFF_ROLE_LABEL;
  protected readonly shortRole: Record<StaffRole, string> = { sales: 'Sales / Ops', risk: 'Risk', cs: 'Customer Success' };
  protected readonly countries = Object.values(ONBOARDING_COUNTRIES);
  protected readonly currencies = [...new Set(Object.values(ONBOARDING_COUNTRIES).map((c) => c.currency))];
  protected readonly ranges = Object.entries(DATE_RANGE_LABEL) as [DateRange, string][];
  protected readonly rangeLabel = DATE_RANGE_LABEL;
  protected readonly rel = fmtRelative;
  protected readonly isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** Filters apply to merchant onboarding data, so they're shown on pages that list it. */
  protected readonly filtersApply = computed(() => /^\/(dashboard(\/[a-z]{2})?|merchants|applications|notifications)$/i.test(this.url().split(/[?#]/)[0]));
  protected readonly latest = computed(() => this.api.myNotifications().slice(0, 6));
  protected readonly selectedMerchantName = computed(() => this.merchants().find((m) => m.id === this.filters.merchantId())?.legalName ?? 'All merchants');
  protected readonly initials = computed(() => this.initialsOf(this.session()?.user.name ?? ''));
  protected readonly accountInitials = computed(() => this.initialsOf(this.session()?.account.name ?? ''));

  protected readonly hits = computed<SearchHit[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (q.length < 2) return [];
    const out: SearchHit[] = [];
    for (const m of this.merchants()) {
      if ([m.id, m.legalName, m.registrationNumber, m.primaryContact.email].join(' ').toLowerCase().includes(q)) {
        out.push({ kind: 'merchant', id: m.id, title: m.legalName, meta: m.id, link: ['/merchants', m.id] });
      }
      for (const a of m.applications) {
        if (a.id.toLowerCase().includes(q)) {
          out.push({ kind: 'application', id: a.id, title: a.id, meta: `${m.legalName} · ${ONBOARDING_COUNTRIES[a.country]?.name ?? a.country}`, link: ['/applications', a.id] });
        }
      }
    }
    return out.slice(0, 8);
  });

  constructor() {
    effect(() => {
      this.roles.role();
      void this.api.refreshNotifications();
    });
    // Keep filter and search options fresh as data changes on other pages.
    effect(() => {
      this.url();
      void this.loadMerchants();
    });
    const timer = setInterval(() => void this.api.refreshNotifications(), NOTIFICATION_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private async loadMerchants() {
    try {
      this.merchants.set(await this.api.listMerchants());
    } catch {
      // Search and the merchant filter keep the last known list.
    }
  }

  private initialsOf(name: string) {
    return name
      .split(/\s+/)
      .filter((p) => /^[A-Za-z]/.test(p))
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }

  private readCollapsed() {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  }

  protected toggleCollapsed() {
    this.collapsed.update((v) => !v);
    try {
      localStorage.setItem(COLLAPSE_KEY, this.collapsed() ? '1' : '0');
    } catch {
      // Preference applies for this page load only.
    }
  }

  protected isUnread(n: PortalNotification) {
    return !n.readBy.includes(this.roles.role());
  }

  protected setFilter(key: 'country' | 'merchantId' | 'currency' | 'range', value: string) {
    this.filters.set(key, value as never);
  }

  protected switchRole(role: StaffRole) {
    this.roles.set(role);
  }

  protected toggle(which: 'bell' | 'menu' | 'help') {
    const next = { bell: !this.bellOpen() && which === 'bell', menu: !this.menuOpen() && which === 'menu', help: !this.helpOpen() && which === 'help' };
    this.bellOpen.set(next.bell);
    this.menuOpen.set(next.menu);
    this.helpOpen.set(next.help);
  }

  protected openNotification(n: PortalNotification) {
    this.bellOpen.set(false);
    if (this.isUnread(n)) void this.api.markRead([n.id]);
    this.router.navigate(['/applications', n.applicationId]);
  }

  protected openHit(hit: SearchHit) {
    this.searchOpen.set(false);
    this.query.set('');
    this.router.navigate(hit.link);
  }

  protected onSearchEnter() {
    const first = this.hits()[0];
    if (first) this.openHit(first);
  }

  protected closeMenus() {
    this.menuOpen.set(false);
    this.bellOpen.set(false);
    this.helpOpen.set(false);
    this.searchOpen.set(false);
    this.mobileOpen.set(false);
  }

  protected onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.searchInput()?.nativeElement.focus();
      this.searchOpen.set(true);
    } else if (e.key === 'Escape') {
      this.closeMenus();
    }
  }

  protected onDocumentClick(e: MouseEvent) {
    const host = this.el.nativeElement as HTMLElement;
    const target = e.target as Node;
    const outside = (sel: string) => !host.querySelector(sel)?.contains(target);
    if (outside('.bell-wrap')) this.bellOpen.set(false);
    if (outside('.user')) this.menuOpen.set(false);
    if (outside('.help-wrap')) this.helpOpen.set(false);
    if (outside('.search')) this.searchOpen.set(false);
  }

  protected navigated() {
    this.mobileOpen.set(false);
  }

  protected logout() {
    this.menuOpen.set(false);
    void this.auth.logout();
  }
}
