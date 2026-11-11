import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { Deactivation, FLOW_LABEL, fmtDay, PRICING_STATUS_LABEL, PRICING_STATUS_TONE, ProductPricingView, SubMerchantPricingRow, todayIso } from '../../core/merchants/products';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { CodePrompt, codeProblem } from '../../shared/code-prompt';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';
import { DeactivateSheet } from '../products/deactivate-sheet';
import { CorridorSelect, CorridorService } from './corridor';
import { MerchantPricingTabs } from './merchant-pricing-tabs';

/** Merchant Pricing – Sub-Merchant View (§7.3): resolved pricing per sub-merchant and payment method (§7.9). */
@Component({
  selector: 'app-sub-merchant-pricing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, CorridorSelect, MerchantPricingTabs, SideSheet, CodePrompt, DeactivateSheet],
  template: `
    <main class="page">
      <div class="portal-head">
        <div>
          <h1>Sub-Merchant View</h1>
          <p class="sub">Pricing that applies to each sub-merchant in {{ corridor.name() }}: its own rule, or inherited from the Master Merchant.</p>
        </div>
        <div class="head-tools"><app-corridor-select /></div>
      </div>
      <app-merchant-pricing-tabs />
      <section class="panel-card">
        <div class="toolbar">
          <select class="f-input sm" aria-label="Merchant" (change)="merchant.set($any($event.target).value)">
            <option value="" [selected]="!merchant()">All Merchants</option>
            @for (m of merchants(); track m.id) {<option [value]="m.id" [selected]="m.id === merchant()">{{ m.name }} ({{ m.count }})</option>}
          </select>
          <input class="f-input grow" type="search" placeholder="Search merchant, MID, sub-merchant, payment method..." aria-label="Search sub-merchants" [value]="q()" (input)="q.set($any($event.target).value)" />
        </div>
        @if (error(); as e) {
          <div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e.message ?? "We couldn't load sub-merchant pricing." }}</div></div>
        } @else if (filtered().length) {
          <div class="table-wrap">
            <table class="data-table mp-table">
              <thead><tr><th scope="col">Merchant Name</th><th scope="col">Merchant MID</th><th scope="col">Sub-Merchant Name</th><th scope="col">Sub-Merchant ID</th><th scope="col">Payment Method</th><th scope="col">Current Pricing Method</th><th scope="col">Applicable Pricing / MDR</th><th scope="col">Currency</th><th scope="col">Effective Start Date</th><th scope="col">Effective End Date</th><th scope="col">Pricing Status</th>@if (ops()) {<th scope="col"><span class="sr-only">Actions</span></th>}</tr></thead>
              <tbody>
                @for (r of filtered(); track r.subMerchantId + (r.methodCode ?? '')) {
                  <tr>
                    <td><a class="row-link" [routerLink]="['/merchant-pricing', r.applicationId]">{{ r.merchantName }}</a></td>
                    <td class="mono">{{ r.mid ?? '—' }}</td>
                    <td>{{ r.subMerchantName }}</td>
                    <td class="mono">{{ r.subMerchantId }}</td>
                    <td>{{ r.methodName ?? '—' }}@if (r.flow) {<div class="sub-line">{{ flowLabel[r.flow] }}</div>}</td>
                    <td>{{ r.technique ?? 'No pricing' }}@if (r.level) {<div class="sub-line">{{ r.level === 'sub_merchant' ? 'Sub-merchant rule' : 'Inherited from Master Merchant' }}</div>}</td>
                    <td class="cfg">{{ r.pricing ?? 'No pricing' }}</td>
                    <td>{{ r.currency ?? '—' }}</td>
                    <td class="nowrap">{{ r.startDate ? day(r.startDate) : '—' }}</td>
                    <td class="nowrap">{{ r.startDate ? (r.endDate ? day(r.endDate) : 'Ongoing') : '—' }}</td>
                    <td>
                      @if (r.deactivated; as d) {
                        <span class="status danger">Deactivated</span><div class="sub-line">{{ d.scope === 'mid' ? 'Whole MID' : 'This sub-merchant' }} · from {{ day(d.effectiveDate) }}</div>
                      } @else if (r.status; as s) {
                        <span class="status" [class]="'status ' + tone[s]">{{ statusLabel[s] }}</span>
                      } @else {
                        <span class="status warning">No pricing</span>
                      }
                      @if (r.stopsOn) {<div class="sub-line">Stops {{ day(r.stopsOn) }}</div>}
                    </td>
                    @if (ops()) {
                      <td class="row-actions">
                        @if (r.methodCode && r.flow) {
                          @if (r.deactivated?.scope === 'sub_merchant') {
                            <button type="button" class="btn sm ghost" (click)="startReactivate(r)" [disabled]="!!busy()">Reactivate</button>
                          } @else if (!r.deactivated && !r.stopsOn) {
                            <button type="button" class="btn sm ghost" (click)="startDeactivate(r)" [disabled]="!!busy()">Deactivate</button>
                          }
                        }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="empty-state"><div class="icon-tile"><app-icon name="users" /></div><h3>{{ rows().length ? 'No sub-merchants match.' : 'No sub-merchants in ' + corridor.name() + ' yet.' }}</h3></div>
        }
        <p class="mp-foot">Showing {{ subCount() }} sub-merchant records ({{ withPricing() }} with pricing, {{ subCount() - withPricing() }} without)</p>
      </section>
      @if (flash(); as f) {<div class="p-toast" role="status"><app-icon name="check-circle" [size]="18" />{{ f }}</div>}
    </main>

    @if (deactivating(); as d) {
      <app-deactivate-sheet [view]="d.view" [methodCode]="d.row.methodCode!" [flow]="d.row.flow!" [subMerchantId]="d.row.subMerchantId" [lockScope]="true" (finished)="reload()" (closed)="deactivating.set(null)" />
    }

    @if (reactivating(); as x) {
      <app-side-sheet [label]="'Reactivate ' + x.row.methodName" (dismiss)="reactivating.set(null)">
        <header class="sheet-head">
          <div class="sheet-titles">
            <p class="sheet-eyebrow">Reactivate payment method</p>
            <h2 class="sheet-title">{{ x.row.methodName }}</h2>
            <p class="sheet-sub">{{ x.row.subMerchantName }} · {{ x.row.merchantName }}</p>
          </div>
          <button type="button" class="sheet-close" (click)="reactivating.set(null)" aria-label="Close"><app-icon name="x" [size]="18" /></button>
        </header>
        <div class="sheet-body">
          <p class="mp-lead">{{ x.row.subMerchantName }} can use {{ x.row.methodName }} again. It uses the Master Merchant's pricing unless you set its own.</p>
          <p class="f-hint">Deactivated {{ day(x.d.effectiveDate) }} by {{ x.d.createdBy }}. Reason: {{ x.d.reason }}</p>
          @if (actionError(); as e) {<div class="alert danger compact" role="alert"><app-icon name="alert-circle" /><div>{{ e }}</div></div>}
        </div>
        @if (codeAsk()) {
          <app-code-prompt title="Confirm: reactivate" message="This needs a code from your authenticator app. You won't be asked again for 5 minutes." confirmLabel="Reactivate" [busy]="!!busy()" [error]="codeError()" (confirmed)="reactivate($event)" (cancelled)="codeAsk.set(false)" />
        } @else {
          <footer class="sheet-foot">
            <span class="sheet-foot-note">FinOps is told in-app and by email.</span>
            <button type="button" class="btn" (click)="reactivating.set(null)">Back</button>
            <button type="button" class="btn primary" (click)="reactivate()" [disabled]="!!busy()">Reactivate</button>
          </footer>
        }
      </app-side-sheet>
    }
  `,
  styleUrl: './pricing.scss',
})
export class SubMerchantPricing {
  private readonly api = inject(MerchantApi);
  protected readonly corridor = inject(CorridorService);
  protected readonly rows = signal<SubMerchantPricingRow[]>([]);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly merchant = signal('');
  protected readonly q = signal('');
  protected readonly day = fmtDay;
  protected readonly statusLabel = PRICING_STATUS_LABEL;
  protected readonly tone = PRICING_STATUS_TONE;
  protected readonly flowLabel = FLOW_LABEL;
  private readonly roles = inject(StaffRoleService);
  /** Ops (Sales / Operations) deactivate and reactivate payment methods. */
  protected readonly ops = computed(() => this.roles.role() === 'sales');
  protected readonly busy = signal<string | null>(null);
  protected readonly flash = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly deactivating = signal<{ view: ProductPricingView; row: SubMerchantPricingRow } | null>(null);
  protected readonly reactivating = signal<{ view: ProductPricingView; row: SubMerchantPricingRow; d: Deactivation } | null>(null);
  protected readonly codeAsk = signal(false);
  protected readonly codeError = signal<string | null>(null);
  private readonly codePrompt = viewChild(CodePrompt);

