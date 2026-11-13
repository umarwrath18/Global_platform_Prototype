import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal, viewChild } from '@angular/core';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { MerchantDetail } from '../../core/merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import {
  CONTROL_CHIP,
  CONTROL_HINT,
  CONTROL_KEYS,
  CONTROL_LABEL,
  DEFAULT_CONTROLS,
  DETECTED_BY,
  isFraudType,
  MERCHANT_REVIEW_MESSAGE,
  MERCHANT_REVIEW_TITLE,
  needsCaseRef,
  PaymentControls,
  portalReadOnly,
  SALES_SUSPENSION_TYPES,
  SuspensionScope,
  SuspensionType,
  SUSPENSION_TYPE_LABEL,
  SUSPENSION_TYPES,
} from '../../core/merchants/suspensions';
import { fmtDateTime, fmtMoney, TxnListRow } from '../../core/transactions/transactions';
import { TransactionsApi } from '../../core/transactions/transactions-api.service';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';

/**
 * Suspend a merchant, one of its countries, or one sub-merchant (docs/merchant-suspension.md):
 * type, scope, payment controls, case, reason, linked transactions, what happens now, and the
 * neutral message the merchant gets. Asks for an authenticator code before it takes effect.
 */
@Component({
  selector: 'app-suspend-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SideSheet, CodePrompt],
  template: `
@let d = detail();
<app-side-sheet size="editor" [label]="title()" (dismiss)="dismiss()">
  <header class="sheet-head">
    <div class="sheet-titles">
      <p class="sheet-eyebrow">{{ roles.role() === 'risk' ? 'Risk action' : 'Sales / Ops action' }}</p>
      <h2 class="sheet-title">{{ title() }}</h2>
      <p class="sheet-sub">{{ d.merchant.legalName }} · {{ d.merchant.id }}</p>
    </div>
    <button type="button" class="sheet-close" (click)="dismiss()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
  </header>

  <div class="sheet-body">
    <div>
      <label class="f-label" for="sus-type">Suspension type <span class="req">*</span></label>
      <select id="sus-type" class="f-input" (change)="setType($any($event.target).value)">
        @for (t of types(); track t) {<option [value]="t" [selected]="t === type()">{{ typeLabel[t] }}</option>}
      </select>
      <p class="f-hint">{{ roles.role() === 'risk' ? 'Fraud types take effect at once and need a second Risk review within 24 hours.' : 'Sales / Ops can suspend for commercial reasons or at the merchant’s request. Risk handles fraud and compliance.' }}</p>
    </div>

    <section class="sheet-section">
      <h3>Scope</h3>
      <div class="sus-options" role="radiogroup" aria-label="Scope">
        <label class="sus-opt" [class.on]="scope() === 'merchant'">
          <input type="radio" name="sus-scope" [checked]="scope() === 'merchant'" (change)="scope.set('merchant')" />
          <span><strong>Whole merchant</strong>All countries ({{ countryList() }}) and all sub-merchants</span>
        </label>
        <label class="sus-opt" [class.on]="scope() === 'country'">
          <input type="radio" name="sus-scope" [checked]="scope() === 'country'" (change)="scope.set('country')" />
          <span><strong>One country</strong>That country's MID and its sub-merchants</span>
        </label>
        @if (scope() === 'country') {
          <select class="f-input sus-pick" aria-label="Country" (change)="country.set($any($event.target).value)">
            @for (c of liveCountries(); track c) {<option [value]="c" [selected]="c === country()">{{ countryName(c) }}</option>}
          </select>
        }
        <label class="sus-opt" [class.on]="scope() === 'sub_merchant'" [class.disabled]="!subs().length">
          <input type="radio" name="sus-scope" [disabled]="!subs().length" [checked]="scope() === 'sub_merchant'" (change)="scope.set('sub_merchant')" />
          <span><strong>One sub-merchant</strong>{{ subs().length ? 'Only that sub-merchant' : 'This merchant has no sub-merchants' }}</span>
        </label>
        @if (scope() === 'sub_merchant') {
          <select class="f-input sus-pick" aria-label="Sub-merchant" (change)="subId.set($any($event.target).value)">
            @for (s of subs(); track s.id) {<option [value]="s.id" [selected]="s.id === subId()">{{ s.displayName }} · {{ countryName(s.country) }}</option>}
          </select>
        }
      </div>
    </section>

    <section class="sheet-section">
      <h3>Payment controls</h3>
      <div class="sus-controls">
        @for (k of controlKeys; track k) {
          <label class="sus-ctl">
            <input type="checkbox" [checked]="controls()[k]" (change)="toggle(k, $any($event.target).checked)" />
            <span><strong>{{ controlLabel[k] }}</strong><span>{{ controlHint[k] }}</span></span>
          </label>
        }
      </div>
      <p class="f-hint">{{ readOnly() ? 'Merchant Portal becomes read only (no exports).' : 'The merchant can still use the Merchant Portal.' }}</p>
    </section>

    <div class="sus-grid">
      <div>
        <label class="f-label" for="sus-case">Case reference@if (caseRequired()) { <span class="req">*</span>}</label>
        <input id="sus-case" class="f-input" maxlength="40" [value]="caseRef()" (input)="caseRef.set($any($event.target).value)" placeholder="e.g. RISK-2026-0142" />
      </div>
      <div>
        <label class="f-label" for="sus-detected">Detected by</label>
        <select id="sus-detected" class="f-input" (change)="detectedBy.set($any($event.target).value)">
          @for (x of detected; track x) {<option [value]="x" [selected]="x === detectedBy()">{{ x }}</option>}
        </select>
      </div>
    </div>

    <div>
      <label class="f-label" for="sus-reason">Reason <span class="req">*</span></label>
      <textarea id="sus-reason" class="f-input" rows="3" maxlength="500" [value]="reason()" (input)="reason.set($any($event.target).value)"></textarea>
      <p class="f-hint">Internal only. The merchant never sees it.</p>
    </div>

    <section class="sheet-section">
      <h3>Linked transactions <span class="sus-muted">(from Transactions flagged Under investigation)</span></h3>
      @if (flagged().length) {
        <div class="table-wrap">
          <table class="data-table txn-mini">
            <thead><tr><th scope="col"><span class="sr-only">Link</span></th><th scope="col">Transaction ID</th><th scope="col">Method</th><th scope="col">Amount</th><th scope="col">Created</th></tr></thead>
            <tbody>
              @for (t of flagged(); track t.transactionId) {
                <tr>
                  <td><input type="checkbox" [attr.aria-label]="'Link ' + t.transactionId" [checked]="linked().includes(t.transactionId)" (change)="link(t.transactionId, $any($event.target).checked)" /></td>
                  <td class="mono">{{ t.transactionId }}</td>
                  <td>{{ t.methodName }}</td>
                  <td>{{ money(t.amount, t.currency) }}</td>
                  <td class="muted">{{ when(t.createdAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <p class="sus-muted">No transactions of this merchant are flagged Under investigation in the last 30 days.</p>
      }
    </section>

    <div class="sus-impact" role="note">
      <h3>What happens now</h3>
      <ul>@for (line of impact(); track line) {<li>{{ line }}</li>}</ul>
    </div>

    @if (anyControl()) {
      <section class="sheet-section">
        <h3>Message to the merchant</h3>
        <div class="sus-msg"><strong>{{ reviewTitle }}</strong><p>{{ reviewMessage }}</p></div>
        <p class="f-hint">The same neutral message for every type. It never mentions fraud.</p>
      </section>
    }

    @if (error(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
  </div>

  @if (codeAsk()) {
    <app-code-prompt title="Confirm it's you" message="Enter a code from your authenticator app to suspend." [confirmLabel]="title()" tone="danger" [busy]="busy()" [error]="codeError()" (confirmed)="submit($event)" (cancelled)="codeAsk.set(false)" />
  } @else {
    <footer class="sheet-foot">
      <span class="sheet-foot-note">Takes effect immediately.</span>
      <button type="button" class="btn" (click)="dismiss()" [disabled]="busy()">Cancel</button>
      <button type="button" class="btn danger" (click)="submit()" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}{{ title() }}</button>
    </footer>
  }
</app-side-sheet>
  `,
  styles: `
    .sus-options { display: grid; gap: 8px; }
    .sus-opt { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; }
    .sus-opt.on { border-color: var(--mobi-blue); background: var(--info-bg); }
    .sus-opt.disabled { opacity: 0.6; cursor: not-allowed; }
    .sus-opt strong { display: block; }
    .sus-pick { margin-left: 28px; width: calc(100% - 28px); }
    .sus-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .sus-ctl { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; }
    .sus-ctl strong { display: block; font-size: 13px; }
    .sus-ctl span span { font-size: 12px; color: var(--text-muted); }
    .sus-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .sus-impact { border: 1px solid var(--danger-border); background: var(--danger-bg); border-radius: 12px; padding: 14px 16px; }
    .sus-impact h3 { margin: 0 0 8px; font-size: 14px; color: var(--danger); }
    .sus-impact ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
    .sus-msg { border: 1px dashed var(--border-strong); border-radius: 10px; padding: 12px 14px; background: #fbfcfe; }
    .sus-msg p { margin: 4px 0 0; }
    .sus-muted { font-weight: 400; color: var(--text-muted); font-size: 13px; margin: 0; }
    @media (max-width: 600px) { .sus-controls, .sus-grid { grid-template-columns: minmax(0, 1fr); } }
  `,
})
export class SuspendSheet implements OnInit {
  private readonly api = inject(MerchantApi);
  private readonly txns = inject(TransactionsApi);
  protected readonly roles = inject(StaffRoleService);
  private readonly prompt = viewChild(CodePrompt);

