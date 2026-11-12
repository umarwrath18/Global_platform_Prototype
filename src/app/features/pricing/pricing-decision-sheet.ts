import { ChangeDetectionStrategy, Component, inject, input, OnDestroy, OnInit, output, signal } from '@angular/core';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import {
  FLOW_LABEL,
  fmtDay,
  METRIC_SHORT,
  money,
  PRICING_STATUS_LABEL,
  PRICING_STATUS_TONE,
  PricingApprovalItem,
  PricingStatus,
  PROMO_TYPE_LABEL,
  REFERENCE_PERIOD_LABEL,
  secondarySummary,
  techniqueLabel,
  VA_BANKS,
  pricingShort,
} from '../../core/merchants/products';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';
import { fmtDateTime } from '../../shared/merchant-ui';
import { codeProblem } from '../../shared/code-prompt';
import { DemoAuthenticatorService } from '../../shared/demo-authenticator';

/**
 * Pricing Detail with the FinOps decision (§7.8, §8.7), in a side sheet: what changes, the full
 * configuration, then Approve or Reject inside the sheet with a current authenticator code. The
 * server enforces FinOps only and maker ≠ checker. Used by the Approvals inbox.
 */
@Component({
  selector: 'app-pricing-decision-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SideSheet],
  template: `
@let i = item();
@let x = i.version;
      <app-side-sheet label="Pricing Detail" (dismiss)="dismissDetail()">
        <header class="sheet-head">
          <div class="sheet-titles">
            <p class="sheet-eyebrow">Pricing Detail</p>
            <h2 class="sheet-title">{{ i.methodName }} · v{{ x.version }} <span class="status" [class]="'status ' + tone[x.status]">{{ statusLabel[x.status] }}</span></h2>
            <p class="sheet-sub">{{ i.merchantName }} · {{ i.subMerchantName ?? 'Master Merchant' }} · {{ flowLabel[x.flow] }}</p>
          </div>
          <button type="button" class="sheet-close" (click)="dismissDetail()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
        </header>
        <div class="sheet-body">
          @if (x.version > 1 && x.status === 'pending_approval') {
            <div class="alert info compact" role="note"><app-icon name="info" /><div>This is v{{ x.version }} – a modified version of the previous configuration. Approving this will supersede the previous version.</div></div>
          }
          @if (x.status === 'pending_approval') {
            <section class="sheet-section">
              <h3>What changes</h3>
              <div class="sheet-compare">
                <div class="row head"><span></span><span>Current</span><span>New · v{{ x.version }}</span></div>
                <div class="row"><span class="k">Rate</span><span class="was">{{ i.current ?? 'No pricing configured' }}</span><span class="now">{{ newRate(i) }}</span></div>
                <div class="row"><span class="k">Effective</span><span class="was">Until approved</span><span class="now">{{ day(x.startDate) }} – {{ x.endDate ? day(x.endDate) : 'No end date' }}</span></div>
              </div>
            </section>
          }
          <section class="sheet-section">
            <h3>Details</h3>
            <dl class="sheet-dl">
            <div><dt>Merchant</dt><dd>{{ i.merchantName }}</dd></div>
            <div><dt>Sub-Merchant</dt><dd>{{ i.subMerchantName ?? 'Master Merchant' }}</dd></div>
            <div><dt>Corridor</dt><dd>{{ i.countryName }}</dd></div>
            <div><dt>Flow Type</dt><dd>{{ flowLabel[x.flow] }}</dd></div>
            <div><dt>Payment Method</dt><dd>{{ i.methodName }}</dd></div>
            @if (vaText(i); as va) {<div><dt>VA Banks</dt><dd>{{ va }}</dd></div>}
            <div><dt>Pricing Technique</dt><dd>{{ technique(x.technique) }}</dd></div>
            <div><dt>Version</dt><dd>v{{ x.version }}</dd></div>
            <div><dt>Created By</dt><dd>{{ x.createdBy }} · {{ dateTime(x.createdAt) }}</dd></div>
            @if (x.technique === null) {
              <div class="wide"><dt>Configuration</dt><dd>No Primary Pricing Method configured; only Subscription Fees will be applied.</dd></div>
            } @else if (x.usd; as u) {
              <div><dt>Fixed Fee per Transaction (USD)</dt><dd>USD {{ u.fixedFeeUsd }}</dd></div>
              <div><dt>{{ u.localEquivalentCurrency }} Equivalent</dt><dd>{{ money(u.localEquivalent, u.localEquivalentCurrency) }}</dd></div>
              <div><dt>Exchange Rate Used</dt><dd>{{ u.usdExchangeRate }} {{ u.localEquivalentCurrency }}/USD</dd></div>
            } @else if (x.historical; as h) {
              <div><dt>Reference Period</dt><dd>{{ refLabel[h.referencePeriod] }}</dd></div>
              <div><dt>Evaluation Metric</dt><dd>{{ metricLabel[h.evaluationMetric] }}</dd></div>
              <div><dt>Volume Threshold</dt><dd>{{ h.thresholdDirection }} {{ money(h.volumeThreshold, x.currency) }}</dd></div>
              <div><dt>Resulting MDR</dt><dd>{{ h.resultingMdr }}%</dd></div>
              <div><dt>Default MDR</dt><dd>{{ h.defaultMdr }}%</dd></div>
            } @else {
              @if (x.mdrPct !== null) {<div><dt>MDR / Percentage</dt><dd>{{ x.mdrPct }}%</dd></div>}
              @if (x.fixedFee !== null) {<div><dt>Fixed Fee</dt><dd>{{ money(x.fixedFee, x.currency) }}</dd></div>}
              @if (x.minimumFee) {<div><dt>Minimum Fee</dt><dd>{{ money(x.minimumFee, x.currency) }}</dd></div>}
              <div><dt>Currency</dt><dd>{{ x.currency }}</dd></div>
            }
            @if (x.tiers?.length) {
              <div class="wide"><dt>Volume Tiers</dt><dd>@for (t of x.tiers; track $index) {<div>{{ t.minVolume }} – {{ t.maxVolume ?? 'No limit' }}: {{ t.mdrPct }}%@if (t.fixedFee) { + {{ money(t.fixedFee, x.currency) }}}</div>}</dd></div>
            }
            @if (x.subscription || x.promotion) {
              <div class="wide"><dt>Secondary Charges</dt><dd>
                @if (x.subscription; as s) {<div>Subscription: {{ s.currency }} {{ s.monthlyFee }}/month</div>}
                @if (x.promotion; as p) {<div>Promotional ({{ promoLabel[p.type] }}): MDR override to {{ p.mdrPct }}%</div>}
              </dd></div>
            }
            <div class="wide"><dt>Effective Period</dt><dd>{{ day(x.startDate) }} – {{ x.endDate ? day(x.endDate) : 'No end date' }}</dd></div>
            @if (i.current) {<div class="wide"><dt>Current pricing</dt><dd>{{ i.current }}</dd></div>}
            @if (x.rejectionReason) {<div class="wide"><dt>Rejection reason</dt><dd>{{ x.rejectionReason }}</dd></div>}
          </dl>
          </section>
          @if (x.status === 'pending_approval' && canDecide() && i.ownSubmission) {
            <p class="pa-own">You submitted this change, so someone else must approve it.</p>
          }
        </div>
        @if (dialog(); as d) {
          <div class="sheet-confirm" role="group" aria-labelledby="pa-title">
            <h3 id="pa-title">{{ d.decision === 'approve' ? 'Approve v' + x.version : 'Reject v' + x.version }}</h3>
            @if (d.decision === 'reject') {
              <label class="f-label" for="pa-reason">Provide a reason for rejecting this pricing configuration.</label>
              <textarea id="pa-reason" class="f-input pa-reason" rows="3" maxlength="1000" placeholder="Enter rejection reason..." [value]="reason()" (input)="reason.set($any($event.target).value)"></textarea>
            } @else {
              <p>v{{ x.version }} takes effect on {{ day(x.startDate) }}{{ x.version > 1 ? ' and supersedes the previous version' : '' }}.</p>
            }
            <label class="f-label" for="pa-code">Confirm it's you: enter the code from your authenticator app</label>
            <input id="pa-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" [attr.aria-invalid]="!!dialogError() || null" (input)="setCode($any($event.target).value, $any($event.target))" (keydown.enter)="confirm()" />
            @if (dialogError(); as e) {<p class="f-error" role="alert"><app-icon name="alert-circle" [size]="16" />{{ e }}</p>}
            <div class="sheet-confirm-actions">
              <button type="button" class="btn" (click)="close()" [disabled]="busy()">Back</button>
              <button type="button" class="btn" [class.primary]="d.decision === 'approve'" [class.danger]="d.decision === 'reject'" (click)="confirm()" [disabled]="busy() || code().length !== 6 || (d.decision === 'reject' && !reason().trim())">
                @if (busy()) {<span class="spinner" aria-hidden="true"></span>}{{ d.decision === 'approve' ? 'Confirm approval' : 'Reject' }}
              </button>
            </div>
          </div>
        } @else {
          <footer class="sheet-foot">
            <span class="sheet-foot-note">{{ x.createdBy }} · {{ dateTime(x.createdAt) }}</span>
            @if (x.status === 'pending_approval' && canDecide() && !i.ownSubmission) {
              <button type="button" class="btn danger-outline" (click)="open(i, 'reject')">Reject</button>
              <button type="button" class="btn primary" (click)="open(i, 'approve')">Approve</button>
            } @else {
              <button type="button" class="btn primary" (click)="dismissDetail()">Close</button>
            }
          </footer>
        }
      </app-side-sheet>
  `,
  styleUrl: './pricing.scss',
})
export class PricingDecisionSheet implements OnInit, OnDestroy {
  private readonly api = inject(MerchantApi);
  readonly item = input.required<PricingApprovalItem>();
  readonly canDecide = input(false);
  /** Open straight at Approve or Reject (row action). */
  readonly startWith = input<'approve' | 'reject' | null>(null);
  readonly decided = output<{ decision: 'approve' | 'reject'; text: string }>();
  readonly failed = output<string>();
  readonly closed = output<void>();

