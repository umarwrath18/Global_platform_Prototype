import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { countryName } from '../../core/merchants/onboarding-config';
import { HostPerformance, OverrideView, ROUTE_MODE_LABEL, ROUTE_STATE_LABEL, RouteDecision, RouteState, RouteView, RoutingActivity, RoutingResponse } from '../../core/routing/routing';
import { RoutingApi, toRoutingError } from '../../core/routing/routing-api.service';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { Icon } from '../../shared/icon';
import { Pager } from '../../shared/pager';
import { SideSheet } from '../../shared/side-sheet';
import { fmtWhen } from '../hosts/host-ui';
import { OverrideSheet } from './override-sheet';
import { RouteSheet } from './route-sheet';

type Tab = 'routes' | 'overrides' | 'checker' | 'performance' | 'activity';
const TABS: { id: Tab; label: string }[] = [
  { id: 'routes', label: 'Routes' },
  { id: 'overrides', label: 'Merchant overrides' },
  { id: 'checker', label: 'Route checker' },
  { id: 'performance', label: 'Performance' },
  { id: 'activity', label: 'Activity Log' },
];

/**
 * Routing (Batch 5B + 5C): default routes per country + payment method, merchant overrides, a
 * route checker, simulated performance for Smart routing, and the activity log (`?tab=`).
 */
