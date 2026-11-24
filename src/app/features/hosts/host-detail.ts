import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HostApi, toHostError } from '../../core/hosts/host-api.service';
import {
  adapterLabel,
  AUTH_METHOD_LABEL,
  AVAILABILITY_LABEL,
  AvailabilityStatus,
  HOST_ENVIRONMENT_LABEL,
  HOST_STATUS_LABEL,
  HostCapabilityView,
  HostDetailResponse,
  hostTypeLabel,
  PAYMENT_FLOW_LABEL,
} from '../../core/hosts/hosts';
import { countryName } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { HostAction, HostActionSheet } from './host-action-sheet';
import { HostCapabilitySheet } from './host-capability-sheet';
import { HostEditor } from './host-editor';
import { availabilityTone, fmtWhen, statusTone } from './host-ui';

type Tab = 'overview' | 'capabilities' | 'integration' | 'activity';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'capabilities', label: 'Payment Methods' },
  { id: 'integration', label: 'Integration' },
  { id: 'activity', label: 'Activity Log' },
];

/**
 * Host Details: a dedicated page with four tabs. Editing uses the editor side sheet; Enable /
 * Disable / Maintenance and payment methods use small side sheets. One status per host, plus a
 * setup checklist; no credentials and no health data.
 */
@Component({
  selector: 'app-host-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, HostEditor, HostActionSheet, HostCapabilitySheet],
  styleUrl: './hosts.scss',
  template: `
<main class="page host-page">
  <nav class="crumbs" aria-label="Breadcrumb"><a routerLink="/hosts">Host Management</a> <span aria-hidden="true">/</span> {{ d()?.host?.name ?? id() }}</nav>

  @if (error(); as e) {
    <div class="empty-state" role="alert"><div class="icon-tile"><app-icon name="alert-circle" /></div><h3>{{ notFound() ? 'Host not found' : "We couldn't load this host" }}</h3><p>{{ e }}</p><a class="btn" routerLink="/hosts">Back to Host Management</a></div>
  } @else if (d(); as x) {
    @let h = x.host;
    <div class="host-head">
      <div>
        <h1>{{ h.name }} @if (h.sample) {<span class="sample-tag">Sample</span>}</h1>
        <p>{{ h.id }} · {{ h.hostCode }} · {{ typeLabel(h.hostType) }} · {{ h.markets.join(', ') || 'No markets yet' }}</p>
        <p>Updated {{ when(h.updatedAt) }} by {{ h.updatedBy }}</p>
        <div class="host-detail-status"><span [class]="tone(h.status)">{{ statusLabel[h.status] }}</span></div>
      </div>
      @if (x.can.manage) {
        <div class="actions">
          <button type="button" class="btn" (click)="openEditor(0)"><app-icon name="edit" [size]="14" />Edit</button>
          @if (h.operationalState === 'active') {
            <button type="button" class="btn" (click)="act('maintenance')">Maintenance</button>
            <button type="button" class="btn danger-outline" (click)="act('disable')">Disable</button>
          } @else if (h.operationalState === 'maintenance') {
            <button type="button" class="btn primary" (click)="act('enable')">Re-enable</button>
            <button type="button" class="btn danger-outline" (click)="act('disable')">Disable</button>
          } @else if (h.status === 'disabled') {
            <button type="button" class="btn primary" (click)="act('enable')">Enable</button>
          }
        </div>
      } @else {
        <p class="f-hint">View only. Tech Ops manages hosts.</p>
      }
    </div>

    @if (created(); as c) {<div class="alert success compact" role="status"><app-icon name="check-circle" /><div>{{ c === 'draft' ? 'Saved as a draft. Finish it with Edit.' : 'Host saved. It stays Disabled until you enable it.' }}</div></div>}
    @if (toast(); as t) {<div class="alert success compact" role="status"><app-icon name="check-circle" /><div>{{ t }}</div></div>}
    @if (h.status === 'active' && !methodsOk()) {
      <div class="host-banner warn" role="note"><app-icon name="alert-circle" /><div><strong>No payment method is Available.</strong> The host is Active but can't take any payments until a method is switched on.</div></div>
    }
    @if (h.maintenance; as m) {
      <div class="host-banner warn" role="note"><app-icon name="clock" /><div><strong>Under maintenance</strong> since {{ when(m.since) }} by {{ m.by }}: {{ m.reason }}@if (m.until) { · expected end {{ when(m.until) }}}</div></div>
    }
    @if (h.operationalState === 'disabled' && h.disabledReason) {
      <div class="host-banner" role="note"><app-icon name="info" /><div><strong>Disabled.</strong> {{ h.disabledReason }}</div></div>
    }

    <nav class="host-tabs" aria-label="Host sections">
      @for (t of tabs; track t.id) {
        <a [routerLink]="[]" [queryParams]="{ tab: t.id === 'overview' ? null : t.id, created: null }" [class.on]="tab() === t.id" [attr.aria-current]="tab() === t.id ? 'page' : null">{{ t.label }}</a>
      }
    </nav>

    @switch (tab()) {
      @case ('overview') {
        <div class="host-layout">
          <div class="host-col">
            <section class="sheet-section">
              <h3>Status</h3>
              <dl class="sheet-dl">
                <div class="wide"><dt>Status</dt><dd><span [class]="tone(h.status)">{{ statusLabel[h.status] }}</span><span class="sub-line">{{ statusNote() }}</span></dd></div>
              </dl>
            </section>
            <section class="sheet-section">
              <h3>Setup checklist</h3>
              <ul class="setup-list">
                @for (c of h.checklist; track c.id) {
                  <li [class.done]="c.done"><app-icon [name]="c.done ? 'check-circle' : 'alert-circle'" [size]="16" /><span>{{ c.label }}</span></li>
                }
              </ul>
              @if (h.status !== 'active' && h.status !== 'maintenance' && x.enableBlockers.length) {<p class="f-hint">All four must be done before the host can be enabled.</p>}
            </section>
            <section class="sheet-section">
              <h3>Coverage</h3>
              <dl class="sheet-dl">
                <div><dt>Markets</dt><dd>{{ h.markets.join(', ') || '—' }}</dd></div>
                <div><dt>Currencies</dt><dd>{{ currencies() || '—' }}</dd></div>
                <div><dt>Payment flows</dt><dd>{{ flows() || '—' }}</dd></div>
                <div><dt>Payment methods</dt><dd>{{ h.paymentMethods.join(', ') || '—' }}</dd></div>
              </dl>
            </section>
            <section class="sheet-section">
              <h3>Host information</h3>
              <dl class="sheet-dl">
                <div><dt>Host Code</dt><dd class="mono">{{ h.hostCode }}</dd></div>
                <div><dt>Host Type</dt><dd>{{ typeLabel(h.hostType) }}</dd></div>
                <div><dt>Country of Registration</dt><dd>{{ h.registrationCountry ? cname(h.registrationCountry) : '—' }}</dd></div>
                <div><dt>Internal Owner</dt><dd>{{ h.ownerTeam || '—' }}</dd></div>
                <div><dt>Created</dt><dd>{{ when(h.createdAt) }} · {{ h.createdBy }}</dd></div>
                @if (h.description) {<div class="wide"><dt>Description</dt><dd>{{ h.description }}</dd></div>}
                @if (h.notes) {<div class="wide"><dt>Notes</dt><dd>{{ h.notes }}</dd></div>}
              </dl>
            </section>
            <p class="f-hint">No transaction volumes, success rates or health data are shown: Mobi has no live data from this host yet. Commercial cost (MDR) is managed in pricing, not here.</p>
          </div>
          <aside class="host-side" aria-label="Recent activity">
            <div class="host-section-head"><h3>Recent activity</h3><a [routerLink]="[]" [queryParams]="{ tab: 'activity' }">View all</a></div>
            <ul class="host-timeline">
              @for (a of x.activity.slice(0, 6); track a.id) {<li><strong>{{ a.action }}</strong><span class="meta">{{ a.details }}</span><span class="meta">{{ when(a.timestamp) }} · {{ a.performedBy }}</span></li>}
            </ul>
          </aside>
        </div>
      }

      @case ('capabilities') {
        <section class="panel-card">
          <div class="panel-head"><div><h2>Payment methods</h2><p>Switch each method on or off on its own. Switching one off never disables the host.</p></div>
            @if (x.can.manage) {<button type="button" class="btn" (click)="capSheet.set({ cap: null })"><app-icon name="plus" [size]="14" />Add payment method</button>}</div>
          @if (x.capabilities.length) {
            <div class="table-wrap">
              <table class="data-table host-table">
                <thead><tr><th scope="col">Country</th><th scope="col">Payment Method</th><th scope="col">Payment Flow</th><th scope="col">Currency</th><th scope="col">Availability</th><th scope="col">Updated At</th>@if (x.can.manage) {<th scope="col">Actions</th>}</tr></thead>
                <tbody>
                  @for (c of x.capabilities; track c.id) {
                    <tr>
                      <td>{{ c.countryName }}</td><td><strong>{{ c.paymentMethodName }}</strong></td><td>{{ flowLabel[c.paymentFlow] }}</td><td>{{ c.supportedCurrencies.join(', ') }}</td>
                      <td><span [class]="availTone(c.availabilityStatus)">{{ availLabel[c.availabilityStatus] }}</span></td>
                      <td>{{ when(c.updatedAt) }}</td>
                      @if (x.can.manage) {
                        <td><div class="row-actions"><button type="button" class="btn sm" (click)="capSheet.set({ cap: c })">Edit</button>@if (c.availabilityStatus === 'disabled') {<button type="button" class="btn sm" (click)="setCap(c, 'available')" [disabled]="busy()">Enable</button>} @else {<button type="button" class="btn sm danger-outline" (click)="setCap(c, 'disabled')" [disabled]="busy()">Disable</button>}</div></td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="empty-state"><h3>No payment methods yet</h3>@if (x.can.manage) {<button type="button" class="btn primary" (click)="capSheet.set({ cap: null })">Add payment method</button>}</div>
          }
        </section>
      }

      @case ('integration') {
        @if (x.integration; as i) {
          <section class="sheet-section">
            <h3>Integration details</h3>
            <dl class="sheet-dl">
              <div><dt>Integration adapter</dt><dd>{{ adapter(i.adapterType) || '—' }}</dd></div>
              <div><dt>Integration name</dt><dd>{{ i.integrationName || '—' }}</dd></div>
              <div class="wide"><dt>API endpoint</dt><dd class="mono">{{ i.apiBaseUrl || '—' }}</dd></div>
              <div><dt>API version</dt><dd>{{ i.apiVersion || '—' }}</dd></div>
              <div><dt>Environment</dt><dd>{{ envLabel[i.environment] }}</dd></div>
              <div><dt>Authentication</dt><dd>{{ i.authenticationType ? authLabel[i.authenticationType] : '—' }}@if (authDetail(); as a) {<span class="sub-line">{{ a }}</span>}</dd></div>
              <div><dt>Timeout</dt><dd>{{ i.timeoutSeconds ? i.timeoutSeconds + ' seconds' : '—' }}</dd></div>
              <div><dt>Details</dt><dd>@if (i.missing.length) {<span class="status warning">Incomplete</span><span class="sub-line">Missing: {{ i.missing.join(', ') }}</span>} @else {<span class="status success">Complete</span>}</dd></div>
              @if (i.connectionConfig) {<div class="wide"><dt>Connection configuration</dt><dd>{{ i.connectionConfig }}</dd></div>}
              @if (i.notes) {<div class="wide"><dt>Integration notes</dt><dd>{{ i.notes }}</dd></div>}
            </dl>
          </section>
          <p class="f-hint">Provider-specific request and response handling lives in the integration adapter. Credentials are not kept in Host Management.</p>
          @if (x.can.manage) {
            <div class="host-actions-row"><button type="button" class="btn" (click)="openEditor(2)">Edit integration</button></div>
          }
        } @else {
          <div class="empty-state"><h3>No integration details yet</h3>@if (x.can.manage) {<button type="button" class="btn primary" (click)="openEditor(2)">Add integration details</button>}</div>
        }
      }

      @case ('activity') {
        <section class="panel-card">
          <div class="panel-head"><div><h2>Activity log</h2><p>Every change, latest first. Actors and times on sample records are simulated.</p></div></div>
          <div class="table-wrap">
            <table class="data-table host-table">
              <thead><tr><th scope="col">Date and Time</th><th scope="col">Activity</th><th scope="col">Performed By</th><th scope="col">Details</th></tr></thead>
              <tbody>@for (a of x.activity; track a.id) {<tr><td class="mono">{{ when(a.timestamp) }}</td><td><strong>{{ a.action }}</strong></td><td>{{ a.performedBy }}</td><td>{{ a.details }}</td></tr>}</tbody>
            </table>
          </div>
        </section>
      }
    }

    @if (editor(); as e) {
      <app-host-editor [existing]="x" [startStep]="e.step" (saved)="onEdited($event)" (closed)="editor.set(null)" />
    }
    @if (action(); as a) {
      <app-host-action-sheet [detail]="x" [action]="a" (done)="onDone($event.detail, $event.message)" (closed)="action.set(null)" />
    }
    @if (capSheet(); as c) {
      <app-host-capability-sheet [detail]="x" [cap]="c.cap" (done)="capSheet.set(null); onDone($event.detail, $event.message)" (closed)="capSheet.set(null)" />
    }
  } @else {
    <div class="skeleton-rows" aria-busy="true" aria-label="Loading host"><span></span><span></span><span></span><span></span></div>
  }
</main>
  `,
})
export class HostDetail {
  private readonly api = inject(HostApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  readonly id = input.required<string>();

  protected readonly tabs = TABS;
  protected readonly tab = computed<Tab>(() => (TABS.find((t) => t.id === this.params().get('tab'))?.id ?? 'overview'));
  protected readonly created = computed(() => this.params().get('created'));
  protected readonly statusLabel = HOST_STATUS_LABEL;
  protected readonly availLabel = AVAILABILITY_LABEL;
  protected readonly flowLabel = PAYMENT_FLOW_LABEL;
  protected readonly envLabel = HOST_ENVIRONMENT_LABEL;
  protected readonly authLabel = AUTH_METHOD_LABEL;
  protected readonly tone = statusTone;
  protected readonly availTone = availabilityTone;
  protected readonly typeLabel = hostTypeLabel;
  protected readonly adapter = adapterLabel;
  protected readonly cname = countryName;
  protected readonly when = fmtWhen;

  protected readonly d = signal<HostDetailResponse | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly notFound = signal(false);
  protected readonly busy = signal(false);
  protected readonly toast = signal<string | null>(null);
  protected readonly editor = signal<{ step: 0 | 1 | 2 | 3 } | null>(null);
  protected readonly action = signal<HostAction | null>(null);
  protected readonly capSheet = signal<{ cap: HostCapabilityView | null } | null>(null);

  protected readonly currencies = computed(() => [...new Set((this.d()?.capabilities ?? []).flatMap((c) => c.supportedCurrencies))].join(', '));
  protected readonly flows = computed(() => [...new Set((this.d()?.capabilities ?? []).filter((c) => c.availabilityStatus !== 'disabled').map((c) => PAYMENT_FLOW_LABEL[c.paymentFlow]))].join(', '));
  protected readonly authDetail = computed(() => {
    const a = this.d()?.integration?.authConfig ?? {};
    return [a.keyHeader && `Header ${a.keyHeader}`, a.signature, a.clientId && `Client ID ${a.clientId}`, a.tokenUrl && `Token URL ${a.tokenUrl}`, a.scope && `Scope ${a.scope}`, a.description].filter(Boolean).join(' · ') || null;
  });
  protected readonly statusNote = computed(() => {
    const s = this.d()?.host.status;
    return s === 'active' ? 'Eligible for routing once Routing Management exists.' : s === 'maintenance' ? 'Not eligible for routing until re-enabled.' : s === 'draft' ? 'Saved incomplete. Finish it with Edit.' : 'Not eligible for routing. Enable it once the setup checklist is complete.';
  });
  protected readonly methodsOk = computed(() => !!this.d()?.host.checklist.find((c) => c.id === 'methods')?.done);

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected async load(id = this.id()) {
    this.error.set(null);
    try {
      this.d.set(await this.api.detail(id));
    } catch (e) {
      const err = toHostError(e);
      this.notFound.set(err.code === 'NOT_FOUND');
      this.error.set(err.message ?? 'Please try again in a moment.');
    }
  }

  protected openEditor(step: 0 | 1 | 2 | 3) {
    this.editor.set({ step });
  }

  protected act(a: HostAction) {
    this.action.set(a);
  }

  protected onEdited(d: HostDetailResponse) {
    this.editor.set(null);
    this.onDone(d, 'Host saved');
  }

  protected onDone(d: HostDetailResponse, message: string) {
    this.action.set(null);
    this.d.set(d);
    this.flash(message);
  }

  /** Switch one payment method on or off. The host's own status never changes. */
  protected async setCap(c: HostCapabilityView, to: AvailabilityStatus) {
    const x = this.d();
    if (!x || this.busy()) return;
    this.busy.set(true);
    try {
      this.onDone(await this.api.setAvailability(x.host.id, c.id, to), to === 'disabled' ? `${c.paymentMethodName} disabled; the host is unchanged` : `${c.paymentMethodName} is Available`);
    } catch (e) {
      this.flash(toHostError(e).message ?? "We couldn't change the capability.");
    } finally {
      this.busy.set(false);
    }
  }

  private flash(text: string) {
    this.toast.set(text);
    setTimeout(() => this.toast.set(null), 4000);
  }
}