  protected readonly dialog = signal<{ item: PricingApprovalItem; decision: 'approve' | 'reject' } | null>(null);
  protected readonly reason = signal('');
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly dialogError = signal<string | null>(null);

  protected readonly flowLabel = FLOW_LABEL;
  protected readonly technique = techniqueLabel;
  protected readonly statusLabel = { ...PRICING_STATUS_LABEL, pending_approval: 'Pending Approval' } as Record<PricingStatus, string>;
  protected readonly tone = PRICING_STATUS_TONE;
  protected readonly day = fmtDay;
  protected readonly dateTime = fmtDateTime;
  protected readonly money = money;
  protected readonly refLabel = REFERENCE_PERIOD_LABEL;
  protected readonly metricLabel = METRIC_SHORT;
  protected readonly promoLabel = PROMO_TYPE_LABEL;

  private readonly restore: () => void;

  constructor() {
    // The demo authenticator shows the signed-in user's code, for the re-authentication step.
    const demo = inject(DemoAuthenticatorService);
    const before = demo.sessionWanted();
    demo.sessionWanted.set(true);
    this.restore = () => demo.sessionWanted.set(before);
  }

  ngOnInit() {
    const s = this.startWith();
    if (s) this.open(this.item(), s);
  }

  ngOnDestroy() {
    this.restore();
  }