@Component({
  selector: 'app-routing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Pager, SideSheet, CodePrompt, RouteSheet, OverrideSheet],
  styleUrls: ['../hosts/hosts.scss', './routing.scss'],
  template: `
<main class="page host-page">
  <div class="host-head">
    <div>
      <h1>Routing <span class="sample-tag" title="No live payments are routed in this prototype.">Sample data</span></h1>
      <p>Decide which partner each payment goes to: by priority, by percentage split, or Smart (simulated performance).</p>
    </div>
    @if (data()?.can?.manage && tab() === 'overrides') {
      <div class="actions"><button type="button" class="btn primary" (click)="overrideSheet.set({ o: null })"><app-icon name="plus" [size]="16" />Add override</button></div>
    }
  </div>

  <nav class="host-tabs" aria-label="Routing">
    @for (t of tabs; track t.id) {
      <a [routerLink]="[]" [queryParams]="{ tab: t.id === 'routes' ? null : t.id }" [class.on]="tab() === t.id" [attr.aria-current]="tab() === t.id ? 'page' : null">{{ t.label }}</a>
    }
  </nav>

  @if (toast(); as t) {<div class="alert success compact" role="status"><app-icon name="check-circle" /><div>{{ t }}</div></div>}

  @if (error(); as e) {
    <div class="empty-state" role="alert"><div class="icon-tile"><app-icon name="alert-circle" /></div><h3>We couldn't load Routing</h3><p>{{ e }}</p><button type="button" class="btn" (click)="load()">Try again</button></div>
  } @else if (!data()) {
    <div class="skeleton-rows" aria-busy="true" aria-label="Loading routing"><span></span><span></span><span></span><span></span></div>
  } @else {
    @let d = data()!;
    @switch (tab()) {
      @case ('routes') {
        <div class="host-kpis" aria-label="Summary">
          <div class="host-kpi"><span>Routes</span><strong>{{ d.summary.routes }}</strong><span>Country + payment method</span></div>
          <div class="host-kpi good"><span>Routing normally</span><strong>{{ d.summary.routing }}</strong></div>
          <div class="host-kpi" [class.warn]="d.summary.fallback > 0"><span>Using fallback</span><strong>{{ d.summary.fallback }}</strong></div>
          <div class="host-kpi" [class.bad]="d.summary.none > 0"><span>No eligible host</span><strong>{{ d.summary.none }}</strong><span>Payments would fail</span></div>
        </div>
        <section class="panel-card">
          <form class="host-filters" role="search" aria-label="Filter routes" (submit)="$event.preventDefault()">
            <label class="fld">Country<select class="f-input" (change)="fCountry.set(v($event))"><option value="">All countries</option>@for (c of countries(); track c) {<option [value]="c" [selected]="c === fCountry()">{{ cname(c) }}</option>}</select></label>
            <label class="fld">Mode<select class="f-input" (change)="fMode.set(v($event))"><option value="">All modes</option>@for (m of modeKeys; track m) {<option [value]="m" [selected]="m === fMode()">{{ modeLabel[m] }}</option>}</select></label>
            <label class="fld">State<select class="f-input" (change)="fState.set(v($event))"><option value="">All states</option>@for (s of stateKeys; track s) {<option [value]="s" [selected]="s === fState()">{{ stateLabel[s] }}</option>}</select></label>
          </form>
          @if (!routes().length) {
            <div class="empty-state"><h3>No routes match these filters.</h3></div>
          } @else {
            <div class="table-wrap">
              <table class="data-table host-table rt-table">
                <thead><tr><th scope="col">Country · Method</th><th scope="col">Mode</th><th scope="col">Partners (in order)</th><th scope="col">Fallback</th><th scope="col">Eligible partners</th><th scope="col">State</th>@if (d.can.manage) {<th scope="col"><span class="sr-only">Actions</span></th>}</tr></thead>
                <tbody>
                  @for (r of routes(); track r.key) {
                    <tr>
                      <td><strong>{{ r.countryName }}</strong><span class="sub-line">{{ r.methodName }} · {{ r.flow === 'payout' ? 'Payout' : 'PayIn' }}@if (r.overrideCount) { · {{ r.overrideCount }} override{{ r.overrideCount === 1 ? '' : 's' }}}</span></td>
                      <td>@if (r.route; as rt) {<span class="rt-mode" [class]="'rt-mode m-' + rt.mode">{{ modeLabel[rt.mode] }}</span>} @else {<span class="muted">—</span>}</td>
                      <td>
                        @if (r.route; as rt) {
                          <div class="rt-hops">
                            @for (h of rt.hosts; track h.hostId; let i = $index; let last = $last) {
                              <span class="rt-hop" [class.off]="!eligible(r, h.hostId)" [attr.title]="reasonOf(r, h.hostId)"><i>{{ rt.mode === 'split' ? h.share + '%' : rt.mode === 'smart' ? rankOf(r, h.hostId) : i + 1 }}</i>{{ hostName(r, h.hostId) }}</span>
                              @if (rt.mode === 'priority' && !last) {<span class="rt-arr" aria-hidden="true">→</span>}
                            }
                          </div>
                          @if (rt.mode === 'smart' && r.effective[0]; as top) {<span class="sub-line">Top now: {{ top.name }} · {{ top.successRate }} % · {{ top.avgResponseMs }} ms (simulated)</span>}
                        } @else {<span class="muted">No route yet</span>}
                      </td>
                      <td>{{ r.route ? (r.route.fallback ? 'On' : 'Off') : '—' }}</td>
                      <td>{{ r.eligibleCount }} of {{ r.route ? r.route.hosts.length : r.options.length }}</td>
                      <td><span [class]="stateTone(r.state)">{{ stateLabel[r.state] }}</span>@if (r.stateNote && r.state !== 'not_set') {<span class="sub-line">{{ r.stateNote }}</span>}</td>
                      @if (d.can.manage) {<td><button type="button" class="btn sm" (click)="routeSheet.set(r)">{{ r.route ? 'Edit' : 'Set route' }}</button></td>}
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="rt-foot">Eligible = partner Active in Partners and that payment method Available. Struck-through partners are skipped.</p>
          }
        </section>
      }

      @case ('overrides') {
        <p class="rt-intro">A merchant or sub-merchant pinned to a specific partner for one country and payment method. Overrides come before the default route.</p>
        <section class="panel-card">
          @if (!d.overrides.length) {
            <div class="empty-state"><h3>No merchant overrides</h3><p>Every merchant follows the default routes.</p>@if (d.can.manage) {<button type="button" class="btn primary" (click)="overrideSheet.set({ o: null })">Add override</button>}</div>
          } @else {
            <div class="table-wrap">
              <table class="data-table host-table">
                <thead><tr><th scope="col">Merchant</th><th scope="col">Country · Method</th><th scope="col">Pinned partner</th><th scope="col">If the partner is not eligible</th><th scope="col">Reason</th><th scope="col">Updated</th>@if (d.can.manage) {<th scope="col"><span class="sr-only">Actions</span></th>}</tr></thead>
                <tbody>
                  @for (o of d.overrides; track o.id) {
                    <tr>
                      <td><strong>{{ o.merchantName }}</strong><span class="sub-line">{{ o.subMerchantId ?? o.merchantId }}</span></td>
                      <td>{{ o.countryName }}<span class="sub-line">{{ o.methodName }}</span></td>
                      <td><span class="rt-hop" [class.off]="!o.hostEligible"><i aria-hidden="true">●</i>{{ o.hostName }}</span>@if (!o.hostEligible) {<span class="sub-line warn-text">{{ o.hostReason }}</span>}</td>
                      <td>@if (o.fallbackToRoute) {Use the default route} @else {<span class="danger-text">Payment fails</span>}</td>
                      <td class="wrap">{{ o.reason }}</td>
                      <td>{{ when(o.updatedAt) }}<span class="sub-line">{{ o.updatedBy }}</span></td>
                      @if (d.can.manage) {<td><div class="row-actions"><button type="button" class="btn sm" (click)="overrideSheet.set({ o })">Edit</button><button type="button" class="btn sm danger-outline" (click)="askRemove(o)">Remove</button></div></td>}
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      @case ('checker') {
        <div class="rt-check">
          <form class="panel-card rt-check-form" (submit)="$event.preventDefault(); runCheck()">
            <h2>Which partner would this payment use?</h2>
            <p class="f-hint">Runs the current rules. Nothing is sent to a provider.</p>
            <div class="f-field"><label for="ck-merchant">Merchant</label>
              <select id="ck-merchant" class="f-input" (change)="ckMerchant.set(v($event)); ckCountry.set(''); ckMethod.set('')">
                <option value="">No specific merchant (default route)</option>
                @for (m of checkMerchants(); track m.key) {<option [value]="m.key" [selected]="m.key === ckMerchant()">{{ m.name }}</option>}
              </select></div>
            <div class="f-grid">
              <div class="f-field"><label for="ck-country">Country</label>
                <select id="ck-country" class="f-input" (change)="ckCountry.set(v($event)); ckMethod.set('')">
                  <option value="" [selected]="!ckCountry()">Select country</option>
                  @for (c of checkCountries(); track c) {<option [value]="c" [selected]="c === ckCountry()">{{ cname(c) }}</option>}
                </select></div>
              <div class="f-field"><label for="ck-method">Payment method</label>
                <select id="ck-method" class="f-input" (change)="ckMethod.set(v($event))">
                  <option value="" [selected]="!ckMethod()">Select method</option>
                  @for (m of checkMethods(); track m.code) {<option [value]="m.code" [selected]="m.code === ckMethod()">{{ m.name }}</option>}
                </select></div>
            </div>
            <div class="f-field"><label for="ck-amount">Amount (optional)</label><input id="ck-amount" class="f-input" inputmode="decimal" maxlength="15" [value]="ckAmount()" (input)="ckAmount.set(v($event))" /></div>
            <div><button type="submit" class="btn primary" [disabled]="!ckCountry() || !ckMethod() || ckBusy()">@if (ckBusy()) {<span class="spinner" aria-hidden="true"></span>}Check route</button></div>
          </form>
          <aside class="panel-card rt-result" aria-live="polite">
            @if (result(); as res) {
              <div class="rt-win" [class.fail]="!res.hostId">
                <span>{{ res.hostId ? 'Routed to' : 'Payment fails' }}</span>
                <strong>{{ res.hostName ?? 'No eligible host' }}</strong>
                <small>{{ res.route }}@if (res.hostId) { · {{ viaLabel[res.via] }}}@if (res.usedFallback) { · fallback}@if (res.simulated) { · simulated}</small>
              </div>
              <h3>How it was decided</h3>
              <ol class="rt-path">
                @for (s of res.steps; track $index) {<li><span class="rt-dot" [class]="'rt-dot ' + s.kind" aria-hidden="true">{{ s.kind === 'ok' ? '✓' : s.kind === 'fail' ? '✕' : s.kind === 'skip' ? '–' : 'i' }}</span><div><strong>{{ s.title }}</strong><span class="sub-line">{{ s.detail }}</span></div></li>}
              </ol>
            } @else {
              <p class="f-hint">Choose a country and payment method, then Check route.</p>
            }
            @if (ckError(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
          </aside>
        </div>
      }

      @case ('performance') {
        <div class="host-banner warn" role="note"><app-icon name="info" /><div><span class="sim-tag">Simulated</span> These numbers are generated for the prototype so Smart routing can be shown. They are not real provider data and must not be used for decisions.</div></div>
        <section class="panel-card">
          <form class="host-filters" role="search" aria-label="Filter performance" (submit)="$event.preventDefault()">
            <label class="fld">Country<select class="f-input" (change)="pCountry.set(v($event))"><option value="">All countries</option>@for (c of countries(); track c) {<option [value]="c" [selected]="c === pCountry()">{{ cname(c) }}</option>}</select></label>
          </form>
          <div class="table-wrap">
            <table class="data-table host-table">
              <thead><tr><th scope="col">Partner</th><th scope="col">Country</th><th scope="col">Payment method</th><th scope="col" class="num">Success rate</th><th scope="col" class="num">Avg response</th><th scope="col" class="num">Attempts (24 h)</th><th scope="col">Used in</th></tr></thead>
              <tbody>
                @for (p of perfRows(); track p.hostId + p.country + p.methodCode) {
                  <tr>
                    <td><strong>{{ p.hostName }}</strong></td><td>{{ cname(p.country) }}</td><td>{{ p.methodName }}</td>
                    <td class="num mono">{{ p.successRate === null ? '—' : p.successRate + ' %' }}</td>
                    <td class="num mono">{{ p.avgResponseMs === null ? '—' : p.avgResponseMs + ' ms' }}</td>
                    <td class="num mono">{{ p.attempts ? p.attempts.toLocaleString('en-GB') : '0' }}</td>
                    <td>{{ usedIn(p) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="rt-foot">Smart score = success rate and speed, weighted per route. Figures refresh every 15 minutes (simulated). Partners that are not Active have none.</p>
        </section>
      }

      @case ('activity') {
        <section class="panel-card">
          @if (!activity().length) {
            <div class="empty-state"><h3>No activity yet.</h3></div>
          } @else {
            <div class="table-wrap">
              <table class="data-table host-table">
                <thead><tr><th scope="col">Date and Time</th><th scope="col">Activity</th><th scope="col">Route or override</th><th scope="col">Performed By</th><th scope="col">Details</th></tr></thead>
                <tbody>@for (a of activityPage(); track a.id) {<tr><td class="mono">{{ when(a.at) }}</td><td><strong>{{ a.action }}</strong></td><td>{{ a.subject }}</td><td>{{ a.by }}</td><td class="wrap">{{ a.details }}</td></tr>}</tbody>
              </table>
            </div>
            <app-pager [total]="activity().length" [(page)]="aPage" [(pageSize)]="aPageSize" />
          }
        </section>
      }
    }
  }

  @if (routeSheet(); as r) {
    <app-route-sheet [view]="r" [performance]="performance()" (done)="onRouteSaved($event)" (closed)="routeSheet.set(null)" />
  }
  @if (overrideSheet(); as s) {
    <app-override-sheet [data]="data()!" [existing]="s.o" (done)="onOverrideSaved($event, !!s.o)" (closed)="overrideSheet.set(null)" />
  }
  @if (removing(); as o) {
    <app-side-sheet [label]="'Remove override for ' + o.merchantName" (dismiss)="closeRemove()">
      <header class="sheet-head">
        <div class="sheet-titles"><p class="sheet-eyebrow">Routing · Merchant override</p><h2 class="sheet-title">Remove override?</h2><p class="sheet-sub">{{ o.merchantName }} · {{ o.countryName }} · {{ o.methodName }}</p></div>
        <button type="button" class="sheet-close" (click)="closeRemove()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
      </header>
      <div class="sheet-body">
        <p>Payments from {{ o.merchantName }} for {{ o.methodName }} in {{ o.countryName }} will use the default route again instead of {{ o.hostName }}.</p>
        @if (rmError(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
      </div>
      @if (rmCode()) {
        <app-code-prompt title="Confirm it's you" message="Enter a code from your authenticator app." confirmLabel="Remove override" tone="danger" [busy]="rmBusy()" [error]="rmCodeError()" (confirmed)="remove($event)" (cancelled)="rmCode.set(false)" />
      } @else {
        <footer class="sheet-foot"><span class="sheet-foot-note"></span><button type="button" class="btn" (click)="closeRemove()" [disabled]="rmBusy()">Cancel</button><button type="button" class="btn danger" (click)="remove()" [disabled]="rmBusy()">@if (rmBusy()) {<span class="spinner" aria-hidden="true"></span>}Remove override</button></footer>
      }
    </app-side-sheet>
  }
</main>
  `,
})
export class RoutingPage {
  private readonly api = inject(RoutingApi);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  private readonly prompt = viewChild(CodePrompt);

