import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import {
  adapterLabel,
  AUTH_METHOD_LABEL,
  AVAILABILITY_LABEL,
  AvailabilityStatus,
  CostVersion,
  HOST_ENVIRONMENT_LABEL,
  HOST_STATUS_LABEL,
  HostCapabilityView,
  HostDetailResponse,
  hostTypeLabel,
  methodCategory,
  MethodCost,
  PAYMENT_FLOW_LABEL,
} from '../../core/hosts/hosts';
import { countryName, ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { countryProducts, fmtDay, PricingDraft, pricingHeadline, pricingSummary, PricingVersion, ProductPricingView, techniqueLabel } from '../../core/merchants/products';
import { OverrideView, RouteView, RoutingResponse } from '../../core/routing/routing';
import { RoutingApi } from '../../core/routing/routing-api.service';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';
import { HostAction, HostActionSheet } from '../hosts/host-action-sheet';
import { availabilityTone, fmtWhen, statusTone } from '../hosts/host-ui';
import { PricingEditor, PricingPreset } from '../products/pricing-editor';
import { RouteSheet } from '../routing/route-sheet';
import { SecretField } from './secret-field';

interface Row {
  cap: HostCapabilityView;
  cost: MethodCost;
  category: string;
  routing: string;
}

/**
 * A partner's page (like a merchant's): payment methods with their cost pricing and routing
 * position, routing, integration and credentials, partner details, the setup checklist and history.
 */
@Component({
  selector: 'app-partner-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, SideSheet, HostActionSheet, PricingEditor, RouteSheet, SecretField],
  styleUrls: ['../merchants/merchant-detail.scss', './partners.scss'],
  template: `
<main class="page">
  <ol class="crumbs"><li><a routerLink="/partners">Partners</a></li><li aria-current="page">{{ d()?.host?.name ?? id() }}</li></ol>
  @if (error(); as e) {
    <div class="empty-state" role="alert"><div class="icon-tile"><app-icon name="alert-circle" /></div><h3>{{ notFound() ? 'Partner not found' : "We couldn't load this partner" }}</h3><p>{{ e }}</p><a class="btn" routerLink="/partners">Back to Partners</a></div>
  } @else if (d(); as x) {
    @let h = x.host;
    <div class="portal-head">
      <div>
        <h1>{{ h.name }} @if (h.sample) {<span class="sample-tag">Sample</span>}</h1>
        <p class="sub"><span class="mono">{{ h.id }}</span> · {{ typeLabel(h.hostType) }} · {{ h.markets.join(', ') || cname(h.registrationCountry) }} · <span [class]="tone(h.status)">{{ statusLabel[h.status] }}</span></p>
      </div>
      @if (x.can.manage) {
        <div class="actions">
          @if (h.status === 'draft') {
            <a class="btn primary" [routerLink]="['/partners', h.id, 'setup']">Continue setup</a>
          } @else {
            <a class="btn" [routerLink]="['/partners', h.id, 'setup']"><app-icon name="edit" [size]="14" />Edit</a>
            @if (h.status === 'active') {
              <button type="button" class="btn" (click)="act.set('maintenance')">Maintenance</button>
              <button type="button" class="btn danger-outline" (click)="act.set('disable')">Disable</button>
            } @else if (h.status === 'maintenance') {
              <button type="button" class="btn primary" (click)="act.set('enable')">Re-enable</button>
              <button type="button" class="btn danger-outline" (click)="act.set('disable')">Disable</button>
            } @else {
              <button type="button" class="btn primary" (click)="act.set('enable')">Enable</button>
            }
          }
        </div>
      }
    </div>

    @if (toast(); as t) {<div class="alert success compact" role="status"><app-icon name="check-circle" /><div>{{ t }}</div></div>}
    @if (savedNote(); as n) {<div class="alert success compact" role="status"><app-icon name="check-circle" /><div>{{ n }}</div></div>}
    @if (h.maintenance; as m) {<div class="alert warning compact" role="note"><app-icon name="clock" /><div><strong>Under maintenance</strong> since {{ when(m.since) }} by {{ m.by }}: {{ m.reason }}@if (m.until) { · expected end {{ when(m.until) }}}</div></div>}
    @if (h.status === 'disabled' && h.disabledReason) {<div class="alert info compact" role="note"><app-icon name="info" /><div><strong>Disabled.</strong> {{ h.disabledReason }}</div></div>}
    @if (x.can.decidePricing && pendingCount()) {<div class="alert warning compact" role="note"><app-icon name="alert-circle" /><div><strong>{{ pendingCount() }} cost pricing change{{ pendingCount() === 1 ? '' : 's' }} waiting for FinOps.</strong> Review them under Payment methods &amp; cost.</div></div>}

    <div class="layout">
      <div class="col-main">
        <section class="panel-card" id="pricing">
          <div class="panel-head"><div><h2>Payment methods &amp; cost</h2><p>What {{ h.name }} processes, what it charges Mobi, and where it sits in routing.</p></div>
            @if (x.can.manage) {<a class="btn sm" [routerLink]="['/partners', h.id, 'setup']" [queryParams]="{ section: 'methods' }"><app-icon name="plus" [size]="14" />Add or remove methods</a>}</div>
          @if (rows().length) {
            <div class="table-wrap">
              <table class="data-table pt-table">
                <thead><tr><th scope="col">Payment method</th><th scope="col">Cost to Mobi</th><th scope="col">Routing</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  @for (r of rows(); track r.cap.id) {
                    <tr>
                      <td><strong>{{ r.cap.paymentMethodName }}</strong> <span [class]="availTone(r.cap.availabilityStatus)">{{ availLabel[r.cap.availabilityStatus] }}</span><span class="sub-line">{{ r.category }} · {{ r.cap.countryName }}</span></td>
                      <td class="pt-wrap">
                        @if (r.cost.current; as c) {
                          <span class="pt-cost">{{ head(c) }}</span><span class="sub-line">{{ techLabel(c.technique) }} · v{{ c.version }} · from {{ day(c.startDate) }}</span>
                        } @else if (r.cost.scheduled; as c) {
                          <span class="pt-cost">{{ head(c) }}</span><span class="sub-line">Starts {{ day(c.startDate) }}</span>
                        } @else {
                          <span class="status warning">Not set</span>
                        }
                        @if (r.cost.scheduled && r.cost.current; as _) {<span class="sub-line">Next: {{ head(r.cost.scheduled!) }} from {{ day(r.cost.scheduled!.startDate) }}</span>}
                        @if (r.cost.pending; as p) {<span class="sub-line warn-text">Waiting for FinOps: {{ head(p) }} from {{ day(p.startDate) }}</span>}
                      </td>
                      <td class="pt-wrap">{{ r.routing }}</td>
                      <td>
                        <div class="row-actions">
                          @if (r.cost.pending && x.can.decidePricing) {
                            <button type="button" class="btn sm primary" (click)="review.set({ v: r.cost.pending!, row: r })">Review</button>
                          }
                          @if (x.can.manage) {
                            @if (r.cost.pending) {
                              <button type="button" class="btn sm" (click)="withdraw(r.cost.pending!)" [disabled]="busy()">Withdraw</button>
                            } @else {
                              <button type="button" class="btn sm" (click)="openCost(r)">{{ r.cost.current || r.cost.scheduled ? 'Change cost' : 'Set cost' }}</button>
                            }
                            @if (r.cap.availabilityStatus === 'disabled') {
                              <button type="button" class="btn sm" (click)="setAvail(r.cap, 'available')" [disabled]="busy()">Switch on</button>
                            } @else {
                              <button type="button" class="btn sm ghost" (click)="setAvail(r.cap, 'disabled')" [disabled]="busy()">Switch off</button>
                            }
                          }
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="pt-foot">Cost pricing uses the same models and rules as merchant pricing. FinOps approves every change; the cost in effect stays until then. Switching a method off never changes the partner's status.</p>
          } @else {
            <div class="empty-state"><h3>No payment methods yet</h3>@if (x.can.manage) {<a class="btn primary" [routerLink]="['/partners', h.id, 'setup']" [queryParams]="{ section: 'methods' }">Add payment methods</a>}</div>
          }
        </section>

        <section class="panel-card">
          <div class="panel-head"><div><h2>Routing</h2><p>Where {{ h.name }} sits in each route. Changes here edit the same routes as the Routing page.</p></div><a class="btn sm" routerLink="/routing">Open Routing</a></div>
          <div class="panel-body pt-routes">
            @for (r of myRoutes(); track r.view.key) {
              <div class="pt-route">
                <span class="pt-pos" [class.warn]="r.warn" [class.none]="!r.view.route">{{ r.badge }}</span>
                <div class="pt-route-text"><strong>{{ r.view.countryName }} · {{ r.view.methodName }}</strong><span class="sub-line">{{ r.text }}</span></div>
                @if (routingManage()) {<button type="button" class="btn sm" (click)="routeSheet.set(r.view)">{{ r.view.route ? 'Edit route' : 'Set route' }}</button>}
              </div>
            } @empty {
              <p class="muted">No routes yet: add payment methods first.</p>
            }
            @for (o of myOverrides(); track o.id) {
              <div class="pt-route">
                <span class="pt-pos none"><app-icon name="route" [size]="16" /></span>
                <div class="pt-route-text"><strong>Merchant override · {{ o.merchantName }}</strong><span class="sub-line">{{ o.countryName }} · {{ o.methodName }} pinned to {{ h.name }} · {{ o.fallbackToRoute ? 'falls back to the default route' : 'no fallback' }}</span></div>
                <a class="btn sm" routerLink="/routing" [queryParams]="{ tab: 'overrides' }">Open overrides</a>
              </div>
            }
          </div>
        </section>

        <section class="panel-card">
          <div class="panel-head"><div><h2>Integration</h2><p>How Mobi's integration layer reaches {{ h.name }}.</p></div>@if (x.can.manage) {<a class="btn sm" [routerLink]="['/partners', h.id, 'setup']" [queryParams]="{ section: 'integration' }"><app-icon name="edit" [size]="14" />Edit</a>}</div>
          <div class="panel-body">
            @if (x.integration; as i) {
              <dl class="kv">
                <div><dt>Adapter</dt><dd>{{ adapter(i.adapterType) || '—' }}</dd></div>
                <div><dt>Environment</dt><dd>{{ envLabel[i.environment] }}</dd></div>
                <div><dt>Authentication</dt><dd>{{ i.authenticationType ? authLabel[i.authenticationType] : '—' }}</dd></div>
                <div class="wide"><dt>API base URL</dt><dd class="mono truncate" [title]="i.apiBaseUrl">{{ i.apiBaseUrl || '—' }}</dd></div>
                <div><dt>Details</dt><dd>@if (i.missing.length) {<span class="status warning">Incomplete</span><span class="sub-line">Missing: {{ i.missing.join(', ') }}</span>} @else {<span class="status success">Complete</span>}</dd></div>
                <div><dt>Partner portal login</dt><dd>{{ i.portalUsername || '—' }}</dd></div>
              </dl>
              <div class="pt-secrets">
                @if (i.authenticationType === 'api_key' || i.authenticationType === 'api_key_secret' || i.authenticationType === 'oauth2') {
                  <app-secret-field [detail]="x" kind="apiKey" [label]="i.authenticationType === 'oauth2' ? 'Client secret' : 'API key'" (changed)="onChanged($event, 'Credential saved. It will not be shown again.')" />
                }
                @if (i.authenticationType === 'api_key_secret') {<app-secret-field [detail]="x" kind="secretKey" label="Secret key" (changed)="onChanged($event, 'Credential saved. It will not be shown again.')" />}
                <app-secret-field [detail]="x" kind="portalPassword" label="Partner portal password" (changed)="onChanged($event, 'Credential saved. It will not be shown again.')" />
              </div>
            } @else {
              <p class="muted">No integration details yet.</p>
            }
          </div>
        </section>

        <section class="panel-card">
          <div class="panel-head"><div><h2>Partner details</h2><p>Who {{ h.name }} is and who to contact.</p></div>@if (x.can.manage) {<a class="btn sm" [routerLink]="['/partners', h.id, 'setup']"><app-icon name="edit" [size]="14" />Edit</a>}</div>
          <div class="panel-body">
            <dl class="kv">
              <div><dt>Partner code</dt><dd class="mono">{{ h.hostCode }}</dd></div>
              <div><dt>Partner type</dt><dd>{{ typeLabel(h.hostType) }}</dd></div>
              <div><dt>Country of registration</dt><dd>{{ h.registrationCountry ? cname(h.registrationCountry) : '—' }}</dd></div>
              <div><dt>Operations email</dt><dd class="truncate" [title]="h.contactEmail">{{ h.contactEmail || '—' }}</dd></div>
              <div><dt>Operations phone</dt><dd>{{ h.contactPhone || '—' }}</dd></div>
              <div><dt>Escalation contact</dt><dd>{{ h.escalationContact || '—' }}</dd></div>
              <div><dt>Internal owner</dt><dd>{{ h.ownerTeam || '—' }}</dd></div>
              <div><dt>Created</dt><dd>{{ when(h.createdAt) }} · {{ h.createdBy }}</dd></div>
              @if (h.description) {<div class="wide"><dt>Description</dt><dd>{{ h.description }}</dd></div>}
            </dl>
          </div>
        </section>
      </div>

      <aside class="col-side">
        <section class="panel-card">
          <div class="panel-head"><div><h2>Setup checklist</h2><p>{{ h.status === 'active' || h.status === 'maintenance' ? 'Everything a live partner needs.' : 'All of these before it can be enabled.' }}</p></div></div>
          <div class="panel-body">
            <ul class="pt-check">
              @for (c of h.checklist; track c.id) {<li [class.done]="c.done"><app-icon [name]="c.done ? 'check-circle' : 'alert-circle'" [size]="16" /><span>{{ c.label }}</span></li>}
            </ul>
          </div>
        </section>
        <section class="profile-history">
          <div class="panel-head"><div><h2>History</h2><p>Every change, latest first</p></div></div>
          <ol class="timeline">
            @for (a of x.activity.slice(0, historyCount()); track a.id) {
              <li><span class="t-action">{{ a.action }}</span><span class="t-comment">{{ a.details }}</span><span class="t-meta">{{ when(a.timestamp) }} · {{ a.performedBy }}</span></li>
            } @empty {<li class="t-empty">Nothing yet.</li>}
          </ol>
          @if (x.activity.length > historyCount()) {<button type="button" class="btn sm ghost" (click)="historyCount.set(historyCount() + 20)">Show more</button>}
        </section>
      </aside>
    </div>

    @if (act(); as a) {<app-host-action-sheet [detail]="x" [action]="a" (done)="onChanged($event.detail, $event.message)" (closed)="act.set(null)" />}
    @if (costFor(); as c) {
      <app-side-sheet size="editor" label="Cost pricing editor" (dismiss)="ed.requestClose()">
        <app-pricing-editor #ed [view]="c.view" [preset]="c.preset" variant="cost" [costSubmit]="c.submit" (saved)="onCostSaved()" (closed)="costFor.set(null)" />
      </app-side-sheet>
    }
    @if (review(); as rv) {
      <app-side-sheet [label]="'Review cost pricing'" (dismiss)="closeReview()">
        <header class="sheet-head">
          <div class="sheet-titles"><p class="sheet-eyebrow">FinOps · Partner cost pricing</p><h2 class="sheet-title">Review {{ rv.row.cap.paymentMethodName }} cost</h2><p class="sheet-sub">{{ h.name }} · {{ rv.row.cap.countryName }} · v{{ rv.v.version }}</p></div>
          <button type="button" class="sheet-close" (click)="closeReview()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
        </header>
        <div class="sheet-body">
          <div class="pt-compare">
            <div><span class="hero-label">In effect now</span>@if (rv.row.cost.current; as c) {<p class="hero-value">{{ head(c) }}</p><p class="hero-sub">{{ summary(c) }}</p>} @else {<p class="hero-value">None</p>}</div>
            <div class="new"><span class="hero-label">Proposed · from {{ day(rv.v.startDate) }}</span><p class="hero-value">{{ head(rv.v) }}</p><p class="hero-sub">{{ summary(rv.v) }}</p></div>
          </div>
          <dl class="sheet-dl"><div><dt>Submitted</dt><dd>{{ when(rv.v.createdAt) }} · {{ rv.v.createdBy }}</dd></div><div><dt>Model</dt><dd>{{ techLabel(rv.v.technique) }}</dd></div><div><dt>Effective</dt><dd>{{ day(rv.v.startDate) }}{{ rv.v.endDate ? ' to ' + day(rv.v.endDate) : ' onwards' }}</dd></div></dl>
          <div class="f-field"><label for="rv-reason">Reason <span class="muted">(required to reject)</span></label><textarea id="rv-reason" class="f-input" rows="3" maxlength="1000" [value]="reason()" (input)="reason.set($any($event.target).value)"></textarea></div>
          @if (reviewError(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
        </div>
        <footer class="sheet-foot">
          <span class="sheet-foot-note">The cost in effect stays until you approve.</span>
          <button type="button" class="btn danger-outline" (click)="decide('reject')" [disabled]="busy()">Reject</button>
          <button type="button" class="btn primary" (click)="decide('approve')" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}Approve</button>
        </footer>
      </app-side-sheet>
    }
    @if (routeSheet(); as r) {<app-route-sheet [view]="r" (done)="onRouteSaved()" (closed)="routeSheet.set(null)" />}
  } @else {
    <div class="skeleton-rows" aria-busy="true" aria-label="Loading partner"><span></span><span></span><span></span><span></span></div>
  }
</main>
  `,
})
export class PartnerPage {
  private readonly api = inject(HostApi);
  private readonly routingApi = inject(RoutingApi);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  readonly id = input.required<string>();

  protected readonly statusLabel = HOST_STATUS_LABEL;
  protected readonly availLabel = AVAILABILITY_LABEL;
  protected readonly envLabel = HOST_ENVIRONMENT_LABEL;
  protected readonly authLabel = AUTH_METHOD_LABEL;
  protected readonly tone = statusTone;
  protected readonly availTone = availabilityTone;
  protected readonly typeLabel = hostTypeLabel;
  protected readonly adapter = adapterLabel;
  protected readonly cname = countryName;
  protected readonly when = fmtWhen;
  protected readonly day = fmtDay;
  protected readonly techLabel = techniqueLabel;
  protected readonly summary = (v: PricingVersion) => pricingSummary(v);

  protected readonly d = signal<HostDetailResponse | null>(null);
  protected readonly routing = signal<RoutingResponse | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly notFound = signal(false);
  protected readonly toast = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly act = signal<HostAction | null>(null);
  protected readonly costFor = signal<{ view: ProductPricingView; preset: PricingPreset; submit: (draft: PricingDraft, editOf: string | null) => Promise<PricingVersion> } | null>(null);
  protected readonly review = signal<{ v: CostVersion; row: Row } | null>(null);
  protected readonly reason = signal('');
  protected readonly reviewError = signal<string | null>(null);
  protected readonly routeSheet = signal<RouteView | null>(null);
  protected readonly historyCount = signal(12);

  protected readonly savedNote = computed(() => {
    const s = this.params().get('saved');
    return s === 'setup' ? 'Setup finished. Next: set cost pricing for each payment method (FinOps approves it), then enable the partner.' : s === 'edit' ? 'Changes saved.' : null;
  });
  protected readonly pendingCount = computed(() => (this.d()?.methodCosts ?? []).filter((c) => c.pending).length);
  protected readonly routingManage = computed(() => !!this.routing()?.can.manage);

  private readonly myRouteViews = computed(() => {
    const x = this.d();
    const r = this.routing();
    if (!x || !r) return [];
    return r.routes.filter((v) => x.capabilities.some((c) => c.countryCode === v.country && c.paymentMethodCode === v.methodCode));
  });
  protected readonly myRoutes = computed(() => {
    const id = this.d()?.host.id;
    return this.myRouteViews().map((view) => {
      const rt = view.route;
      const i = rt ? rt.hosts.findIndex((h) => h.hostId === id) : -1;
      const opt = view.options.find((o) => o.hostId === id);
      const others = (rt?.hosts ?? []).map((h) => view.options.find((o) => o.hostId === h.hostId)?.name ?? 'Removed partner');
      let badge = '—';
      let text = 'No route yet for this method.';
      let warn = false;
      if (rt && i >= 0) {
        if (rt.mode === 'priority') {
          badge = `#${i + 1}`;
          text = `Priority: ${others.join(' → ')} · fallback ${rt.fallback ? 'on' : 'off'}${i > 0 ? ` · takes payments only if ${others.slice(0, i).join(', ')} can't` : ''}`;
        } else if (rt.mode === 'split') {
          badge = `${rt.hosts[i].share}%`;
          const eff = view.effective.find((e) => e.hostId === id)?.share;
          text = `Split: ${rt.hosts.map((h, j) => `${others[j]} ${h.share} %`).join(' / ')}${eff !== undefined && eff !== rt.hosts[i].share ? ` · ${eff} % right now` : ''}`;
          warn = eff !== undefined && eff !== rt.hosts[i].share;
        } else {
          const rank = view.effective.findIndex((e) => e.hostId === id);
          badge = rank === 0 ? '★' : rank > 0 ? `#${rank + 1}` : '–';
          text = `Smart (simulated performance): ${rank === 0 ? 'ranked first now' : rank > 0 ? `ranked #${rank + 1} now` : 'not ranked now'}`;
        }
        if (opt && !opt.eligible) {
          warn = true;
          text += ` · skipped: ${opt.reason}`;
        }
      } else if (rt) {
        text = `Not in this route (${others.join(', ')}).`;
      }
      return { view, badge, text, warn };
    });
  });
  protected readonly myOverrides = computed<OverrideView[]>(() => (this.routing()?.overrides ?? []).filter((o) => o.hostId === this.d()?.host.id));

  protected readonly rows = computed<Row[]>(() => {
    const x = this.d();
    if (!x) return [];
    const routes = this.myRoutes();
    return x.capabilities.map((cap) => {
      const cost = x.methodCosts.find((c) => c.country === cap.countryCode && c.methodCode === cap.paymentMethodCode) ?? { country: cap.countryCode, methodCode: cap.paymentMethodCode, current: null, scheduled: null, pending: null };
      const r = routes.find((y) => y.view.country === cap.countryCode && y.view.methodCode === cap.paymentMethodCode);
      return {
        cap,
        cost,
        category: methodCategory(cap.countryCode, cap.paymentMethodCode),
        routing: !r ? '—' : !r.view.route ? 'No route yet' : r.badge === '—' ? 'Not in route' : r.view.route.mode === 'priority' ? `Priority ${r.badge} of ${r.view.route.hosts.length}` : r.view.route.mode === 'split' ? `Split ${r.badge}` : `Smart ${r.badge}`,
      };
    });
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected async load(id = this.id()) {
    this.error.set(null);
    try {
      const [x, r] = await Promise.all([this.api.detail(id), this.routingApi.overview().catch(() => null)]);
      this.d.set(x);
      this.routing.set(r);
      if (this.params().get('tab') === 'pricing') queueMicrotask(() => document.getElementById('pricing')?.scrollIntoView({ block: 'start' }));
    } catch (e) {
      const err = toHostError(e);
      this.notFound.set(err.code === 'NOT_FOUND');
      this.error.set(err.message ?? 'Please try again in a moment.');
    }
  }

  protected head(v: PricingVersion) {
    return pricingHeadline(v).value;
  }

  protected onChanged(x: HostDetailResponse, message: string) {
    this.act.set(null);
    this.d.set(x);
    this.flash(message);
    void this.routingApi.overview().then((r) => this.routing.set(r)).catch(() => undefined);
  }

  protected async setAvail(cap: HostCapabilityView, to: AvailabilityStatus) {
    const x = this.d();
    if (!x || this.busy()) return;
    this.busy.set(true);
    try {
      this.onChanged(await this.api.setAvailability(x.host.id, cap.id, to), to === 'disabled' ? `${cap.paymentMethodName} switched off; the partner is unchanged` : `${cap.paymentMethodName} switched on`);
    } catch (e) {
      this.flash(toHostError(e).message ?? "We couldn't change the payment method.");
    } finally {
      this.busy.set(false);
    }
  }

  /** Opens the merchant pricing editor in cost mode, scoped to this partner and the method's country. */
  protected openCost(r: Row) {
    const x = this.d()!;
    const country = r.cap.countryCode;
    const cfg = ONBOARDING_COUNTRIES[country];
    const codes = x.capabilities.filter((c) => c.countryCode === country);
    const methods = countryProducts(cfg).filter((m) => codes.some((c) => c.paymentMethodCode === m.code));
    const versions = x.costVersions.filter((v) => v.country === country);
    const editOf = r.cost.current ?? r.cost.scheduled;
    const view: ProductPricingView = {
      applicationId: `${x.host.id}:${country}`, merchantId: x.host.id, merchantName: x.host.name, mid: null, country, countryName: cfg.name, currency: cfg.currency,
      status: 'operational', mode: 'change', suspended: false, notice: '', inferred: false, methods,
      config: { applicationId: `${x.host.id}:${country}`, products: methods.map((m) => ({ methodCode: m.code, flow: m.flow, enabled: true })), settlement: {}, revision: 0, savedAt: null, savedBy: null },
      versions, subMerchants: [], gaps: [], gapCount: 0, can: { editProducts: false, editPricing: true, decidePricing: false, deactivate: false }, productsMessage: null, pricingMessage: null,
      usdRate: 1, today: x.today, now: Date.now(),
    };
    this.costFor.set({
      view,
      preset: { flow: r.cap.paymentFlow, methodCode: r.cap.paymentMethodCode, editOf: editOf?.id ?? null },
      submit: (draft, edit) => this.api.setCost(x.host.id, country, draft, edit),
    });
  }

  protected async onCostSaved() {
    const x = await this.api.detail(this.id());
    this.d.set(x);
  }

  protected async withdraw(v: CostVersion) {
    if (!confirm(`Withdraw cost pricing v${v.version}? The cost in effect stays as it is.`)) return;
    this.busy.set(true);
    try {
      await this.api.cancelCost(this.id(), v.id);
      this.d.set(await this.api.detail(this.id()));
      this.flash(`Cost pricing v${v.version} withdrawn`);
    } catch (e) {
      this.flash(toHostError(e).message ?? "We couldn't withdraw it.");
    } finally {
      this.busy.set(false);
    }
  }

  protected closeReview() {
    if (this.busy()) return;
    this.review.set(null);
    this.reason.set('');
    this.reviewError.set(null);
  }

  protected async decide(decision: 'approve' | 'reject') {
    const rv = this.review();
    if (!rv) return;
    if (decision === 'reject' && this.reason().trim().length < 5) return this.reviewError.set('Give the reason for rejecting (at least 5 characters).');
    this.busy.set(true);
    this.reviewError.set(null);
    try {
      await this.api.decideCost(this.id(), rv.v.id, decision, this.reason().trim());
      this.busy.set(false);
      this.closeReview();
      this.d.set(await this.api.detail(this.id()));
      this.flash(decision === 'approve' ? `${rv.row.cap.paymentMethodName} cost v${rv.v.version} approved` : `${rv.row.cap.paymentMethodName} cost v${rv.v.version} rejected; the cost in effect is unchanged`);
    } catch (e) {
      this.reviewError.set(toHostError(e).message ?? "We couldn't record the decision.");
    } finally {
      this.busy.set(false);
    }
  }

  protected async onRouteSaved() {
    this.routeSheet.set(null);
    this.flash('Route saved');
    this.routing.set(await this.routingApi.overview());
  }

  private flash(text: string) {
    this.toast.set(text);
    setTimeout(() => this.toast.set(null), 4000);
  }
}
