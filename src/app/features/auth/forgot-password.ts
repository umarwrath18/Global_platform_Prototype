import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { APP_PORTAL } from '../../core/app-portal';
import { ClientError, formatClock, toClientError } from '../../core/api/api-error';
import { OtpRequestResponse, OtpVerifyResponse } from '../../core/api/models';
import { demoAccountsFor } from '../../core/mock-server/seed';
import { PASSWORD_POLICY, PASSWORD_VIOLATION_TEXT, PasswordViolation, checkPassword } from '../../core/api/password-policy';
import { DemoInboxService } from '../../shared/demo-inbox.service';
import { Icon } from '../../shared/icon';
import { AuthShell } from './auth-shell';

type Step = 'email' | 'otp' | 'password' | 'success';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Component({
  selector: 'app-forgot-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthShell, ReactiveFormsModule, RouterLink, Icon],
  templateUrl: './forgot-password.html',
  styleUrl: './forgot-password.scss',
})
export class ForgotPassword {
  private readonly http = inject(HttpClient);
  /** PROTOTYPE ONLY: registered emails of this app's test accounts ("Use a test email"). */
  protected readonly testEmails = demoAccountsFor(inject(APP_PORTAL).portal).filter((a) => a.email);
  protected readonly showTestEmails = signal(false);
  private readonly inbox = inject(DemoInboxService);
  private readonly otpInput = viewChild<ElementRef<HTMLInputElement>>('otpInput');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly step = signal<Step>('email');
  protected readonly busy = signal(false);
  protected readonly resending = signal(false);
  protected readonly submitted = signal(false);
  protected readonly error = signal<ClientError | null>(null);
  protected readonly resentNotice = signal(false);
  protected readonly now = signal(Date.now());

  private requestId = '';
  private resetToken = '';
  protected readonly email = signal('');
  protected readonly resendAvailableAt = signal(0);
  protected readonly expiresAt = signal(0);

