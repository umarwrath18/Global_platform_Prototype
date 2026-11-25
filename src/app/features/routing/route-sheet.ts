import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal, viewChild } from '@angular/core';
import { DEFAULT_SMART, effectiveShares, HostOption, RouteMode, RouteView, smartScore } from '../../core/routing/routing';
import { RoutingApi, toRoutingError } from '../../core/routing/routing-api.service';
import { HostPerformance } from '../../core/routing/routing';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';

interface Row {
  hostId: string;
  share: number;
}

/**
 * Edit route (one country + payment method): mode (Priority / Percentage split / Smart), hosts,
 * fallback and Smart settings. The preview line says where payments go right now. Saving asks
 * for an authenticator code.
 */
@Component({
  selector: 'app-route-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SideSheet, Icon, CodePrompt],
  styleUrls: ['../hosts/hosts.scss', './routing.scss'],
  template: `
@let r = view();
<app-side-sheet size="editor" [label]="'Edit route ' + r.countryName + ' ' + r.methodName" (dismiss)="close()">
  <header class="sheet-head">
    <div class="sheet-titles">
      <p class="sheet-eyebrow">Routing · {{ r.countryName }} · {{ r.methodName }}@if (r.flow === 'payout') { (Payout)}</p>
      <h2 class="sheet-title">{{ r.route ? 'Edit route' : 'Set route' }}</h2>
      <p class="sheet-sub">Applies to every merchant without an override.</p>
    </div>
    <button type="button" class="sheet-close" (click)="close()" aria-label="Close"><app-icon name="x" [size]="18" /></button>
  </header>
  <div class="sheet-body">
    <fieldset class="rt-field">
      <legend>Routing mode</legend>
      <div class="rt-seg" role="radiogroup" aria-label="Routing mode">
        @for (m of modes; track m.id) {
          <button type="button" role="radio" [attr.aria-checked]="mode() === m.id" [class.on]="mode() === m.id" (click)="setMode(m.id)">{{ m.label }}<small>{{ m.hint }}</small></button>
        }
      </div>
    </fieldset>

    @if (mode() === 'smart') {
      <div class="host-banner warn" role="note"><app-icon name="info" /><div><span class="sim-tag">Simulated</span> Smart routing uses simulated success rates and response times. No live provider data exists yet; replace with real data before production use.</div></div>
      <div class="f-field">
        <label for="rt-weight">What matters more</label>
        <div class="rt-slider"><span>Success rate</span><input id="rt-weight" type="range" min="0" max="100" step="5" [value]="100 - weight()" (input)="weight.set(100 - +v($event))" [attr.aria-valuetext]="weight() + ' % success rate, ' + (100 - weight()) + ' % speed'" /><span>Speed</span></div>
        <p class="f-hint">{{ weight() }} % success rate · {{ 100 - weight() }} % speed</p>
      </div>
      <div class="f-field">
        <label for="rt-min">Minimum success rate (%)</label>
        <input id="rt-min" class="f-input rt-num" inputmode="decimal" maxlength="5" [class.invalid]="err('smart.minSuccessRate')" [value]="minRate()" (input)="minRate.set(v($event))" />
        @if (err('smart.minSuccessRate'); as m) {<p class="f-error">{{ m }}</p>} @else {<p class="f-hint">Partners below this are skipped. Look-back: last 24 hours (simulated).</p>}
      </div>
    }

    <div class="f-field">
      <span class="f-label">{{ mode() === 'split' ? 'Traffic share' : mode() === 'smart' ? 'Candidate partners' : 'Partners, in order' }}</span>
      @if (rows().length) {
        <ol class="rt-list">
          @for (row of rows(); track row.hostId; let i = $index; let last = $last) {
            @let o = option(row.hostId);
            <li [class.off]="!o?.eligible">
              @if (mode() === 'priority') {<span class="rt-num-badge">{{ i + 1 }}</span>}
              <span class="rt-name">{{ o?.name ?? row.hostId }}<small>@if (o?.eligible) {Active · {{ r.methodName }} Available} @else {<span class="warn-text">{{ o?.reason ?? 'Not registered' }}: skipped until eligible</span>}</small>
                @if (mode() === 'smart' && perfOf(row.hostId); as p) {<small>{{ p.successRate }} % success · {{ p.avgResponseMs }} ms · score {{ score(p) }} (simulated)</small>}
              </span>
              @if (mode() === 'split') {
                <label class="sr-only" [for]="'share-' + i">Share for {{ o?.name }}</label>
                <span class="rt-pct"><input [id]="'share-' + i" class="f-input" inputmode="numeric" maxlength="3" [value]="row.share" (input)="setShare(i, v($event))" />%</span>
              }
              @if (mode() === 'priority') {
                <button type="button" class="btn sm ghost" [disabled]="i === 0" (click)="move(i, -1)" [attr.aria-label]="'Move ' + o?.name + ' up'"><app-icon name="arrow-up" [size]="14" /></button>
                <button type="button" class="btn sm ghost" [disabled]="last" (click)="move(i, 1)" [attr.aria-label]="'Move ' + o?.name + ' down'"><app-icon name="arrow-down" [size]="14" /></button>
              }
              <button type="button" class="btn sm ghost" (click)="remove(i)" [attr.aria-label]="'Remove ' + o?.name"><app-icon name="trash" [size]="14" /></button>
            </li>
          }
        </ol>
      } @else {
        <p class="host-empty-line">No partners yet. Add one below.</p>
      }
      @if (mode() === 'split') {
        <div class="rt-meter" aria-hidden="true">@for (row of rows(); track row.hostId; let i = $index) {<i [style.width.%]="row.share" [class]="'c' + (i % 4)"></i>}</div>
        <p class="f-hint" [class.f-error]="shareTotal() !== 100">Total {{ shareTotal() }} %. Shares must add up to 100 before you can save.</p>
      }
      @if (err('hosts') || err('shares'); as m) {<p class="f-error" role="alert">{{ m }}</p>}
      @if (addable().length) {
        <div class="rt-add">
          <label class="sr-only" for="rt-add">Partner to add</label>
          <select id="rt-add" class="f-input" (change)="pick.set(v($event))">
            <option value="" [selected]="!pick()">Add a partner…</option>
            @for (o of addable(); track o.hostId) {<option [value]="o.hostId">{{ o.name }} · {{ o.eligible ? 'eligible' : o.reason }}</option>}
          </select>
          <button type="button" class="btn" [disabled]="!pick()" (click)="add()"><app-icon name="plus" [size]="14" />Add</button>
        </div>
      }
      <p class="f-hint">Only partners registered for {{ r.countryName }} · {{ r.methodName }} in Partners can be added.</p>
    </div>

    <label class="rt-toggle">
      <input type="checkbox" role="switch" [checked]="fallback()" (change)="fallback.set($any($event.target).checked)" />
      <span><strong>Fallback</strong>{{ fallbackText() }}</span>
    </label>

    @if (preview(); as p) {<div class="alert info compact" role="status"><app-icon name="info" /><div>{{ p }}</div></div>}
    @if (error(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
  </div>
  @if (codeAsk()) {
    <app-code-prompt title="Confirm it's you" message="Enter a code from your authenticator app." confirmLabel="Save route" [busy]="busy()" [error]="codeError()" (confirmed)="save($event)" (cancelled)="codeAsk.set(false)" />
  } @else {
    <footer class="sheet-foot">
      <span class="sheet-foot-note">Saving needs an authenticator code.</span>
      <button type="button" class="btn" (click)="close()" [disabled]="busy()">Cancel</button>
      <button type="button" class="btn primary" (click)="save()" [disabled]="busy()">@if (busy()) {<span class="spinner" aria-hidden="true"></span>}Save route</button>
    </footer>
  }
</app-side-sheet>
  `,
})
export class RouteSheet implements OnInit {
  private readonly api = inject(RoutingApi);
  private readonly prompt = viewChild(CodePrompt);

