import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { MerchantDetail } from '../../core/merchants/merchant-models';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { CONTROL_CHIP, CONTROL_KEYS, isFraudType, REACTIVATION_OUTCOMES, SUSPENSION_SCOPE_LABEL, SUSPENSION_TYPE_LABEL, SuspensionView, VIA_LABEL } from '../../core/merchants/suspensions';
import { CurrencyAmount, fmtDateTime, fmtMoney } from '../../core/transactions/transactions';
import { TransactionsApi } from '../../core/transactions/transactions-api.service';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';

export type SuspensionMode = 'view' | 'review' | 'reactivate' | 'approve' | 'settlement';

/**
 * One suspension in a side sheet: its details and activity, then the step the user can take:
 * the second Risk review (fraud), a reactivation (Risk; fraud needs another Risk person to approve),
 * approving that reactivation, or FinOps releasing held settlement. Each step asks for an
 * authenticator code. The server enforces team, maker ≠ checker and state.
 */
@Component({
  selector: 'app-suspension-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SideSheet, CodePrompt, RouterLink],
  template: `
@let s = suspension();
<app-side-sheet [size]="mode() === 'view' ? 'detail' : 'editor'" [label]="heading()" (dismiss)="dismiss()">
  <header class="sheet-head">
    <div class="sheet-titles">
      <p class="sheet-eyebrow">{{ eyebrow() }}</p>
      <h2 class="sheet-title">{{ heading() }}</h2>
      <p class="sheet-sub">{{ s.merchantName }} · {{ typeLabel[s.type] }}@if (s.caseRef) { · Case {{ s.caseRef }}}</p>
    </div>
    <button type="button" class="sheet-close" (click)="dismiss()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
  </header>

  <div class="sheet-body">
    @if (makerBlock(); as m) {<div class="alert info compact" role="note"><app-icon name="info" /><div>{{ m }}</div></div>}

    <section class="sheet-section">
      <h3>Details</h3>
      <dl class="sheet-dl">
        <div><dt>Status</dt><dd><span class="status" [class]="s.status === 'active' ? 'status danger' : 'status success'">{{ s.status === 'active' ? 'Suspended' : 'Reactivated' }}</span></dd></div>
        <div><dt>Scope</dt><dd>{{ scopeText() }}</dd></div>
        <div><dt>Suspended by</dt><dd>{{ s.createdBy }}</dd></div>
        <div><dt>Since</dt><dd>{{ when(s.createdAt) }}</dd></div>
        <div><dt>Detected by</dt><dd>{{ s.detectedBy }}</dd></div>
        <div><dt>Covers</dt><dd>{{ s.coverage }}</dd></div>
        <div class="wide"><dt>Payment controls</dt><dd>{{ chips() }}</dd></div>
        <div class="wide"><dt>Reason</dt><dd>{{ s.reason }}</dd></div>
        @if (s.linkedTransactions.length) {
          <div class="wide"><dt>Linked transactions</dt><dd>@for (t of s.linkedTransactions; track t; let last = $last) {<a [routerLink]="['/transactions']" [queryParams]="{ flow: t.startsWith('PYO') ? 'payout' : null, q: t, txn: t }">{{ t }}</a>@if (!last) {, }}</dd></div>
        }
        <div><dt>Settlement</dt><dd>{{ settlementText() }}</dd></div>
        @if (s.review.required) {<div><dt>Second review</dt><dd>{{ reviewText() }}</dd></div>}
      </dl>
    </section>

    @if (mode() === 'settlement' || s.settlement.status !== 'not_held') {
      <section class="sheet-section">
        <h3>Held settlement</h3>
        @if (held().length) {
          <div class="sus-held">@for (a of held(); track a.currency) {<span>{{ money(a.amount, a.currency) }}</span>}</div>
        } @else {
          <p class="txn-meta">No successful pay-ins since the suspension.</p>
        }
        <p class="f-hint">Sample figures: successful pay-ins since the suspension. The Settlements module will hold the real amounts.</p>
      </section>
    }

    <section class="sheet-section">
      <h3>Activity</h3>
      <ol class="sheet-timeline">
        @for (a of activity(); track $index) {
          <li [class.waiting]="a.waiting" [class.bad]="a.bad"><div><strong>{{ a.title }}</strong><div class="meta">{{ a.meta }}</div>@if (a.note) {<div class="meta">{{ a.note }}</div>}</div></li>
        }
      </ol>
    </section>

    @switch (mode()) {
      @case ('review') {
        <section class="sheet-section">
          <h3>Decision</h3>
          <label class="sus-opt" [class.on]="decision() === 'confirm'"><input type="radio" name="rv" [checked]="decision() === 'confirm'" (change)="decision.set('confirm')" /><span><strong>Confirm suspension</strong>Keeps everything as it is.</span></label>
          <label class="sus-opt" [class.on]="decision() === 'lift'"><input type="radio" name="rv" [checked]="decision() === 'lift'" (change)="decision.set('lift')" /><span><strong>Lift suspension</strong>Reactivates now. Held settlement then goes to FinOps.</span></label>
          <div><label class="f-label" for="rv-note">Review note <span class="req">*</span></label><textarea id="rv-note" class="f-input" rows="2" maxlength="500" [value]="note()" (input)="note.set($any($event.target).value)"></textarea></div>
        </section>
      }
      @case ('reactivate') {
        <section class="sheet-section">
          <div><label class="f-label" for="ra-outcome">Outcome <span class="req">*</span></label>
            <select id="ra-outcome" class="f-input" (change)="outcome.set($any($event.target).value)">@for (o of outcomes; track o) {<option [value]="o" [selected]="o === outcome()">{{ o }}</option>}</select></div>
          <div><label class="f-label" for="ra-reason">Reason <span class="req">*</span></label><textarea id="ra-reason" class="f-input" rows="2" maxlength="500" [value]="note()" (input)="note.set($any($event.target).value)"></textarea></div>
          <span class="f-label">Lift</span>
          <div class="sus-controls">
            @if (s.controls.payins) {<label class="sus-ctl"><input type="checkbox" checked disabled /><span><strong>Allow new pay-ins</strong></span></label>}
            @if (s.controls.payouts) {<label class="sus-ctl"><input type="checkbox" checked disabled /><span><strong>Allow payouts</strong></span></label>}
            @if (s.controls.refunds) {<label class="sus-ctl"><input type="checkbox" checked disabled /><span><strong>Allow refunds</strong></span></label>}
            @if (s.settlement.status === 'held') {
              <label class="sus-ctl"><input type="checkbox" [checked]="release()" (change)="release.set($any($event.target).checked)" /><span><strong>Release settlement <span class="sus-tag">FinOps confirms</span></strong><span>Held funds stay on hold until FinOps confirms the release in Approvals.</span></span></label>
            }
          </div>
          @if (ownSubSuspensions().length) {
            <div class="table-wrap"><table class="data-table txn-mini"><thead><tr><th scope="col">Sub-merchant</th><th scope="col">After reactivation</th></tr></thead><tbody>
              @for (x of ownSubSuspensions(); track x.id) {<tr><td>{{ x.name }}</td><td>Stays suspended ({{ x.why }})</td></tr>}
            </tbody></table></div>
          }
          @if (fraud()) {<div class="alert warning compact" role="note"><app-icon name="info" /><div>Fraud suspension: another Risk reviewer must approve this reactivation. It stays suspended until then.</div></div>}
        </section>
      }
      @case ('approve') {
        <section class="sheet-section">
          <h3>Reactivation request</h3>
          <dl class="sheet-dl">
            <div><dt>Requested by</dt><dd>{{ s.reactivation?.requestedBy }}</dd></div>
            <div><dt>Outcome</dt><dd>{{ s.reactivation?.outcome }}</dd></div>
            <div class="wide"><dt>Reason</dt><dd>{{ s.reactivation?.reason }}</dd></div>
            <div class="wide"><dt>Settlement</dt><dd>{{ s.reactivation?.releaseSettlement && s.settlement.status === 'held' ? 'Release (FinOps confirms)' : 'Not affected' }}</dd></div>
          </dl>
          <label class="sus-opt" [class.on]="decision() === 'approve'"><input type="radio" name="ap" [checked]="decision() === 'approve'" (change)="decision.set('approve')" /><span><strong>Approve</strong>Reactivates now.</span></label>
          <label class="sus-opt" [class.on]="decision() === 'reject'"><input type="radio" name="ap" [checked]="decision() === 'reject'" (change)="decision.set('reject')" /><span><strong>Reject</strong>It stays suspended.</span></label>
          <div><label class="f-label" for="ap-note">Note@if (decision() === 'reject') { <span class="req">*</span>}</label><textarea id="ap-note" class="f-input" rows="2" maxlength="500" [value]="note()" (input)="note.set($any($event.target).value)"></textarea></div>
        </section>
      }
      @case ('settlement') {
        <section class="sheet-section">
          <div><label class="f-label" for="st-note">Note@if (decision() === 'keep') { <span class="req">*</span>} @else { (optional)}</label><textarea id="st-note" class="f-input" rows="2" maxlength="500" [value]="note()" (input)="note.set($any($event.target).value)"></textarea></div>
        </section>
      }
    }

    @if (error(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
  </div>

  @if (codeAsk()) {
    <app-code-prompt title="Confirm it's you" message="Enter a code from your authenticator app." [confirmLabel]="confirmLabel()" [tone]="tone()" [busy]="busy()" [error]="codeError()" (confirmed)="submit($event)" (cancelled)="codeAsk.set(false)" />
  } @else if (mode() !== 'view' && !makerBlock()) {
    <footer class="sheet-foot">
      <span class="sheet-foot-note">{{ footNote() }}</span>
      @if (mode() === 'settlement') {
        <button type="button" class="btn danger-outline" (click)="decision.set('keep'); submit()" [disabled]="busy()">Keep on hold</button>
        <button type="button" class="btn primary" (click)="decision.set('release'); submit()" [disabled]="busy()">Release settlement</button>
      } @else {
        <button type="button" class="btn" (click)="dismiss()" [disabled]="busy()">Cancel</button>
        <button type="button" class="btn" [class.primary]="tone() === 'primary'" [class.danger]="tone() === 'danger'" (click)="submit()" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}{{ confirmLabel() }}</button>
      }
    </footer>
  } @else if (mode() === 'view') {
    <footer class="sheet-foot"><span class="sheet-foot-note"></span><button type="button" class="btn primary" (click)="closed.emit()">Close</button></footer>
  }
</app-side-sheet>
  `,
  styles: `
    .sus-opt { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; }
    .sus-opt.on { border-color: var(--mobi-blue); background: var(--info-bg); }
    .sus-opt strong { display: block; }
    .sus-controls { display: grid; gap: 8px; }
    .sus-ctl { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; }
    .sus-ctl strong { display: block; font-size: 13px; }
    .sus-ctl span span { font-size: 12px; color: var(--text-muted); }
    .sus-tag { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 5px; background: var(--mobi-blue-tint); color: var(--mobi-blue) !important; font-size: 11px !important; font-weight: 700; }
    .sus-held { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
  `,
})
export class SuspensionSheet implements OnInit {
  private readonly api = inject(MerchantApi);
  private readonly txns = inject(TransactionsApi);
  private readonly auth = inject(AuthService);
  protected readonly roles = inject(StaffRoleService);
  private readonly prompt = viewChild(CodePrompt);

