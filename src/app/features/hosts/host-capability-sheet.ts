import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import { AVAILABILITY_LABEL, AvailabilityStatus, HostCapabilityView, HostDetailResponse, hostCountries, hostMethods, PAYMENT_FLOW_LABEL } from '../../core/hosts/hosts';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';

/**
 * Add a payment capability (country + catalogue method), or change one's availability. Each
 * capability is managed on its own: disabling one never disables the host.
 */
@Component({
  selector: 'app-host-capability-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SideSheet, Icon],
  styleUrl: './hosts.scss',
  template: `
<app-side-sheet [label]="cap() ? 'Edit payment method' : 'Add payment method'" (dismiss)="closed.emit()">
  <header class="sheet-head">
    <div class="sheet-titles">
      <p class="sheet-eyebrow">Payment methods</p>
      <h2 class="sheet-title">{{ cap() ? 'Edit ' + cap()!.paymentMethodName : 'Add payment method' }}</h2>
      <p class="sheet-sub">{{ detail().host.name }} · {{ detail().host.id }}</p>
    </div>
    <button type="button" class="sheet-close" (click)="closed.emit()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
  </header>
  <div class="sheet-body">
    @if (cap(); as c) {
      <dl class="sheet-dl">
        <div><dt>Country</dt><dd>{{ c.countryName }}</dd></div>
        <div><dt>Payment Method</dt><dd>{{ c.paymentMethodName }}</dd></div>
        <div><dt>Payment Flow</dt><dd>{{ flowLabel[c.paymentFlow] }}</dd></div>
        <div><dt>Currency</dt><dd>{{ c.supportedCurrencies.join(', ') }}</dd></div>
      </dl>
    } @else {
      <div class="f-grid">
        <div class="f-field"><label for="hc-country">Country</label>
          <select id="hc-country" class="f-input" (change)="country.set(v($event)); method.set('')">
            @for (c of countries; track c.code) {<option [value]="c.code" [selected]="c.code === country()">{{ c.name }} · {{ c.currency }}</option>}
          </select></div>
        <div class="f-field"><label for="hc-method">Payment Method <span class="req">*</span></label>
          <select id="hc-method" class="f-input" [class.invalid]="tried() && !method()" (change)="method.set(v($event))">
            <option value="" [selected]="!method()">Select method</option>
            @for (m of methods(); track m.code) {<option [value]="m.code" [selected]="m.code === method()">{{ m.name }} · {{ flowLabel[m.flow] }}</option>}
          </select>
          @if (tried() && !method()) {<p class="f-error">Choose a payment method.</p>} @else {<p class="f-hint">From {{ countryLabel() }}'s configured catalogue. Methods this host already has are not listed.</p>}
        </div>
      </div>
    }
    <div class="f-field"><label for="hc-avail">Availability</label>
      <select id="hc-avail" class="f-input" (change)="avail.set($any(v($event)))">
        @for (a of availabilities; track a) {<option [value]="a" [selected]="a === avail()">{{ availLabel[a] }}</option>}
      </select>
      <p class="f-hint">Disabled stops this method only; the host stays as it is.</p>
    </div>
    @if (error(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
  </div>
  <footer class="sheet-foot">
    <span class="sheet-foot-note"></span>
    <button type="button" class="btn" (click)="closed.emit()" [disabled]="busy()">Cancel</button>
    <button type="button" class="btn primary" (click)="save()" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}{{ cap() ? 'Save' : 'Add payment method' }}</button>
  </footer>
</app-side-sheet>
  `,
})
export class HostCapabilitySheet implements OnInit {
  private readonly api = inject(HostApi);

  readonly detail = input.required<HostDetailResponse>();
  /** The capability to edit; null adds one. */
  readonly cap = input<HostCapabilityView | null>(null);
  readonly done = output<{ detail: HostDetailResponse; message: string }>();
  readonly closed = output<void>();

  protected readonly countries = hostCountries();
  protected readonly availabilities: AvailabilityStatus[] = ['available', 'unavailable', 'disabled'];
  protected readonly availLabel = AVAILABILITY_LABEL;
  protected readonly flowLabel = PAYMENT_FLOW_LABEL;
  protected readonly country = signal(hostCountries()[0]?.code ?? '');
  protected readonly method = signal('');
  protected readonly avail = signal<AvailabilityStatus>('available');
  protected readonly busy = signal(false);
  protected readonly tried = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly methods = computed(() => hostMethods(this.country()).filter((m) => !this.detail().capabilities.some((c) => c.countryCode === this.country() && c.paymentMethodCode === m.code)));
  protected readonly countryLabel = computed(() => this.countries.find((c) => c.code === this.country())?.name ?? '');

  ngOnInit() {
    const c = this.cap();
    if (c) this.avail.set(c.availabilityStatus);
    else this.country.set(this.detail().host.registrationCountry && this.countries.some((x) => x.code === this.detail().host.registrationCountry) ? this.detail().host.registrationCountry : this.country());
  }

  protected v(e: Event) {
    return (e.target as HTMLSelectElement).value;
  }

  protected async save() {
    this.tried.set(true);
    const c = this.cap();
    if (!c && !this.method()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const id = this.detail().host.id;
      const res = c ? await this.api.setAvailability(id, c.id, this.avail()) : await this.api.addCapability(id, { countryCode: this.country(), paymentMethodCode: this.method(), availabilityStatus: this.avail() });
      this.done.emit({ detail: res, message: c ? (this.avail() === 'disabled' ? 'Payment method disabled' : 'Payment method updated') : 'Payment method added' });
    } catch (e) {
      this.error.set(toHostError(e).message ?? "That didn't work. Please try again.");
    } finally {
      this.busy.set(false);
    }
  }
}
