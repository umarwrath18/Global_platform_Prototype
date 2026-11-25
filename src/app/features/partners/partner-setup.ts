import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import {
  AUTH_METHOD_LABEL,
  AuthMethod,
  AvailabilityStatus,
  HOST_ADAPTERS,
  HOST_CODE_RE,
  HOST_ENVIRONMENT_LABEL,
  HOST_TYPES,
  HostAuthConfig,
  HostDetailResponse,
  HostDraftInput,
  HostEnvironment,
  hostCountries,
  hostMethods,
  hostTypeLabel,
  adapterLabel,
  methodCategory,
  methodName,
  PAYMENT_CATEGORIES,
  PAYMENT_FLOW_LABEL,
  registrationCountries,
  SecretKind,
} from '../../core/hosts/hosts';
import { countryName } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { SecretField } from './secret-field';

type Section = 'details' | 'methods' | 'integration' | 'review';
const SECTIONS: Section[] = ['details', 'methods', 'integration', 'review'];
const LABEL: Record<Section, string> = { details: 'Partner details', methods: 'Payment methods', integration: 'Integration', review: 'Review' };
const URL_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?(\/\S*)?$/i;

interface Method {
  countryCode: string;
  paymentMethodCode: string;
  availabilityStatus: AvailabilityStatus;
}

/**
 * Partner setup (like a country application): sections on the left with their state, one section
 * at a time, Save, then Review. A draft partner is finished here; an existing partner is edited here.
 */