  readonly view = input.required<RouteView>();
  readonly performance = input<HostPerformance[]>([]);
  readonly done = output<RouteView>();
  readonly closed = output<void>();

  protected readonly modes: { id: RouteMode; label: string; hint: string }[] = [
    { id: 'priority', label: 'Priority', hint: 'Ordered list' },
    { id: 'split', label: 'Percentage split', hint: 'Share traffic' },
    { id: 'smart', label: 'Smart', hint: 'Simulated performance' },
  ];
  protected readonly mode = signal<RouteMode>('priority');
  protected readonly rows = signal<Row[]>([]);
  protected readonly fallback = signal(true);
  protected readonly weight = signal(DEFAULT_SMART.successWeight);
  protected readonly minRate = signal(String(DEFAULT_SMART.minSuccessRate));
  protected readonly pick = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly codeAsk = signal(false);
  protected readonly codeError = signal<string | null>(null);

  ngOnInit() {
    const r = this.view().route;
    if (r) {
      this.mode.set(r.mode);
      this.rows.set(r.hosts.map((h) => ({ hostId: h.hostId, share: h.share ?? 0 })));
      this.fallback.set(r.fallback);
      this.weight.set(r.smart.successWeight);
      this.minRate.set(String(r.smart.minSuccessRate));
    }
  }