  readonly suspension = input.required<SuspensionView>();
  readonly detail = input.required<MerchantDetail>();
  readonly mode = input<SuspensionMode>('view');
  readonly done = output<string>();
  readonly closed = output<void>();

  protected readonly typeLabel = SUSPENSION_TYPE_LABEL;
  protected readonly outcomes = REACTIVATION_OUTCOMES;
  protected readonly money = fmtMoney;
  protected readonly when = (t: number) => fmtDateTime(t);

  protected readonly decision = signal<'confirm' | 'lift' | 'approve' | 'reject' | 'release' | 'keep'>('confirm');
  protected readonly note = signal('');
  protected readonly outcome = signal<string>(REACTIVATION_OUTCOMES[0]);
  protected readonly release = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly codeAsk = signal(false);
  protected readonly codeError = signal<string | null>(null);
  protected readonly held = signal<CurrencyAmount[]>([]);

  protected readonly fraud = computed(() => isFraudType(this.suspension().type));
  private readonly what = computed(() => (this.suspension().scope === 'sub_merchant' ? 'sub-merchant' : this.suspension().scope === 'country' ? 'country' : 'merchant'));
  protected readonly heading = computed(() => {
    switch (this.mode()) {
      case 'review':
        return 'Suspension review';
      case 'reactivate':
        return `Reactivate ${this.what()}`;
      case 'approve':
        return 'Reactivation';
      case 'settlement':
        return 'Settlement release';
      default:
        return this.suspension().status === 'active' ? `Suspended ${this.what()}` : `Suspension (lifted)`;
    }
  });
  protected readonly eyebrow = computed(() => (this.mode() === 'settlement' ? 'FinOps action' : this.mode() === 'view' ? 'Suspension' : 'Risk action'));
  protected readonly scopeText = computed(() => {
    const s = this.suspension();
    return s.scope === 'merchant' ? SUSPENSION_SCOPE_LABEL.merchant : s.scope === 'country' ? `One country · ${s.countryName}` : `One sub-merchant · ${s.subMerchantName}`;
  });
  protected readonly chips = computed(() => CONTROL_KEYS.filter((k) => this.suspension().controls[k]).map((k) => CONTROL_CHIP[k]).join(' · ') || 'None (onboarding on hold only)');
  protected readonly settlementText = computed(() => ({ not_held: 'Not held', held: 'On hold', release_pending: 'Release waiting for FinOps', released: 'Released' })[this.suspension().settlement.status]);
  protected readonly reviewText = computed(() => {
    const r = this.suspension().review;
    if (r.status === 'pending') return `Waiting · due ${r.dueAt ? this.when(r.dueAt) : ''}`;
    if (r.status === 'confirmed') return `Confirmed by ${r.by}`;
    if (r.status === 'lifted') return `Lifted by ${r.by}`;
    return r.required ? 'Not done (reactivated first)' : 'Not needed';
  });
  /** Sub-merchants with their own suspension stay suspended when the merchant or country is reactivated. */
  protected readonly ownSubSuspensions = computed(() => {
    const s = this.suspension();
    if (s.scope === 'sub_merchant') return [];
    return this.detail()
      .suspensions.filter((x) => x.id !== s.id && x.status === 'active' && x.scope === 'sub_merchant' && (s.scope === 'merchant' || x.country === s.country))
      .map((x) => ({ id: x.id, name: x.subMerchantName ?? '', why: `${VIA_LABEL.sub_merchant} · ${SUSPENSION_TYPE_LABEL[x.type]}` }));
  });
  /** Maker ≠ checker: the person who raised it can't review it, and who asked for a reactivation can't approve it. */
  protected readonly makerBlock = computed(() => {
    const me = this.auth.session()?.user.id;
    const s = this.suspension();
    if (this.mode() === 'review' && s.createdById === me) return 'You raised this suspension, so another Risk reviewer must review it. It stays in effect while it waits.';
    if (this.mode() === 'approve' && s.reactivation?.requestedById === me) return 'You asked for this reactivation, so another Risk reviewer must approve it.';
    return null;
  });
  protected readonly confirmLabel = computed(() => {
    switch (this.mode()) {
      case 'review':
        return this.decision() === 'lift' ? 'Lift suspension' : 'Confirm suspension';
      case 'reactivate':
        return this.fraud() ? 'Submit for approval' : `Reactivate ${this.what()}`;
      case 'approve':
        return this.decision() === 'reject' ? 'Reject' : 'Approve';
      case 'settlement':
        return this.decision() === 'keep' ? 'Keep on hold' : 'Release settlement';
      default:
        return 'Confirm';
    }
  });
  protected readonly tone = computed<'primary' | 'danger'>(() => (this.decision() === 'reject' || this.decision() === 'keep' ? 'danger' : 'primary'));
  protected readonly footNote = computed(() => (this.mode() === 'reactivate' && this.fraud() ? 'Goes to Approvals · Waiting for Risk' : ''));

