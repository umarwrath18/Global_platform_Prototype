import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import { HOST_CODE_RE, HOST_TYPES, registrationCountries } from '../../core/hosts/hosts';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';

interface Draft {
  name: string;
  hostCode: string;
  hostType: string;
  registrationCountry: string;
  contactEmail: string;
  contactPhone: string;
  ownerTeam: string;
}

/**
 * Add partner, step 1 (like New merchant): the essentials. Saving creates a draft partner with its
 * ID; setup (payment methods, integration, cost pricing) continues on the partner's setup page.
 */
@Component({
  selector: 'app-new-partner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  styleUrl: '../merchants/merchant-forms.scss',
  template: `
<main class="page narrow">
  <ol class="crumbs">
    <li><a routerLink="/partners">Partners</a></li>
    <li aria-current="page">New partner</li>
  </ol>
  <div class="portal-head">
    <div>
      <h1>New partner</h1>
      <p class="sub">Start with the essentials. You'll add payment methods, integration and cost pricing next.</p>
    </div>
  </div>
  <ol class="flow-steps" aria-label="Steps">
    <li class="current"><span>1</span>Partner details</li>
    <li><span>2</span>Setup</li>
    <li><span>3</span>Cost pricing</li>
  </ol>

  @if (!roles.techOps()) {
    <div class="alert warning compact" role="status"><app-icon name="info" /><div>Only Tech Ops can add partners. Switch your view to Tech Ops to continue.</div></div>
  }

  <form class="panel-card" (submit)="$event.preventDefault(); create()" novalidate>
    <div class="panel-head"><div><h2>Partner details</h2><p>The company Mobi contracts with to process payments. Contacts are used for incidents and settlement queries.</p></div></div>
    <div class="panel-body">
      @if (error(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
      <div class="f-grid">
        <div class="f-field">
          <label for="p-name">Partner name <span class="req" aria-hidden="true">*</span></label>
          <input id="p-name" class="f-input" maxlength="80" [class.invalid]="show('name')" [value]="d().name" (input)="set('name', v($event))" (blur)="touch('name')" autocomplete="organization" placeholder="e.g. Mekong Pay" />
          @if (show('name'); as m) {<p class="f-error"><app-icon name="alert-circle" [size]="16" />{{ m }}</p>}
        </div>
        <div class="f-field">
          <label for="p-code">Partner code <span class="req" aria-hidden="true">*</span></label>
          <input id="p-code" class="f-input mono" maxlength="20" [class.invalid]="show('hostCode')" [value]="d().hostCode" (input)="set('hostCode', v($event).toUpperCase())" (blur)="touch('hostCode')" placeholder="e.g. MEKONG" />
          @if (show('hostCode'); as m) {<p class="f-error"><app-icon name="alert-circle" [size]="16" />{{ m }}</p>} @else {<p class="f-hint">Short unique code used in reports and routing. Letters, numbers, - and _.</p>}
        </div>
        <div class="f-field">
          <label for="p-type">Partner type <span class="req" aria-hidden="true">*</span></label>
          <select id="p-type" class="f-input" [class.invalid]="show('hostType')" (change)="set('hostType', v($event)); touch('hostType')">
            <option value="" [selected]="!d().hostType">Select partner type</option>
            @for (t of types; track t.id) {<option [value]="t.id" [selected]="t.id === d().hostType">{{ t.label }}</option>}
          </select>
          @if (show('hostType'); as m) {<p class="f-error"><app-icon name="alert-circle" [size]="16" />{{ m }}</p>}
        </div>
        <div class="f-field">
          <label for="p-country">Country of registration <span class="req" aria-hidden="true">*</span></label>
          <select id="p-country" class="f-input" [class.invalid]="show('registrationCountry')" (change)="set('registrationCountry', v($event)); touch('registrationCountry')">
            <option value="" [selected]="!d().registrationCountry">Select country</option>
            @for (c of countries; track c.code) {<option [value]="c.code" [selected]="c.code === d().registrationCountry">{{ c.name }}</option>}
          </select>
          @if (show('registrationCountry'); as m) {<p class="f-error"><app-icon name="alert-circle" [size]="16" />{{ m }}</p>}
        </div>
        <div class="f-field">
          <label for="p-email">Operations email <span class="req" aria-hidden="true">*</span></label>
          <input id="p-email" class="f-input" type="email" maxlength="120" [class.invalid]="show('contactEmail')" [value]="d().contactEmail" (input)="set('contactEmail', v($event))" (blur)="touch('contactEmail')" placeholder="ops@partner.example" />
          @if (show('contactEmail'); as m) {<p class="f-error"><app-icon name="alert-circle" [size]="16" />{{ m }}</p>}
        </div>
        <div class="f-field">
          <label for="p-phone">Operations phone <span class="req" aria-hidden="true">*</span></label>
          <input id="p-phone" class="f-input" type="tel" maxlength="30" [class.invalid]="show('contactPhone')" [value]="d().contactPhone" (input)="set('contactPhone', v($event))" (blur)="touch('contactPhone')" placeholder="+84 24 3974 8888" />
          @if (show('contactPhone'); as m) {<p class="f-error"><app-icon name="alert-circle" [size]="16" />{{ m }}</p>}
        </div>
        <div class="f-field full">
          <label for="p-owner">Internal owner <span class="req" aria-hidden="true">*</span></label>
          <input id="p-owner" class="f-input" maxlength="80" [class.invalid]="show('ownerTeam')" [value]="d().ownerTeam" (input)="set('ownerTeam', v($event))" (blur)="touch('ownerTeam')" placeholder="e.g. Tech Ops – Vietnam" />
          @if (show('ownerTeam'); as m) {<p class="f-error"><app-icon name="alert-circle" [size]="16" />{{ m }}</p>}
        </div>
      </div>
      <p class="f-hint">The partner is saved as a <strong>draft</strong> and stays out of routing until it is set up and enabled.</p>
    </div>
    <div class="form-foot">
      <a class="btn" routerLink="/partners">Cancel</a>
      <button type="submit" class="btn primary" [disabled]="busy() || !roles.techOps()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>Creating…} @else {Create partner<app-icon name="arrow-right" [size]="16" />}</button>
    </div>
  </form>
</main>
  `,
})
export class NewPartner {
  private readonly api = inject(HostApi);
  private readonly router = inject(Router);
  protected readonly roles = inject(StaffRoleService);
  protected readonly types = HOST_TYPES;
  protected readonly countries = registrationCountries();
  protected readonly d = signal<Draft>({ name: '', hostCode: '', hostType: '', registrationCountry: '', contactEmail: '', contactPhone: '', ownerTeam: '' });
  private readonly touched = signal<Set<keyof Draft>>(new Set());
  private readonly tried = signal(false);
  private readonly serverErrors = signal<Partial<Record<keyof Draft, { message: string; value: string }>>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly problems = computed(() => {
    const d = this.d();
    const p: Partial<Record<keyof Draft, string>> = {};
    if (!d.name.trim()) p.name = 'Enter the partner name.';
    if (!d.hostCode.trim()) p.hostCode = 'Enter a partner code.';
    else if (!HOST_CODE_RE.test(d.hostCode.trim())) p.hostCode = 'Use 2–20 letters, numbers, dashes or underscores, starting with a letter or number.';
    if (!d.hostType) p.hostType = 'Choose the partner type.';
    if (!d.registrationCountry) p.registrationCountry = 'Choose the country of registration.';
    if (!d.contactEmail.trim()) p.contactEmail = 'Enter the operations email.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.contactEmail.trim())) p.contactEmail = 'Enter a valid email address.';
    if (!d.contactPhone.trim()) p.contactPhone = 'Enter the operations phone number.';
    else if (!/^\+?[0-9 ()-]{7,20}$/.test(d.contactPhone.trim())) p.contactPhone = 'Enter a phone number with country code, e.g. +84 24 3974 8888.';
    if (!d.ownerTeam.trim()) p.ownerTeam = 'Enter the responsible team.';
    return p;
  });