  protected readonly emailForm = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(EMAIL_PATTERN), Validators.maxLength(254)] }),
  });
  protected readonly otpControl = new FormControl('', { nonNullable: true });
  protected readonly otpForm = new FormGroup({ code: this.otpControl });
  protected readonly passwordForm = new FormGroup({
    newPassword: new FormControl('', { nonNullable: true }),
    confirmPassword: new FormControl('', { nonNullable: true }),
  });
  protected readonly showNew = signal(false);
  protected readonly showConfirm = signal(false);
  private readonly newPasswordValue = signal('');
  private readonly confirmValue = signal('');
  protected readonly otpValue = signal('');
  protected readonly serverViolations = signal<PasswordViolation[]>([]);

  protected readonly policy = PASSWORD_POLICY;
  protected readonly resendInSec = computed(() => Math.max(0, (this.resendAvailableAt() - this.now()) / 1000));
  protected readonly otpComplete = computed(() => /^\d{6}$/.test(this.otpValue()));

  protected readonly violations = computed(() => checkPassword(this.newPasswordValue(), { email: this.email() }));
  protected readonly policyChecks = computed(() => {
    const v = new Set([...this.violations(), ...this.serverViolations()]);
    const pw = this.newPasswordValue();
    return [
      { label: `At least ${PASSWORD_POLICY.minLength} characters`, ok: pw.length > 0 && !v.has('too_short') && !v.has('too_long') },
      { label: 'Not a common or breached password', ok: pw.length > 0 && !v.has('common') && !v.has('repetitive') },
      { label: 'Doesn’t include your ID or email', ok: pw.length > 0 && !v.has('contains_identity') },
    ];
  });
  protected readonly mismatch = computed(() => this.confirmValue().length > 0 && this.confirmValue() !== this.newPasswordValue());

  protected readonly errorText = computed<{ tone: 'danger' | 'warning'; title?: string; text: string } | null>(() => {
    const e = this.error();
    if (!e) return null;
    // Short on purpose: say what to do next, never how the limits work.
    switch (e.code) {
      case 'OTP_COOLDOWN':
        return { tone: 'warning', text: 'Please wait before requesting a new code.' };
      case 'OTP_SEND_LIMIT':
        return { tone: 'warning', text: 'Too many requests. Try again later.' };
      case 'OTP_DELIVERY_FAILED':
        return { tone: 'warning', text: 'Couldn’t send the code. Try again later.' };
      case 'OTP_INVALID': {
        const left = 'attemptsRemaining' in e ? e.attemptsRemaining : undefined;
        return { tone: 'danger', text: `Incorrect or expired code.${left ? ` ${left} attempt${left === 1 ? '' : 's'} left` : ''}` };
      }
      case 'OTP_EXPIRED':
      case 'OTP_USED':
      case 'OTP_ATTEMPTS_EXCEEDED':
        return { tone: 'danger', text: 'Request a new code.' };
      case 'RESET_TOKEN_INVALID':
        return { tone: 'danger', text: 'Session timed out.' };
      case 'RESET_NOT_ALLOWED':
        return { tone: 'danger', text: 'This account can’t be updated. Contact Mobi Support.' };
      case 'PASSWORD_POLICY':
        return { tone: 'danger', text: 'Choose a different password.' };
      case 'NETWORK_ERROR':
        return { tone: 'warning', text: 'You’re offline. Check your connection and try again.' };
      case 'SERVICE_UNAVAILABLE':
        return { tone: 'warning', text: 'Service unavailable. Try again shortly.' };
      default:
        return { tone: 'danger', text: 'Something went wrong. Please try again.' };
    }
  });

  /** Errors after which the current code can't be used and a new one is required. */
  protected readonly codeDead = computed(() => ['OTP_EXPIRED', 'OTP_USED', 'OTP_ATTEMPTS_EXCEEDED'].includes(this.error()?.code ?? ''));

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      this.inbox.clear();
    });
    this.passwordForm.controls.newPassword.valueChanges.subscribe((v) => {
      this.newPasswordValue.set(v);
      this.serverViolations.set([]);
    });
    this.passwordForm.controls.confirmPassword.valueChanges.subscribe((v) => this.confirmValue.set(v));
    this.otpControl.valueChanges.subscribe((v) => {
      const digits = v.replace(/\D/g, '').slice(0, 6);
      if (digits !== v) this.otpControl.setValue(digits, { emitEvent: false });
      this.otpValue.set(digits);
    });
  }

  protected formatClock = formatClock;
  protected violationText = (v: PasswordViolation) => PASSWORD_VIOLATION_TEXT[v];

  protected useTestEmail(email: string) {
    this.emailForm.controls.email.setValue(email);
    this.showTestEmails.set(false);
  }

  protected emailError(): string | null {
    const c = this.emailForm.controls.email;
    if (!(this.submitted() || c.touched) || c.valid) return null;
    return c.hasError('required') ? 'Enter your registered email address.' : 'Enter a valid email address, e.g. name@company.com.';
  }

  // ------------------------------------------------------------------ steps

  protected async sendOtp() {
    this.submitted.set(true);
    const email = this.emailForm.controls.email.value.trim();
    this.emailForm.controls.email.setValue(email);
    if (this.emailForm.invalid || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.http.post<OtpRequestResponse>('/api/auth/password/otp', { email }));
      this.applyOtpResponse(res);
      this.email.set(email);
      this.otpControl.setValue('');
      this.goTo('otp');
    } catch (e) {
      this.error.set(toClientError(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async resend() {
    if (this.resending() || this.resendInSec() > 0) return;
    this.resending.set(true);
    this.error.set(null);
    this.resentNotice.set(false);
    try {
      const res = await firstValueFrom(this.http.post<OtpRequestResponse>('/api/auth/password/otp/resend', { requestId: this.requestId }));
      this.applyOtpResponse(res);
      this.otpControl.setValue('');
      this.resentNotice.set(true);
      this.otpInput()?.nativeElement.focus();
    } catch (e) {
      const err = toClientError(e);
      if (err.code === 'OTP_COOLDOWN' && 'retryAfterSec' in err && err.retryAfterSec) {
        this.now.set(Date.now());
        this.resendAvailableAt.set(Date.now() + err.retryAfterSec * 1000);
      }
      this.error.set(err);
    } finally {
      this.resending.set(false);
    }
  }

  protected async verifyOtp() {
    if (!this.otpComplete() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.resentNotice.set(false);
    try {
      const res = await firstValueFrom(this.http.post<OtpVerifyResponse>('/api/auth/password/otp/verify', { requestId: this.requestId, code: this.otpValue() }));
      this.resetToken = res.resetToken;
      this.inbox.clear();
      this.passwordForm.reset();
      this.goTo('password');
    } catch (e) {
      this.error.set(toClientError(e));
      this.otpControl.setValue('');
      this.otpInput()?.nativeElement.focus();
    } finally {
      this.busy.set(false);
    }
  }

  protected async updatePassword() {
    this.submitted.set(true);
    const { newPassword, confirmPassword } = this.passwordForm.getRawValue();
    if (this.violations().length || !newPassword || newPassword !== confirmPassword || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.http.post('/api/auth/password/reset', { resetToken: this.resetToken, newPassword, confirmPassword }));
      this.resetToken = '';
      this.passwordForm.reset();
      this.goTo('success');
    } catch (e) {
      const err = toClientError(e);
      if (err.code === 'PASSWORD_POLICY' && 'violations' in err) this.serverViolations.set((err.violations ?? []) as PasswordViolation[]);
      this.error.set(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected changeEmail() {
    this.error.set(null);
    this.resentNotice.set(false);
    this.submitted.set(false);
    this.goTo('email');
  }

  protected startOver() {
    this.requestId = '';
    this.resetToken = '';
    this.changeEmail();
  }

  private applyOtpResponse(res: OtpRequestResponse) {
    this.now.set(Date.now());
    this.requestId = res.requestId;
    this.expiresAt.set(Date.now() + res.expiresInSec * 1000);
    this.resendAvailableAt.set(Date.now() + res.resendAvailableInSec * 1000);
  }

  private goTo(step: Step) {
    this.step.set(step);
    this.submitted.set(false);
    // Move focus to the new step's heading so screen readers announce the change.
    setTimeout(() => {
      if (step === 'otp') this.otpInput()?.nativeElement.focus();
      else this.heading()?.nativeElement.focus();
    });
  }
}
