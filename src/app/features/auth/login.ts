import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ClientError, toClientError } from '../../core/api/api-error';
import { APP_PORTAL } from '../../core/app-portal';
import { safeReturnUrl } from '../../core/auth/auth.guards';
import { AuthService, SignedOutReason } from '../../core/auth/auth.service';
import { DEMO_PASSWORD, demoAccountsFor } from '../../core/mock-server/seed';
import { Icon } from '../../shared/icon';
import { AuthShell } from './auth-shell';

interface Notice {
  tone: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  text: string;
}

// Short on purpose: say what to do next, never why an account is restricted or how the rules work.
const BLOCKED: Notice = { tone: 'danger', text: 'This account can’t sign in. Contact Mobi Support.' };

const REASON_NOTICES: Record<SignedOutReason | 'password-reset', Notice> = {
  'signed-out': { tone: 'info', text: 'You’ve been signed out.' },
  'session-expired': { tone: 'warning', text: 'Session expired. Sign in again.' },
  'signin-required': { tone: 'info', text: 'Sign in to continue.' },
  'account-suspended': BLOCKED,
  'account-inactive': BLOCKED,
  'user-disabled': BLOCKED,
  'password-reset': { tone: 'success', text: 'Password updated. Sign in with your new password.' },
  'mfa-required': { tone: 'info', text: 'MFA is now required. Sign in to set it up.' },
  'mfa-blocked': { tone: 'danger', text: 'Sign-in blocked. Contact Mobi Support.' },
  // Replaced with the app-specific "use the other portal" message in the constructor.
  'wrong-portal': { tone: 'warning', text: '' },
  'mfa-reset': { tone: 'warning', text: 'MFA was reset. Sign in to set it up again.' },
};

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthShell, ReactiveFormsModule, RouterLink, Icon],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private readonly passwordInput = viewChild<ElementRef<HTMLInputElement>>('passwordInput');

  protected readonly form = new FormGroup({
    loginId: new FormControl(this.auth.rememberedLoginId, { nonNullable: true, validators: [Validators.required, Validators.maxLength(64)] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(256)] }),
    remember: new FormControl(!!this.auth.rememberedLoginId, { nonNullable: true }),
  });

  protected readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly showPassword = signal(false);
  protected readonly showSamples = signal(false);
  protected readonly error = signal<ClientError | null>(null);
  protected readonly lockedUntil = signal(0);
  protected readonly now = signal(Date.now());
  protected readonly notice = signal<Notice | null>(null);

  protected readonly app = inject(APP_PORTAL);
  // Each app lists only the test accounts that can sign in to it.
  protected readonly demoAccounts = demoAccountsFor(this.app.portal);
  protected readonly demoPassword = DEMO_PASSWORD;

  protected readonly lockRemainingSec = computed(() => Math.max(0, (this.lockedUntil() - this.now()) / 1000));
  protected readonly isLocked = computed(() => this.lockRemainingSec() > 0);

  protected readonly errorNotice = computed<Notice | null>(() => {
    const e = this.error();
    if (!e) return null;
    switch (e.code) {
      case 'INVALID_CREDENTIALS': {
        const left = 'attemptsRemaining' in e ? e.attemptsRemaining : undefined;
        const suffix = left ? ` ${left} attempt${left === 1 ? '' : 's'} left` : '';
        return { tone: 'danger', text: `Incorrect Global Account ID or password.${suffix}` };
      }
      case 'LOGIN_LOCKED':
        // The lock time is not shown; the Sign in button stays disabled until it ends.
        return this.isLocked() ? { tone: 'danger', text: 'Too many attempts. Try again later.' } : null;
      case 'ACCOUNT_SUSPENDED':
      case 'ACCOUNT_INACTIVE':
      case 'USER_DISABLED':
        return BLOCKED;
      case 'WRONG_PORTAL':
        return { tone: 'warning', text: this.wrongPortalText() };
      case 'MFA_BLOCKED':
        return { tone: 'danger', text: 'Sign-in blocked. Contact Mobi Support.' };
      case 'NETWORK_ERROR':
        return { tone: 'warning', text: 'You’re offline. Check your connection and try again.' };
      case 'SERVICE_UNAVAILABLE':
        return { tone: 'warning', text: 'Service unavailable. Try again shortly.' };
      default:
        return { tone: 'danger', text: 'Something went wrong. Please try again.' };
    }
  });

  constructor() {
    // Coming back to the password step abandons any half-finished 2FA step.
    this.auth.cancelPending();
    const reason = this.route.snapshot.queryParamMap.get('reason') as keyof typeof REASON_NOTICES | null;
    if (reason === 'wrong-portal') this.notice.set({ tone: 'warning', text: this.wrongPortalText() });
    else if (reason && REASON_NOTICES[reason]) this.notice.set(REASON_NOTICES[reason]);

    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private wrongPortalText() {
    return `Use the Mobi ${this.app.portal === 'merchant' ? 'Global Platform' : 'Merchant Portal'} to sign in.`;
  }

  protected fieldError(name: 'loginId' | 'password'): string | null {
    const c = this.form.controls[name];
    if (!(this.submitted() || c.touched) || c.valid || c.disabled) return null;
    if (c.hasError('maxlength')) return 'This value is too long.';
    return name === 'loginId' ? 'Enter your Global Account ID.' : 'Enter your password.';
  }

  protected fillSample(loginId: string) {
    this.form.patchValue({ loginId, password: DEMO_PASSWORD });
    this.showSamples.set(false);
  }

  protected async submit() {
    this.submitted.set(true);
    const { loginId, password, remember } = this.form.getRawValue();
    this.form.controls.loginId.setValue(loginId.trim());
    if (this.form.invalid || !loginId.trim() || this.busy() || this.isLocked()) {
      this.form.markAllAsTouched();
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    this.form.disable({ emitEvent: false });
    try {
      // The password alone never grants access: continue to the second factor.
      await this.auth.login(loginId.trim(), password, remember);
      const returnUrl = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
      await this.router.navigate(['/mfa'], returnUrl ? { queryParams: { returnUrl } } : {});
    } catch (e) {
      const err = toClientError(e);
      if (err.code === 'LOGIN_LOCKED' && 'retryAfterSec' in err && err.retryAfterSec) {
        this.now.set(Date.now());
        this.lockedUntil.set(Date.now() + err.retryAfterSec * 1000);
      }
      this.error.set(err);
      this.form.enable({ emitEvent: false });
      if (err.code === 'INVALID_CREDENTIALS' || err.code === 'LOGIN_LOCKED') {
        this.form.controls.password.reset('');
        this.submitted.set(false);
        queueMicrotask(() => this.passwordInput()?.nativeElement.focus());
      }
    } finally {
      this.busy.set(false);
      if (this.form.disabled) this.form.enable({ emitEvent: false });
    }
  }
}
