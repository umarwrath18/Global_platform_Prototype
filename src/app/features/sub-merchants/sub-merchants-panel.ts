import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { CountryApplication, FieldIssue, GlobalMerchant, STAFF_ROLE_LABEL } from '../../core/merchants/merchant-models';
import { countryName, FieldRule, ONBOARDING_COUNTRIES, subMerchantRoutes } from '../../core/merchants/onboarding-config';
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
  protected readonly roles = inject(StaffRoleService);

  readonly merchant = input.required<GlobalMerchant>();
  readonly applications = input.required<CountryApplication[]>();
  readonly subMerchants = input.required<SubMerchantView[]>();
  readonly changed = output<string>();

  protected readonly statusLabel = SUB_MERCHANT_STATUS_LABEL;
  protected readonly tone = TONE;
  protected readonly countryName = countryName;
  protected readonly dateTime = fmtDateTime;
  protected readonly teamLabel = STAFF_ROLE_LABEL as Record<string, string>;

  protected readonly adding = signal(false);
  protected readonly form = signal({ country: '', displayName: '', separate: false, legalName: '', registrationNumber: '' });
  protected readonly issues = signal<FieldIssue[]>([]);
  protected readonly selected = signal<string | null>(null);
  protected readonly comment = signal('');
  protected readonly lifecycleReason = signal('');
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  /** Countries where the parent has an application and Sales / Operations may create sub-merchants. */
  protected readonly countries = computed(() =>
    [...new Set(this.applications().filter((a) => a.status !== 'rejected').map((a) => a.country))].filter((c) => subMerchantRoutes(ONBOARDING_COUNTRIES[c]).opsInitiated),
  );
  protected readonly canAdd = computed(() => this.roles.role() === 'sales' && this.merchant().lifecycleStatus !== 'suspended' && this.countries().length > 0);
  protected readonly current = computed(() => this.subMerchants().find((s) => s.id === this.selected()) ?? null);
  protected readonly regRule = computed<FieldRule | null>(() => ONBOARDING_COUNTRIES[this.form().country]?.localRegistration ?? null);

  protected issue(field: string) {
    return this.issues().find((i) => i.field === field)?.message ?? null;
  }

  protected openAdd() {
    this.form.set({ country: this.countries()[0] ?? '', displayName: '', separate: false, legalName: '', registrationNumber: '' });
    this.issues.set([]);
    this.error.set(null);
    this.adding.set(true);
  }

  protected cancelAdd() {
    const f = this.form();
    if ((f.displayName || f.legalName || f.registrationNumber) && !confirm('Discard this sub-merchant?')) return;
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
        legalEntity: f.separate ? { legalName: f.legalName.trim(), registrationNumber: f.registrationNumber.trim() } : null,
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
    this.lifecycleReason.set('');
    this.error.set(null);
  }

  protected async act(s: SubMerchantView, action: 'submit' | 'review' | 'checks' | 'go-live' | 'lifecycle', body: object, message: string) {
    this.busy.set(action);
    this.error.set(null);
    try {
      await this.api.subMerchantAction(s.id, action, body);
      this.comment.set('');
      this.lifecycleReason.set('');
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

  protected lifecycle(s: SubMerchantView, action: 'suspend' | 'reactivate') {
    if (this.lifecycleReason().trim().length < 5) {
      this.error.set('Enter a reason with at least 5 characters.');
      return;
    }
    void this.act(s, 'lifecycle', { action, reason: this.lifecycleReason().trim() }, action === 'suspend' ? `${s.displayName} suspended` : `${s.displayName} reactivated`);
  }
}
