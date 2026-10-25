import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ClientError, toClientError } from '../../core/api/api-error';
import { CountryStatus, WorkspaceContext } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import { Icon } from '../../shared/icon';
import { MobiLogo } from '../../shared/mobi-logo';

const STATUS_LABEL: Record<CountryStatus, string> = {
  active: 'Active',
  pending: 'Activation pending',
  failed: 'Activation failed',
};

/**
 * Placeholder Global Platform workspace. MVP feature modules are out of scope for this
 * phase; this screen only proves the post-login session, role and country-access rules.
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobiLogo, Icon, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Bound from the `:country` route parameter. */
  readonly country = input<string>();

  protected readonly session = this.auth.session;
  protected readonly context = signal<WorkspaceContext | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<ClientError | null>(null);
  protected readonly menuOpen = signal(false);
  protected readonly statusLabel = STATUS_LABEL;

  protected readonly activeCountries = computed(() => this.session()?.countries.filter((c) => c.status === 'active') ?? []);
  protected readonly unavailableCountries = computed(() => this.session()?.countries.filter((c) => c.status !== 'active') ?? []);
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
      const code = this.country() ?? null;
      void this.loadContext(code);
    });
  }

  private async loadContext(code: string | null) {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.context.set(await this.auth.workspaceContext(code));
    } catch (e) {
      this.context.set(null);
      this.error.set(toClientError(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected switchCountry(code: string) {
    this.router.navigate(code ? ['/dashboard', code] : ['/dashboard']);
  }

  protected retry() {
    void this.loadContext(this.country() ?? null);
  }

  protected logout() {
    this.menuOpen.set(false);
    void this.auth.logout();
  }
}