  protected readonly activity = computed(() => {
    const s = this.suspension();
    const out: { title: string; meta: string; note?: string | null; waiting?: boolean; bad?: boolean }[] = [{ title: `Suspended · ${SUSPENSION_TYPE_LABEL[s.type]}`, meta: `${s.createdBy} · ${this.when(s.createdAt)}`, bad: true }];
    const r = s.review;
    if (r.status === 'pending') out.push({ title: 'Second Risk review', meta: `Waiting · due ${r.dueAt ? this.when(r.dueAt) : ''}`, waiting: true });
    else if (r.status === 'confirmed' || r.status === 'lifted') out.push({ title: r.status === 'confirmed' ? 'Suspension confirmed' : 'Lifted at review', meta: `${r.by} · ${r.at ? this.when(r.at) : ''}`, note: r.note });
    const a = s.reactivation;
    if (a && r.status !== 'lifted') {
      out.push({ title: 'Reactivation requested', meta: `${a.requestedBy} · ${this.when(a.requestedAt)} · ${a.outcome}`, note: a.reason });
      if (a.status === 'pending') out.push({ title: 'Waiting for a second Risk approval', meta: 'It stays suspended until then.', waiting: true });
      else if (a.decidedBy && a.decidedBy !== a.requestedBy) out.push({ title: a.status === 'approved' ? 'Reactivation approved' : 'Reactivation rejected', meta: `${a.decidedBy} · ${a.decidedAt ? this.when(a.decidedAt) : ''}`, note: a.note, bad: a.status === 'rejected' });
    }
    if (s.settlement.status === 'release_pending') out.push({ title: 'Settlement release', meta: 'Waiting for FinOps', waiting: true });
    else if (s.settlement.decidedAt) out.push({ title: s.settlement.status === 'released' ? 'Settlement released' : 'Settlement kept on hold', meta: `${s.settlement.decidedBy} · ${this.when(s.settlement.decidedAt)}`, note: s.settlement.note });
    return out;
  });

