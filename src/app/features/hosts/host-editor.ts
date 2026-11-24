import { ChangeDetectionStrategy, Component, computed, effect, inject, input, OnInit, output, signal, untracked } from '@angular/core';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import {
  adapterLabel,
  AUTH_METHOD_LABEL,
  AuthMethod,
  AVAILABILITY_LABEL,
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
  methodName,
  Partner,
  PAYMENT_FLOW_LABEL,
  registrationCountries,
} from '../../core/hosts/hosts';
import { countryName } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';

type Step = 0 | 1 | 2 | 3;
interface CapRow {
  countryCode: string;
  paymentMethodCode: string;
  availabilityStatus: AvailabilityStatus;
}

/**
 * Add Host / Edit Host in a side sheet, in four steps (the same pattern as the pricing editor):
 * Basic information → Markets & capabilities → Integration → Review. Save as Draft keeps an
 * unfinished host; Save Host saves it as Disabled (a new host is never operational).
 */
@Component({
  selector: 'app-host-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SideSheet, Icon],
  styleUrl: './hosts.scss',
  template: `
<app-side-sheet size="editor" [label]="title()" (dismiss)="requestClose()">
  <header class="sheet-head editor-sheet-head">
    <div class="editor-head-row">
      <div class="sheet-titles">
        <p class="sheet-eyebrow">Host Management</p>
        <h2 class="sheet-title">{{ title() }}</h2>
        <p class="sheet-sub">{{ existing() ? existing()!.host.id + ' · ' + existing()!.host.hostCode : 'Register a payment provider. It stays Disabled until you enable it.' }}</p>
      </div>
      <button type="button" class="sheet-close" (click)="requestClose()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
    </div>
    <ol class="sheet-steps" aria-label="Steps">
      @for (s of steps; track s; let i = $index) {
        <li [class.current]="i === step()" [class.done]="i < step()" [attr.aria-current]="i === step() ? 'step' : null">
          <span class="bar" aria-hidden="true"></span>
          <span class="lbl">@if (i < step()) {<app-icon name="check" [size]="12" />}{{ s }}</span>
        </li>
      }
    </ol>
  </header>

  <div class="sheet-body">
    @if (serverError(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
    @switch (step()) {
      @case (0) {
        <section class="sheet-section">
          <h3>Basic information</h3>
          <p class="f-hint">Who the provider is and who owns it at Mobi. The commercial relationship (partner) is optional.</p>
          <div class="f-grid">
            <div class="f-field"><label for="h-name">Host Name <span class="req">*</span></label><input id="h-name" class="f-input" maxlength="80" [class.invalid]="err('basic.name')" [value]="name()" (input)="name.set(v($event))" />@if (err('basic.name'); as m) {<p class="f-error">{{ m }}</p>}</div>
            <div class="f-field"><label for="h-code">Host Code <span class="req">*</span></label><input id="h-code" class="f-input mono" maxlength="20" [class.invalid]="err('basic.hostCode')" [value]="hostCode()" (input)="hostCode.set(v($event).toUpperCase())" />@if (err('basic.hostCode'); as m) {<p class="f-error">{{ m }}</p>} @else {<p class="f-hint">Unique short code, e.g. HARSYA. Letters, numbers, - and _.</p>}</div>
            <div class="f-field full"><label for="h-desc">Description</label><input id="h-desc" class="f-input" maxlength="300" [value]="description()" (input)="description.set(v($event))" /></div>
            <div class="f-field"><label for="h-partner">Associated Partner</label>
              <select id="h-partner" class="f-input" (change)="partnerId.set(v($event))">
                <option value="" [selected]="!partnerId()">None</option>
                @for (p of partners(); track p.id) {<option [value]="p.id" [selected]="p.id === partnerId()">{{ p.name }} · {{ cname(p.country) }}</option>}
              </select>
              <p class="f-hint">Optional. Sample partner list until the Partner module is built.</p>
            </div>
            <div class="f-field"><label for="h-type">Host Type <span class="req">*</span></label>
              <select id="h-type" class="f-input" [class.invalid]="err('basic.hostType')" (change)="hostType.set(v($event))">
                <option value="" [selected]="!hostType()">Select host type</option>
                @for (t of hostTypes; track t.id) {<option [value]="t.id" [selected]="t.id === hostType()">{{ t.label }}</option>}
              </select>
              @if (err('basic.hostType'); as m) {<p class="f-error">{{ m }}</p>}
            </div>
            <div class="f-field"><label for="h-country">Country of Registration <span class="req">*</span></label>
              <select id="h-country" class="f-input" [class.invalid]="err('basic.registrationCountry')" (change)="regCountry.set(v($event))">
                <option value="" [selected]="!regCountry()">Select country</option>
                @for (c of regCountries; track c.code) {<option [value]="c.code" [selected]="c.code === regCountry()">{{ c.name }}</option>}
              </select>
              @if (err('basic.registrationCountry'); as m) {<p class="f-error">{{ m }}</p>}
            </div>
            <div class="f-field"><label for="h-owner">Internal Owner / Responsible Team <span class="req">*</span></label><input id="h-owner" class="f-input" maxlength="80" [class.invalid]="err('basic.ownerTeam')" [value]="ownerTeam()" (input)="ownerTeam.set(v($event))" placeholder="e.g. Tech Ops – Indonesia" />@if (err('basic.ownerTeam'); as m) {<p class="f-error">{{ m }}</p>}</div>
            <div class="f-field full"><label for="h-notes">Notes</label><textarea id="h-notes" class="f-input" rows="2" maxlength="1000" [value]="notes()" (input)="notes.set(v($event))"></textarea></div>
          </div>
        </section>
      }
      @case (1) {
        <section class="sheet-section">
          <h3>Markets &amp; capabilities</h3>
          <p class="f-hint">One row per country and payment method, from each country's configured catalogue. The flow and currency follow the method and country.</p>
          @if (caps().length) {
            <div class="table-wrap">
              <table class="data-table host-cap-table">
                <thead><tr><th scope="col">Country</th><th scope="col">Payment Method</th><th scope="col">Flow</th><th scope="col">Currency</th><th scope="col">Availability</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead>
                <tbody>
                  @for (c of caps(); track c.countryCode + c.paymentMethodCode; let i = $index) {
                    <tr>
                      <td>{{ cname(c.countryCode) }}</td>
                      <td>{{ mname(c.countryCode, c.paymentMethodCode) }}</td>
                      <td>{{ flowOf(c) }}</td>
                      <td>{{ currencyOf(c.countryCode) }}</td>
                      <td>
                        <select class="f-input sm" [attr.aria-label]="'Availability of ' + mname(c.countryCode, c.paymentMethodCode)" (change)="setAvail(i, v($event))">
                          @for (a of availabilities; track a) {<option [value]="a" [selected]="a === c.availabilityStatus">{{ availLabel[a] }}</option>}
                        </select>
                      </td>
                      <td><button type="button" class="btn sm ghost" (click)="removeCap(i)" [attr.aria-label]="'Remove ' + mname(c.countryCode, c.paymentMethodCode)"><app-icon name="trash" [size]="14" /></button></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="host-empty-line">No payment methods yet. Add the first one below.</p>
          }
          <div class="host-cap-add" role="group" aria-label="Add a payment method">
            <div class="f-field"><label for="cap-country">Country</label>
              <select id="cap-country" class="f-input" (change)="newCountry.set(v($event)); newMethod.set('')">
                @for (c of countries; track c.code) {<option [value]="c.code" [selected]="c.code === newCountry()">{{ c.name }}</option>}
              </select></div>
            <div class="f-field"><label for="cap-method">Payment Method</label>
              <select id="cap-method" class="f-input" (change)="newMethod.set(v($event))">
                <option value="" [selected]="!newMethod()">Select method</option>
                @for (m of newMethods(); track m.code) {<option [value]="m.code" [selected]="m.code === newMethod()">{{ m.name }} · {{ flowLabel[m.flow] }}</option>}
              </select></div>
            <div class="f-field"><label for="cap-avail">Availability</label>
              <select id="cap-avail" class="f-input" (change)="newAvail.set($any(v($event)))">
                @for (a of availabilities; track a) {<option [value]="a" [selected]="a === newAvail()">{{ availLabel[a] }}</option>}
              </select></div>
            <button type="button" class="btn" (click)="addCap()" [disabled]="!newMethod()"><app-icon name="plus" [size]="14" />Add</button>
          </div>
          @if (err('capabilities'); as m) {<p class="f-error" role="alert">{{ m }}</p>}
        </section>
      }
      @case (2) {
        <section class="sheet-section">
          <h3>Integration</h3>
          <p class="f-hint">How Mobi's integration layer reaches this host. Provider-specific handling lives in the adapter, not here. You can save now and finish later.</p>
          <div class="f-grid">
            <div class="f-field"><label for="i-name">Integration Name</label><input id="i-name" class="f-input" maxlength="80" [value]="iName()" (input)="iName.set(v($event))" /></div>
            <div class="f-field"><label for="i-adapter">Integration Adapter</label>
              <select id="i-adapter" class="f-input" (change)="iAdapter.set(v($event))">
                <option value="" [selected]="!iAdapter()">Select adapter</option>
                @for (a of adapters; track a.id) {<option [value]="a.id" [selected]="a.id === iAdapter()">{{ a.label }}</option>}
              </select>
              @if (adapterHint(); as h) {<p class="f-hint">{{ h }}</p>}
            </div>
            <div class="f-field full"><label for="i-url">API Base URL</label><input id="i-url" class="f-input mono" maxlength="300" [class.invalid]="urlError()" [value]="iUrl()" (input)="iUrl.set(v($event))" placeholder="https://api.provider.example/v1" />@if (urlError(); as m) {<p class="f-error">{{ m }}</p>}</div>
            <div class="f-field"><label for="i-version">API Version (optional)</label><input id="i-version" class="f-input" maxlength="20" [value]="iVersion()" (input)="iVersion.set(v($event))" /></div>
            <div class="f-field"><label for="i-env">Environment</label>
              <select id="i-env" class="f-input" (change)="iEnv.set($any(v($event)))">
                @for (e of envs; track e) {<option [value]="e" [selected]="e === iEnv()">{{ envLabel[e] }}</option>}
              </select></div>
            <div class="f-field"><label for="i-timeout">Request Timeout (seconds)</label><input id="i-timeout" class="f-input" inputmode="numeric" maxlength="3" [class.invalid]="err('integration.timeoutSeconds')" [value]="iTimeout()" (input)="iTimeout.set(v($event))" />@if (err('integration.timeoutSeconds'); as m) {<p class="f-error">{{ m }}</p>}</div>
            <div class="f-field"><label for="i-auth">Authentication Method</label>
              <select id="i-auth" class="f-input" (change)="iAuth.set($any(v($event)) || null)">
                <option value="" [selected]="!iAuth()">Select method</option>
                @for (a of authMethods; track a) {<option [value]="a" [selected]="a === iAuth()">{{ authLabel[a] }}</option>}
              </select></div>
            @switch (iAuth()) {
              @case ('api_key') {
                <div class="f-field full"><label for="a-header">API key header</label><input id="a-header" class="f-input" maxlength="60" [value]="cfg().keyHeader ?? ''" (input)="setCfg('keyHeader', v($event))" placeholder="X-Api-Key" /></div>
              }
              @case ('api_key_secret') {
                <div class="f-field"><label for="a-header">API key header</label><input id="a-header" class="f-input" maxlength="60" [value]="cfg().keyHeader ?? ''" (input)="setCfg('keyHeader', v($event))" placeholder="X-Api-Key" /></div>
                <div class="f-field"><label for="a-sig">Signature method</label><input id="a-sig" class="f-input" maxlength="40" [value]="cfg().signature ?? ''" (input)="setCfg('signature', v($event))" placeholder="HMAC-SHA256" /></div>
              }
              @case ('oauth2') {
                <div class="f-field full"><label for="a-token">Token URL</label><input id="a-token" class="f-input mono" maxlength="200" [value]="cfg().tokenUrl ?? ''" (input)="setCfg('tokenUrl', v($event))" /></div>
                <div class="f-field"><label for="a-client">Client ID</label><input id="a-client" class="f-input" maxlength="100" [value]="cfg().clientId ?? ''" (input)="setCfg('clientId', v($event))" /></div>
                <div class="f-field"><label for="a-scope">Scope</label><input id="a-scope" class="f-input" maxlength="100" [value]="cfg().scope ?? ''" (input)="setCfg('scope', v($event))" /></div>
              }
              @case ('mtls') {
                <p class="f-hint full">Mutual TLS: the client certificate is held with the credential reference. Nothing to enter here.</p>
              }
              @case ('other') {
                <div class="f-field full"><label for="a-desc">Authentication details</label><input id="a-desc" class="f-input" maxlength="200" [value]="cfg().description ?? ''" (input)="setCfg('description', v($event))" /></div>
              }
            }
            @if (iAuth()) {
              <div class="f-field full"><span class="f-label">Credential reference</span><p class="f-static mono">{{ credentialText() }}</p><p class="f-hint">Prototype: no key, secret or certificate is entered or stored here. Mobi assigns a masked reference; replace it from the host's Integration tab.</p></div>
            }
            <div class="f-field full"><label for="i-conn">Connection Configuration</label><input id="i-conn" class="f-input" maxlength="500" [value]="iConn()" (input)="iConn.set(v($event))" placeholder="Callback URL, IP allowlist, ports…" /></div>
            <div class="f-field full"><label for="i-notes">Integration Notes</label><textarea id="i-notes" class="f-input" rows="2" maxlength="1000" [value]="iNotes()" (input)="iNotes.set(v($event))"></textarea></div>
          </div>
        </section>
      }
      @case (3) {
        <section class="sheet-section">
          <h3>Basic information</h3>
          <dl class="sheet-dl">
            <div><dt>Host Name</dt><dd>{{ name() }}</dd></div>
            <div><dt>Host Code</dt><dd class="mono">{{ hostCode() }}</dd></div>
            <div><dt>Host Type</dt><dd>{{ hostType() ? typeLabel($any(hostType())) : '—' }}</dd></div>
            <div><dt>Country of Registration</dt><dd>{{ regCountry() ? cname(regCountry()) : '—' }}</dd></div>
            <div><dt>Owner</dt><dd>{{ ownerTeam() || '—' }}</dd></div>
            <div><dt>Associated Partner</dt><dd>{{ partnerName() }}</dd></div>
            @if (description()) {<div class="wide"><dt>Description</dt><dd>{{ description() }}</dd></div>}
          </dl>
        </section>
        <section class="sheet-section">
          <h3>Markets and payment methods</h3>
          @if (byCountry().length) {
            <dl class="sheet-dl">
              @for (g of byCountry(); track g.code) {<div class="wide"><dt>{{ g.name }} · {{ g.currency }}</dt><dd>{{ g.methods }}</dd></div>}
            </dl>
          } @else {<p class="f-hint">None yet.</p>}
        </section>
        <section class="sheet-section">
          <h3>Integration</h3>
          <dl class="sheet-dl">
            <div><dt>Adapter</dt><dd>{{ iAdapter() ? adapterName(iAdapter()) : '—' }}</dd></div>
            <div><dt>Environment</dt><dd>{{ envLabel[iEnv()] }}</dd></div>
            <div><dt>Authentication</dt><dd>{{ iAuth() ? authLabel[iAuth()!] : '—' }}</dd></div>
            <div><dt>Timeout</dt><dd>{{ iTimeout() ? iTimeout() + ' s' : '—' }}</dd></div>
            <div class="wide"><dt>Endpoint</dt><dd class="mono">{{ iUrl() || '—' }}@if (iVersion()) { · {{ iVersion() }}}</dd></div>
          </dl>
        </section>
        <div class="alert info compact" role="note"><app-icon name="info" /><div>After saving, the host is <strong>Disabled</strong>. Validate its configuration, then enable it on the host page. Enabling makes it eligible for routing later; it creates no routing rules.</div></div>
      }
    }
  </div>

  @if (askDiscard()) {
    <div class="sheet-confirm" role="alertdialog" aria-labelledby="h-discard">
      <h3 id="h-discard">Discard your changes?</h3>
      <p>What you've entered will be lost.</p>
      <div class="sheet-confirm-actions">
        <button type="button" class="btn" (click)="askDiscard.set(false)" autofocus>Keep editing</button>
        <button type="button" class="btn danger" (click)="closed.emit()">Discard</button>
      </div>
    </div>
  } @else {
    <footer class="sheet-foot">
      <span class="sheet-foot-note">Step {{ step() + 1 }} of {{ steps.length }}</span>
      @if (step() > 0) {<button type="button" class="btn" (click)="back()" [disabled]="busy()">Back</button>}
      @if (canDraft()) {<button type="button" class="btn" (click)="save(true)" [disabled]="busy()">Save as Draft</button>}
      @if (step() < 3) {
        <button type="button" class="btn primary" (click)="next()" [disabled]="busy()">Next</button>
      } @else {
        <button type="button" class="btn primary" (click)="save(false)" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}{{ existing() ? 'Save changes' : 'Save Host' }}</button>
      }
    </footer>
  }
</app-side-sheet>
  `,
})
export class HostEditor implements OnInit {
  private readonly api = inject(HostApi);

