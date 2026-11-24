import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal, viewChild } from '@angular/core';
import { MerchantOption, OverrideView, RoutingResponse } from '../../core/routing/routing';
import { RoutingApi, toRoutingError } from '../../core/routing/routing-api.service';
import { countryName } from '../../core/merchants/onboarding-config';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';

/** Add or edit a merchant override (pin one merchant to a host for one country + method). */
@Component({
  selector: 'app-override-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SideSheet, Icon, CodePrompt],
  styleUrls: ['../hosts/hosts.scss', './routing.scss'],
  template: `
<app-side-sheet size="editor" [label]="existing() ? 'Edit merchant override' : 'Add merchant override'" (dismiss)="close()">
  <header class="sheet-head">
    <div class="sheet-titles">
      <p class="sheet-eyebrow">Routing · Merchant override</p>
      <h2 class="sheet-title">{{ existing() ? 'Edit merchant override' : 'Add merchant override' }}</h2>
      <p class="sheet-sub">Pin one merchant to a host for one country and payment method.</p>
    </div>
    <button type="button" class="sheet-close" (click)="close()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
  </header>
  <div class="sheet-body">
    <div class="f-field">
      <label for="ov-merchant">Merchant <span class="req">*</span></label>
      <select id="ov-merchant" class="f-input" [disabled]="!!existing()" [class.invalid]="err('merchantId')" (change)="setMerchant(v($event))">
        <option value="" [selected]="!merchantKey()">Select merchant</option>
        @for (m of merchantList(); track m.key) {<option [value]="m.key" [selected]="m.key === merchantKey()">{{ m.name }}{{ m.subMerchantId ? ' (sub-merchant)' : '' }}</option>}
      </select>
      @if (err('merchantId'); as m) {<p class="f-error">{{ m }}</p>} @else {<p class="f-hint">Live merchants and sub-merchants. A sub-merchant's own override comes before its parent's.</p>}
    </div>
    <div class="f-grid">
      <div class="f-field">
        <label for="ov-country">Country <span class="req">*</span></label>
        <select id="ov-country" class="f-input" [disabled]="!!existing() || !merchantKey()" (change)="country.set(v($event)); method.set(''); hostId.set('')">
          <option value="" [selected]="!country()">Select country</option>
          @for (c of countries(); track c) {<option [value]="c" [selected]="c === country()">{{ cname(c) }}</option>}
        </select>
        <p class="f-hint">Only countries this merchant is live in.</p>
      </div>
      <div class="f-field">
        <label for="ov-method">Payment method <span class="req">*</span></label>
        <select id="ov-method" class="f-input" [disabled]="!!existing() || !country()" [class.invalid]="err('methodCode')" (change)="method.set(v($event)); hostId.set('')">
          <option value="" [selected]="!method()">Select method</option>
          @for (m of methods(); track m.code) {<option [value]="m.code" [selected]="m.code === method()">{{ m.name }}</option>}
        </select>
        @if (err('methodCode'); as m) {<p class="f-error">{{ m }}</p>}
      </div>
    </div>
    <div class="f-field">
      <label for="ov-host">Pinned host <span class="req">*</span></label>
      <select id="ov-host" class="f-input" [disabled]="!method()" [class.invalid]="err('hostId')" (change)="hostId.set(v($event))">
        <option value="" [selected]="!hostId()">Select host</option>
        @for (o of hosts(); track o.hostId) {<option [value]="o.hostId" [selected]="o.hostId === hostId()">{{ o.name }} · {{ o.eligible ? 'Active · ' + methodLabel() + ' Available' : o.reason }}</option>}
      </select>
      @if (err('hostId'); as m) {<p class="f-error">{{ m }}</p>} @else if (defaultLine(); as d) {<p class="f-hint">{{ d }}</p>}
    </div>
    <label class="rt-toggle">
      <input type="checkbox" role="switch" [checked]="fallback()" (change)="fallback.set($any($event.target).checked)" />
      <span><strong>Fall back to the default route</strong> If {{ hostName() || 'the pinned host' }} is not eligible, use the default route. Off: the payment fails.</span>
    </label>
    <div class="f-field">
      <label for="ov-reason">Reason <span class="req">*</span></label>
      <textarea id="ov-reason" class="f-input" rows="3" maxlength="300" [class.invalid]="err('reason')" [value]="reason()" (input)="reason.set(v($event))"></textarea>
      @if (err('reason'); as m) {<p class="f-error">{{ m }}</p>} @else {<p class="f-hint">At least 5 characters. Kept in the Activity Log.</p>}
    </div>
    @if (error(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
  </div>
  @if (codeAsk()) {
    <app-code-prompt title="Confirm it's you" message="Enter a code from your authenticator app." confirmLabel="Save override" [busy]="busy()" [error]="codeError()" (confirmed)="save($event)" (cancelled)="codeAsk.set(false)" />
  } @else {
    <footer class="sheet-foot">
      <span class="sheet-foot-note">Saving needs an authenticator code.</span>
      <button type="button" class="btn" (click)="close()" [disabled]="busy()">Cancel</button>
      <button type="button" class="btn primary" (click)="save()" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}Save override</button>
    </footer>
  }
</app-side-sheet>
  `,
})
export class OverrideSheet implements OnInit {
  private readonly api = inject(RoutingApi);
  private readonly prompt = viewChild(CodePrompt);