  protected v(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected set(key: keyof Draft, value: string) {
    this.d.update((d) => ({ ...d, [key]: value }));
  }

  protected touch(key: keyof Draft) {
    this.touched.update((t) => new Set([...t, key]));
  }

  protected show(key: keyof Draft): string | null {
    const server = this.serverErrors()[key];
    if (server && server.value === this.d()[key]) return server.message;
    return this.tried() || this.touched().has(key) ? (this.problems()[key] ?? null) : null;
  }

  protected async create() {
    this.tried.set(true);
    if (Object.keys(this.problems()).length) return;
    this.busy.set(true);
    this.error.set(null);
    const d = this.d();
    try {
      const res = await this.api.create({
        draft: true,
        basic: { name: d.name.trim(), hostCode: d.hostCode.trim(), hostType: d.hostType as never, registrationCountry: d.registrationCountry, contactEmail: d.contactEmail.trim(), contactPhone: d.contactPhone.trim(), ownerTeam: d.ownerTeam.trim(), description: '', notes: '', escalationContact: '' },
        capabilities: [],
        integration: null,
      });
      void this.router.navigate(['/partners', res.host.id, 'setup'], { queryParams: { created: 1 } });
    } catch (e) {
      const err = toHostError(e);
      const map: Partial<Record<keyof Draft, { message: string; value: string }>> = {};
      for (const x of err.errors) {
        const key = x.field.replace('basic.', '') as keyof Draft;
        if (key in this.d()) map[key] = { message: x.message, value: this.d()[key] };
      }
      this.serverErrors.set(map);
      if (!Object.keys(map).length) this.error.set(err.message ?? "We couldn't create the partner. Please try again.");
    } finally {
      this.busy.set(false);
    }
  }
}