  /** The host to edit; null adds a new one. */
  readonly existing = input<HostDetailResponse | null>(null);
  readonly partners = input<Partner[]>([]);
  /** Opens on this step (e.g. Integration from the host page). */
  readonly startStep = input<Step>(0);
  readonly saved = output<HostDetailResponse>();
  readonly closed = output<void>();

  protected readonly steps = ['Basic information', 'Markets & capabilities', 'Integration', 'Review'];
  protected readonly hostTypes = HOST_TYPES;
  protected readonly regCountries = registrationCountries();
  protected readonly countries = hostCountries();
  protected readonly adapters = HOST_ADAPTERS;
  protected readonly envs: HostEnvironment[] = ['sandbox', 'production'];
  protected readonly envLabel = HOST_ENVIRONMENT_LABEL;
  protected readonly authMethods = Object.keys(AUTH_METHOD_LABEL) as AuthMethod[];
  protected readonly authLabel = AUTH_METHOD_LABEL;
  protected readonly availabilities: AvailabilityStatus[] = ['available', 'unavailable', 'disabled'];
  protected readonly availLabel = AVAILABILITY_LABEL;
  protected readonly flowLabel = PAYMENT_FLOW_LABEL;
  protected readonly cname = countryName;
  protected readonly mname = methodName;
  protected readonly typeLabel = hostTypeLabel;
  protected readonly adapterName = adapterLabel;