@Component({
  selector: 'app-partner-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, SecretField],
  styleUrls: ['../applications/application-form.scss', './partners.scss'],
  template: `
<main class="page">
  <ol class="crumbs">
    <li><a routerLink="/partners">Partners</a></li>
    @if (d(); as x) {<li><a [routerLink]="['/partners', x.host.id]">{{ x.host.name }}</a></li>}
    <li aria-current="page">Setup</li>
  </ol>
  @if (loadError(); as e) {
    <div class="empty-state" role="alert"><div class="icon-tile"><app-icon name="alert-circle" /></div><h3>We couldn't load this partner</h3><p>{{ e }}</p><a class="btn" routerLink="/partners">Back to Partners</a></div>
  } @else if (d(); as x) {
    <div class="portal-head">
      <div>
        <h1>{{ x.host.status === 'draft' ? 'Set up ' : 'Edit ' }}{{ x.host.name }}</h1>
        <p class="sub">{{ x.host.id }} · {{ typeLabel(x.host.hostType) }} · {{ x.host.status === 'draft' ? 'Draft: not used for payments until set up and enabled.' : 'Changes apply when you save.' }}</p>
      </div>
    </div>
    @if (created()) {<div class="alert success compact" role="status"><app-icon name="check-circle" /><div><strong>{{ x.host.id }} created as a draft.</strong> Add its payment methods and integration, then finish setup.</div></div>}
    @if (!x.can.manage) {<div class="alert warning compact" role="status"><app-icon name="info" /><div>View only. Tech Ops sets up partners.</div></div>}

    <div class="wizard">
      <nav class="steps" aria-label="Setup sections">
        <p class="progress-label"><strong>{{ completeCount() }} of 3</strong> sections complete</p>
        <span class="progress"><span [style.width.%]="(completeCount() / 3) * 100"></span></span>
        <ol>
          @for (s of sections; track s; let i = $index) {
            <li>
              <button type="button" (click)="go(s)" [class.current]="section() === s" [attr.aria-current]="section() === s ? 'step' : null">
                @if (s === 'review') {
                  <span class="st review"><app-icon name="send" [size]="14" /></span>
                } @else {
                  <span class="st" [class.complete]="state()[s] === 0" [attr.aria-label]="state()[s] === 0 ? 'Complete' : state()[s] + ' to complete'">@if (state()[s] === 0) {<app-icon name="check" [size]="14" />} @else { {{ i + 1 }} }</span>
                }
                <span class="s-label">{{ label[s] }}@if (s !== 'review' && state()[s] > 0 && (visited().has(s) || tried())) {<span class="s-issues">{{ state()[s] }} missing</span>}</span>
              </button>
            </li>
          }
        </ol>
      </nav>

      <section class="body panel-card" aria-labelledby="section-title">
        <div class="panel-head">
          <div><h2 id="section-title" tabindex="-1">{{ label[section()] }}</h2><p>{{ hint[section()] }}</p></div>
          <span class="save-state" [class.dirty]="dirty()" aria-live="polite">{{ dirty() ? 'Unsaved changes' : 'Saved' }}</span>
        </div>
        <div class="panel-body">
          @if (message(); as m) {<div class="alert compact" [class]="'alert compact ' + m.tone" role="status"><app-icon [name]="m.tone === 'success' ? 'check-circle' : 'alert-circle'" /><div>{{ m.text }}</div></div>}

          @switch (section()) {
            @case ('details') {
              <div class="f-grid">
                <div class="f-field"><label for="s-name">Partner name <span class="req">*</span></label><input id="s-name" class="f-input" maxlength="80" [class.invalid]="err('basic.name')" [value]="name()" (input)="name.set(v($event))" />@if (err('basic.name'); as m) {<p class="f-error">{{ m }}</p>}</div>
                <div class="f-field"><label for="s-code">Partner code <span class="req">*</span></label><input id="s-code" class="f-input mono" maxlength="20" [class.invalid]="err('basic.hostCode')" [value]="code()" (input)="code.set(v($event).toUpperCase())" />@if (err('basic.hostCode'); as m) {<p class="f-error">{{ m }}</p>}</div>
                <div class="f-field"><label for="s-type">Partner type <span class="req">*</span></label>
                  <select id="s-type" class="f-input" [class.invalid]="err('basic.hostType')" (change)="type.set(v($event))"><option value="" [selected]="!type()">Select partner type</option>@for (t of types; track t.id) {<option [value]="t.id" [selected]="t.id === type()">{{ t.label }}</option>}</select>
                  @if (err('basic.hostType'); as m) {<p class="f-error">{{ m }}</p>}</div>
                <div class="f-field"><label for="s-country">Country of registration <span class="req">*</span></label>
                  <select id="s-country" class="f-input" [class.invalid]="err('basic.registrationCountry')" (change)="regCountry.set(v($event))"><option value="" [selected]="!regCountry()">Select country</option>@for (c of regCountries; track c.code) {<option [value]="c.code" [selected]="c.code === regCountry()">{{ c.name }}</option>}</select>
                  @if (err('basic.registrationCountry'); as m) {<p class="f-error">{{ m }}</p>}</div>
                <div class="f-field"><label for="s-email">Operations email <span class="req">*</span></label><input id="s-email" class="f-input" type="email" maxlength="120" [class.invalid]="err('basic.contactEmail')" [value]="email()" (input)="email.set(v($event))" />@if (err('basic.contactEmail'); as m) {<p class="f-error">{{ m }}</p>}</div>
                <div class="f-field"><label for="s-phone">Operations phone <span class="req">*</span></label><input id="s-phone" class="f-input" type="tel" maxlength="30" [class.invalid]="err('basic.contactPhone')" [value]="phone()" (input)="phone.set(v($event))" />@if (err('basic.contactPhone'); as m) {<p class="f-error">{{ m }}</p>}</div>
                <div class="f-field"><label for="s-owner">Internal owner <span class="req">*</span></label><input id="s-owner" class="f-input" maxlength="80" [class.invalid]="err('basic.ownerTeam')" [value]="owner()" (input)="owner.set(v($event))" />@if (err('basic.ownerTeam'); as m) {<p class="f-error">{{ m }}</p>}</div>
                <div class="f-field"><label for="s-esc">Escalation contact (optional)</label><input id="s-esc" class="f-input" maxlength="120" [value]="escalation()" (input)="escalation.set(v($event))" placeholder="Name, email or phone" /></div>
                <div class="f-field full"><label for="s-desc">Description (optional)</label><input id="s-desc" class="f-input" maxlength="300" [value]="description()" (input)="description.set(v($event))" placeholder="What this partner does for Mobi" /></div>
                <div class="f-field full"><label for="s-notes">Notes (optional)</label><textarea id="s-notes" class="f-input" rows="2" maxlength="1000" [value]="notes()" (input)="notes.set(v($event))"></textarea></div>
              </div>
            }

            @case ('methods') {
              <div class="pt-countries" role="tablist" aria-label="Countries">
                @for (c of countries; track c.code) {
                  <button type="button" role="tab" [attr.aria-selected]="tab() === c.code" [class.on]="tab() === c.code" (click)="tab.set(c.code)">{{ c.name }}@if (countIn(c.code); as n) {<span class="pt-count">{{ n }}</span>}</button>
                }
              </div>
              <div class="pt-cats">
                @for (g of catalogue(); track g.category) {
                  @let n = selectedIn(g.items);
                  <fieldset class="pt-cat" [class.on]="n > 0">
                    <legend class="sr-only">{{ g.category }}</legend>
                    <label class="pt-cat-head">
                      <input type="checkbox" [checked]="n === g.items.length" [indeterminate]="n > 0 && n < g.items.length" (change)="toggleAll(g.items, $any($event.target).checked)" [disabled]="!canEdit()" />
                      <strong>{{ g.category }}</strong><span class="muted">{{ n }} of {{ g.items.length }}</span>
                    </label>
                    @for (m of g.items; track m.code) {
                      <label class="pt-method"><input type="checkbox" [checked]="isOn(m.code)" (change)="toggle(m.code, $any($event.target).checked)" [disabled]="!canEdit()" />{{ m.name }}@if (m.flow === 'payout') {<span class="muted">Payout</span>}</label>
                    }
                  </fieldset>
                }
              </div>
              @if (err('capabilities'); as m) {<p class="f-error" role="alert">{{ m }}</p>}
              <p class="f-hint">New methods start <strong>Available</strong>. Switch each one on or off later from the partner's page without changing the partner. Removing a method keeps its cost pricing history.</p>
            }

            @case ('integration') {
              <div class="f-grid">
                <div class="f-field"><label for="i-adapter">Integration adapter <span class="req">*</span></label>
                  <select id="i-adapter" class="f-input" (change)="adapter.set(v($event))"><option value="" [selected]="!adapter()">Select adapter</option>@for (a of adapters; track a.id) {<option [value]="a.id" [selected]="a.id === adapter()">{{ a.label }}</option>}</select>
                  @if (adapterHint(); as h) {<p class="f-hint">{{ h }}</p>}</div>
                <div class="f-field"><label for="i-name">Integration name <span class="req">*</span></label><input id="i-name" class="f-input" maxlength="80" [value]="iName()" (input)="iName.set(v($event))" placeholder="e.g. Mekong Pay Collections API" /></div>
                <div class="f-field"><label for="i-env">Environment <span class="req">*</span></label>
                  <select id="i-env" class="f-input" (change)="env.set($any(v($event)))">@for (e of envs; track e) {<option [value]="e" [selected]="e === env()">{{ envLabel[e] }}</option>}</select>
                  <p class="f-hint">A partner can be enabled only on Production.</p></div>
                <div class="f-field"><label for="i-version">API version (optional)</label><input id="i-version" class="f-input" maxlength="20" [value]="apiVersion()" (input)="apiVersion.set(v($event))" /></div>
                <div class="f-field full"><label for="i-url">API base URL <span class="req">*</span></label><input id="i-url" class="f-input mono" maxlength="300" [class.invalid]="err('integration.apiBaseUrl')" [value]="url()" (input)="url.set(v($event))" placeholder="https://api.partner.example/v1" />@if (err('integration.apiBaseUrl'); as m) {<p class="f-error">{{ m }}</p>}</div>
                <div class="f-field"><label for="i-auth">Authentication <span class="req">*</span></label>
                  <select id="i-auth" class="f-input" (change)="auth.set($any(v($event)) || null)"><option value="" [selected]="!auth()">Select method</option>@for (a of authMethods; track a) {<option [value]="a" [selected]="a === auth()">{{ authLabel[a] }}</option>}</select></div>
                @switch (auth()) {
                  @case ('api_key') {<div class="f-field"><label for="a-header">API key header <span class="req">*</span></label><input id="a-header" class="f-input" maxlength="60" [value]="cfg().keyHeader ?? ''" (input)="setCfg('keyHeader', v($event))" placeholder="X-Api-Key" /></div>}
                  @case ('api_key_secret') {
                    <div class="f-field"><label for="a-header">API key header <span class="req">*</span></label><input id="a-header" class="f-input" maxlength="60" [value]="cfg().keyHeader ?? ''" (input)="setCfg('keyHeader', v($event))" placeholder="X-Api-Key" /></div>
                    <div class="f-field"><label for="a-sig">Signature method</label><input id="a-sig" class="f-input" maxlength="40" [value]="cfg().signature ?? ''" (input)="setCfg('signature', v($event))" placeholder="HMAC-SHA256" /></div>
                  }
                  @case ('oauth2') {
                    <div class="f-field"><label for="a-client">Client ID <span class="req">*</span></label><input id="a-client" class="f-input" maxlength="100" [value]="cfg().clientId ?? ''" (input)="setCfg('clientId', v($event))" /></div>
                    <div class="f-field full"><label for="a-token">Token URL <span class="req">*</span></label><input id="a-token" class="f-input mono" maxlength="200" [class.invalid]="err('integration.authConfig.tokenUrl')" [value]="cfg().tokenUrl ?? ''" (input)="setCfg('tokenUrl', v($event))" />@if (err('integration.authConfig.tokenUrl'); as m) {<p class="f-error">{{ m }}</p>}</div>
                    <div class="f-field"><label for="a-scope">Scope</label><input id="a-scope" class="f-input" maxlength="100" [value]="cfg().scope ?? ''" (input)="setCfg('scope', v($event))" /></div>
                  }
                  @case ('mtls') {<p class="f-hint full">Mutual TLS: certificates are managed by engineering, outside the portal.</p>}
                  @case ('other') {<div class="f-field full"><label for="a-desc">Authentication details <span class="req">*</span></label><input id="a-desc" class="f-input" maxlength="200" [value]="cfg().description ?? ''" (input)="setCfg('description', v($event))" /></div>}
                }
              </div>
              @if (auth() === 'api_key' || auth() === 'api_key_secret' || auth() === 'oauth2') {
                <div class="pt-secrets">
                  <h3>Credentials</h3>
                  <p class="f-hint">Write-only: entered once and never shown again. Setting or replacing one asks for your authenticator code.</p>
                  <app-secret-field [detail]="x" kind="apiKey" [label]="auth() === 'oauth2' ? 'Client secret' : 'API key'" (changed)="onSecret($event)" />
                  @if (auth() === 'api_key_secret') {<app-secret-field [detail]="x" kind="secretKey" label="Secret key" (changed)="onSecret($event)" />}
                </div>
              }
              <div class="f-grid pt-more">
                <div class="f-field"><label for="i-timeout">Request timeout (seconds)</label><input id="i-timeout" class="f-input" inputmode="numeric" maxlength="3" [class.invalid]="err('integration.timeoutSeconds')" [value]="timeout()" (input)="timeout.set(v($event))" />@if (err('integration.timeoutSeconds'); as m) {<p class="f-error">{{ m }}</p>}</div>
                <div class="f-field"><label for="i-conn">Callback URL, IP allowlist, ports</label><input id="i-conn" class="f-input" maxlength="500" [value]="conn()" (input)="conn.set(v($event))" /></div>
                <div class="f-field"><label for="i-portal">Partner portal username (optional)</label><input id="i-portal" class="f-input" maxlength="80" [value]="portalUser()" (input)="portalUser.set(v($event))" autocomplete="off" /><p class="f-hint">Mobi's login to the partner's own portal.</p></div>
                <div class="f-field"><span class="f-label">Partner portal password (optional)</span><app-secret-field [detail]="x" kind="portalPassword" label="Partner portal password" [compact]="true" (changed)="onSecret($event)" /></div>
                <div class="f-field full"><label for="i-notes">Integration notes (optional)</label><textarea id="i-notes" class="f-input" rows="2" maxlength="1000" [value]="iNotes()" (input)="iNotes.set(v($event))"></textarea></div>
              </div>
            }

            @case ('review') {
              @if (tried() && completeCount() < 3) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>Finish the sections marked missing before {{ x.host.status === 'draft' ? 'finishing setup' : 'saving' }}.</div></div>}
              <section class="sheet-section"><h3>Partner details</h3>
                <dl class="sheet-dl">
                  <div><dt>Partner</dt><dd>{{ name() || '—' }} · <span class="mono">{{ code() || '—' }}</span></dd></div>
                  <div><dt>Type · country</dt><dd>{{ type() ? typeLabel($any(type())) : '—' }} · {{ regCountry() ? cname(regCountry()) : '—' }}</dd></div>
                  <div><dt>Operations contact</dt><dd>{{ email() || '—' }}<span class="sub-line">{{ phone() }}</span></dd></div>
                  <div><dt>Internal owner</dt><dd>{{ owner() || '—' }}</dd></div>
                </dl>
                <button type="button" class="btn sm ghost" (click)="go('details')">Edit</button>
              </section>
              <section class="sheet-section"><h3>Payment methods ({{ methods().length }})</h3>
                @if (byCountry().length) {<dl class="sheet-dl">@for (g of byCountry(); track g.country) {<div class="wide"><dt>{{ g.name }}</dt><dd>{{ g.text }}</dd></div>}</dl>} @else {<p class="f-hint">None yet.</p>}
                <button type="button" class="btn sm ghost" (click)="go('methods')">Edit</button>
              </section>
              <section class="sheet-section"><h3>Integration</h3>
                <dl class="sheet-dl">
                  <div><dt>Adapter</dt><dd>{{ adapter() ? adapterName(adapter()) : '—' }}</dd></div>
                  <div><dt>Environment</dt><dd>{{ envLabel[env()] }}</dd></div>
                  <div class="wide"><dt>Endpoint</dt><dd class="mono">{{ url() || '—' }}</dd></div>
                  <div><dt>Authentication</dt><dd>{{ auth() ? authLabel[auth()!] : '—' }}</dd></div>
                  <div><dt>Credentials</dt><dd>{{ secretSummary() }}</dd></div>
                </dl>
                <button type="button" class="btn sm ghost" (click)="go('integration')">Edit</button>
              </section>
              <div class="alert info compact" role="note"><app-icon name="info" /><div>@if (x.host.status === 'draft') {After setup the partner is <strong>Disabled</strong>. Next, set each payment method's <strong>cost pricing</strong> on the partner's page (FinOps approves it), then enable the partner and add it to routes.} @else {Saving updates the partner straight away. Cost pricing is changed on the partner's page.}</div></div>
            }
          }
        </div>
        @if (x.can.manage) {
          <div class="form-foot">
            @if (section() !== 'details') {<button type="button" class="btn" (click)="back()" [disabled]="busy()">Back</button>}
            <span class="spacer"></span>
            @if (section() !== 'review') {
              <button type="button" class="btn" (click)="save(false)" [disabled]="busy() || !dirty()">Save</button>
              <button type="button" class="btn primary" (click)="save(true)" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}Save and continue</button>
            } @else {
              <button type="button" class="btn primary" (click)="finish()" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}{{ x.host.status === 'draft' ? 'Finish setup' : 'Save changes' }}</button>
            }
          </div>
        }
      </section>
    </div>
  } @else {
    <div class="skeleton-rows" aria-busy="true" aria-label="Loading partner"><span></span><span></span><span></span></div>
  }
</main>
  `,
})
export class PartnerSetup {
  private readonly api = inject(HostApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  readonly id = input.required<string>();

  protected readonly sections = SECTIONS;
  protected readonly label = LABEL;
  protected readonly hint: Record<Section, string> = {
    details: 'Who the partner is and who to contact.',
    methods: 'What the partner processes, per country. From each country’s catalogue.',
    integration: 'How Mobi’s integration layer reaches the partner.',
    review: 'Check everything before saving.',
  };
  protected readonly types = HOST_TYPES;
  protected readonly regCountries = registrationCountries();
  protected readonly countries = hostCountries();
  protected readonly adapters = HOST_ADAPTERS;
  protected readonly envs: HostEnvironment[] = ['sandbox', 'production'];
  protected readonly envLabel = HOST_ENVIRONMENT_LABEL;
  protected readonly authMethods = Object.keys(AUTH_METHOD_LABEL) as AuthMethod[];
  protected readonly authLabel = AUTH_METHOD_LABEL;
  protected readonly typeLabel = hostTypeLabel;
  protected readonly adapterName = adapterLabel;
  protected readonly cname = countryName;
  protected readonly created = computed(() => this.params().get('created') === '1');

  protected readonly d = signal<HostDetailResponse | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly section = signal<Section>('details');
  protected readonly visited = signal<ReadonlySet<Section>>(new Set(['details']));
  protected readonly tried = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal<{ tone: 'success' | 'danger'; text: string } | null>(null);
  private readonly serverErrors = signal<Record<string, { message: string; value: string }>>({});

  // Fields
  protected readonly name = signal('');
  protected readonly code = signal('');
  protected readonly type = signal('');
  protected readonly regCountry = signal('');
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly owner = signal('');
  protected readonly escalation = signal('');
  protected readonly description = signal('');
  protected readonly notes = signal('');
  protected readonly methods = signal<Method[]>([]);
  protected readonly tab = signal(hostCountries()[0]?.code ?? '');
  protected readonly adapter = signal('');
  protected readonly iName = signal('');
  protected readonly env = signal<HostEnvironment>('sandbox');
  protected readonly apiVersion = signal('');
  protected readonly url = signal('');
  protected readonly auth = signal<AuthMethod | null>(null);
  protected readonly cfg = signal<HostAuthConfig>({});
  protected readonly timeout = signal('30');
  protected readonly conn = signal('');
  protected readonly portalUser = signal('');
  protected readonly iNotes = signal('');

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected readonly canEdit = computed(() => !!this.d()?.can.manage);
  protected readonly dirty = computed(() => !!this.d() && JSON.stringify(this.input(true)) !== this.initialSig());
  private readonly initialSig = signal('');
  protected readonly adapterHint = computed(() => HOST_ADAPTERS.find((a) => a.id === this.adapter())?.description ?? null);

  /** Missing items per section (0 = complete). */
  protected readonly state = computed<Record<Section, number>>(() => {
    const details = [this.name().trim(), HOST_CODE_RE.test(this.code().trim()) ? 'ok' : '', this.type(), this.regCountry(), /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email().trim()) ? 'ok' : '', /^\+?[0-9 ()-]{7,20}$/.test(this.phone().trim()) ? 'ok' : '', this.owner().trim()].filter((x) => !x).length;
    const a = this.cfg();
    const authMissing =
      !this.auth() ? 1
      : (this.auth() === 'api_key' || this.auth() === 'api_key_secret') && !a.keyHeader?.trim() ? 1
      : this.auth() === 'oauth2' ? (!a.clientId?.trim() ? 1 : 0) + (!a.tokenUrl?.trim() ? 1 : 0)
      : this.auth() === 'other' && !a.description?.trim() ? 1 : 0;
    const integration = [this.adapter(), this.iName().trim(), URL_RE.test(this.url().trim()) ? 'ok' : ''].filter((x) => !x).length + authMissing;
    return { details, methods: this.methods().length ? 0 : 1, integration, review: 0 };
  });
  protected readonly completeCount = computed(() => (['details', 'methods', 'integration'] as Section[]).filter((s) => this.state()[s] === 0).length);

