import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import { HostDetailResponse } from '../../core/hosts/hosts';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';

export type HostAction = 'enable' | 'disable' | 'maintenance';

/**
 * Switching a host on and off, in a side sheet: Enable / Re-enable, Disable (reason +
 * confirmation) and Maintenance (reason + optional expected end). Each asks for an authenticator
 * code (not asked again for 5 minutes). Nothing is rerouted automatically.
 */
@Component({
  selector: 'app-host-action-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SideSheet, Icon, CodePrompt],
  styleUrl: './hosts.scss',
  template: `
@let h = detail().host;
<app-side-sheet [label]="title()" (dismiss)="close()">
  <header class="sheet-head">
    <div class="sheet-titles">
      <p class="sheet-eyebrow">Partner status</p>
      <h2 class="sheet-title">{{ title() }}</h2>
      <p class="sheet-sub">{{ h.name }} · {{ h.id }}</p>
    </div>
    <button type="button" class="sheet-close" (click)="close()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
  </header>
  <div class="sheet-body">
    @switch (action()) {
      @case ('enable') {
        @if (detail().enableBlockers.length) {
          <div class="host-banner bad" role="alert"><app-icon name="alert-circle" /><div><strong>Can't enable yet: finish the setup checklist</strong><ul>@for (b of detail().enableBlockers; track b) {<li>{{ b }}</li>}</ul></div></div>
        } @else {
          <p class="f-hint">{{ reenable() ? 'Ends maintenance and makes the host Active again.' : 'Makes the host Active.' }} An active host becomes eligible for routing once Routing Management exists. No routing rules are created now.</p>
          @if (h.maintenance; as m) {<dl class="sheet-dl"><div class="wide"><dt>Maintenance reason</dt><dd>{{ m.reason }}</dd></div></dl>}
        }
      }
      @case ('disable') {
        <div class="host-banner warn" role="note"><app-icon name="info" /><div>A disabled host is not eligible for routing. Mobi does not reroute or fall back automatically in this release; Routing Management will handle that later.</div></div>
        <div class="f-field"><label for="ha-reason">Reason <span class="req">*</span></label><textarea id="ha-reason" class="f-input" rows="3" maxlength="500" [class.invalid]="reasonError()" [value]="reason()" (input)="reason.set(v($event))"></textarea>@if (reasonError(); as m) {<p class="f-error">{{ m }}</p>}</div>
        <label class="check-line"><input type="checkbox" [checked]="confirmed()" (change)="confirmed.set($any($event.target).checked)" /> I understand {{ h.name }} stops being eligible for routing.</label>
      }
      @case ('maintenance') {
        <p class="f-hint">The host shows as under maintenance and is not eligible for routing until you re-enable it.</p>
        <div class="f-field"><label for="ha-reason">Reason <span class="req">*</span></label><textarea id="ha-reason" class="f-input" rows="3" maxlength="500" [class.invalid]="reasonError()" [value]="reason()" (input)="reason.set(v($event))"></textarea>@if (reasonError(); as m) {<p class="f-error">{{ m }}</p>}</div>
        <div class="f-field"><label for="ha-until">Expected end (optional)</label><input id="ha-until" type="datetime-local" class="f-input" [value]="until()" (input)="until.set(v($event))" />@if (untilError(); as m) {<p class="f-error">{{ m }}</p>} @else {<p class="f-hint">For information only: ending maintenance is done with Re-enable.</p>}</div>
      }
    }
    @if (error(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
  </div>
  @if (codeAsk()) {
    <app-code-prompt title="Confirm it's you" message="Enter a code from your authenticator app." [confirmLabel]="confirmLabel()" [tone]="action() === 'disable' ? 'danger' : 'primary'" [busy]="busy()" [error]="codeError()" (confirmed)="submit($event)" (cancelled)="codeAsk.set(false)" />
  } @else {
    <footer class="sheet-foot">
      <span class="sheet-foot-note"></span>
      <button type="button" class="btn" (click)="close()" [disabled]="busy()">Cancel</button>
      <button type="button" class="btn" [class.primary]="action() !== 'disable'" [class.danger]="action() === 'disable'" (click)="submit()" [disabled]="busy() || (action() === 'enable' && detail().enableBlockers.length > 0)">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}{{ confirmLabel() }}</button>
    </footer>
  }
</app-side-sheet>
  `,
})
export class HostActionSheet {
  private readonly api = inject(HostApi);
  private readonly prompt = viewChild(CodePrompt);

  readonly detail = input.required<HostDetailResponse>();
  readonly action = input.required<HostAction>();
  readonly done = output<{ detail: HostDetailResponse; message: string }>();
  readonly closed = output<void>();

  protected readonly reason = signal('');
  protected readonly until = signal('');
  protected readonly confirmed = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly codeAsk = signal(false);
  protected readonly codeError = signal<string | null>(null);
  protected readonly tried = signal(false);

  protected readonly reenable = computed(() => this.detail().host.operationalState === 'maintenance');
  protected readonly title = computed(() => {
    const n = this.detail().host.name;
    switch (this.action()) {
      case 'enable':
        return this.reenable() ? `Re-enable ${n}?` : `Enable ${n}?`;
      case 'disable':
        return `Disable ${n}?`;
      default:
        return `Put ${n} under maintenance`;
    }
  });
  protected readonly confirmLabel = computed(() => ({ enable: this.reenable() ? 'Re-enable host' : 'Enable host', disable: 'Disable host', maintenance: 'Start maintenance' })[this.action()]);
  protected readonly reasonError = computed(() => (this.tried() && (this.action() === 'disable' || this.action() === 'maintenance') && this.reason().trim().length < 5 ? 'Enter a reason (at least 5 characters).' : null));
  protected readonly untilError = computed(() => (this.until() && new Date(this.until()).getTime() <= Date.now() ? 'The expected end must be in the future.' : null));
  protected v(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected close() {
    if (this.busy()) return;
    if (this.codeAsk()) return this.codeAsk.set(false);
    this.closed.emit();
  }

  protected async submit(code?: string) {
    this.tried.set(true);
    if (this.reasonError() || this.untilError()) return;
    if (this.action() === 'disable' && !this.confirmed()) return this.error.set('Tick the box to confirm.');
    const id = this.detail().host.id;
    const c = code ? { code } : {};
    this.busy.set(true);
    this.error.set(null);
    this.codeError.set(null);
    try {
      const res = await this.api.changeStatus(id, { action: this.action(), reason: this.reason().trim(), until: this.until() ? new Date(this.until()).getTime() : null, confirm: this.confirmed(), ...c });
      this.codeAsk.set(false);
      const message = { enable: this.reenable() ? 'Host re-enabled' : 'Host enabled', disable: 'Host disabled', maintenance: 'Maintenance started' }[this.action()];
      this.done.emit({ detail: res, message });
    } catch (e) {
      const err = toHostError(e);
      const mfa = this.codeAsk() ? codeProblem(err.code, err.attemptsRemaining) : null;
      if (err.code === 'MFA_CODE_REQUIRED') this.codeAsk.set(true);
      else if (mfa) {
        this.codeError.set(mfa);
        this.prompt()?.reset();
      } else {
        this.codeAsk.set(false);
        this.error.set(err.message ?? "That didn't work. Please try again.");
      }
    } finally {
      this.busy.set(false);
    }
  }
}