  protected readonly step = signal<Step>(0);
  protected readonly busy = signal(false);
  protected readonly askDiscard = signal(false);
  protected readonly serverError = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  private readonly serverErrors = signal<Record<string, { message: string; value: string }>>({});

  protected readonly name = signal('');
  protected readonly hostCode = signal('');
  protected readonly description = signal('');
  protected readonly partnerId = signal('');
  protected readonly hostType = signal('');
  protected readonly regCountry = signal('');
  protected readonly ownerTeam = signal('');
  protected readonly notes = signal('');
  protected readonly caps = signal<CapRow[]>([]);
  protected readonly newCountry = signal(hostCountries()[0]?.code ?? '');
  protected readonly newMethod = signal('');
  protected readonly newAvail = signal<AvailabilityStatus>('available');
  protected readonly iName = signal('');
  protected readonly iAdapter = signal('');
  protected readonly iUrl = signal('');
  protected readonly iVersion = signal('');
  protected readonly iEnv = signal<HostEnvironment>('sandbox');
  protected readonly iAuth = signal<AuthMethod | null>(null);
  protected readonly cfg = signal<HostAuthConfig>({});
  protected readonly iTimeout = signal('30');
  protected readonly iConn = signal('');
  protected readonly iNotes = signal('');
  private initial = '';
  /** Steps the user tried to leave: their messages update as fields are fixed. */
  private readonly attempted = signal<ReadonlySet<Step>>(new Set());