  protected readonly merchants = computed(() => {
    const map = new Map<string, { id: string; name: string; subs: Set<string> }>();
    for (const r of this.rows()) {
      const m = map.get(r.merchantId) ?? { id: r.merchantId, name: r.merchantName, subs: new Set<string>() };
      m.subs.add(r.subMerchantId);
      map.set(r.merchantId, m);
    }
    return [...map.values()].map((m) => ({ id: m.id, name: m.name, count: m.subs.size }));
  });
  protected readonly filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.rows().filter(
      (r) => (!this.merchant() || r.merchantId === this.merchant()) && (!q || [r.merchantName, r.mid ?? '', r.subMerchantName, r.subMerchantId, r.methodName ?? '', r.technique ?? '', r.currency ?? '', r.pricing ? '' : 'no pricing'].join(' ').toLowerCase().includes(q)),
    );
  });
  protected readonly subCount = computed(() => new Set(this.filtered().map((r) => r.subMerchantId)).size);
  protected readonly withPricing = computed(() => new Set(this.filtered().filter((r) => r.pricing).map((r) => r.subMerchantId)).size);

  constructor() {
    effect(() => void this.load(this.corridor.code()));
  }

  protected reload() {
    return this.load(this.corridor.code());
  }

  protected async startDeactivate(r: SubMerchantPricingRow) {
    this.busy.set(r.subMerchantId);
    try {
      this.deactivating.set({ view: await this.api.getProducts(r.applicationId), row: r });
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.busy.set(null);
    }
  }

  protected async startReactivate(r: SubMerchantPricingRow) {
    this.busy.set(r.subMerchantId);
    this.actionError.set(null);
    this.codeAsk.set(false);
    try {
      const view = await this.api.getProducts(r.applicationId);
      const d = (view.config.deactivations ?? []).find((x) => x.status === 'done' && x.subMerchantId === r.subMerchantId && x.methodCode === r.methodCode && x.flow === r.flow && x.effectiveDate <= todayIso(view.now));
      if (d) this.reactivating.set({ view, row: r, d });
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.busy.set(null);
    }
  }

  protected async reactivate(code?: string) {
    const x = this.reactivating();
    if (!x) return;
    this.busy.set(x.d.id);
    this.actionError.set(null);
    this.codeError.set(null);
    try {
      await this.api.deactivationAction(x.view.applicationId, x.d.id, 'reactivate', code);
      this.reactivating.set(null);
      this.codeAsk.set(false);
      this.flash.set(`${x.row.methodName} reactivated for ${x.row.subMerchantName}`);
      setTimeout(() => this.flash.set(null), 3000);
      await this.reload();
    } catch (e) {
      const err = toMerchantError(e) as { code?: string; message?: string; attemptsRemaining?: number };
      const mfa = this.codeAsk() ? codeProblem(err.code, err.attemptsRemaining) : null;
      if (err.code === 'MFA_CODE_REQUIRED') this.codeAsk.set(true);
      else if (mfa) {
        this.codeError.set(mfa);
        this.codePrompt()?.reset();
      } else {
        this.codeAsk.set(false);
        this.actionError.set(err.message ?? "We couldn't reactivate it.");
      }
    } finally {
      this.busy.set(null);
    }
  }

  private async load(country: string) {
    this.error.set(null);
    try {
      this.rows.set(await this.api.subMerchantPricing(country));
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }
}