  protected v(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected option(id: string): HostOption | undefined {
    return this.view().options.find((o) => o.hostId === id);
  }

  protected readonly addable = computed(() => this.view().options.filter((o) => o.hostStatus !== 'removed' && !this.rows().some((r) => r.hostId === o.hostId)));
  protected readonly shareTotal = computed(() => this.rows().reduce((n, r) => n + (Number(r.share) || 0), 0));

  protected perfOf(id: string) {
    const r = this.view();
    const p = this.performance().find((x) => x.hostId === id && x.country === r.country && x.methodCode === r.methodCode);
    return p && p.successRate !== null ? p : null;
  }

  protected score(p: HostPerformance) {
    return smartScore(p.successRate!, p.avgResponseMs!, { successWeight: this.weight(), minSuccessRate: Number(this.minRate()) || 0 }).toFixed(2);
  }

  protected readonly fallbackText = computed(() =>
    this.mode() === 'split'
      ? ' If a host is Disabled, under Maintenance or has this method switched off, its share is split across the remaining eligible hosts in proportion. Off: those payments fail.'
      : this.mode() === 'smart'
        ? ' If no host meets the minimum, or a host is not eligible, use the next host in the ranking. Off: the payment fails instead.'
        : ' If a host is Disabled, under Maintenance or has this method switched off, use the next eligible host. Off: the payment fails instead.',
  );

  /** Where payments go right now with these settings. */
  protected readonly preview = computed(() => {
    const rows = this.rows();
    if (!rows.length) return null;
    const elig = (id: string) => !!this.option(id)?.eligible;
    const name = (id: string) => this.option(id)?.name ?? id;
    if (this.mode() === 'priority') {
      if (elig(rows[0].hostId)) {
        const next = rows.slice(1).find((r) => elig(r.hostId));
        return `Payments now go to ${name(rows[0].hostId)}.${next && this.fallback() ? ` If ${name(rows[0].hostId)} becomes ineligible: ${name(next.hostId)}.` : ''}`;
      }
      const next = rows.find((r) => elig(r.hostId));
      return !this.fallback() ? `${name(rows[0].hostId)} isn't eligible and fallback is off: payments fail.` : next ? `${name(rows[0].hostId)} isn't eligible: payments go to ${name(next.hostId)}.` : 'No host is eligible: payments fail.';
    }
    if (this.mode() === 'split') {
      if (this.shareTotal() !== 100) return null;
      const blocked = rows.filter((r) => !elig(r.hostId));
      if (!blocked.length) return `Payments are shared: ${rows.map((r) => `${r.share} % ${name(r.hostId)}`).join(', ')}.`;
      if (!this.fallback()) return `${blocked.map((b) => `${name(b.hostId)}'s ${b.share} %`).join(', ')} fail while not eligible.`;
      const eff = effectiveShares(rows.map((r) => ({ hostId: r.hostId, share: Number(r.share) })), elig);
      return eff.length ? `Right now ${blocked.map((b) => name(b.hostId)).join(', ')} ${blocked.length === 1 ? 'is' : 'are'} not eligible, so ${eff.map((e) => `${e.share} % goes to ${name(e.hostId)}`).join(', ')}.` : 'No host is eligible: payments fail.';
    }
    const min = Number(this.minRate()) || 0;
    const ranked = rows
      .filter((r) => elig(r.hostId))
      .map((r) => ({ r, p: this.perfOf(r.hostId) }))
      .filter((x) => x.p)
      .map((x) => ({ id: x.r.hostId, ok: x.p!.successRate! >= min, s: smartScore(x.p!.successRate!, x.p!.avgResponseMs!, { successWeight: this.weight(), minSuccessRate: min }) }))
      .sort((a, b) => b.s - a.s);
    const best = ranked.find((x) => x.ok) ?? (this.fallback() ? ranked[0] : undefined);
    return best ? `Smart ranks ${name(best.id)} first right now (simulated).` : 'No host meets the minimum: payments fail.';
  });

  protected setMode(m: RouteMode) {
    this.mode.set(m);
    this.errors.set({});
    if (m === 'split' && this.rows().length && this.shareTotal() !== 100) {
      const n = this.rows().length;
      this.rows.update((list) => list.map((r, i) => ({ ...r, share: Math.floor(100 / n) + (i < 100 % n ? 1 : 0) })));
    }
  }

  protected add() {
    if (!this.pick()) return;
    this.rows.update((list) => [...list, { hostId: this.pick(), share: list.length ? 0 : 100 }]);
    this.pick.set('');
    this.errors.set({});
  }

  protected remove(i: number) {
    this.rows.update((list) => list.filter((_, j) => j !== i));
  }

  protected move(i: number, d: -1 | 1) {
    this.rows.update((list) => {
      const out = [...list];
      [out[i], out[i + d]] = [out[i + d], out[i]];
      return out;
    });
  }

  protected setShare(i: number, value: string) {
    this.rows.update((list) => list.map((r, j) => (j === i ? { ...r, share: Number(value.replace(/\D/g, '')) || 0 } : r)));
    this.errors.update(({ shares: _, ...rest }) => rest);
  }

  protected err(field: string) {
    return this.errors()[field] ?? null;
  }

  protected close() {
    if (this.busy()) return;
    if (this.codeAsk()) return this.codeAsk.set(false);
    this.closed.emit();
  }

  protected async save(code?: string) {
    const r = this.view();
    this.busy.set(true);
    this.error.set(null);
    this.codeError.set(null);
    try {
      const res = await this.api.saveRoute(
        r.country,
        r.methodCode,
        {
          mode: this.mode(),
          hosts: this.rows().map((x) => (this.mode() === 'split' ? { hostId: x.hostId, share: Number(x.share) } : { hostId: x.hostId })),
          fallback: this.fallback(),
          smart: { successWeight: this.weight(), minSuccessRate: Number(this.minRate()) },
        },
        code,
      );
      this.codeAsk.set(false);
      this.done.emit(res);
    } catch (e) {
      const err = toRoutingError(e);
      const mfa = this.codeAsk() ? codeProblem(err.code, err.attemptsRemaining) : null;
      if (err.code === 'MFA_CODE_REQUIRED') this.codeAsk.set(true);
      else if (mfa) {
        this.codeError.set(mfa);
        this.prompt()?.reset();
      } else {
        this.codeAsk.set(false);
        if (err.errors.length) this.errors.set(Object.fromEntries(err.errors.map((x) => [x.field, x.message])));
        else this.error.set(err.message ?? "That didn't work. Please try again.");
      }
    } finally {
      this.busy.set(false);
    }
  }
}