  protected readonly catalogue = computed(() => {
    const methods = hostMethods(this.tab());
    return PAYMENT_CATEGORIES.map((category) => ({ category, items: methods.filter((m) => methodCategory(this.tab(), m.code) === category) })).filter((g) => g.items.length);
  });
  protected readonly byCountry = computed(() =>
    this.countries
      .map((c) => ({ country: c.code, name: c.name, list: this.methods().filter((m) => m.countryCode === c.code) }))
      .filter((g) => g.list.length)
      .map((g) => ({ country: g.country, name: g.name, text: PAYMENT_CATEGORIES.map((cat) => ({ cat, names: g.list.filter((m) => methodCategory(g.country, m.paymentMethodCode) === cat).map((m) => methodName(g.country, m.paymentMethodCode)) })).filter((x) => x.names.length).map((x) => `${x.cat}: ${x.names.join(', ')}`).join(' · ') })),
  );
  protected readonly secretSummary = computed(() => {
    const s = this.d()?.host.secrets ?? {};
    const parts = (Object.keys(s) as SecretKind[]).map((k) => `${k === 'apiKey' ? 'API key' : k === 'secretKey' ? 'Secret key' : 'Portal password'} ends in ${s[k]!.last4}`);
    return parts.join(' · ') || 'None set';
  });