  constructor() {
    effect(() => {
      const s = this.step();
      if (!this.attempted().has(s) || s === 3) return;
      // Re-check the step whenever one of its fields changes (reads below are tracked).
      void [this.name(), this.hostCode(), this.hostType(), this.regCountry(), this.ownerTeam(), this.caps(), this.iTimeout(), this.iUrl()];
      untracked(() => this.checkStep(s, true));
    });
  }

  protected readonly title = computed(() => (this.existing() ? `Edit ${this.existing()!.host.name}` : 'Add Host'));
  /** A saved (non-draft) host can't go back to being a draft. */
  protected readonly canDraft = computed(() => !this.existing() || this.existing()!.host.draft);
  protected readonly newMethods = computed(() => hostMethods(this.newCountry()).filter((m) => !this.caps().some((c) => c.countryCode === this.newCountry() && c.paymentMethodCode === m.code)));
  protected readonly adapterHint = computed(() => HOST_ADAPTERS.find((a) => a.id === this.iAdapter())?.description ?? null);
  protected readonly urlError = computed(() => {
    const u = this.iUrl().trim();
    if (!u) return null;
    return /^https?:\/\/[a-z0-9.-]+(:\d+)?(\/\S*)?$/i.test(u) ? null : 'Enter a valid URL, e.g. https://api.provider.example/v1';
  });
  protected readonly credentialText = computed(() => this.existing()?.integration?.credentialReferenceMasked ?? 'Assigned when you save (simulated)');
  protected readonly partnerName = computed(() => this.partners().find((p) => p.id === this.partnerId())?.name ?? 'None');
  protected readonly byCountry = computed(() => {
    const out = new Map<string, string[]>();
    for (const c of this.caps()) out.set(c.countryCode, [...(out.get(c.countryCode) ?? []), `${methodName(c.countryCode, c.paymentMethodCode)} (${this.flowOf(c)}${c.availabilityStatus !== 'available' ? ', ' + AVAILABILITY_LABEL[c.availabilityStatus] : ''})`]);
    return [...out.entries()].map(([code, methods]) => ({ code, name: countryName(code), currency: this.currencyOf(code), methods: methods.join(' · ') }));
  });