  readonly data = input.required<RoutingResponse>();
  readonly existing = input<OverrideView | null>(null);
  readonly done = output<OverrideView>();
  readonly closed = output<void>();

  protected readonly cname = countryName;
  protected readonly merchantKey = signal('');
  protected readonly country = signal('');
  protected readonly method = signal('');
  protected readonly hostId = signal('');
  protected readonly fallback = signal(true);
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly codeAsk = signal(false);
  protected readonly codeError = signal<string | null>(null);

  ngOnInit() {
    const o = this.existing();
    if (o) {
      this.merchantKey.set(mkey(o.merchantId, o.subMerchantId));
      this.country.set(o.country);
      this.method.set(o.methodCode);
      this.hostId.set(o.hostId);
      this.fallback.set(o.fallbackToRoute);
      this.reason.set(o.reason);
    }
  }

  protected v(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  /** One entry per merchant / sub-merchant (all its live countries). */
  protected readonly merchantList = computed(() => {
    const seen = new Map<string, { key: string; name: string; subMerchantId: string | null }>();
    for (const m of this.data().merchants) seen.set(mkey(m.merchantId, m.subMerchantId), { key: mkey(m.merchantId, m.subMerchantId), name: m.name, subMerchantId: m.subMerchantId });
    return [...seen.values()];
  });
  private readonly entries = computed<MerchantOption[]>(() => this.data().merchants.filter((m) => mkey(m.merchantId, m.subMerchantId) === this.merchantKey()));
  protected readonly countries = computed(() => [...new Set(this.entries().map((m) => m.country))]);
  protected readonly methods = computed(() => this.entries().find((m) => m.country === this.country())?.methods ?? []);
  private readonly route = computed(() => this.data().routes.find((r) => r.country === this.country() && r.methodCode === this.method()) ?? null);
  protected readonly hosts = computed(() => this.route()?.options.filter((o) => o.hostStatus !== 'removed') ?? []);
  protected readonly methodLabel = computed(() => this.methods().find((m) => m.code === this.method())?.name ?? '');
  protected readonly hostName = computed(() => this.hosts().find((h) => h.hostId === this.hostId())?.name ?? '');
  protected readonly defaultLine = computed(() => {
    const r = this.route();
    if (!r) return null;
    if (!r.route) return 'This country and method has no default route yet.';
    const first = r.route.mode === 'priority' ? r.options.find((o) => o.hostId === r.route!.hosts[0]?.hostId)?.name : null;
    return first ? `Default route sends this to ${first}.` : `Default route: ${r.route.mode === 'split' ? 'percentage split' : 'Smart'}.`;
  });

  protected setMerchant(key: string) {
    this.merchantKey.set(key);
    const countries = [...new Set(this.data().merchants.filter((m) => mkey(m.merchantId, m.subMerchantId) === key).map((m) => m.country))];
    this.country.set(countries.length === 1 ? countries[0] : '');
    this.method.set('');
    this.hostId.set('');
  }

  protected err(field: string) {
    return this.errors()[field] ?? null;
  }

  protected close() {
    if (this.busy()) return;
    if (this.codeAsk()) return this.codeAsk.set(false);
    this.closed.emit();
  }

  protected async save(code?: string) {
    const [merchantId, sub] = this.merchantKey().split('|');
    this.busy.set(true);
    this.error.set(null);
    this.codeError.set(null);
    try {
      const res = await this.api.saveOverride(
        this.existing()?.id ?? null,
        { merchantId: merchantId ?? '', subMerchantId: sub || null, country: this.country(), methodCode: this.method(), hostId: this.hostId(), fallbackToRoute: this.fallback(), reason: this.reason().trim() },
        code,
      );
      this.codeAsk.set(false);
      this.done.emit(res);
    } catch (e) {
      const err = toRoutingError(e);
      const mfa = this.codeAsk() ? codeProblem(err.code, err.attemptsRemaining) : null;
      if (err.code === 'MFA_CODE_REQUIRED') this.codeAsk.set(true);
      else if (mfa) {
        this.codeError.set(mfa);
        this.prompt()?.reset();
      } else {
        this.codeAsk.set(false);
        if (err.errors.length) this.errors.set(Object.fromEntries(err.errors.map((x) => [x.field, x.message])));
        else this.error.set(err.message ?? "That didn't work. Please try again.");
      }
    } finally {
      this.busy.set(false);
    }
  }
}

const mkey = (merchantId: string, sub: string | null) => `${merchantId}|${sub ?? ''}`;
