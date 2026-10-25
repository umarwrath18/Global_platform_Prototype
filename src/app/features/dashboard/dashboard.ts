import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClientError, toClientError } from '../../core/api/api-error';
import { CountryStatus, WorkspaceContext } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import { Icon } from '../../shared/icon';

const STATUS_LABEL: Record<CountryStatus, string> = {
  active: 'Active',
  pending: 'Activation pending',
  failed: 'Activation failed',
};

/**
 * Placeholder Global Platform workspace. MVP feature modules are out of scope for this
 * phase; this screen only proves the post-login session, role and country-access rules.
 * The top bar (country switcher, user menu) is provided by the shared PortalShell.
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly auth = inject(AuthService);

  /** Bound from the `:country` route parameter. */
  readonly country = input<string>();

  protected readonly session = this.auth.session;
  protected readonly context = signal<WorkspaceContext | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<ClientError | null>(null);
  protected readonly statusLabel = STATUS_LABEL;

  protected readonly activeCountries = computed(() => this.session()?.countries.filter((c) => c.status === 'active') ?? []);
  protected readonly unavailableCountries = computed(() => this.session()?.countries.filter((c) => c.status !== 'active') ?? []);

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

  protected retry() {
    void this.loadContext(this.country() ?? null);
  }
}