  ngOnInit() {
    const d = this.existing();
    if (d) {
      const h = d.host;
      this.name.set(h.name);
      this.hostCode.set(h.hostCode);
      this.description.set(h.description);
      this.partnerId.set(h.associatedPartnerId ?? '');
      this.hostType.set(h.hostType);
      this.regCountry.set(h.registrationCountry);
      this.ownerTeam.set(h.ownerTeam);
      this.notes.set(h.notes);
      this.caps.set(d.capabilities.map((c) => ({ countryCode: c.countryCode, paymentMethodCode: c.paymentMethodCode, availabilityStatus: c.availabilityStatus })));
      const i = d.integration;
      if (i) {
        this.iName.set(i.integrationName);
        this.iAdapter.set(i.adapterType);
        this.iUrl.set(i.apiBaseUrl);
        this.iVersion.set(i.apiVersion);
        this.iEnv.set(i.environment);
        this.iAuth.set(i.authenticationType);
        this.cfg.set({ ...i.authConfig });
        this.iTimeout.set(i.timeoutSeconds === null ? '' : String(i.timeoutSeconds));
        this.iConn.set(i.connectionConfig);
        this.iNotes.set(i.notes);
      }
    }
    this.step.set(this.startStep());
    this.initial = JSON.stringify(this.input(false));
  }

