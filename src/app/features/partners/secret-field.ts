import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import { HostDetailResponse, SecretKind } from '../../core/hosts/hosts';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';
import { fmtWhen } from '../hosts/host-ui';

/**
 * A write-only credential: shows only that it is set (last 4 characters, who, when). Set / Replace
 * opens a side sheet; the value is sent once with an authenticator code and never shown again.
 */
@Component({
  selector: 'app-secret-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SideSheet, CodePrompt],
  styleUrl: './partners.scss',
  template: `
@let s = meta();
<div class="pt-secret" [class.compact]="compact()">
  <app-icon [name]="s ? 'shield' : 'alert-circle'" [size]="16" />
  <div class="pt-secret-text">
    @if (!compact()) {<strong>{{ label() }}</strong>}
    @if (s) {<span>Set · ends in <b class="mono">{{ s.last4 }}</b> · {{ s.setBy }}, {{ when(s.setAt) }}</span>} @else {<span class="muted">Not set</span>}
  </div>
  @if (detail().can.manage) {<button type="button" class="btn sm" (click)="open.set(true)">{{ s ? 'Replace' : 'Set' }}</button>}
</div>
@if (open()) {
  <app-side-sheet [label]="(s ? 'Replace ' : 'Set ') + label()" (dismiss)="close()">
    <header class="sheet-head">
      <div class="sheet-titles"><p class="sheet-eyebrow">Credential · write-only</p><h2 class="sheet-title">{{ s ? 'Replace' : 'Set' }} {{ label().toLowerCase() }}</h2><p class="sheet-sub">{{ detail().host.name }} · {{ detail().host.id }}</p></div>
      <button type="button" class="sheet-close" (click)="close()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
    </header>
    <form class="sheet-body" id="secret-form" (submit)="$event.preventDefault(); save()" novalidate>
      @if (s) {<dl class="sheet-dl"><div class="wide"><dt>Current</dt><dd>Ends in <span class="mono">{{ s.last4 }}</span> · set by {{ s.setBy }}, {{ when(s.setAt) }}</dd></div></dl>}
      <div class="f-field">
        <label for="secret-value">{{ label() }} <span class="req">*</span></label>
        <input id="secret-value" class="f-input mono" type="password" autocomplete="new-password" maxlength="500" [class.invalid]="error()" [value]="value()" (input)="value.set($any($event.target).value)" />
        @if (error(); as e) {<p class="f-error">{{ e }}</p>} @else {<p class="f-hint">Paste it from the partner. It is sent once, stored in the credential vault, and never shown again: only its last 4 characters.</p>}
      </div>
      @if (s) {<div class="alert warning compact" role="note"><app-icon name="alert-circle" /><div>The old {{ label().toLowerCase() }} stops working for Mobi as soon as you replace it. Make sure the partner has issued the new one.</div></div>}
    </form>
    @if (codeAsk()) {
      <app-code-prompt title="Confirm it's you" message="Enter a code from your authenticator app." [confirmLabel]="s ? 'Replace' : 'Save'" [busy]="busy()" [error]="codeError()" (confirmed)="save($event)" (cancelled)="codeAsk.set(false)" />
    } @else {
      <footer class="sheet-foot">
        <span class="sheet-foot-note">Needs an authenticator code.</span>
        <button type="button" class="btn" (click)="close()" [disabled]="busy()">Cancel</button>
        <button type="submit" form="secret-form" class="btn primary" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}{{ s ? 'Replace' : 'Save' }}</button>
      </footer>
    }
  </app-side-sheet>
}
  `,
})
export class SecretField {
  private readonly api = inject(HostApi);
  private readonly prompt = viewChild(CodePrompt);

  readonly detail = input.required<HostDetailResponse>();
  readonly kind = input.required<SecretKind>();
  readonly label = input.required<string>();
  readonly compact = input(false);
  readonly changed = output<HostDetailResponse>();

  protected readonly when = fmtWhen;
  protected readonly meta = computed(() => this.detail().host.secrets?.[this.kind()] ?? null);
  protected readonly open = signal(false);
  protected readonly value = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly codeAsk = signal(false);
  protected readonly codeError = signal<string | null>(null);

  protected close() {
    if (this.busy()) return;
    if (this.codeAsk()) return this.codeAsk.set(false);
    this.value.set('');
    this.error.set(null);
    this.open.set(false);
  }

  protected async save(code?: string) {
    const v = this.value().trim();
    if (v.length < 8) return this.error.set(`Enter the ${this.label().toLowerCase()} (at least 8 characters).`);
    this.busy.set(true);
    this.error.set(null);
    this.codeError.set(null);
    try {
      const res = await this.api.setSecret(this.detail().host.id, this.kind(), v, code);
      this.value.set('');
      this.codeAsk.set(false);
      this.open.set(false);
      this.changed.emit(res);
    } catch (e) {
      const err = toHostError(e);
      const mfa = this.codeAsk() ? codeProblem(err.code, err.attemptsRemaining) : null;
      if (err.code === 'MFA_CODE_REQUIRED') this.codeAsk.set(true);
      else if (mfa) {
        this.codeError.set(mfa);
        this.prompt()?.reset();
      } else {
        this.codeAsk.set(false);
        this.error.set(err.errors[0]?.message ?? err.message ?? "That didn't work. Please try again.");
      }
    } finally {
      this.busy.set(false);
    }
  }
}