  readonly detail = input.required<MerchantDetail>();
  /** Opened from a sub-merchant row: scope pre-selected. */
  readonly preset = input<{ scope?: SuspensionScope; subMerchantId?: string | null; country?: string | null } | null>(null);
  readonly done = output<string>();
  readonly closed = output<void>();

  protected readonly typeLabel = SUSPENSION_TYPE_LABEL;
  protected readonly controlKeys = CONTROL_KEYS;
  protected readonly controlLabel = CONTROL_LABEL;
  protected readonly controlHint = CONTROL_HINT;
  protected readonly detected = DETECTED_BY;
  protected readonly reviewTitle = MERCHANT_REVIEW_TITLE;
  protected readonly reviewMessage = MERCHANT_REVIEW_MESSAGE;
  protected readonly money = fmtMoney;
  protected readonly when = (t: number) => fmtDateTime(t);
  protected readonly countryName = (c: string | null | undefined) => (c ? (ONBOARDING_COUNTRIES[c]?.name ?? c) : '');

  protected readonly types = computed<SuspensionType[]>(() => (this.roles.role() === 'risk' ? SUSPENSION_TYPES : SALES_SUSPENSION_TYPES));
  protected readonly type = signal<SuspensionType>('suspected_fraud');
  protected readonly scope = signal<SuspensionScope>('merchant');
  protected readonly country = signal('');
  protected readonly subId = signal('');
  protected readonly controls = signal<PaymentControls>({ ...DEFAULT_CONTROLS.suspected_fraud });
  protected readonly caseRef = signal('');
  protected readonly detectedBy = signal<string>('Transaction monitoring');
  protected readonly reason = signal('');
  protected readonly linked = signal<string[]>([]);
  protected readonly flagged = signal<TxnListRow[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly codeAsk = signal(false);
  protected readonly codeError = signal<string | null>(null);

  protected readonly liveCountries = computed(() => this.detail().applications.filter((a) => a.status === 'operational').map((a) => a.country));
  protected readonly countryList = computed(() => this.liveCountries().map((c) => this.countryName(c)).join(', '));
  protected readonly subs = computed(() => this.detail().subMerchants.filter((s) => s.status !== 'rejected'));
  protected readonly caseRequired = computed(() => needsCaseRef(this.type()));
  protected readonly readOnly = computed(() => portalReadOnly(this.type()));
  protected readonly anyControl = computed(() => CONTROL_KEYS.some((k) => this.controls()[k]));
  protected readonly title = computed(() => (this.scope() === 'sub_merchant' ? 'Suspend sub-merchant' : this.scope() === 'country' ? 'Suspend country' : 'Suspend merchant'));

  protected readonly impact = computed(() => {
    const d = this.detail();
    const out: string[] = [];
    if (this.scope() === 'merchant') {
      const live = this.liveCountries();
      const subs = d.subMerchants.filter((s) => s.status === 'live').length;
      out.push(`${live.length} MID${live.length === 1 ? '' : 's'} suspended (${this.countryList()})${subs ? ` and ${subs} sub-merchant${subs === 1 ? '' : 's'} with them` : ''}`);
      out.push('New country applications, go-live and sub-merchants are on hold');
    } else if (this.scope() === 'country') {
      const subs = d.subMerchants.filter((s) => s.status === 'live' && s.country === this.country()).length;
      out.push(`${this.countryName(this.country())} MID suspended${subs ? ` and ${subs} sub-merchant${subs === 1 ? '' : 's'} with it` : ''}`);
    } else {
      out.push(`${this.subs().find((s) => s.id === this.subId())?.displayName ?? 'The sub-merchant'} suspended; the merchant and its other sub-merchants are not affected`);
    }
    const chips = CONTROL_KEYS.filter((k) => this.controls()[k]).map((k) => CONTROL_CHIP[k]);
    out.push(chips.length ? chips.join(' · ') : 'No payment controls: transactions and settlement continue');
    if (this.readOnly()) out.push('Merchant Portal: read only, no exports');
    out.push('Risk, Sales / Ops, CS, FinOps and Mobi Support notified');
    if (isFraudType(this.type())) out.push('Second Risk review due within 24 hours');
    return out;
  });

  ngOnInit() {
    if (this.roles.role() !== 'risk') this.setType('commercial');
    const p = this.preset();
    this.country.set(p?.country ?? this.liveCountries()[0] ?? '');
    this.subId.set(p?.subMerchantId ?? this.subs()[0]?.id ?? '');
    if (p?.scope) this.scope.set(p.scope);
    // Transactions flagged Under investigation (PayIn and Payout), to link to the case.
    const q = { merchant: this.detail().merchant.id, flag: 'investigation', range: '30d', pageSize: 50 };
    Promise.all([this.txns.list('payin', q), this.txns.list('payout', q)])
      .then(([a, b]) => this.flagged.set([...a.items, ...b.items].sort((x, y) => y.createdAt - x.createdAt)))
      .catch(() => this.flagged.set([]));
  }

  protected setType(t: SuspensionType) {
    this.type.set(t);
    this.controls.set({ ...DEFAULT_CONTROLS[t] });
    if (t === 'merchant_request') this.detectedBy.set('Merchant request');
    else if (t === 'commercial' || t === 'compliance') this.detectedBy.set('Internal review');
    else this.detectedBy.set('Transaction monitoring');
  }

  protected toggle(k: keyof PaymentControls, on: boolean) {
    this.controls.update((c) => ({ ...c, [k]: on }));
  }

  protected link(id: string, on: boolean) {
    this.linked.update((l) => (on ? [...l, id] : l.filter((x) => x !== id)));
  }

  protected dismiss() {
    if (this.busy()) return;
    if (this.codeAsk()) return this.codeAsk.set(false);
    this.closed.emit();
  }

  protected async submit(code?: string) {
    if (this.caseRequired() && !this.caseRef().trim()) return this.error.set('Enter a case reference.');
    if (this.reason().trim().length < 5) return this.error.set('Enter a reason with at least 5 characters.');
    this.busy.set(true);
    this.error.set(null);
    this.codeError.set(null);
    try {
      const s = await this.api.suspend(this.detail().merchant.id, {
        type: this.type(),
        scope: this.scope(),
        country: this.scope() === 'country' ? this.country() : null,
        subMerchantId: this.scope() === 'sub_merchant' ? this.subId() : null,
        controls: this.controls(),
        caseRef: this.caseRef().trim(),
        detectedBy: this.detectedBy(),
        reason: this.reason().trim(),
        linkedTransactions: this.linked(),
        ...(code ? { code } : {}),
      });
      this.codeAsk.set(false);
      this.done.emit(s.scope === 'sub_merchant' ? `${s.subMerchantName} suspended` : s.scope === 'country' ? `${s.merchantName} suspended in ${s.countryName}` : `${s.merchantName} suspended`);
    } catch (e) {
      const err = toMerchantError(e) as { code?: string; message?: string; attemptsRemaining?: number };
      const mfa = this.codeAsk() ? codeProblem(err.code, err.attemptsRemaining) : null;
      if (err.code === 'MFA_CODE_REQUIRED') this.codeAsk.set(true);
      else if (mfa) {
        this.codeError.set(mfa);
        this.prompt()?.reset();
      } else {
        this.codeAsk.set(false);
        this.error.set(err.message ?? "We couldn't suspend.");
      }
    } finally {
      this.busy.set(false);
    }
  }
}
