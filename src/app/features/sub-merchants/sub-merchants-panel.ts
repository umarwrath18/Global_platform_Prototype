import { AuthService } from '../../core/auth/auth.service';
import { SUSPENSION_TYPE_LABEL, SuspensionEffect, SuspensionView, VIA_LABEL } from '../../core/merchants/suspensions';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, Injector, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { CountryApplication, FieldIssue, GlobalMerchant, STAFF_ROLE_LABEL } from '../../core/merchants/merchant-models';
import { countryName, ONBOARDING_COUNTRIES, subMerchantRoutes } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { SUB_MERCHANT_STATUS_LABEL, SubMerchantStatus, SubMerchantView } from '../../core/merchants/sub-merchants';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

const TONE: Record<SubMerchantStatus, string> = { draft: '', pending_risk_review: 'warning', approved: 'info', rejected: 'danger', live: 'success' };

/** Sub-merchants of a parent merchant: list, creation, Risk review, CS go-live and suspension. */
@Component({
  selector: 'app-sub-merchants-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  templateUrl: './sub-merchants-panel.html',
  styleUrl: './sub-merchants.scss',
})
export class SubMerchantsPanel {
  private readonly api = inject(MerchantApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly roles = inject(StaffRoleService);

  readonly merchant = input.required<GlobalMerchant>();
  readonly applications = input.required<CountryApplication[]>();
  readonly subMerchants = input.required<SubMerchantView[]>();
  /** Opens this sub-merchant's details (e.g. from the Approvals page). */
  readonly openId = input<string | null | undefined>(null);
  /** What each sub-merchant is under (suspensions); and the merchant's suspensions. */
  readonly effects = input<Record<string, SuspensionEffect>>({});
  readonly suspensions = input<SuspensionView[]>([]);
  readonly changed = output<string>();
  /** Opens the Suspend sheet with this sub-merchant pre-selected. */
  readonly suspendSub = output<string>();
  /** Opens a suspension step (view, review, reactivate, approve). */
  readonly openSuspension = output<{ id: string; mode: 'view' | 'review' | 'reactivate' | 'approve' }>();
  protected readonly viaLabel = VIA_LABEL;
  protected readonly typeLabel = SUSPENSION_TYPE_LABEL;
  private readonly authService = inject(AuthService);
  protected readonly me = computed(() => this.authService.session()?.user.id);
  /** The sub-merchant's own active suspension, if any. */
  protected ownSuspension(id: string) {
    return this.suspensions().find((x) => x.scope === 'sub_merchant' && x.subMerchantId === id && x.status === 'active') ?? null;
  }

  protected readonly statusLabel = SUB_MERCHANT_STATUS_LABEL;
  protected readonly tone = TONE;
  protected readonly countryName = countryName;
  protected readonly dateTime = fmtDateTime;
  protected readonly teamLabel = STAFF_ROLE_LABEL as Record<string, string>;

  protected readonly adding = signal(false);
  protected readonly form = signal({ displayName: '', email: '', website: '', country: '', tradingLicenseUrl: '' });
  protected readonly issues = signal<FieldIssue[]>([]);
  protected readonly selected = signal<string | null>(null);
  protected readonly comment = signal('');
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  /** Countries where the parent has an application and Sales / Operations may create sub-merchants. */
  protected readonly countries = computed(() =>
    [...new Set(this.applications().filter((a) => a.status !== 'rejected').map((a) => a.country))].filter((c) => subMerchantRoutes(ONBOARDING_COUNTRIES[c]).opsInitiated),
  );
  protected readonly canAdd = computed(() => !this.blockedReason());
  /** Why "Add sub-merchant" isn't available right now, phrased as what to do next. */
  protected readonly blockedReason = computed(() => {
    const m = this.merchant();
    if (this.roles.role() !== 'sales') return 'Sales / Operations add sub-merchants. Switch "View as" to Sales / Ops to add one.';
    if (m.lifecycleStatus === 'suspended') return `${m.legalName} is suspended, so it can't add sub-merchants. Risk must reactivate it first.`;
    if (this.countries().length) return null;
    const applied = [...new Set(this.applications().filter((a) => a.status !== 'rejected').map((a) => a.country))];
    if (!applied.length) return `Start a country application for ${m.legalName} first. Sub-merchants are added in countries where the parent has applied.`;
    return `The country rules for ${applied.map(countryName).join(', ')} don't allow Sales / Operations to create sub-merchants.`;
  });

  constructor() {
    effect(() => {
      const id = this.openId();
      if (id && this.subMerchants().some((s) => s.id === id)) {
        this.selected.set(id);
        queueMicrotask(() => this.host.nativeElement.querySelector('.sm-detail')?.scrollIntoView?.({ block: 'nearest' }));
      }
    });
  }

  /** Opens the add form and brings it into view (used by the merchant page header action). */
  startAdd() {
    if (!this.canAdd()) return;
    this.openAdd();
    // After the form has rendered.
    afterNextRender(
      () => {
        this.host.nativeElement.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        this.host.nativeElement.querySelector<HTMLElement>('#sm-name')?.focus();
      },
      { injector: this.injector },
    );
  }
  protected readonly current = computed(() => this.subMerchants().find((s) => s.id === this.selected()) ?? null);

  protected issue(field: string) {
    return this.issues().find((i) => i.field === field)?.message ?? null;
  }

  protected openAdd() {
    this.form.set({ displayName: '', email: '', website: '', country: this.countries()[0] ?? '', tradingLicenseUrl: '' });
    this.issues.set([]);
    this.error.set(null);
    this.adding.set(true);
  }

  protected cancelAdd() {
    const f = this.form();
    if ((f.displayName || f.email || f.website || f.tradingLicenseUrl) && !confirm('Discard this sub-merchant?')) return;
    this.adding.set(false);
  }

  protected set<K extends keyof ReturnType<typeof this.form>>(key: K, value: ReturnType<typeof this.form>[K]) {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected async create(submit: boolean) {
    const f = this.form();
    this.busy.set('create');
    this.error.set(null);
    this.issues.set([]);
    try {
      const s = await this.api.createSubMerchant(this.merchant().id, {
        country: f.country,
        displayName: f.displayName.trim(),
        email: f.email.trim(),
        website: f.website.trim(),
        tradingLicenseUrl: f.tradingLicenseUrl.trim() || null,
        submit,
      });
      this.adding.set(false);
      this.selected.set(s.id);
      this.changed.emit(submit ? `${s.displayName} sent to Risk` : `${s.displayName} saved as a draft`);
    } catch (e) {
      const err = toMerchantError(e);
      if ('errors' in err && err.errors?.length) this.issues.set(err.errors);
      else this.error.set(err.message ?? "We couldn't create the sub-merchant.");
    } finally {
      this.busy.set(null);
    }
  }

  protected toggle(id: string) {
    this.selected.set(this.selected() === id ? null : id);
    this.comment.set('');
    this.error.set(null);
  }

  protected async act(s: SubMerchantView, action: 'submit' | 'review' | 'checks' | 'go-live' | 'lifecycle', body: object, message: string) {
    this.busy.set(action);
    this.error.set(null);
    try {
      await this.api.subMerchantAction(s.id, action, body);
      this.comment.set('');
      this.changed.emit(message);
    } catch (e) {
      this.error.set(toMerchantError(e).message ?? "We couldn't update the sub-merchant.");
    } finally {
      this.busy.set(null);
    }
  }

  protected review(s: SubMerchantView, decision: 'approve' | 'reject') {
    if (decision === 'reject' && this.comment().trim().length < 10) {
      this.error.set('Give the reason for rejecting (at least 10 characters).');
      return;
    }
    void this.act(s, 'review', { decision, comment: this.comment().trim() }, decision === 'approve' ? `${s.displayName} approved` : `${s.displayName} rejected`);
  }

}
