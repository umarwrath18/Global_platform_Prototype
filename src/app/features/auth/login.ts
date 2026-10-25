import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ClientError, formatDuration, toClientError } from '../../core/api/api-error';
import { safeReturnUrl } from '../../core/auth/auth.guards';
import { AuthService, SignedOutReason } from '../../core/auth/auth.service';
import { DEMO_ACCOUNT_GUIDE, DEMO_PASSWORD } from '../../core/mock-server/seed';
import { Icon } from '../../shared/icon';
import { AuthShell } from './auth-shell';

interface Notice {
  tone: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  text: string;
}

const REASON_NOTICES: Record<SignedOutReason | 'password-reset', Notice> = {
  'signed-out': { tone: 'info', text: 'You have been signed out.' },
  'session-expired': { tone: 'warning', text: 'Your session expired. Please sign in again to continue.' },
  'signin-required': { tone: 'info', text: 'Please sign in to continue.' },
  'account-suspended': { tone: 'danger', title: 'Account suspended', text: 'Your session ended because this Global Account was suspended. Please contact Mobi Support.' },
  'account-inactive': { tone: 'danger', title: 'Account inactive', text: 'Your session ended because this Global Account is not active. Please contact Mobi Support.' },
  'user-disabled': { tone: 'danger', title: 'Access disabled', text: 'Your session ended because your user access was disabled. Please contact Mobi Support.' },
  'password-reset': { tone: 'success', text: 'Password updated. Sign in with your new password.' },
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

  protected readonly demoAccounts = DEMO_ACCOUNT_GUIDE;
  protected readonly demoPassword = DEMO_PASSWORD;

  protected readonly lockRemainingSec = computed(() => Math.max(0, (this.lockedUntil() - this.now()) / 1000));
  protected readonly isLocked = computed(() => this.lockRemainingSec() > 0);

  protected readonly errorNotice = computed<Notice | null>(() => {
    const e = this.error();
    if (!e) return null;
    switch (e.code) {
      case 'INVALID_CREDENTIALS': {
        const left = 'attemptsRemaining' in e ? e.attemptsRemaining : undefined;
        const suffix = left ? ` ${left} attempt${left === 1 ? '' : 's'} left before sign-in is temporarily locked.` : '';
        return { tone: 'danger', text: `The Global Account ID or password is incorrect.${suffix}` };
      }
      case 'LOGIN_LOCKED':
        return this.isLocked()
          ? { tone: 'danger', title: 'Too many failed attempts', text: `For your security, sign-in is temporarily locked. Try again in ${formatDuration(this.lockRemainingSec())}, or reset your password.` }
          : { tone: 'info', text: 'You can try signing in again now.' };
      case 'ACCOUNT_SUSPENDED':
        return { tone: 'danger', title: 'Account suspended', text: 'This Global Account has been suspended. Please contact Mobi Support for assistance.' };
      case 'ACCOUNT_INACTIVE':
        return { tone: 'danger', title: 'Account inactive', text: 'This Global Account is not active. Please contact Mobi Support for assistance.' };
      case 'USER_DISABLED':
        return { tone: 'danger', title: 'Access disabled', text: 'Your user access has been disabled. Please contact Mobi Support for assistance.' };
      case 'NETWORK_ERROR':
        return { tone: 'warning', title: 'No connection', text: 'You appear to be offline. Check your internet connection and try again.' };
      case 'SERVICE_UNAVAILABLE':
        return { tone: 'warning', title: 'Service unavailable', text: 'We couldn’t reach the sign-in service. Please try again in a moment.' };
      default:
        return { tone: 'danger', text: 'Something went wrong. Please try again.' };
    }
  });

  constructor() {
    const reason = this.route.snapshot.queryParamMap.get('reason') as keyof typeof REASON_NOTICES | null;
    if (reason && REASON_NOTICES[reason]) this.notice.set(REASON_NOTICES[reason]);

    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
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
      const session = await this.auth.login(loginId.trim(), password, remember);
      const target = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl')) ?? session.landingPath;
      await this.router.navigateByUrl(target);
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
