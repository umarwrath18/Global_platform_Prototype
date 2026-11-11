import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal, viewChild } from '@angular/core';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { addDays, Deactivation, FLOW_LABEL, fmtDay, pricingSummary, ProductFlow, ProductPricingView } from '../../core/merchants/products';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { DateField } from '../../shared/date-field';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';

/**
 * Deactivate a live payment method (Ops, after onboarding): for the whole MID (Master Merchant and
 * every sub-merchant) or one sub-merchant, immediately or from a date, with a reason. The server checks
 * everything, then asks for an authenticator code. FinOps is alerted in-app and by email.
 */
@Component({
  selector: 'app-deactivate-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SideSheet, Icon, DateField, CodePrompt],
  template: `
    <app-side-sheet size="editor" [label]="title()" (dismiss)="requestClose()">
      <header class="sheet-head">
        <div class="sheet-titles">
          <p class="sheet-eyebrow">Deactivate payment method</p>
          <h2 class="sheet-title">{{ title() }}</h2>
          <p class="sheet-sub">{{ view().merchantName }} - {{ view().mid ? 'MID ' + view().mid : view().applicationId }} · {{ flowLabel[flow()] }}</p>
        </div>
        <button type="button" class="sheet-close" (click)="requestClose()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
      </header>

      @if (done(); as d) {
        <div class="sheet-body">
          <div class="da-done" role="status">
            <span class="ok" aria-hidden="true"><app-icon name="check-circle" [size]="28" /></span>
            <h3>{{ d.immediate ? methodName() + ' deactivated' : 'Deactivation scheduled' }}</h3>
            <p>{{ d.immediate ? methodName() + ' stopped ' + scopeText() + ' just now.' : methodName() + ' stops ' + scopeText() + ' from ' + day(d.effectiveDate) + '. You can cancel it until then.' }} FinOps has been told in-app and by email.</p>
          </div>
        </div>
        <footer class="sheet-foot"><span class="sheet-foot-note"></span><button type="button" class="btn primary" (click)="closed.emit()" autofocus>Done</button></footer>
      } @else {
        <div class="sheet-body">
          <section class="sheet-section">
            <h3 id="da-scope">Where it stops</h3>
            @if (lockScope()) {
              <p class="da-fixed"><app-icon name="lock" [size]="14" />{{ subName(subId()) ?? 'Master Merchant and all sub-merchants' }}</p>
            } @else {
              <div class="da-options" role="radiogroup" aria-labelledby="da-scope">
                <label class="da-option" [class.on]="!subId()">
                  <input type="radio" name="da-scope" [checked]="!subId()" (change)="subId.set(null)" />
                  <span><strong>Master Merchant and all sub-merchants</strong><span class="muted">The product switches off for this MID.</span></span>
                </label>
                @if (view().subMerchants.length) {
                  <label class="da-option" [class.on]="!!subId()">
                    <input type="radio" name="da-scope" [checked]="!!subId()" (change)="subId.set(view().subMerchants[0].id)" />
                    <span><strong>One sub-merchant</strong><span class="muted">The Master Merchant and other sub-merchants keep it.</span></span>
                  </label>
                  @if (subId()) {
                    <label class="f-label" for="da-sub">Sub-merchant</label>
                    <select id="da-sub" class="f-input" (change)="subId.set($any($event.target).value)">
                      @for (s of view().subMerchants; track s.id) {<option [value]="s.id" [selected]="s.id === subId()">{{ s.name }}</option>}
                    </select>
                  }
                }
              </div>
            }
          </section>

          <section class="sheet-section">
            <h3 id="da-when">When</h3>
            <div class="da-options" role="radiogroup" aria-labelledby="da-when">
              <label class="da-option" [class.on]="when() === 'immediate'">
                <input type="radio" name="da-when" [checked]="when() === 'immediate'" (change)="when.set('immediate')" />
                <span><strong>Immediately</strong><span class="muted">Stops now. Use it for an outage, fraud or a provider stopping the method.</span></span>
              </label>
              <label class="da-option" [class.on]="when() === 'scheduled'">
                <input type="radio" name="da-when" [checked]="when() === 'scheduled'" (change)="when.set('scheduled')" />
                <span><strong>On a date</strong><span class="muted">Works until the day before. You can cancel it until then.</span></span>
              </label>
            </div>
            @if (when() === 'scheduled') {
              <label class="f-label" for="da-date">Stops from</label>
              <app-date-field inputId="da-date" [min]="tomorrow()" [value]="date()" [invalid]="!!fieldError('effectiveDate')" (changed)="date.set($event)" />
              @if (fieldError('effectiveDate'); as e) {<p class="f-error" role="alert">{{ e }}</p>}
            }
          </section>

          <section class="sheet-section">
            <label class="f-label" for="da-reason"><strong>Reason</strong> <span class="req">*</span></label>
            <textarea id="da-reason" class="f-input da-reason" rows="3" maxlength="500" placeholder="E.g. provider contract ended, merchant request, fraud" [value]="reason()" (input)="reason.set($any($event.target).value)" [attr.aria-invalid]="!!fieldError('reason') || null"></textarea>
            @if (fieldError('reason'); as e) {<p class="f-error" role="alert">{{ e }}</p>}
          </section>

          <section class="sheet-section">
            <h3>What happens</h3>
            <ul class="da-impact">
              @for (line of impact(); track line) {<li>{{ line }}</li>}
            </ul>
          </section>

          @if (error(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
        </div>

        @if (codeAsk()) {
          <app-code-prompt
            [title]="'Confirm: deactivate ' + methodName()"
            message="Deactivating a payment method needs a code from your authenticator app. You won't be asked again for 5 minutes."
            confirmLabel="Deactivate"
            tone="danger"
            [busy]="busy()"
            [error]="codeError()"
            (confirmed)="send($event)"
            (cancelled)="codeAsk.set(false)"
          />
        } @else {
          <footer class="sheet-foot">
            <span class="sheet-foot-note">FinOps is alerted in-app and by email.</span>
            <button type="button" class="btn" (click)="closed.emit()" [disabled]="busy()">Cancel</button>
            <button type="button" class="btn danger" (click)="send()" [disabled]="busy()">
              @if (busy()) {<span class="spinner" aria-hidden="true"></span>}<app-icon name="power" [size]="15" />Deactivate
            </button>
          </footer>
        }
      }
    </app-side-sheet>
  `,
  styles: `
    .da-options { display: flex; flex-direction: column; gap: 8px; }
    .da-option { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-card); cursor: pointer; }
    .da-option.on { border-color: var(--mobi-blue); background: var(--mobi-blue-tint); }
    .da-option input { margin-top: 3px; }
    .da-option > span { display: flex; flex-direction: column; gap: 2px; font-size: 14px; }
    .da-option .muted { font-size: 13px; color: var(--text-muted); }
    .da-fixed { display: inline-flex; align-items: center; gap: 8px; margin: 0; padding: 8px 12px; border-radius: 999px; background: var(--mobi-blue-tint); color: var(--brand-dark); font-size: 13px; font-weight: 600; }
    .da-reason { height: auto; min-height: 88px; padding: 10px 12px; resize: vertical; }
    .da-impact { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: var(--text); line-height: 1.5; }
    .f-error { margin: 0; color: var(--danger); font-size: 13px; }
    .req { color: var(--danger); }
    .da-done { display: flex; flex-direction: column; gap: 8px; }
    .da-done .ok { color: var(--success); }
    .da-done h3 { margin: 4px 0 0; font-size: 18px; }
    .da-done p { margin: 0; color: var(--text-muted); line-height: 1.5; }
  `,
})
export class DeactivateSheet implements OnInit {
  private readonly api = inject(MerchantApi);

