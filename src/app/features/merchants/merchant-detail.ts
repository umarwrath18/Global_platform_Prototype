import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isEmail, isPhone, validateRegistrationNumber } from '../../core/merchants/application-rules';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { MCC_OUTCOME_LABEL, mccCountryCheck, mccLabel } from '../../core/merchants/mcc';
import { MccService } from '../../core/merchants/mcc.service';
import { productPhase } from '../../core/merchants/products';
import { IdentityValue, PROFILE_ACTION_LABEL } from '../../core/merchants/change-requests';
import { FieldIssue } from '../../core/merchants/merchant-models';
import { PendingChanges } from '../changes/pending-changes';
import { HistoryEvent, MerchantDetail, READINESS_STATUSES, STAFF_ROLE_LABEL } from '../../core/merchants/merchant-models';
import { REGISTRATION_COUNTRIES, countryName } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { isStrictValidation } from '../../core/merchants/validation-mode';
import { Icon } from '../../shared/icon';
import { StatusBadge, fmtDate, fmtDateTime } from '../../shared/merchant-ui';

interface ProfileDraft {
  legalName: string;
  registrationCountry: string;
  registrationNumber: string;
  name: string;
  email: string;
  phone: string;
}

const STAGES = ['draft', 'pending_risk_review', ...READINESS_STATUSES];

@Component({
  selector: 'app-merchant-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, StatusBadge, PendingChanges],
  templateUrl: './merchant-detail.html',
  styleUrl: './merchant-detail.scss',
})
export class MerchantDetailPage {
  private readonly api = inject(MerchantApi);
  protected readonly roles = inject(StaffRoleService);
  protected readonly mccService = inject(MccService);

  /** Bound from the `:id` route parameter. */
  readonly id = input.required<string>();

  protected readonly detail = signal<MerchantDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly editing = signal(false);
  protected readonly draft = signal<ProfileDraft | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly toast = signal<string | null>(null);
  protected readonly lifecycleAction = signal<'suspend' | 'reactivate' | null>(null);
  protected readonly lifecycleReason = signal('');
  protected readonly lifecycleSaving = signal(false);
  protected readonly lifecycleError = signal<string | null>(null);
  protected readonly regCountries = REGISTRATION_COUNTRIES;
  protected readonly countryName = countryName;
  protected readonly date = fmtDate;
  protected readonly dateTime = fmtDateTime;
  /** Live MIDs by application ID. */
  private readonly mids = computed(() => new Map((this.detail()?.mids ?? []).map((m) => [m.applicationId, m])));
  protected midFor(applicationId: string) {
    return this.mids().get(applicationId) ?? null;
  }
  protected readonly roleLabel = { ...STAFF_ROLE_LABEL, system: 'System' } as Record<HistoryEvent['role'], string>;
  protected readonly mccLabel = mccLabel;
  protected readonly profileActionLabel = PROFILE_ACTION_LABEL;

  // Legal identity change request (after Risk approval).
  protected readonly identityForm = signal(false);
  protected readonly idDraft = signal<IdentityValue>({ legalName: '', registrationCountry: '', registrationNumber: '' });
  protected readonly idReason = signal('');
  protected readonly idBusy = signal(false);
  protected readonly idError = signal<string | null>(null);
  protected readonly idIssues = signal<FieldIssue[]>([]);
  protected readonly identityPending = computed(() => (this.detail()?.pendingChanges ?? []).some((c) => c.scope === 'merchant_profile'));
  protected readonly handedOff = (status: Parameters<typeof productPhase>[0]) => productPhase(status) === 'post_handoff';
  protected readonly mccOutcomeLabel = MCC_OUTCOME_LABEL;
  protected readonly teamLabel = (role: string | null) => (role ? (STAFF_ROLE_LABEL as Record<string, string>)[role] ?? role : '');

