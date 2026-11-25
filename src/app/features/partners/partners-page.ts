import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import { HOST_STATUS_LABEL, HostActivity, HostListResponse, HostStatus, HostView, hostCountries, hostTypeLabel, PAYMENT_CATEGORIES, PaymentCategory } from '../../core/hosts/hosts';
import { RoutingResponse } from '../../core/routing/routing';
import { RoutingApi } from '../../core/routing/routing-api.service';
import { Icon } from '../../shared/icon';
import { Pager } from '../../shared/pager';
import { fmtWhen, statusTone } from '../hosts/host-ui';

type Tab = 'partners' | 'activity';

/** Partners: the payment partners Mobi connects to (list and activity log, `?tab=`). */
@Component({
  selector: 'app-partners-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Pager],
  styleUrls: ['../hosts/hosts.scss', './partners.scss'],
  template: `
<main class="page host-page">
  <div class="host-head">
    <div>
      <h1>Partners <span class="sample-tag" title="No live provider connections exist in this prototype.">Sample data</span></h1>
      <p>Payment partners Mobi connects to: what they process, what they cost Mobi, and where they sit in routing.</p>
    </div>
    @if (data()?.can?.manage) {<div class="actions"><a class="btn primary" routerLink="/partners/new"><app-icon name="plus" [size]="16" />Add partner</a></div>}
  </div>
  <nav class="host-tabs" aria-label="Partners">
    <a [routerLink]="[]" [queryParams]="{ tab: null }" [class.on]="tab() === 'partners'" [attr.aria-current]="tab() === 'partners' ? 'page' : null">Partners</a>
    <a [routerLink]="[]" [queryParams]="{ tab: 'activity' }" [class.on]="tab() === 'activity'" [attr.aria-current]="tab() === 'activity' ? 'page' : null">Activity Log</a>
  </nav>

  @if (error(); as e) {
    <div class="empty-state" role="alert"><div class="icon-tile"><app-icon name="alert-circle" /></div><h3>We couldn't load Partners</h3><p>{{ e }}</p><button type="button" class="btn" (click)="load()">Try again</button></div>
  } @else if (!data()) {
    <div class="skeleton-rows" aria-busy="true" aria-label="Loading partners"><span></span><span></span><span></span><span></span></div>
  } @else {
    @let s = data()!.summary;
    @if (tab() === 'partners') {
      <div class="host-kpis" aria-label="Summary">
        <div class="host-kpi"><span>Partners</span><strong>{{ s.total }}</strong>@if (s.draft) {<span>{{ s.draft }} draft</span>}</div>
        <div class="host-kpi good"><span>Active</span><strong>{{ s.active }}</strong>@if (s.maintenance) {<span>+ {{ s.maintenance }} in maintenance</span>}</div>
        <div class="host-kpi" [class.warn]="s.costMissing > 0"><span>Cost pricing missing</span><strong>{{ s.costMissing }}</strong><span>Margin can't be worked out</span></div>
        <div class="host-kpi" [class.warn]="s.costPending > 0"><span>Waiting for FinOps</span><strong>{{ s.costPending }}</strong><span>Cost pricing changes</span></div>
      </div>
      <section class="panel-card">
        <form class="host-filters" role="search" aria-label="Filter partners" (submit)="$event.preventDefault()">
          <label class="fld search">Search<input class="f-input" type="search" placeholder="Partner name, code or ID" maxlength="60" [value]="q()" (input)="q.set(v($event)); page.set(0)" /></label>
          <label class="fld">Country<select class="f-input" (change)="country.set(v($event)); page.set(0)"><option value="">All countries</option>@for (c of countries; track c.code) {<option [value]="c.name" [selected]="c.name === country()">{{ c.name }}</option>}</select></label>
          <label class="fld">Category<select class="f-input" (change)="category.set($any(v($event))); page.set(0)"><option value="">All categories</option>@for (c of categories; track c) {<option [value]="c" [selected]="c === category()">{{ c }}</option>}</select></label>
          <label class="fld">Status<select class="f-input" (change)="st.set($any(v($event))); page.set(0)"><option value="">All</option>@for (k of statusKeys; track k) {<option [value]="k" [selected]="k === st()">{{ statusLabel[k] }}</option>}</select></label>
          <label class="fld">Cost pricing<select class="f-input" (change)="cost.set(v($event)); page.set(0)"><option value="">Any</option><option value="missing" [selected]="cost() === 'missing'">Missing</option><option value="pending" [selected]="cost() === 'pending'">Waiting for FinOps</option></select></label>
          @if (hasFilters()) {<button type="button" class="btn ghost" (click)="clear()">Clear filters</button>}
        </form>
        @if (!data()!.hosts.length) {
          <div class="empty-state"><div class="icon-tile"><app-icon name="route" /></div><h3>No partners yet</h3><p>Add the first payment partner to start.</p>@if (data()!.can.manage) {<a class="btn primary" routerLink="/partners/new">Add partner</a>}</div>
        } @else if (!filtered().length) {
          <div class="empty-state"><div class="icon-tile"><app-icon name="search" /></div><h3>No partners match these filters.</h3><button type="button" class="btn" (click)="clear()">Clear filters</button></div>
        } @else {
          <div class="table-wrap">
            <table class="data-table host-table">
              <thead><tr><th scope="col">Partner</th><th scope="col">Country</th><th scope="col">Payment methods</th><th scope="col">Cost pricing</th><th scope="col">Status</th><th scope="col">In routing</th></tr></thead>
              <tbody>
                @for (h of pageRows(); track h.id) {
                  <tr class="clickable" (click)="open(h)">
                    <td><a class="txn-id" [routerLink]="['/partners', h.id]" (click)="$event.stopPropagation()">{{ h.name }}</a><span class="sub-line">{{ typeLabel(h.hostType) }} · <span class="mono">{{ h.id }}</span></span></td>
                    <td>{{ h.markets.join(', ') || '—' }}</td>
                    <td><div class="chips">@for (c of h.categories; track c.category) {<span class="chip">{{ c.category }} {{ c.count }}</span>} @empty {<span class="muted">None yet</span>}</div></td>
                    <td>
                      @if (!h.cost.total) {<span class="muted">—</span>}
                      @else if (h.cost.priced === h.cost.total) {<span class="status success">Set</span>}
                      @else {<span class="status warning">Missing</span>}
                      @if (h.cost.total) {<span class="sub-line">{{ h.cost.priced }} of {{ h.cost.total }} method{{ h.cost.total === 1 ? '' : 's' }}@if (h.cost.pending) { · {{ h.cost.pending }} waiting for FinOps}</span>}
                    </td>
                    <td><span [class]="tone(h.status)">{{ statusLabel[h.status] }}</span>@if (h.status === 'draft') {<span class="sub-line">Setup not finished</span>}</td>
                    <td class="wrap">{{ inRouting(h) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <app-pager [total]="filtered().length" [(page)]="page" [(pageSize)]="pageSize" />
        }
      </section>
    } @else {
      <section class="panel-card">
        <form class="host-filters" role="search" aria-label="Filter activity" (submit)="$event.preventDefault()">
          <label class="fld">Partner<select class="f-input" (change)="aHost.set(v($event)); aPage.set(0)"><option value="">All partners</option>@for (h of data()!.hosts; track h.id) {<option [value]="h.id" [selected]="h.id === aHost()">{{ h.name }}</option>}</select></label>
        </form>
        @if (!activityRows().length) {
          <div class="empty-state"><h3>No activity yet.</h3></div>
        } @else {
          <div class="table-wrap">
            <table class="data-table host-table">
              <thead><tr><th scope="col">Date and Time</th><th scope="col">Partner</th><th scope="col">Activity</th><th scope="col">Performed By</th><th scope="col">Details</th></tr></thead>
              <tbody>@for (a of activityPage(); track a.id) {<tr><td class="mono">{{ when(a.timestamp) }}</td><td><a [routerLink]="['/partners', a.hostId]">{{ a.hostName }}</a></td><td><strong>{{ a.action }}</strong></td><td>{{ a.performedBy }}</td><td class="wrap">{{ a.details }}</td></tr>}</tbody>
            </table>
          </div>
          <app-pager [total]="activityRows().length" [(page)]="aPage" [(pageSize)]="aPageSize" />
        }
      </section>
    }
  }
</main>
  `,
})
export class PartnersPage {
  private readonly api = inject(HostApi);
  private readonly routingApi = inject(RoutingApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  protected readonly tab = computed<Tab>(() => (this.params().get('tab') === 'activity' ? 'activity' : 'partners'));
  protected readonly countries = hostCountries();
  protected readonly categories = PAYMENT_CATEGORIES;
  protected readonly statusLabel = HOST_STATUS_LABEL;
  protected readonly statusKeys = Object.keys(HOST_STATUS_LABEL) as HostStatus[];
  protected readonly tone = statusTone;
  protected readonly typeLabel = hostTypeLabel;
  protected readonly when = fmtWhen;

  protected readonly data = signal<HostListResponse | null>(null);
  protected readonly routing = signal<RoutingResponse | null>(null);
  protected readonly activity = signal<HostActivity[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly q = signal('');
  protected readonly country = signal('');
  protected readonly category = signal<PaymentCategory | ''>('');
  protected readonly st = signal<HostStatus | ''>('');
  protected readonly cost = signal('');
  protected readonly page = signal(0);
  protected readonly pageSize = signal(25);
  protected readonly aHost = signal('');
  protected readonly aPage = signal(0);
  protected readonly aPageSize = signal(25);

  protected readonly hasFilters = computed(() => !!(this.q() || this.country() || this.category() || this.st() || this.cost()));
  protected readonly filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    return (this.data()?.hosts ?? []).filter(
      (h) =>
        (!q || h.name.toLowerCase().includes(q) || h.id.toLowerCase().includes(q) || h.hostCode.toLowerCase().includes(q)) &&
        (!this.country() || h.markets.includes(this.country())) &&
        (!this.category() || h.categories.some((c) => c.category === this.category())) &&
        (!this.st() || h.status === this.st()) &&
        (!this.cost() || (this.cost() === 'missing' ? h.cost.priced < h.cost.total : h.cost.pending > 0)),
    );
  });
  protected readonly pageRows = computed(() => this.filtered().slice(this.page() * this.pageSize(), (this.page() + 1) * this.pageSize()));
  protected readonly activityRows = computed(() => this.activity().filter((a) => !this.aHost() || a.hostId === this.aHost()));
  protected readonly activityPage = computed(() => this.activityRows().slice(this.aPage() * this.aPageSize(), (this.aPage() + 1) * this.aPageSize()));

