import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { DemoAuthenticatorService } from './demo-authenticator';
import { Icon } from './icon';

let nextId = 0;

/**
 * "Confirm it's you" panel, shown inside a side sheet's footer area (never as a second popup):
 * one field for the 6-digit code from the user's authenticator app. Used for FinOps decisions,
 * settlement changes, USD fixed fees and payment-method deactivations. While it shows, the
 * prototype's Demo authenticator card shows the signed-in user's live code.
 */
@Component({
  selector: 'app-code-prompt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="sheet-confirm code-prompt" role="group" [attr.aria-labelledby]="id + '-t'">
      <div class="cp-head">
        <span class="cp-icon" aria-hidden="true"><app-icon name="shield" [size]="20" /></span>
        <div>
          <h3 [id]="id + '-t'">{{ title() }}</h3>
          <p>{{ message() }}</p>
        </div>
      </div>
      <label class="f-label" [for]="id">Code from your authenticator app</label>
      <input
        #field
        [id]="id"
        class="code-input"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        placeholder="000000"
        [attr.aria-invalid]="!!error()"
        [attr.aria-describedby]="error() ? id + '-e' : null"
        (input)="onInput(field)"
        (keydown.enter)="submit()"
      />
      @if (error(); as e) {<p class="f-error" [id]="id + '-e'" role="alert">{{ e }}</p>}
      <div class="sheet-confirm-actions">
        <button type="button" class="btn" (click)="cancelled.emit()" [disabled]="busy()">Back</button>
        <button type="button" class="btn" [class.primary]="tone() === 'primary'" [class.danger]="tone() === 'danger'" (click)="submit()" [disabled]="busy() || code().length !== 6">
          @if (busy()) {<span class="spinner" aria-hidden="true"></span>}{{ confirmLabel() }}
        </button>
      </div>
    </div>
  `,
  styles: `
    .cp-head { display: flex; gap: 14px; align-items: flex-start; }
    .cp-icon { flex: 0 0 40px; width: 40px; height: 40px; border-radius: 10px; background: var(--mobi-blue-tint); color: var(--mobi-blue); display: inline-flex; align-items: center; justify-content: center; }
    .f-error { margin: 0; color: var(--danger); font-size: 13px; }
  `,
})
export class CodePrompt implements AfterViewInit {
  readonly title = input.required<string>();
  readonly message = input.required<string>();
  readonly confirmLabel = input('Confirm');
  readonly tone = input<'primary' | 'danger'>('primary');
  readonly busy = input(false);
  readonly error = input<string | null>(null);
  readonly confirmed = output<string>();
  readonly cancelled = output<void>();

  protected readonly id = `code-${++nextId}`;
  protected readonly code = signal('');
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  constructor() {
    const demo = inject(DemoAuthenticatorService);
    const before = demo.sessionWanted();
    demo.sessionWanted.set(true);
    inject(DestroyRef).onDestroy(() => demo.sessionWanted.set(before));
  }

  ngAfterViewInit() {
    queueMicrotask(() => this.field()?.nativeElement.focus({ preventScroll: true }));
  }

  /** Clears the field after a wrong code, ready for the next one. */
  reset() {
    this.code.set('');
    const el = this.field()?.nativeElement;
    if (el) {
      el.value = '';
      el.focus();
    }
  }

  protected onInput(el: HTMLInputElement) {
    const digits = el.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== el.value) el.value = digits;
    this.code.set(digits);
  }

  protected submit() {
    if (this.code().length === 6 && !this.busy()) this.confirmed.emit(this.code());
  }
}

/** Message for an authenticator-code error from the server, or null when it isn't one. */
export function codeProblem(code: string | undefined, attemptsRemaining?: number): string | null {
  if (code === 'MFA_CODE_INVALID') return `Incorrect code.${attemptsRemaining ? ` ${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} left` : ''}`;
  if (code === 'MFA_CODE_REUSED') return 'Code already used. Wait for a new code.';
  if (code === 'MFA_BLOCKED') return 'Sign-in blocked. Contact Mobi Support.';
  return null;
}
