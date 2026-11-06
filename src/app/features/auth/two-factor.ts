import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ClientError, formatClock, toClientError } from '../../core/api/api-error';
import { AuthenticatorEnrolment } from '../../core/api/models';
import { APP_PORTAL } from '../../core/app-portal';
import { safeReturnUrl } from '../../core/auth/auth.guards';
import { AuthService } from '../../core/auth/auth.service';
import { AuthenticatorQr } from '../../shared/authenticator-qr';
import { Icon } from '../../shared/icon';
import { RecoveryCodes } from '../../shared/recovery-codes';
import { AuthShell } from './auth-shell';

/** What is on screen. The server's challenge stage decides which of these are reachable. */
type View =
  | 'intro' // setup/rebind: why 2FA is required
  | 'scan' // setup/rebind: QR code and setup key
  | 'confirm' // setup/rebind: enter a code from the new authenticator
  | 'codes' // acknowledge: recovery codes
  | 'enabled' // setup done, signed in
  | 'code' // verify: enter authenticator code
  | 'recovery' // verify: enter a recovery code
  | 'lost' // verify: lost device help
  | 'signed-in' // verify done
  | 'blocked'
  | 'expired';

interface Notice {
  tone: 'danger' | 'warning' | 'info';
  title?: string;
  text: string;
}

@Component({
  selector: 'app-two-factor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthShell, Icon, AuthenticatorQr, RecoveryCodes],
  templateUrl: './two-factor.html',
  styleUrl: './two-factor.scss',
})
export class TwoFactor {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly app = inject(APP_PORTAL);
  protected readonly pending = this.auth.pending;
  protected readonly view = signal<View>(this.initialView());
  protected readonly busy = signal(false);
  protected readonly error = signal<ClientError | null>(null);
  protected readonly code = signal('');
  protected readonly recoveryCode = signal('');
  protected readonly enrolment = signal<AuthenticatorEnrolment | null>(null);
  protected readonly acknowledged = signal(false);
  protected readonly now = signal(Date.now());
  protected readonly landing = signal('/dashboard');

  protected readonly firstName = computed(() => this.pending()?.user.name.split(' ')[0] ?? '');
  protected readonly rebinding = computed(() => this.pending()?.stage === 'rebind' || !!this.pending()?.usedRecoveryCode);
  protected readonly recoveryCodes = computed(() => this.pending()?.recoveryCodes ?? null);
  protected readonly expiresIn = computed(() => Math.max(0, ((this.pending()?.expiresAt ?? 0) - this.now()) / 1000));
  protected readonly codeComplete = computed(() => /^\d{6}$/.test(this.code()));
  protected readonly recoveryComplete = computed(() => this.recoveryCode().replace(/[\s-]/g, '').length === 12);
  protected readonly formatClock = formatClock;

  protected readonly notice = computed<Notice | null>(() => {
    const e = this.error();
    if (!e) return null;
    const left = 'attemptsRemaining' in e ? e.attemptsRemaining : undefined;
    const tail = left ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : '';
    switch (e.code) {
      case 'MFA_CODE_INVALID':
        return this.view() === 'recovery'
          ? { tone: 'danger', text: `That recovery code isn’t valid.${tail}` }
          : { tone: 'danger', text: `That code is incorrect or has expired. Enter the current code from your app.${tail}` };
      case 'MFA_CODE_REUSED':
        return { tone: 'warning', text: 'That code was already used. Wait for your app to show a new code, then enter it.' };
      case 'RECOVERY_CODE_USED':
        return { tone: 'danger', text: `That recovery code has already been used. Each code works once.${tail}` };
      case 'RECOVERY_CODES_EXHAUSTED':
        return { tone: 'danger', title: 'No recovery codes left', text: 'All your recovery codes have been used. Contact Mobi Support to verify your identity and reset two-factor authentication.' };
      case 'MFA_SETUP_ATTEMPTS_EXCEEDED':
        return { tone: 'danger', title: 'Too many incorrect codes', text: 'For your security, please sign in again to restart setup.' };
      case 'VALIDATION_FAILED':
        return { tone: 'danger', text: this.view() === 'recovery' ? 'Enter the 12-character recovery code, e.g. K7QM-2XRP-H9WD.' : 'Enter the 6-digit code.' };
      case 'NETWORK_ERROR':
        return { tone: 'warning', title: 'No connection', text: 'You appear to be offline. Check your internet connection and try again.' };
      case 'SERVICE_UNAVAILABLE':
        return { tone: 'warning', title: 'Service unavailable', text: 'We couldn’t reach the sign-in service. Please try again in a moment.' };
      case 'ACCOUNT_SUSPENDED':
      case 'ACCOUNT_INACTIVE':
      case 'USER_DISABLED':
        return { tone: 'danger', title: 'Access unavailable', text: 'This account can’t sign in right now. Please contact Mobi Support.' };
      default:
        return { tone: 'danger', text: 'Something went wrong. Please try again.' };
    }
  });