  // MCC: Sales / Operations request a change once Risk has approved the merchant; Risk decides.
  protected readonly mccForm = signal(false);
  protected readonly mccCode = signal('');
  protected readonly mccReason = signal('');
  protected readonly mccComment = signal('');
  protected readonly mccBusy = signal<string | null>(null);
  protected readonly mccError = signal<string | null>(null);
  /** Countries the MCC must work in: every application that isn't rejected. */
  private readonly mccCountries = computed(() => (this.detail()?.applications ?? []).filter((a) => a.status !== 'rejected').map((a) => a.country));
  /** Catalogue codes available in all of the merchant's countries (restricted ones included, marked). */
  protected readonly mccCandidates = computed(() =>
    this.mccService
      .catalogue()
      .entries.map((e) => ({ ...e, check: mccCountryCheck(this.mccService.catalogue(), e.code, this.mccCountries()) }))
      .filter((e) => !e.check.unavailable.length && e.code !== this.detail()?.merchant.mcc?.code)
      .sort((a, b) => a.code.localeCompare(b.code)),
  );
  protected readonly canRequestMcc = computed(() => this.roles.role() === 'sales' && !!this.detail()?.mccChangeNeedsRisk && !this.detail()?.mccRequest && this.mccService.catalogue().entries.length > 0);

  protected readonly canSuspend = computed(() => (this.roles.role() === 'sales' || this.roles.role() === 'risk') && this.detail()?.merchant.globalStatus === 'active' && this.detail()?.merchant.lifecycleStatus !== 'suspended');
  protected readonly canReactivate = computed(() => this.roles.role() === 'risk' && this.detail()?.merchant.lifecycleStatus === 'suspended');

  protected readonly history = computed(() =>
    (this.detail()?.applications ?? [])
      .flatMap((a) => a.history.map((h) => ({ ...h, applicationId: a.id, country: a.country })))
      .sort((a, b) => b.at - a.at)
      .slice(0, 40),
  );

  protected readonly draftErrors = computed(() => {
    const d = this.draft();
    if (!d) return {} as Record<string, string>;
    const e: Record<string, string> = {};
    if (!d.legalName.trim()) e['legalName'] = 'Enter the registered legal name.';
    const reg = validateRegistrationNumber(d.registrationCountry, d.registrationNumber);
    if (reg) e['registrationNumber'] = reg;
    if (!d.name.trim()) e['name'] = 'Enter the primary contact name.';
    if (!isEmail(d.email)) e['email'] = 'Enter a valid email address.';
    if (!isPhone(d.phone)) e['phone'] = 'Enter a valid phone number including the country code.';
    return e;
  });

  protected readonly hasDraftErrors = computed(() => isStrictValidation() && Object.keys(this.draftErrors()).length > 0);

  constructor() {
    effect(() => void this.load(this.id()));
  }

