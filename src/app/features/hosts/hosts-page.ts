import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import {
  HEALTH_STATUS_LABEL,
  HealthStatus,
  HostActivity,
  HostDetailResponse,
  HostHealthRow,
  HostListResponse,
  HostView,
  hostCountries,
  hostMethods,
  INTEGRATION_STATUS_LABEL,
  IntegrationStatus,
  OPERATIONAL_STATUS_LABEL,
  OperationalStatus,
} from '../../core/hosts/hosts';
import { Icon } from '../../shared/icon';
import { Pager } from '../../shared/pager';
import { HostActionSheet, HostAction } from './host-action-sheet';
import { HostEditor } from './host-editor';
import { fmtWhen, healthTone, integrationTone, operationalTone } from './host-ui';

type Tab = 'hosts' | 'health' | 'activity';
type SortKey = 'name' | 'updated' | 'health';

/**
 * Host Management: Hosts (directory), Host Health and Activity Log, as tabs of one page
 * (`?tab=`). Add Host and Edit open the editor side sheet; Enable / Disable open the confirmation
 * sheet. Everything shown is sample data from the simulated backend.
 */
@Component({
  selector: 'app-hosts-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Pager, HostEditor, HostActionSheet],
  styleUrl: './hosts.scss',
  template: `
<main class="page host-page">
  <div class="host-head">
    <div>
      <h1>Host Management <span class="sample-tag" title="No live provider connections exist in this prototype.">Sample data · simulated</span></h1>
      <p>Manage payment providers, integrations and operational availability.</p>
    </div>
    @if (data()?.can?.manage) {
      <div class="actions"><button type="button" class="btn primary" (click)="editor.set({ host: null })"><app-icon name="plus" [size]="16" />Add Host</button></div>
    }
  </div>

  <nav class="host-tabs" aria-label="Host Management">
    <a [routerLink]="[]" [queryParams]="{ tab: null }" [class.on]="tab() === 'hosts'" [attr.aria-current]="tab() === 'hosts' ? 'page' : null">Hosts</a>
    <a [routerLink]="[]" [queryParams]="{ tab: 'health' }" [class.on]="tab() === 'health'" [attr.aria-current]="tab() === 'health' ? 'page' : null">Host Health</a>
    <a [routerLink]="[]" [queryParams]="{ tab: 'activity' }" [class.on]="tab() === 'activity'" [attr.aria-current]="tab() === 'activity' ? 'page' : null">Activity Log</a>
  </nav>

  @if (toast(); as t) {<div class="alert success compact" role="status"><app-icon name="check-circle" /><div>{{ t }}</div></div>}

  @if (error(); as e) {
    <div class="empty-state" role="alert">
      <div class="icon-tile"><app-icon name="alert-circle" /></div>
      <h3>We couldn't load Host Management</h3>
      <p>{{ e }}</p>
      <button type="button" class="btn" (click)="load()">Try again</button>
    </div>
  } @else if (!data()) {
    <div class="skeleton-rows" aria-busy="true" aria-label="Loading hosts"><span></span><span></span><span></span><span></span></div>
  } @else {
    @switch (tab()) {
      @case ('hosts') {
        @let s = data()!.summary;
        <div class="host-kpis" aria-label="Summary">
          <div class="host-kpi"><span>Total Hosts</span><strong>{{ s.total }}</strong></div>
          <div class="host-kpi good"><span>Active Hosts</span><strong>{{ s.active }}</strong></div>
          <div class="host-kpi"><span>Inactive Hosts</span><strong>{{ s.inactive }}</strong><span>Disabled or under maintenance</span></div>
          <div class="host-kpi" [class.bad]="s.attention > 0"><span>Attention Required</span><strong>{{ s.attention }}</strong></div>
        </div>

        <section class="panel-card">
          <form class="host-filters" role="search" aria-label="Filter hosts" (submit)="$event.preventDefault()">
            <label class="fld search">Search<input class="f-input" type="search" placeholder="Host name or Host ID" maxlength="60" [value]="q()" (input)="q.set(v($event)); page.set(0)" /></label>
            <label class="fld">Country
              <select class="f-input" (change)="country.set(v($event)); method.set(''); page.set(0)"><option value="">All countries</option>@for (c of countries; track c.code) {<option [value]="c.code" [selected]="c.code === country()">{{ c.name }}</option>}</select></label>
            <label class="fld">Payment Method
              <select class="f-input" (change)="method.set(v($event)); page.set(0)"><option value="">All payment methods</option>@for (m of methodOptions(); track m) {<option [value]="m" [selected]="m === method()">{{ m }}</option>}</select></label>
            <label class="fld">Integration Status
              <select class="f-input" (change)="integ.set($any(v($event))); page.set(0)"><option value="">All</option>@for (k of integKeys; track k) {<option [value]="k" [selected]="k === integ()">{{ integLabel[k] }}</option>}</select></label>
            <label class="fld">Operational Status
              <select class="f-input" (change)="op.set($any(v($event))); page.set(0)"><option value="">All</option>@for (k of opKeys; track k) {<option [value]="k" [selected]="k === op()">{{ opLabel[k] }}</option>}</select></label>
            <label class="fld">Associated Partner
              <select class="f-input" (change)="partner.set(v($event)); page.set(0)"><option value="">All partners</option><option value="none" [selected]="partner() === 'none'">No partner</option>@for (p of data()!.partners; track p.id) {<option [value]="p.id" [selected]="p.id === partner()">{{ p.name }}</option>}</select></label>
            @if (hasFilters()) {<button type="button" class="btn ghost" (click)="clear()">Clear filters</button>}
          </form>

          @if (!data()!.hosts.length) {
            <div class="empty-state"><div class="icon-tile"><app-icon name="route" /></div><h3>No hosts yet</h3><p>Add the first payment provider to start.</p>@if (data()!.can.manage) {<button type="button" class="btn primary" (click)="editor.set({ host: null })">Add Host</button>}</div>
          } @else if (!filtered().length) {
            <div class="empty-state"><div class="icon-tile"><app-icon name="search" /></div><h3>No hosts match these filters.</h3><button type="button" class="btn" (click)="clear()">Clear filters</button></div>
          } @else {
            <div class="table-wrap" [class.dim]="loading()">
              <table class="data-table host-table">
                <thead>
                  <tr>
                    <th scope="col" [attr.aria-sort]="ariaSort('name')"><button type="button" class="sort" (click)="sortBy('name')">Host Name <app-icon [name]="sortIcon('name')" [size]="12" /></button></th>
                    <th scope="col">Host ID</th>
                    <th scope="col">Associated Partner</th>
                    <th scope="col">Country / Markets</th>
                    <th scope="col">Supported Payment Methods</th>
                    <th scope="col">Integration Status</th>
                    <th scope="col">Operational Status</th>
                    <th scope="col" [attr.aria-sort]="ariaSort('health')"><button type="button" class="sort" (click)="sortBy('health')">Last Health Check <app-icon [name]="sortIcon('health')" [size]="12" /></button></th>
                    <th scope="col" [attr.aria-sort]="ariaSort('updated')"><button type="button" class="sort" (click)="sortBy('updated')">Updated At <app-icon [name]="sortIcon('updated')" [size]="12" /></button></th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  @for (h of pageRows(); track h.id) {
                    <tr class="clickable" (click)="open(h)">
                      <td><a class="txn-id" [routerLink]="['/hosts', h.id]" (click)="$event.stopPropagation()">{{ h.name }}</a>@if (h.draft) {<span class="sub-line">Draft</span>}</td>
                      <td class="mono">{{ h.id }}<span class="sub-line">{{ h.hostCode }}</span></td>
                      <td [class.muted]="!h.partnerName">{{ h.partnerName ?? '—' }}</td>
                      <td>{{ h.markets.join(', ') || '—' }}</td>
                      <td><div class="chips">@for (m of h.paymentMethods; track m) {<span class="chip">{{ m }}</span>} @empty {<span class="muted">—</span>}</div></td>
                      <td><span [class]="integTone(h.integrationStatus)">{{ integLabel[h.integrationStatus] }}</span></td>
                      <td><span [class]="opTone(h.operationalStatus)">{{ opLabel[h.operationalStatus] }}</span></td>
                      <td>@if (h.lastHealth; as l) {{{ when(l.checkedAt) }}<span class="sub-line">{{ healthLabel[l.status] }}@if (l.responseTimeMs) { · {{ l.responseTimeMs }} ms}</span>} @else {<span class="muted">Not checked</span>}</td>
                      <td>{{ when(h.updatedAt) }}</td>
                      <td (click)="$event.stopPropagation()">
                        <div class="row-actions">
                          <a class="btn sm" [routerLink]="['/hosts', h.id]">View</a>
                          @if (data()!.can.manage) {
                            <button type="button" class="btn sm" (click)="edit(h)">Edit</button>
                            @if (h.operationalStatus === 'disabled') {
                              <button type="button" class="btn sm" (click)="act(h, 'enable')">Enable</button>
                            } @else {
                              <button type="button" class="btn sm danger-outline" (click)="act(h, 'disable')">Disable</button>
                            }
                          }
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <app-pager [total]="filtered().length" [(page)]="page" [(pageSize)]="pageSize" />
          }
        </section>
      }

      @case ('health') {
        <div class="sim-note" role="note"><app-icon name="info" [size]="16" /><div>Simulated health data. No live provider connections exist in this prototype; checks are run from each host's page.</div></div>
        <div class="host-kpis" aria-label="Health summary">
          <div class="host-kpi good"><span>Healthy</span><strong>{{ healthCount('healthy') }}</strong></div>
          <div class="host-kpi warn"><span>Degraded</span><strong>{{ healthCount('degraded') }}</strong></div>
          <div class="host-kpi bad"><span>Unreachable</span><strong>{{ healthCount('unreachable') }}</strong></div>
          <div class="host-kpi"><span>Unknown</span><strong>{{ healthCount('unknown') }}</strong></div>
        </div>
        <section class="panel-card">
          <form class="host-filters" role="search" aria-label="Filter host health" (submit)="$event.preventDefault()">
            <label class="fld">Country<select class="f-input" (change)="hCountry.set(v($event))"><option value="">All countries</option>@for (c of countries; track c.code) {<option [value]="c.name" [selected]="c.name === hCountry()">{{ c.name }}</option>}</select></label>
            <label class="fld">Host<select class="f-input" (change)="hHost.set(v($event))"><option value="">All hosts</option>@for (r of health(); track r.hostId) {<option [value]="r.hostId" [selected]="r.hostId === hHost()">{{ r.hostName }}</option>}</select></label>
            <label class="fld">Health Status<select class="f-input" (change)="hStatus.set($any(v($event)))"><option value="">All</option>@for (k of healthKeys; track k) {<option [value]="k" [selected]="k === hStatus()">{{ healthLabel[k] }}</option>}</select></label>
            <label class="fld">Payment Method<select class="f-input" (change)="hMethod.set(v($event))"><option value="">All payment methods</option>@for (m of allMethods(); track m) {<option [value]="m" [selected]="m === hMethod()">{{ m }}</option>}</select></label>
          </form>
          @if (!healthRows().length) {
            <div class="empty-state"><h3>No hosts match these filters.</h3></div>
          } @else {
            <div class="table-wrap">
              <table class="data-table host-table">
                <thead><tr><th scope="col">Host</th><th scope="col">Country</th><th scope="col">Payment Methods</th><th scope="col">Health Status</th><th scope="col">Last Checked</th><th scope="col" class="num">Response Time</th><th scope="col">Recent Error</th><th scope="col">Action</th></tr></thead>
                <tbody>
                  @for (r of healthRows(); track r.hostId) {
                    <tr>
                      <td><strong>{{ r.hostName }}</strong><span class="sub-line">{{ r.hostId }}</span></td>
                      <td>{{ r.countries.join(', ') || '—' }}</td>
                      <td><div class="chips">@for (m of r.paymentMethods; track m) {<span class="chip">{{ m }}</span>}</div></td>
                      <td><span [class]="hTone(r.status)">{{ healthLabel[r.status] }}</span></td>
                      <td>{{ r.checkedAt ? when(r.checkedAt) : 'Never' }}</td>
                      <td class="num mono">{{ r.responseTimeMs ? r.responseTimeMs + ' ms' : '—' }}</td>
                      <td [class.muted]="!r.recentError">{{ r.recentError ?? '—' }}</td>
                      <td><a class="btn sm" [routerLink]="['/hosts', r.hostId]" [queryParams]="{ tab: 'health' }">Open host</a></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      @case ('activity') {
        <section class="panel-card">
          <form class="host-filters" role="search" aria-label="Filter activity" (submit)="$event.preventDefault()">
            <label class="fld">Host<select class="f-input" (change)="aHost.set(v($event)); aPage.set(0)"><option value="">All hosts</option>@for (h of data()!.hosts; track h.id) {<option [value]="h.id" [selected]="h.id === aHost()">{{ h.name }}</option>}</select></label>
          </form>
          @if (!activityRows().length) {
            <div class="empty-state"><h3>No activity yet.</h3></div>
          } @else {
            <div class="table-wrap">
              <table class="data-table host-table">
                <thead><tr><th scope="col">Date and Time</th><th scope="col">Host</th><th scope="col">Activity</th><th scope="col">Performed By</th><th scope="col">Details</th></tr></thead>
                <tbody>
                  @for (a of activityPage(); track a.id) {
                    <tr><td class="mono">{{ when(a.timestamp) }}</td><td><a [routerLink]="['/hosts', a.hostId]" [queryParams]="{ tab: 'activity' }">{{ a.hostName }}</a></td><td><strong>{{ a.action }}</strong></td><td>{{ a.performedBy }}</td><td>{{ a.details }}</td></tr>
                  }
                </tbody>
              </table>
            </div>
            <app-pager [total]="activityRows().length" [(page)]="aPage" [(pageSize)]="aPageSize" />
          }
        </section>
      }
    }
  }

  @if (editor(); as e) {
    <app-host-editor [existing]="e.host" [partners]="data()?.partners ?? []" (saved)="onSaved($event)" (closed)="editor.set(null)" />
  }
  @if (action(); as a) {
    <app-host-action-sheet [detail]="a.detail" [action]="a.action" (done)="onActionDone($event.message)" (closed)="action.set(null)" />
  }
</main>
  `,
})
export class HostsPage {
  private readonly api = inject(HostApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  protected readonly tab = computed<Tab>(() => {
    const t = this.params().get('tab');
    return t === 'health' || t === 'activity' ? t : 'hosts';
  });

  protected readonly countries = hostCountries();
  protected readonly integLabel = INTEGRATION_STATUS_LABEL;
  protected readonly opLabel = OPERATIONAL_STATUS_LABEL;
  protected readonly healthLabel = HEALTH_STATUS_LABEL;
  protected readonly integKeys = Object.keys(INTEGRATION_STATUS_LABEL) as IntegrationStatus[];
  protected readonly opKeys = Object.keys(OPERATIONAL_STATUS_LABEL) as OperationalStatus[];
  protected readonly healthKeys = Object.keys(HEALTH_STATUS_LABEL) as HealthStatus[];
  protected readonly integTone = integrationTone;
  protected readonly opTone = operationalTone;
  protected readonly hTone = healthTone;
  protected readonly when = fmtWhen;

  protected readonly data = signal<HostListResponse | null>(null);
  protected readonly health = signal<HostHealthRow[]>([]);
  protected readonly activity = signal<HostActivity[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly toast = signal<string | null>(null);
  protected readonly editor = signal<{ host: HostDetailResponse | null } | null>(null);
  protected readonly action = signal<{ detail: HostDetailResponse; action: HostAction } | null>(null);

  // Hosts tab filters, sort and paging.
  protected readonly q = signal('');
  protected readonly country = signal('');
  protected readonly method = signal('');
  protected readonly integ = signal<IntegrationStatus | ''>('');
  protected readonly op = signal<OperationalStatus | ''>('');
  protected readonly partner = signal('');
  protected readonly sort = signal<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  protected readonly page = signal(0);
  protected readonly pageSize = signal(25);
  // Health tab filters.
  protected readonly hCountry = signal('');
  protected readonly hHost = signal('');
  protected readonly hStatus = signal<HealthStatus | ''>('');
  protected readonly hMethod = signal('');
  // Activity tab.
  protected readonly aHost = signal('');
  protected readonly aPage = signal(0);
  protected readonly aPageSize = signal(25);

  protected readonly hasFilters = computed(() => !!(this.q() || this.country() || this.method() || this.integ() || this.op() || this.partner()));
  protected readonly methodOptions = computed(() => {
    const codes = this.country() ? [this.country()] : this.countries.map((c) => c.code);
    return [...new Set(codes.flatMap((c) => hostMethods(c).map((m) => m.name + (m.flow === 'payout' ? ' (Payout)' : ''))))].sort();
  });
  protected readonly allMethods = computed(() => [...new Set(this.health().flatMap((r) => r.paymentMethods))].sort());
  protected readonly filtered = computed(() => {
    const d = this.data();
    if (!d) return [];
    const q = this.q().trim().toLowerCase();
    const countryName = this.countries.find((c) => c.code === this.country())?.name;
    const rows = d.hosts.filter(
      (h) =>
        (!q || h.name.toLowerCase().includes(q) || h.id.toLowerCase().includes(q) || h.hostCode.toLowerCase().includes(q)) &&
        (!countryName || h.markets.includes(countryName)) &&
        (!this.method() || h.paymentMethods.includes(this.method())) &&
        (!this.integ() || h.integrationStatus === this.integ()) &&
        (!this.op() || h.operationalStatus === this.op()) &&
        (!this.partner() || (this.partner() === 'none' ? !h.associatedPartnerId : h.associatedPartnerId === this.partner())),
    );
    const { key, dir } = this.sort();
    const val = (h: HostView) => (key === 'name' ? h.name.toLowerCase() : key === 'updated' ? h.updatedAt : (h.lastHealth?.checkedAt ?? 0));
    return [...rows].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir);
  });
  protected readonly pageRows = computed(() => this.filtered().slice(this.page() * this.pageSize(), (this.page() + 1) * this.pageSize()));
  protected readonly healthRows = computed(() =>
    this.health().filter((r) => (!this.hCountry() || r.countries.includes(this.hCountry())) && (!this.hHost() || r.hostId === this.hHost()) && (!this.hStatus() || r.status === this.hStatus()) && (!this.hMethod() || r.paymentMethods.includes(this.hMethod()))),
  );
  protected readonly activityRows = computed(() => this.activity().filter((a) => !this.aHost() || a.hostId === this.aHost()));
  protected readonly activityPage = computed(() => this.activityRows().slice(this.aPage() * this.aPageSize(), (this.aPage() + 1) * this.aPageSize()));

  constructor() {
    effect(() => {
      this.tab();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [list, health, activity] = await Promise.all([this.api.list(), this.api.health(), this.api.activity()]);
      this.data.set(list);
      this.health.set(health);
      this.activity.set(activity);
    } catch (e) {
      const err = toHostError(e);
      this.error.set(err.message ?? 'Please try again in a moment.');
    } finally {
      this.loading.set(false);
    }
  }

  protected v(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected healthCount(s: HealthStatus) {
    return this.health().filter((r) => r.status === s).length;
  }

  protected sortBy(key: SortKey) {
    this.sort.update((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 }));
  }

  protected ariaSort(key: SortKey) {
    const s = this.sort();
    return s.key === key ? (s.dir === 1 ? 'ascending' : 'descending') : null;
  }

  protected sortIcon(key: SortKey) {
    const s = this.sort();
    return s.key === key && s.dir === 1 ? 'chevron-up' : 'chevron-down';
  }

  protected clear() {
    this.q.set('');
    this.country.set('');
    this.method.set('');
    this.integ.set('');
    this.op.set('');
    this.partner.set('');
    this.page.set(0);
  }

  protected open(h: HostView) {
    void this.router.navigate(['/hosts', h.id]);
  }

  protected async edit(h: HostView) {
    this.editor.set({ host: await this.api.detail(h.id) });
  }

  protected async act(h: HostView, action: HostAction) {
    this.action.set({ detail: await this.api.detail(h.id), action });
  }

  protected onSaved(d: HostDetailResponse) {
    const isNew = !this.editor()?.host;
    this.editor.set(null);
    if (isNew) void this.router.navigate(['/hosts', d.host.id], { queryParams: { created: d.host.draft ? 'draft' : '1' } });
    else {
      this.flash(`${d.host.name} saved`);
      void this.load();
    }
  }

  protected onActionDone(message: string) {
    this.action.set(null);
    this.flash(message);
    void this.load();
  }

  private flash(text: string) {
    this.toast.set(text);
    setTimeout(() => this.toast.set(null), 4000);
  }
}