  protected vaText(i: PricingApprovalItem) {
    if (!(i.country === 'ID' && i.version.methodCode === 'va')) return '';
    return i.version.vaBanks.length ? i.version.vaBanks.map((b) => VA_BANKS.find((v) => v.code === b)?.name ?? b).join(', ') : 'All VA Banks';
  }

  /** "New Rate" (§7.8): including USD and secondary charges. */
  protected newRate(i: PricingApprovalItem) {
    const sec = secondarySummary(i.version);
    return `${pricingShort(i.version)}${sec ? ` · ${sec}` : ''}`;
  }

  protected open(item: PricingApprovalItem, decision: 'approve' | 'reject') {
    this.dialog.set({ item, decision });
    this.reason.set('');
    this.code.set('');
    this.dialogError.set(null);
    setTimeout(() => document.querySelector<HTMLElement>('.sheet-confirm textarea, .sheet-confirm input')?.focus());
  }

  protected close() {
    if (!this.busy()) this.dialog.set(null);
  }

  /** Esc / backdrop / close: leave the decision first, then the sheet. */
  protected dismissDetail() {
    if (this.busy()) return;
    if (this.dialog()) this.dialog.set(null);
    else this.closed.emit();
  }

  protected setCode(value: string, el: HTMLInputElement) {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    if (digits !== value) el.value = digits;
    this.code.set(digits);
    this.dialogError.set(null);
  }

  protected async confirm() {
    const d = this.dialog();
    if (!d || this.busy()) return;
    if (d.decision === 'reject' && !this.reason().trim()) return;
    if (!/^\d{6}$/.test(this.code())) {
      this.dialogError.set('Enter the 6-digit code.');
      return;
    }
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      await this.api.decidePricing(d.item.applicationId, d.item.version.id, { decision: d.decision, reason: this.reason().trim(), code: this.code() });
      this.decided.emit({ decision: d.decision, text: d.decision === 'approve' ? `Approved – ${d.item.methodName} for ${d.item.merchantName}.` : `Rejected – ${d.item.methodName} for ${d.item.merchantName}.` });
    } catch (e) {
      const err = toMerchantError(e) as MerchantClientError & { attemptsRemaining?: number };
      const mfa = codeProblem(String(err.code), err.attemptsRemaining);
      if (mfa) this.dialogError.set(mfa);
      else this.failed.emit(`Could not ${d.decision} – ${err.message ?? 'please try again.'}`);
    } finally {
      this.busy.set(false);
    }
  }
}