  readonly view = input.required<ProductPricingView>();
  readonly methodCode = input.required<string>();
  readonly flow = input.required<ProductFlow>();
  /** Start with this sub-merchant (null = whole MID). */
  readonly subMerchantId = input<string | null>(null);
  /** From a sub-merchant row: the scope is that sub-merchant only. */
  readonly lockScope = input(false);
  readonly finished = output<ProductPricingView>();
  readonly closed = output<void>();

  protected readonly flowLabel = FLOW_LABEL;
  protected readonly day = fmtDay;
  protected readonly subId = signal<string | null>(null);
  protected readonly when = signal<'immediate' | 'scheduled'>('immediate');
  protected readonly tomorrow = computed(() => addDays(this.view().today, 1));
  protected readonly date = signal('');
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<{ field: string; message: string }[]>([]);
  protected readonly codeAsk = signal(false);
  protected readonly codeError = signal<string | null>(null);
  protected readonly done = signal<Deactivation | null>(null);
  private readonly codePrompt = viewChild(CodePrompt);

  protected readonly methodName = computed(() => this.view().methods.find((m) => m.code === this.methodCode() && m.flow === this.flow())?.name ?? this.methodCode());
  protected readonly title = computed(() => `Deactivate ${this.methodName()}`);
  protected readonly scopeText = computed(() => (this.subId() ? `for ${this.subName(this.subId())}` : 'for the Master Merchant and all sub-merchants'));

