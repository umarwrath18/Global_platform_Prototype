import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { ClientError, toClientError } from '../../core/api/api-error';
import { MfaStatus, SecurityAuditView, SecurityOverview, SecurityUserRow } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import { SecurityApi } from '../../core/auth/security-api.service';
import { SECURITY_ROLE_LABEL, StaffRoleService } from '../../core/merchants/staff-role.service';
import { DemoAuthenticatorService } from '../../shared/demo-authenticator';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';
import { fmtDateTime, fmtRelative } from '../../shared/merchant-ui';

type Tab = 'users' | 'requests' | 'alerts' | 'audit';
type ActionKind = 'request' | 'reset' | 'waive';

interface Action {
  kind: ActionKind;
  user: SecurityUserRow;
}

const STATUS: Record<MfaStatus, { label: string; tone: string }> = {
  not_enrolled: { label: 'Not set up', tone: 'warning' },
  active: { label: 'Active', tone: 'success' },
  blocked: { label: 'Blocked', tone: 'danger' },
};

const EVENT_LABEL: Record<string, string> = {
  MFA_ROLLOUT_SESSIONS_REVOKED: 'Rollout: all sessions ended',
  MFA_REGISTRATION_STARTED: 'Registration started',
  MFA_REGISTRATION_COMPLETED: 'Registration completed',
  MFA_SETUP_CODE_FAILED: 'New authenticator code failed',
  MFA_VERIFIED: 'Code verified',
  MFA_CODE_FAILED: 'Code failed',
  MFA_CODE_REUSED: 'Code reused (refused)',
  MFA_BLOCKED: 'Security block',
  TECH_ALERT_RAISED: 'Tech alert raised',
  MFA_BLOCK_WAIVED: 'Block waived',
  LOGIN_BLOCKED_MFA: 'Sign-in refused (blocked)',
  AUTHENTICATOR_REPLACEMENT_STARTED: 'Replacement started',
  AUTHENTICATOR_REPLACED: 'Authenticator replaced',
  ADMIN_STEP_UP_VERIFIED: 'Admin identity confirmed',
  MFA_RESET_REQUESTED: 'Reset requested',
  IDENTITY_VERIFIED: 'Identity verified',
  MFA_RESET: 'MFA reset',
  NOTIFICATION_SENT: 'User notified',
};

/** Mobi Support and Security Admin: 2FA status, reset requests, Tech alerts and the audit log (FR-03/05/07/08). */
@Component({
  selector: 'app-user-security',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SideSheet],
  templateUrl: './user-security.html',
  styleUrl: './security.scss',
})
export class UserSecurity {
  private readonly api = inject(SecurityApi);
  private readonly demo = inject(DemoAuthenticatorService);
  protected readonly roles = inject(StaffRoleService);
  protected readonly session = inject(AuthService).session;