  protected v(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected err(field: string): string | null {
    const server = this.serverErrors()[field];
    // A server message (e.g. a duplicate host code) stays until that field changes.
    return this.errors()[field] ?? (server && server.value === this.fieldValue(field) ? server.message : null);
  }

  private fieldValue(field: string): string {
    const map: Record<string, () => string> = {
      'basic.name': this.name,
      'basic.hostCode': this.hostCode,
      'basic.hostType': this.hostType,
      'basic.registrationCountry': this.regCountry,
      'basic.ownerTeam': this.ownerTeam,
      'basic.associatedPartnerId': this.partnerId,
      'integration.timeoutSeconds': this.iTimeout,
      capabilities: () => JSON.stringify(this.caps()),
    };
    return map[field]?.() ?? '';
  }

  protected flowOf(c: CapRow): string {
    const m = hostMethods(c.countryCode).find((x) => x.code === c.paymentMethodCode);
    return m ? PAYMENT_FLOW_LABEL[m.flow] : '—';
  }

  protected currencyOf(code: string): string {
    return hostCountries().find((c) => c.code === code)?.currency ?? '';
  }

  protected setCfg(key: keyof HostAuthConfig, value: string) {
    this.cfg.update((c) => ({ ...c, [key]: value }));
  }

  protected addCap() {
    if (!this.newMethod()) return;
    this.caps.update((list) => [...list, { countryCode: this.newCountry(), paymentMethodCode: this.newMethod(), availabilityStatus: this.newAvail() }]);
    this.newMethod.set('');
    this.clearError('capabilities');
  }

  protected removeCap(i: number) {
    this.caps.update((list) => list.filter((_, j) => j !== i));
  }

  protected setAvail(i: number, value: string) {
    this.caps.update((list) => list.map((c, j) => (j === i ? { ...c, availabilityStatus: value as AvailabilityStatus } : c)));
  }

  protected next() {
    if (!this.checkStep(this.step())) return;
    this.step.update((s) => (s + 1) as Step);
  }

  protected back() {
    this.step.update((s) => Math.max(0, s - 1) as Step);
  }

  protected requestClose() {
    if (this.busy()) return;
    if (this.askDiscard()) return this.askDiscard.set(false);
    if (JSON.stringify(this.input(false)) !== this.initial) return this.askDiscard.set(true);
    this.closed.emit();
  }

  protected async save(draft: boolean) {
    if (draft) {
      if (!this.checkDraft()) return;
    } else {
      for (const s of [0, 1, 2] as Step[]) {
        if (!this.checkStep(s)) return this.step.set(s);
      }
    }
    this.busy.set(true);
    this.serverError.set(null);
    try {
      const body = this.input(draft);
      const id = this.existing()?.host.id;
      const res = id ? await this.api.update(id, body) : await this.api.create(body);
      this.saved.emit(res);
    } catch (e) {
      const err = toHostError(e);
      if (err.errors.length) {
        this.serverErrors.set(
          Object.fromEntries(
            err.errors.map((x) => {
              const field = x.field.startsWith('capabilities.') ? 'capabilities' : x.field;
              return [field, { message: x.message, value: this.fieldValue(field) }];
            }),
          ),
        );
        const first = err.errors[0].field;
        this.step.set(first.startsWith('basic') ? 0 : first.startsWith('capabilities') ? 1 : 2);
      }
      this.serverError.set(err.message ?? "We couldn't save the host. Please try again.");
    } finally {
      this.busy.set(false);
    }
  }

  // ------------------------------------------------------------- helpers

  private input(draft: boolean): HostDraftInput {
    const hasIntegration = !!(this.iName() || this.iAdapter() || this.iUrl() || this.iAuth() || this.existing()?.integration);
    const timeout = this.iTimeout().trim();
    return {
      draft,
      basic: {
        name: this.name().trim(),
        hostCode: this.hostCode().trim(),
        description: this.description().trim(),
        hostType: this.hostType() as never,
        associatedPartnerId: this.partnerId() || null,
        registrationCountry: this.regCountry(),
        ownerTeam: this.ownerTeam().trim(),
        notes: this.notes().trim(),
      },
      capabilities: this.caps(),
      integration: hasIntegration
        ? {
            integrationName: this.iName().trim(),
            adapterType: this.iAdapter(),
            apiBaseUrl: this.iUrl().trim(),
            apiVersion: this.iVersion().trim(),
            environment: this.iEnv(),
            authenticationType: this.iAuth(),
            authConfig: this.relevantCfg(),
            timeoutSeconds: timeout === '' ? null : (Number(timeout) as number),
            connectionConfig: this.iConn().trim(),
            notes: this.iNotes().trim(),
          }
        : null,
    };
  }

  /** Only the fields of the chosen authentication method are kept. */
  private relevantCfg(): HostAuthConfig {
    const c = this.cfg();
    const keys: Record<AuthMethod, (keyof HostAuthConfig)[]> = { api_key: ['keyHeader'], api_key_secret: ['keyHeader', 'signature'], oauth2: ['tokenUrl', 'clientId', 'scope'], mtls: [], other: ['description'] };
    const out: HostAuthConfig = {};
    for (const k of this.iAuth() ? keys[this.iAuth()!] : []) if (c[k]?.trim()) out[k] = c[k]!.trim();
    return out;
  }

  private checkDraft(): boolean {
    const e: Record<string, string> = {};
    if (!this.name().trim()) e['basic.name'] = 'Enter the host name.';
    this.codeError(e);
    this.errors.set(e);
    if (Object.keys(e).length) this.step.set(0);
    return !Object.keys(e).length;
  }

  private checkStep(s: Step, live = false): boolean {
    if (!live) this.attempted.update((a) => new Set([...a, s]));
    const e: Record<string, string> = { ...this.errors() };
    for (const k of Object.keys(e)) if (k.startsWith(s === 0 ? 'basic' : s === 1 ? 'capabilities' : 'integration')) delete e[k];
    if (s === 0) {
      if (!this.name().trim()) e['basic.name'] = 'Enter the host name.';
      this.codeError(e);
      if (!this.hostType()) e['basic.hostType'] = 'Choose the host type.';
      if (!this.regCountry()) e['basic.registrationCountry'] = 'Choose the country of registration.';
      if (!this.ownerTeam().trim()) e['basic.ownerTeam'] = 'Enter the responsible team.';
    } else if (s === 1) {
      if (!this.caps().length) e['capabilities'] = 'Add at least one country and payment method.';
    } else if (s === 2) {
      const t = this.iTimeout().trim();
      if (t && (!/^\d+$/.test(t) || +t < 1 || +t > 600)) e['integration.timeoutSeconds'] = 'Enter a whole number of seconds (1–600).';
      if (this.urlError()) e['integration.apiBaseUrl'] = this.urlError()!;
    }
    this.errors.set(e);
    if (!live) this.serverError.set(null);
    return !Object.keys(e).some((k) => k.startsWith(s === 0 ? 'basic' : s === 1 ? 'capabilities' : 'integration'));
  }

  private codeError(e: Record<string, string>) {
    const code = this.hostCode().trim();
    if (!code) e['basic.hostCode'] = 'Enter a host code.';
    else if (!HOST_CODE_RE.test(code)) e['basic.hostCode'] = 'Use 2–20 letters, numbers, dashes or underscores, starting with a letter or number.';
  }

  private clearError(field: string) {
    this.errors.update(({ [field]: _, ...rest }) => rest);
  }
}