  constructor() {
    effect(() => {
      this.tab();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.error.set(null);
    try {
      const [list, activity, routing] = await Promise.all([this.api.list(), this.api.activity(), this.routingApi.overview().catch(() => null)]);
      this.data.set(list);
      this.activity.set(activity);
      this.routing.set(routing);
    } catch (e) {
      this.error.set(toHostError(e).message ?? 'Please try again in a moment.');
    }
  }

  /** Where the partner sits in routing, e.g. "VA #2 · Bank Transfer 70 %". */
  protected inRouting(h: HostView): string {
    const r = this.routing();
    if (!r) return '—';
    const parts: string[] = [];
    for (const v of r.routes) {
      const rt = v.route;
      const i = rt?.hosts.findIndex((x) => x.hostId === h.id) ?? -1;
      if (!rt || i < 0) continue;
      const skipped = !v.options.find((o) => o.hostId === h.id)?.eligible;
      parts.push(`${v.methodName} ${rt.mode === 'priority' ? `#${i + 1}` : rt.mode === 'split' ? `${rt.hosts[i].share} %` : 'Smart'}${skipped ? ' (skipped)' : ''}`);
    }
    const overrides = r.overrides.filter((o) => o.hostId === h.id).length;
    if (overrides) parts.push(`${overrides} override${overrides === 1 ? '' : 's'}`);
    return parts.join(' · ') || 'Not in a route';
  }

  protected v(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected clear() {
    this.q.set('');
    this.country.set('');
    this.category.set('');
    this.st.set('');
    this.cost.set('');
    this.page.set(0);
  }

  protected open(h: HostView) {
    void this.router.navigate(['/partners', h.id]);
  }
}