  protected readonly tabs = TABS;
  protected readonly tab = computed<Tab>(() => TABS.find((t) => t.id === this.params().get('tab'))?.id ?? 'routes');
  protected readonly modeLabel = ROUTE_MODE_LABEL;
  protected readonly modeKeys = Object.keys(ROUTE_MODE_LABEL) as (keyof typeof ROUTE_MODE_LABEL)[];
  protected readonly stateLabel = ROUTE_STATE_LABEL;
  protected readonly stateKeys = Object.keys(ROUTE_STATE_LABEL) as RouteState[];
  protected readonly viaLabel: Record<RouteDecision['via'], string> = { override: 'merchant override', priority: 'priority', split: 'percentage split', smart: 'Smart', none: '' };
  protected readonly cname = countryName;
  protected readonly when = fmtWhen;

  protected readonly data = signal<RoutingResponse | null>(null);
  protected readonly performance = signal<HostPerformance[]>([]);
  protected readonly activity = signal<RoutingActivity[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly toast = signal<string | null>(null);
  protected readonly routeSheet = signal<RouteView | null>(null);
  protected readonly overrideSheet = signal<{ o: OverrideView | null } | null>(null);

  protected readonly fCountry = signal('');
  protected readonly fMode = signal('');
  protected readonly fState = signal('');
  protected readonly pCountry = signal('');
  protected readonly aPage = signal(0);
  protected readonly aPageSize = signal(25);

  protected readonly ckMerchant = signal('');
  protected readonly ckCountry = signal('');
  protected readonly ckMethod = signal('');
  protected readonly ckAmount = signal('');
  protected readonly ckBusy = signal(false);
  protected readonly ckError = signal<string | null>(null);
  protected readonly result = signal<(RouteDecision & { route: string; simulated: boolean }) | null>(null);

  protected readonly removing = signal<OverrideView | null>(null);
  protected readonly rmBusy = signal(false);
  protected readonly rmCode = signal(false);
  protected readonly rmError = signal<string | null>(null);
  protected readonly rmCodeError = signal<string | null>(null);

  protected readonly countries = computed(() => [...new Set((this.data()?.routes ?? []).map((r) => r.country))]);
  protected readonly routes = computed(() =>
    (this.data()?.routes ?? []).filter((r) => (!this.fCountry() || r.country === this.fCountry()) && (!this.fMode() || r.route?.mode === this.fMode()) && (!this.fState() || r.state === this.fState())),
  );
  protected readonly perfRows = computed(() => this.performance().filter((p) => !this.pCountry() || p.country === this.pCountry()));
  protected readonly activityPage = computed(() => this.activity().slice(this.aPage() * this.aPageSize(), (this.aPage() + 1) * this.aPageSize()));

  // Route checker: merchant → its live countries → its methods; without a merchant, every route.
  protected readonly checkMerchants = computed(() => {
    const seen = new Map<string, { key: string; name: string }>();
    for (const m of this.data()?.merchants ?? []) seen.set(`${m.merchantId}|${m.subMerchantId ?? ''}`, { key: `${m.merchantId}|${m.subMerchantId ?? ''}`, name: m.name });
    return [...seen.values()];
  });
  private readonly ckEntries = computed(() => (this.data()?.merchants ?? []).filter((m) => `${m.merchantId}|${m.subMerchantId ?? ''}` === this.ckMerchant()));
  protected readonly checkCountries = computed(() => (this.ckMerchant() ? [...new Set(this.ckEntries().map((m) => m.country))] : this.countries()));
  protected readonly checkMethods = computed(() =>
    this.ckMerchant()
      ? (this.ckEntries().find((m) => m.country === this.ckCountry())?.methods ?? [])
      : (this.data()?.routes ?? []).filter((r) => r.country === this.ckCountry()).map((r) => ({ code: r.methodCode, name: r.methodName })),
  );

  constructor() {
    effect(() => {
      this.tab();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.error.set(null);
    try {
      const [overview, perf, activity] = await Promise.all([this.api.overview(), this.api.performance(), this.api.activity()]);
      this.data.set(overview);
      this.performance.set(perf);
      this.activity.set(activity);
    } catch (e) {
      this.error.set(toRoutingError(e).message ?? 'Please try again in a moment.');
    }
  }

  protected v(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected hostName(r: RouteView, id: string) {
    return r.options.find((o) => o.hostId === id)?.name ?? 'Removed host';
  }

  protected eligible(r: RouteView, id: string) {
    return !!r.options.find((o) => o.hostId === id)?.eligible;
  }

  protected reasonOf(r: RouteView, id: string) {
    return r.options.find((o) => o.hostId === id)?.reason || 'Eligible';
  }

  protected rankOf(r: RouteView, id: string) {
    const i = r.effective.findIndex((e) => e.hostId === id);
    return i < 0 ? '–' : i === 0 ? '★' : String(i + 1);
  }

  protected stateTone(s: RouteState) {
    return { routing: 'status success', fallback: 'status warning', at_risk: 'status warning', none: 'status danger', not_set: 'status' }[s];
  }

  protected usedIn(p: HostPerformance) {
    const r = this.data()?.routes.find((x) => x.country === p.country && x.methodCode === p.methodCode);
    const rt = r?.route;
    if (!rt) return '—';
    const i = rt.hosts.findIndex((h) => h.hostId === p.hostId);
    if (i < 0) return '—';
    return rt.mode === 'priority' ? `Priority #${i + 1}` : rt.mode === 'split' ? `Split ${rt.hosts[i].share} %` : 'Smart';
  }

  protected async runCheck() {
    const [merchantId, sub] = this.ckMerchant().split('|');
    this.ckBusy.set(true);
    this.ckError.set(null);
    try {
      this.result.set(await this.api.check({ merchantId: merchantId || null, subMerchantId: sub || null, country: this.ckCountry(), methodCode: this.ckMethod(), amount: this.ckAmount() ? Number(this.ckAmount().replace(/,/g, '')) || null : null }));
    } catch (e) {
      this.ckError.set(toRoutingError(e).message ?? "We couldn't check the route.");
    } finally {
      this.ckBusy.set(false);
    }
  }

  protected onRouteSaved(r: RouteView) {
    this.routeSheet.set(null);
    this.flash(`Route saved: ${r.countryName} · ${r.methodName}`);
    void this.load();
  }

  protected onOverrideSaved(o: OverrideView, edited: boolean) {
    this.overrideSheet.set(null);
    this.flash(`${edited ? 'Override saved' : 'Override added'}: ${o.merchantName} → ${o.hostName}`);
    void this.load();
  }

  protected askRemove(o: OverrideView) {
    this.rmError.set(null);
    this.rmCode.set(false);
    this.removing.set(o);
  }

  protected closeRemove() {
    if (this.rmBusy()) return;
    if (this.rmCode()) return this.rmCode.set(false);
    this.removing.set(null);
  }

  protected async remove(code?: string) {
    const o = this.removing();
    if (!o) return;
    this.rmBusy.set(true);
    this.rmError.set(null);
    this.rmCodeError.set(null);
    try {
      await this.api.removeOverride(o.id, code);
      this.removing.set(null);
      this.rmCode.set(false);
      this.flash(`Override removed: ${o.merchantName} uses the default route`);
      void this.load();
    } catch (e) {
      const err = toRoutingError(e);
      const mfa = this.rmCode() ? codeProblem(err.code, err.attemptsRemaining) : null;
      if (err.code === 'MFA_CODE_REQUIRED') this.rmCode.set(true);
      else if (mfa) {
        this.rmCodeError.set(mfa);
        this.prompt()?.reset();
      } else {
        this.rmCode.set(false);
        this.rmError.set(err.message ?? "That didn't work. Please try again.");
      }
    } finally {
      this.rmBusy.set(false);
    }
  }

  private flash(text: string) {
    this.toast.set(text);
    setTimeout(() => this.toast.set(null), 4000);
  }
}