  ngOnInit() {
    const m = this.mode();
    this.decision.set(m === 'approve' ? 'approve' : m === 'settlement' ? 'release' : 'confirm');
    const s = this.suspension();
    if (s.settlement.status !== 'not_held') {
      // Sample held amount: successful pay-ins since the suspension (≤ 93 days).
      const from = new Date(Math.max(s.createdAt, Date.now() - 92 * 86_400_000)).toISOString();
      this.txns
        .list('payin', { merchant: s.gmid, status: 'successful', range: 'custom', from, to: new Date().toISOString(), country: s.scope === 'merchant' ? '' : (s.country ?? ''), pageSize: 10 })
        .then((r) => this.held.set(r.summary.byStatus.successful.amounts))
        .catch(() => this.held.set([]));
    }
  }

  protected dismiss() {
    if (this.busy()) return;
    if (this.codeAsk()) return this.codeAsk.set(false);
    this.closed.emit();
  }

  protected async submit(code?: string) {
    const s = this.suspension();
    const note = this.note().trim();
    const m = this.mode();
    if ((m === 'review' || m === 'reactivate') && note.length < 5) return this.error.set(m === 'review' ? 'Enter a review note with at least 5 characters.' : 'Enter a reason with at least 5 characters.');
    if ((this.decision() === 'reject' || this.decision() === 'keep') && note.length < 5) return this.error.set('Enter a reason with at least 5 characters.');
    const c = code ? { code } : {};
    const [step, body, message] =
      m === 'review'
        ? (['review', { decision: this.decision(), note, ...c }, this.decision() === 'lift' ? 'Suspension lifted' : 'Suspension confirmed'] as const)
        : m === 'reactivate'
          ? (['reactivation', { outcome: this.outcome(), reason: note, releaseSettlement: this.release(), ...c }, this.fraud() ? 'Reactivation sent for approval' : 'Reactivated'] as const)
          : m === 'approve'
            ? (['reactivation/decision', { decision: this.decision(), note, ...c }, this.decision() === 'approve' ? 'Reactivation approved' : 'Reactivation rejected'] as const)
            : (['settlement', { decision: this.decision(), note, ...c }, this.decision() === 'release' ? 'Settlement released' : 'Settlement kept on hold'] as const);
    this.busy.set(true);
    this.error.set(null);
    this.codeError.set(null);
    try {
      await this.api.suspensionAction(s.id, step, body);
      this.codeAsk.set(false);
      this.done.emit(message);
    } catch (e) {
      const err = toMerchantError(e) as { code?: string; message?: string; attemptsRemaining?: number };
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