  protected readonly tab = signal<Tab>('users');
  protected readonly data = signal<SecurityOverview | null>(null);
  protected readonly auditRows = signal<SecurityAuditView[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<ClientError | null>(null);
  protected readonly query = signal('');
  protected readonly toast = signal<string | null>(null);

  protected readonly action = signal<Action | null>(null);
  protected readonly stepUpToken = signal<string | null>(null);
  private stepUpExpiresAt = 0;
  protected readonly needsStepUp = signal(true);
  protected readonly code = signal('');
  protected readonly reason = signal('');
  protected readonly reference = signal('');
  protected readonly method = signal('');
  protected readonly identityVerified = signal(false);
  protected readonly busy = signal(false);
  protected readonly actionError = signal<ClientError | null>(null);

  protected readonly status = STATUS;
  protected readonly eventLabel = (t: string) => EVENT_LABEL[t] ?? t;
  protected readonly dateTime = fmtDateTime;
  protected readonly rel = fmtRelative;
  protected readonly roleLabel = SECURITY_ROLE_LABEL;

  protected readonly role = this.roles.securityRole;
  protected readonly openAlerts = computed(() => this.data()?.alerts.filter((a) => a.status === 'open').length ?? 0);
  protected readonly openRequests = computed(() => this.data()?.requests.filter((r) => r.status === 'open').length ?? 0);
  protected readonly users = computed(() => {
    const q = this.query().trim().toLowerCase();
    const list = this.data()?.users ?? [];
    return q ? list.filter((u) => [u.name, u.loginId, u.email, u.accountId, u.accountName].join(' ').toLowerCase().includes(q)) : list;
  });

  constructor() {
    this.demo.sessionWanted.set(true);
    inject(DestroyRef).onDestroy(() => this.demo.sessionWanted.set(false));
    // Reload whenever the acting role changes; the server decides what each role may see.
    effect(() => {
      this.role();
      // A different role is a different hat: confirm identity again before acting.
      this.stepUpToken.set(null);
      this.stepUpExpiresAt = 0;
      void this.load();
    });
  }

  protected async load() {
    if (!this.role()) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const [overview, audit] = await Promise.all([this.api.overview(), this.api.audit()]);
      this.data.set(overview);
      this.auditRows.set(audit);
    } catch (e) {
      this.loadError.set(toClientError(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected isSelf(u: SecurityUserRow) {
    return u.userId === this.session()?.user.id;
  }

  protected userById(userId: string) {
    return this.data()?.users.find((u) => u.userId === userId) ?? null;
  }

  // ---------------------------------------------------------------- actions

  protected open(kind: ActionKind, user: SecurityUserRow) {
    this.action.set({ kind, user });
    this.code.set('');
    this.reason.set('');
    this.reference.set('');
    this.method.set('');
    this.identityVerified.set(false);
    this.actionError.set(null);
    this.needsStepUp.set(!this.stepUpToken() || Date.now() > this.stepUpExpiresAt - 15_000);
  }

  protected close() {
    if (!this.busy()) this.action.set(null);
  }

  protected onCode(value: string, el: HTMLInputElement) {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    if (digits !== value) el.value = digits;
    this.code.set(digits);
    this.actionError.set(null);
  }

  protected async confirmIdentity() {
    if (this.code().length !== 6 || this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const res = await this.api.stepUp(this.code());
      this.stepUpToken.set(res.stepUpToken);
      this.stepUpExpiresAt = Date.now() + res.expiresInSec * 1000;
      this.needsStepUp.set(false);
    } catch (e) {
      this.actionError.set(toClientError(e));
    } finally {
      this.code.set('');
      this.busy.set(false);
    }
  }

  protected canSubmit(): boolean {
    const a = this.action();
    if (!a || this.busy()) return false;
    if (!this.reason().trim()) return false;
    if (a.kind === 'request') return !!this.reference().trim();
    if (a.kind === 'reset') return this.identityVerified() && !!this.method().trim();
    return true;
  }

  protected async submit() {
    const a = this.action();
    const token = this.stepUpToken();
    if (!a || !token || !this.canSubmit()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      if (a.kind === 'request') {
        const res = await this.api.createResetRequest(a.user.userId, this.reason().trim(), this.reference().trim(), token);
        this.flash(`Reset request ${res.id} opened for ${a.user.name}. A Security Admin must verify identity and complete it.`);
      } else if (a.kind === 'reset') {
        await this.api.resetAuthenticator(a.user.userId, { requestId: a.user.openRequestId ?? '', identityVerified: true, verificationMethod: this.method().trim(), reason: this.reason().trim(), stepUpToken: token });
        this.flash(`MFA reset for ${a.user.name}. They must register a new authenticator at next sign-in.`);
      } else {
        await this.api.waiveBlock(a.user.userId, this.reason().trim(), token);
        this.flash(`Block waived for ${a.user.name}. They can sign in again.`);
      }
      this.action.set(null);
      await this.load();
    } catch (e) {
      const err = toClientError(e);
      if (err.code === 'STEP_UP_REQUIRED') {
        this.stepUpToken.set(null);
        this.needsStepUp.set(true);
      }
      this.actionError.set(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected actionErrorText(): string | null {
    const e = this.actionError();
    if (!e) return null;
    const left = 'attemptsRemaining' in e ? e.attemptsRemaining : undefined;
    switch (e.code) {
      case 'MFA_CODE_INVALID':
        return `That code is incorrect or has expired.${left ? ` ${left} attempt${left === 1 ? '' : 's'} left before your own sign-in is blocked.` : ''}`;
      case 'MFA_CODE_REUSED':
        return 'That code was already used. Wait for the next code, then enter it.';
      case 'STEP_UP_REQUIRED':
        return 'Your identity confirmation expired. Enter a new code to continue.';
      case 'RESET_REQUEST_EXISTS':
        return 'This user already has an open reset request.';
      case 'RESET_REQUEST_REQUIRED':
        return 'Mobi Support must open a reset request before MFA can be reset.';
      case 'NOT_BLOCKED':
        return 'This user isn’t blocked any more.';
      case 'ROLE_NOT_PERMITTED':
        return 'Your role can’t perform this action, and nobody can act on their own account.';
      case 'VALIDATION_FAILED':
        return 'Complete all required fields.';
      case 'NETWORK_ERROR':
        return 'You appear to be offline. Check your connection and try again.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }

  private flash(text: string) {
    this.toast.set(text);
    setTimeout(() => this.toast.set(null), 5000);
  }
}