  /** Plain-language impact on the pricing in scope, worked out from the view (the server decides). */
  protected readonly impact = computed(() => {
    const v = this.view();
    const sub = this.subId();
    const stop = this.when() === 'immediate' ? v.today : this.date();
    const inScope = v.versions.filter((x) => x.methodCode === this.methodCode() && x.flow === this.flow() && (sub === null || (x.subMerchantId ?? null) === sub));
    const lines: string[] = [];
    const ends = inScope.filter((x) => (x.status === 'active' || (x.status === 'scheduled' && stop && x.startDate < stop)) && (x.endDate === null || !stop || x.endDate >= stop));
    for (const x of ends) lines.push(`${pricingSummary(x)} (v${x.version}${x.subMerchantId ? `, ${this.subName(x.subMerchantId)}` : ''}) ${this.when() === 'immediate' ? 'ends today' : stop ? `ends on ${fmtDay(addDays(stop, -1))}` : 'ends the day before'}.`);
    const cancelled = inScope.filter((x) => x.status === 'pending_approval' || (x.status === 'scheduled' && (this.when() === 'immediate' || (stop && x.startDate >= stop))));
    if (cancelled.length) lines.push(`${cancelled.length} scheduled or pending pricing change${cancelled.length === 1 ? '' : 's'} will be cancelled.`);
    if (sub === null) lines.push(`${this.methodName()} switches off for this MID${this.when() === 'immediate' ? ' now' : stop ? ` on ${fmtDay(stop)}` : ''}. To offer it again, switch the product on and set pricing.`);
    else lines.push(`${this.subName(sub)} stops inheriting ${this.methodName()} from the Master Merchant. You can reactivate it later.`);
    if (!ends.length && !cancelled.length && sub !== null) lines.unshift(`${this.subName(sub)} has no pricing of its own for ${this.methodName()}.`);
    return lines;
  });

  ngOnInit() {
    this.subId.set(this.subMerchantId());
  }

  protected subName(id: string | null) {
    return id ? (this.view().subMerchants.find((s) => s.id === id)?.name ?? id) : null;
  }

  protected fieldError(field: string) {
    return this.errors().find((e) => e.field === field)?.message ?? null;
  }

  protected requestClose() {
    if (this.done()) return this.closed.emit();
    if (this.codeAsk()) return this.codeAsk.set(false);
    this.closed.emit();
  }

  protected async send(code?: string) {
    this.busy.set(true);
    this.error.set(null);
    this.codeError.set(null);
    this.errors.set([]);
    try {
      const res = await this.api.deactivateMethod(this.view().applicationId, {
        methodCode: this.methodCode(),
        flow: this.flow(),
        subMerchantId: this.subId(),
        when: this.when(),
        ...(this.when() === 'scheduled' ? { effectiveDate: this.date() } : {}),
        reason: this.reason().trim(),
        ...(code ? { code } : {}),
      });
      this.codeAsk.set(false);
      this.done.set(res.deactivation);
      this.finished.emit(res.view);
    } catch (e) {
      const err = toMerchantError(e) as { code?: string; message?: string; errors?: { field: string; message: string }[]; attemptsRemaining?: number };
      const mfa = this.codeAsk() ? codeProblem(err.code, err.attemptsRemaining) : null;
      if (err.code === 'MFA_CODE_REQUIRED') this.codeAsk.set(true);
      else if (mfa) {
        this.codeError.set(mfa);
        this.codePrompt()?.reset();
      } else {
        this.codeAsk.set(false);
        if (err.errors?.length) this.errors.set(err.errors);
        else this.error.set(err.message ?? "We couldn't deactivate the payment method.");
      }
    } finally {
      this.busy.set(false);
    }
  }
}