  protected async load(id = this.id()) {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.detail.set(await this.api.getMerchant(id));
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Position of an application along the review → operational path, for the mini progress bar. */
  protected progress(status: string) {
    if (status === 'rejected') return 0;
    if (status === 'returned') return 1;
    return Math.max(0, STAGES.indexOf(status));
  }

  protected readonly stageCount = STAGES.length - 1;

  protected openLifecycleAction(action: 'suspend' | 'reactivate') { this.lifecycleAction.set(action); this.lifecycleReason.set(''); this.lifecycleError.set(null); }
  protected closeLifecycleAction() { if (!this.lifecycleSaving()) this.lifecycleAction.set(null); }
  protected async confirmLifecycleAction() {
    const action = this.lifecycleAction();
    const reason = this.lifecycleReason().trim();
    if (!action || reason.length < 5) { this.lifecycleError.set('Enter a reason with at least 5 characters.'); return; }
    this.lifecycleSaving.set(true); this.lifecycleError.set(null);
    try {
      await this.api.updateLifecycle(this.id(), action, reason);
      this.lifecycleAction.set(null);
      await this.load();
      this.flash(action === 'suspend' ? 'Merchant suspended' : 'Merchant reactivated');
    } catch (e) {
      const err = toMerchantError(e);
      this.lifecycleError.set(err.message || "We couldn't update the merchant status.");
    } finally { this.lifecycleSaving.set(false); }
  }

  protected openMccForm() {
    this.mccForm.set(true);
    this.mccCode.set('');
    this.mccReason.set('');
    this.mccError.set(null);
  }

  protected async requestMcc() {
    if (!this.mccCode() || this.mccReason().trim().length < 10) {
      this.mccError.set('Choose the new MCC and explain why it should change (at least 10 characters).');
      return;
    }
    this.mccBusy.set('request');
    this.mccError.set(null);
    try {
      await this.api.requestMccChange(this.id(), this.mccCode(), this.mccReason().trim());
      this.mccForm.set(false);
      await this.load();
      this.flash('MCC change sent to Risk');
    } catch (e) {
      this.mccError.set(toMerchantError(e).message ?? "We couldn't send the MCC change request.");
    } finally {
      this.mccBusy.set(null);
    }
  }

  protected async decideMcc(decision: 'approve' | 'reject') {
    const request = this.detail()?.mccRequest;
    if (!request) return;
    if (decision === 'reject' && this.mccComment().trim().length < 10) {
      this.mccError.set('Give the reason for rejecting (at least 10 characters).');
      return;
    }
    this.mccBusy.set(decision);
    this.mccError.set(null);
    try {
      await this.api.decideMccChange(this.id(), request.id, decision, this.mccComment().trim());
      this.mccComment.set('');
      await this.load();
      this.flash(decision === 'approve' ? 'MCC change approved' : 'MCC change rejected');
    } catch (e) {
      this.mccError.set(toMerchantError(e).message ?? "We couldn't record the decision.");
    } finally {
      this.mccBusy.set(null);
    }
  }

  protected openIdentityForm() {
    const m = this.detail()!.merchant;
    this.idDraft.set({ legalName: m.legalName, registrationCountry: m.registrationCountry, registrationNumber: m.registrationNumber });
    this.idReason.set('');
    this.idError.set(null);
    this.idIssues.set([]);
    this.identityForm.set(true);
  }

  protected closeIdentityForm() {
    const m = this.detail()!.merchant;
    const d = this.idDraft();
    const dirty = d.legalName !== m.legalName || d.registrationCountry !== m.registrationCountry || d.registrationNumber !== m.registrationNumber || this.idReason().trim() !== '';
    if (dirty && !confirm('Discard this change request?')) return;
    this.identityForm.set(false);
  }

  protected setId(key: keyof IdentityValue, value: string) {
    this.idDraft.update((d) => ({ ...d, [key]: value }));
  }

  protected idIssue(field: string) {
    return this.idIssues().find((i) => i.field === field)?.message ?? null;
  }

  protected async requestIdentity() {
    this.idBusy.set(true);
    this.idError.set(null);
    this.idIssues.set([]);
    try {
      const r = await this.api.requestProfileChange(this.id(), { section: 'identity', value: this.idDraft(), reason: this.idReason().trim() });
      this.identityForm.set(false);
      await this.load();
      this.flash(`${r.id} sent to Risk`);
    } catch (e) {
      const err = toMerchantError(e);
      if ('errors' in err && err.errors?.length) {
        this.idIssues.set(err.errors);
        this.idError.set(err.errors.find((i) => i.field === 'reason')?.message ?? `${err.errors.length} item${err.errors.length === 1 ? '' : 's'} must be fixed.`);
      } else this.idError.set(err.message ?? "We couldn't send the change request.");
    } finally {
      this.idBusy.set(false);
    }
  }

  protected async onChangeAction(message: string) {
    await this.load();
    this.flash(message);
  }

  protected startEdit() {
    const m = this.detail()!.merchant;
    this.draft.set({ legalName: m.legalName, registrationCountry: m.registrationCountry, registrationNumber: m.registrationNumber, ...m.primaryContact });
    this.saveError.set(null);
    this.editing.set(true);
  }

  protected setDraft(field: keyof ProfileDraft, value: string) {
    this.draft.update((d) => (d ? { ...d, [field]: value } : d));
  }

  protected async saveProfile() {
    const d = this.draft();
    if (!d || this.hasDraftErrors()) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      await this.api.updateMerchant(this.id(), {
        legalName: d.legalName.trim(),
        registrationCountry: d.registrationCountry,
        registrationNumber: d.registrationNumber.trim(),
        primaryContact: { name: d.name.trim(), email: d.email.trim(), phone: d.phone.trim() },
      });
      this.editing.set(false);
      await this.load();
      this.flash('Profile saved');
    } catch (e) {
      const err = toMerchantError(e);
      this.saveError.set(err.message || ('errors' in err && err.errors?.[0]?.message) || "We couldn't save the profile.");
    } finally {
      this.saving.set(false);
    }
  }

  private flash(msg: string) {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(null), 3000);
  }
}