  constructor() {
    const timer = setInterval(() => {
      this.now.set(Date.now());
      const v = this.view();
      if (this.pending() && this.expiresIn() <= 0 && v !== 'enabled' && v !== 'signed-in' && v !== 'blocked') this.view.set('expired');
    }, 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private initialView(): View {
    const p = this.auth.pending();
    if (!p) return 'expired';
    if (p.stage === 'verify') return 'code';
    if (p.stage === 'acknowledge') return 'codes';
    return 'intro';
  }

  // ------------------------------------------------------------ navigation

  protected go(view: View) {
    this.error.set(null);
    this.code.set('');
    this.recoveryCode.set('');
    this.view.set(view);
    setTimeout(() => (view === 'code' || view === 'confirm' || view === 'recovery' ? this.codeInput() : this.heading())?.nativeElement.focus());
  }

  protected async startScan() {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.enrolment.set(await this.auth.startSetup());
      this.go('scan');
    } catch (e) {
      this.handle(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected onCodeInput(value: string, el: HTMLInputElement) {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    if (digits !== value) el.value = digits;
    this.code.set(digits);
    if (this.error()) this.error.set(null);
  }

  protected onRecoveryInput(value: string) {
    this.recoveryCode.set(value);
    if (this.error()) this.error.set(null);
  }

  protected async confirmSetup() {
    if (!this.codeComplete() || this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.confirmSetup(this.code());
      this.acknowledged.set(false);
      this.go('codes');
    } catch (e) {
      this.handle(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async finishSetup() {
    if (!this.acknowledged() || this.busy()) return;
    this.busy.set(true);
    try {
      const session = await this.auth.completeSetup();
      this.landing.set(this.target(session.landingPath));
      this.go('enabled');
    } catch (e) {
      this.handle(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async verify() {
    if (!this.codeComplete() || this.busy()) return;
    this.busy.set(true);
    try {
      const session = await this.auth.verifyCode(this.code());
      this.landing.set(this.target(session.landingPath));
      this.go('signed-in');
      setTimeout(() => this.continue(), 1200);
    } catch (e) {
      this.handle(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async useRecovery() {
    if (!this.recoveryComplete() || this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.useRecoveryCode(this.recoveryCode());
      this.enrolment.set(null);
      this.go('intro');
    } catch (e) {
      this.handle(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected continue() {
    if (this.router.url.startsWith('/two-factor')) void this.router.navigateByUrl(this.landing());
  }

  protected backToLogin() {
    this.auth.cancelPending();
    void this.router.navigate(['/login']);
  }

  private target(landing: string) {
    return safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl')) ?? landing;
  }

  private handle(e: unknown) {
    const err = toClientError(e);
    if (err.code === 'MFA_BLOCKED') {
      this.auth.cancelPending();
      this.go('blocked');
      return;
    }
    if (err.code === 'MFA_CHALLENGE_EXPIRED' || err.code === 'MFA_STAGE_INVALID') {
      this.auth.cancelPending();
      this.go('expired');
      return;
    }
    if (err.code === 'MFA_SETUP_ATTEMPTS_EXCEEDED') this.auth.cancelPending();
    this.error.set(err);
    this.code.set('');
    const el = this.codeInput()?.nativeElement;
    if (el) {
      el.value = '';
      el.focus();
    }
  }
}