  protected v(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async load(id = this.id()) {
    this.loadError.set(null);
    try {
      const x = await this.api.detail(id);
      this.fill(x);
    } catch (e) {
      this.loadError.set(toHostError(e).message ?? 'Please try again in a moment.');
    }
  }

  private fill(x: HostDetailResponse) {
    const h = x.host;
    this.name.set(h.name);
    this.code.set(h.hostCode);
    this.type.set(h.hostType);
    this.regCountry.set(h.registrationCountry);
    this.email.set(h.contactEmail ?? '');
    this.phone.set(h.contactPhone ?? '');
    this.owner.set(h.ownerTeam);
    this.escalation.set(h.escalationContact ?? '');
    this.description.set(h.description);
    this.notes.set(h.notes);
    this.methods.set(x.capabilities.map((c) => ({ countryCode: c.countryCode, paymentMethodCode: c.paymentMethodCode, availabilityStatus: c.availabilityStatus })));
    const first = x.capabilities[0]?.countryCode ?? (this.countries.some((c) => c.code === h.registrationCountry) ? h.registrationCountry : this.tab());
    this.tab.set(first);
    const i = x.integration;
    this.adapter.set(i?.adapterType ?? '');
    this.iName.set(i?.integrationName ?? '');
    this.env.set(i?.environment ?? 'sandbox');
    this.apiVersion.set(i?.apiVersion ?? '');
    this.url.set(i?.apiBaseUrl ?? '');
    this.auth.set(i?.authenticationType ?? null);
    this.cfg.set({ ...(i?.authConfig ?? {}) });
    this.timeout.set(i?.timeoutSeconds === null || i?.timeoutSeconds === undefined ? '30' : String(i.timeoutSeconds));
    this.conn.set(i?.connectionConfig ?? '');
    this.portalUser.set(i?.portalUsername ?? '');
    this.iNotes.set(i?.notes ?? '');
    const first_load = !this.d();
    this.d.set(x);
    this.initialSig.set(JSON.stringify(this.input(true)));
    const wanted = this.params().get('section') as Section | null;
    if (first_load && wanted && SECTIONS.includes(wanted)) this.go(wanted);
  }

  protected go(s: Section) {
    this.section.set(s);
    this.visited.update((v) => new Set([...v, s]));
    this.message.set(null);
    queueMicrotask(() => document.getElementById('section-title')?.focus());
  }

  protected back() {
    this.go(SECTIONS[Math.max(0, SECTIONS.indexOf(this.section()) - 1)]);
  }

  protected countIn(country: string) {
    return this.methods().filter((m) => m.countryCode === country).length;
  }

  protected isOn(code: string) {
    return this.methods().some((m) => m.countryCode === this.tab() && m.paymentMethodCode === code);
  }

  protected selectedIn(items: { code: string }[]) {
    return items.filter((m) => this.isOn(m.code)).length;
  }

  protected toggle(code: string, on: boolean) {
    const c = this.tab();
    this.methods.update((list) => (on ? (list.some((m) => m.countryCode === c && m.paymentMethodCode === code) ? list : [...list, { countryCode: c, paymentMethodCode: code, availabilityStatus: 'available' }]) : list.filter((m) => !(m.countryCode === c && m.paymentMethodCode === code))));
  }

  protected toggleAll(items: { code: string }[], on: boolean) {
    for (const m of items) this.toggle(m.code, on);
  }

  protected setCfg(key: keyof HostAuthConfig, value: string) {
    this.cfg.update((c) => ({ ...c, [key]: value }));
  }

  protected err(field: string): string | null {
    const s = this.serverErrors()[field];
    return s && s.value === this.fieldValue(field) ? s.message : null;
  }

  private fieldValue(field: string): string {
    const map: Record<string, () => string> = {
      'basic.name': this.name, 'basic.hostCode': this.code, 'basic.hostType': this.type, 'basic.registrationCountry': this.regCountry, 'basic.ownerTeam': this.owner,
      'basic.contactEmail': this.email, 'basic.contactPhone': this.phone, 'integration.timeoutSeconds': this.timeout,
      'integration.apiBaseUrl': () => `${this.env()}|${this.url()}`, 'integration.authConfig.tokenUrl': () => this.cfg().tokenUrl ?? '', capabilities: () => JSON.stringify(this.methods()),
    };
    return map[field]?.() ?? '';
  }

  private input(draft: boolean): HostDraftInput {
    const keys: Record<AuthMethod, (keyof HostAuthConfig)[]> = { api_key: ['keyHeader'], api_key_secret: ['keyHeader', 'signature'], oauth2: ['tokenUrl', 'clientId', 'scope'], mtls: [], other: ['description'] };
    const authConfig: HostAuthConfig = {};
    for (const k of this.auth() ? keys[this.auth()!] : []) if (this.cfg()[k]?.trim()) authConfig[k] = this.cfg()[k]!.trim();
    const hasIntegration = !!(this.adapter() || this.iName().trim() || this.url().trim() || this.auth() || this.d()?.integration);
    const t = this.timeout().trim();
    return {
      draft,
      basic: { name: this.name().trim(), hostCode: this.code().trim(), hostType: this.type() as never, registrationCountry: this.regCountry(), ownerTeam: this.owner().trim(), contactEmail: this.email().trim(), contactPhone: this.phone().trim(), escalationContact: this.escalation().trim(), description: this.description().trim(), notes: this.notes().trim() },
      capabilities: this.methods(),
      integration: hasIntegration
        ? { integrationName: this.iName().trim(), adapterType: this.adapter(), apiBaseUrl: this.url().trim(), apiVersion: this.apiVersion().trim(), environment: this.env(), authenticationType: this.auth(), authConfig, timeoutSeconds: t === '' ? null : Number(t), connectionConfig: this.conn().trim(), notes: this.iNotes().trim(), portalUsername: this.portalUser().trim() }
        : null,
    };
  }

  /** Save the partner as it is now. A draft stays a draft until Finish setup. */
  protected async save(next: boolean) {
    const x = this.d();
    if (!x) return;
    const ok = await this.send(x.host.status === 'draft');
    if (ok && next) this.go(SECTIONS[SECTIONS.indexOf(this.section()) + 1]);
    else if (ok) this.message.set({ tone: 'success', text: 'Saved.' });
  }

  protected async finish() {
    this.tried.set(true);
    if (this.completeCount() < 3) return;
    const wasDraft = this.d()?.host.status === 'draft';
    if (await this.send(false)) void this.router.navigate(['/partners', this.id()], { queryParams: { saved: wasDraft ? 'setup' : 'edit' } });
  }

  private async send(draft: boolean): Promise<boolean> {
    this.busy.set(true);
    this.message.set(null);
    try {
      const res = await this.api.update(this.id(), this.input(draft));
      this.serverErrors.set({});
      this.fill(res);
      return true;
    } catch (e) {
      const err = toHostError(e);
      if (err.errors.length) {
        this.serverErrors.set(Object.fromEntries(err.errors.map((x) => [x.field.startsWith('capabilities.') ? 'capabilities' : x.field, { message: x.message, value: this.fieldValue(x.field.startsWith('capabilities.') ? 'capabilities' : x.field) }])));
        const f = err.errors[0].field;
        this.go(f.startsWith('basic') ? 'details' : f.startsWith('capabilities') ? 'methods' : 'integration');
      }
      this.message.set({ tone: 'danger', text: err.message ?? "We couldn't save. Please try again." });
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  protected onSecret(res: HostDetailResponse) {
    // Keep what's typed; only the secrets change.
    this.d.set(res);
    this.message.set({ tone: 'success', text: 'Credential saved. It will not be shown again.' });
  }
}
