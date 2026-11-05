import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { ClientError, toClientError } from '../../core/api/api-error';
import { AccountSecurityView, ReplaceAuthenticatorStart } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import { SecurityApi } from '../../core/auth/security-api.service';
import { AuthenticatorQr } from '../../shared/authenticator-qr';
import { DemoAuthenticatorService } from '../../shared/demo-authenticator';
import { Icon } from '../../shared/icon';
import { fmtDateTime, fmtRelative } from '../../shared/merchant-ui';
import { RecoveryCodes } from '../../shared/recovery-codes';

type ReplaceStep = 'idle' | 'current' | 'new' | 'done' | 'unavailable';
type CodesStep = 'idle' | 'current' | 'show';

/** A signed-in user's own two-factor settings: replace the authenticator (FR-06), new recovery codes. */
@Component({
  selector: 'app-account-security',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, AuthenticatorQr, RecoveryCodes],
  templateUrl: './account-security.html',
  styleUrl: './security.scss',
})
export class AccountSecurity {
  private readonly api = inject(SecurityApi);
  private readonly demo = inject(DemoAuthenticatorService);
  protected readonly session = inject(AuthService).session;

  protected readonly view = signal<AccountSecurityView | null>(null);
  protected readonly loadError = signal(false);
  protected readonly toast = signal<string | null>(null);

  protected readonly replaceStep = signal<ReplaceStep>('idle');
  protected readonly replacement = signal<ReplaceAuthenticatorStart | null>(null);
  protected readonly codesStep = signal<CodesStep>('idle');
  protected readonly newCodes = signal<string[]>([]);
  protected readonly codesSaved = signal(false);

  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<ClientError | null>(null);

  protected readonly dateTime = fmtDateTime;
  protected readonly rel = fmtRelative;

  constructor() {
    this.demo.sessionWanted.set(true);
    inject(DestroyRef).onDestroy(() => {
      this.demo.sessionWanted.set(false);
      this.demo.replacement.set(null);
    });
    void this.load();
  }

  protected async load() {
    this.loadError.set(false);
    try {
      this.view.set(await this.api.accountSecurity());
    } catch {
      this.loadError.set(true);
    }
  }

  protected errorText(): string | null {
    const e = this.error();
    if (!e) return null;
    const left = 'attemptsRemaining' in e ? e.attemptsRemaining : undefined;
    const tail = left ? ` ${left} attempt${left === 1 ? '' : 's'} left before sign-in is blocked.` : '';
    switch (e.code) {
      case 'MFA_CODE_INVALID':
        return this.replaceStep() === 'new' ? `That code doesn’t match the new authenticator.${left ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''}` : `That code is incorrect or has expired.${tail}`;
      case 'MFA_CODE_REUSED':
        return 'That code was already used. Wait for the next code, then enter it.';
      case 'MFA_SETUP_ATTEMPTS_EXCEEDED':
        return 'Too many incorrect codes for the new authenticator. Start the replacement again.';
      case 'STEP_UP_REQUIRED':
        return 'This replacement timed out. Start again.';
      case 'VALIDATION_FAILED':
        return 'Enter the 6-digit code.';
      case 'NETWORK_ERROR':
        return 'You appear to be offline. Check your connection and try again.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }

  protected onCode(value: string, el: HTMLInputElement) {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    if (digits !== value) el.value = digits;
    this.code.set(digits);
    this.error.set(null);
  }

  private reset() {
    this.code.set('');
    this.error.set(null);
  }

  // ---- Replace authenticator ----

  protected startReplace() {
    this.codesStep.set('idle');
    this.reset();
    this.replaceStep.set('current');
  }

  protected cancelReplace() {
    this.reset();
    this.replacement.set(null);
    this.demo.replacement.set(null);
    this.replaceStep.set('idle');
  }

  protected async verifyCurrentForReplace() {
    if (this.code().length !== 6 || this.busy()) return;
    this.busy.set(true);
    try {
      const r = await this.api.startReplacement(this.code());
      this.replacement.set(r);
      this.demo.replacement.set({ kind: 'replace', token: r.replaceToken });
      this.reset();
      this.replaceStep.set('new');
    } catch (e) {
      this.error.set(toClientError(e));
      this.code.set('');
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirmNew() {
    const r = this.replacement();
    if (!r || this.code().length !== 6 || this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.confirmReplacement(r.replaceToken, this.code());
      this.reset();
      this.replacement.set(null);
      this.demo.replacement.set(null);
      this.replaceStep.set('done');
      void this.load();
    } catch (e) {
      const err = toClientError(e);
      if (err.code === 'MFA_SETUP_ATTEMPTS_EXCEEDED' || err.code === 'STEP_UP_REQUIRED') {
        this.replacement.set(null);
        this.demo.replacement.set(null);
        this.replaceStep.set('current');
      }
      this.error.set(err);
      this.code.set('');
    } finally {
      this.busy.set(false);
    }
  }

  // ---- Recovery codes ----

  protected startCodes() {
    this.cancelReplace();
    this.reset();
    this.codesSaved.set(false);
    this.codesStep.set('current');
  }

  protected cancelCodes() {
    this.reset();
    this.codesStep.set('idle');
  }

  protected async regenerate() {
    if (this.code().length !== 6 || this.busy()) return;
    this.busy.set(true);
    try {
      const res = await this.api.regenerateRecoveryCodes(this.code());
      this.newCodes.set(res.recoveryCodes);
      this.reset();
      this.codesStep.set('show');
      void this.load();
    } catch (e) {
      this.error.set(toClientError(e));
      this.code.set('');
    } finally {
      this.busy.set(false);
    }
  }

  protected doneCodes() {
    this.newCodes.set([]);
    this.codesStep.set('idle');
    this.flash('New recovery codes saved. Your previous codes no longer work.');
  }

  private flash(text: string) {
    this.toast.set(text);
    setTimeout(() => this.toast.set(null), 4000);
  }
}
