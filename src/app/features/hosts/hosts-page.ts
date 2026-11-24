import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import { HOST_STATUS_LABEL, HostActivity, HostDetailResponse, HostListResponse, HostStatus, HostView, hostCountries, hostMethods } from '../../core/hosts/hosts';
import { Icon } from '../../shared/icon';
import { Pager } from '../../shared/pager';
import { HostActionSheet, HostAction } from './host-action-sheet';
import { HostEditor } from './host-editor';
import { fmtWhen, statusTone } from './host-ui';

type Tab = 'hosts' | 'activity';
type SortKey = 'name' | 'updated';

/**
 * Host Management: Hosts (directory) and Activity Log, as tabs of one page (`?tab=`). Add Host and
 * Edit open the editor side sheet; Enable / Disable open the confirmation sheet. Everything shown
 * is sample data from the simulated backend.
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
      <h1>Host Management <span class="sample-tag" title="No live provider connections exist in this prototype.">Sample data</span></h1>
      <p>Register payment providers with the countries and payment methods they handle, and switch them on or off.</p>
    </div>
    @if (data()?.can?.manage) {
      <div class="actions"><button type="button" class="btn primary" (click)="editor.set({ host: null })"><app-icon name="plus" [size]="16" />Add Host</button></div>
    }
  </div>

  <nav class="host-tabs" aria-label="Host Management">
    <a [routerLink]="[]" [queryParams]="{ tab: null }" [class.on]="tab() === 'hosts'" [attr.aria-current]="tab() === 'hosts' ? 'page' : null">Hosts</a>
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
          <div class="host-kpi"><span>Total Hosts</span><strong>{{ s.total }}</strong>@if (s.draft) {<span>{{ s.draft }} draft</span>}</div>
          <div class="host-kpi good"><span>Active</span><strong>{{ s.active }}</strong></div>
          <div class="host-kpi"><span>Disabled</span><strong>{{ s.disabled }}</strong></div>
          <div class="host-kpi" [class.warn]="s.maintenance > 0"><span>Maintenance</span><strong>{{ s.maintenance }}</strong></div>
        </div>

        <section class="panel-card">
          <form class="host-filters" role="search" aria-label="Filter hosts" (submit)="$event.preventDefault()">
            <label class="fld search">Search<input class="f-input" type="search" placeholder="Host name or Host ID" maxlength="60" [value]="q()" (input)="q.set(v($event)); page.set(0)" /></label>
            <label class="fld">Country
              <select class="f-input" (change)="country.set(v($event)); method.set(''); page.set(0)"><option value="">All countries</option>@for (c of countries; track c.code) {<option [value]="c.code" [selected]="c.code === country()">{{ c.name }}</option>}</select></label>
            <label class="fld">Payment Method
              <select class="f-input" (change)="method.set(v($event)); page.set(0)"><option value="">All payment methods</option>@for (m of methodOptions(); track m) {<option [value]="m" [selected]="m === method()">{{ m }}</option>}</select></label>
            <label class="fld">Status
              <select class="f-input" (change)="st.set($any(v($event))); page.set(0)"><option value="">All</option>@for (k of statusKeys; track k) {<option [value]="k" [selected]="k === st()">{{ statusLabel[k] }}</option>}</select></label>
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
                    <th scope="col">Country / Markets</th>
                    <th scope="col">Supported Payment Methods</th>
                    <th scope="col">Status</th>
                    <th scope="col">Setup</th>
                    <th scope="col" [attr.aria-sort]="ariaSort('updated')"><button type="button" class="sort" (click)="sortBy('updated')">Updated At <app-icon [name]="sortIcon('updated')" [size]="12" /></button></th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  @for (h of pageRows(); track h.id) {
                    <tr class="clickable" (click)="open(h)">
                      <td><a class="txn-id" [routerLink]="['/hosts', h.id]" (click)="$event.stopPropagation()">{{ h.name }}</a></td>
                      <td class="mono">{{ h.id }}<span class="sub-line">{{ h.hostCode }}</span></td>
                      <td>{{ h.markets.join(', ') || '—' }}</td>
                      <td><div class="chips">@for (m of h.paymentMethods; track m) {<span class="chip">{{ m }}</span>} @empty {<span class="muted">—</span>}</div></td>
                      <td><span [class]="tone(h.status)">{{ statusLabel[h.status] }}</span></td>
                      <td>@if (setupDone(h) === h.checklist.length) {<span class="setup-ok"><app-icon name="check-circle" [size]="14" />Complete</span>} @else {<span class="muted">{{ setupDone(h) }} of {{ h.checklist.length }} done</span>}</td>
                      <td>{{ when(h.updatedAt) }}</td>
                      <td (click)="$event.stopPropagation()">
                        <div class="row-actions">
                          @if (data()!.can.manage) {
                            <button type="button" class="btn sm" (click)="edit(h)">Edit</button>
                            @if (h.status === 'disabled') {
                              <button type="button" class="btn sm" (click)="act(h, 'enable')">Enable</button>
                            } @else if (h.status !== 'draft') {
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
    <app-host-editor [existing]="e.host" (saved)="onSaved($event)" (closed)="editor.set(null)" />
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
    return t === 'activity' ? t : 'hosts';
  });

  protected readonly countries = hostCountries();
  protected readonly statusLabel = HOST_STATUS_LABEL;
  protected readonly statusKeys = Object.keys(HOST_STATUS_LABEL) as HostStatus[];
  protected readonly tone = statusTone;
  protected readonly when = fmtWhen;

  protected readonly data = signal<HostListResponse | null>(null);
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
  protected readonly st = signal<HostStatus | ''>('');
  protected readonly sort = signal<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  protected readonly page = signal(0);
  protected readonly pageSize = signal(25);
  // Activity tab.
  protected readonly aHost = signal('');
  protected readonly aPage = signal(0);
  protected readonly aPageSize = signal(25);

  protected readonly hasFilters = computed(() => !!(this.q() || this.country() || this.method() || this.st()));
  protected readonly methodOptions = computed(() => {
    const codes = this.country() ? [this.country()] : this.countries.map((c) => c.code);
    return [...new Set(codes.flatMap((c) => hostMethods(c).map((m) => m.name + (m.flow === 'payout' ? ' (Payout)' : ''))))].sort();
  });
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
        (!this.st() || h.status === this.st()),
    );
    const { key, dir } = this.sort();
    const val = (h: HostView) => (key === 'name' ? h.name.toLowerCase() : h.updatedAt);
    return [...rows].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir);
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
    this.loading.set(true);
    this.error.set(null);
    try {
      const [list, activity] = await Promise.all([this.api.list(), this.api.activity()]);
      this.data.set(list);
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

  protected setupDone(h: HostView) {
    return h.checklist.filter((c) => c.done).length;
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
    this.st.set('');
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
