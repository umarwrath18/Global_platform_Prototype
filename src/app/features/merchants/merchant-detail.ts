import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { isEmail, isPhone, validateRegistrationNumber } from '../../core/merchants/application-rules';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { mccCountryCheck, mccLabel } from '../../core/merchants/mcc';
import { MccService } from '../../core/merchants/mcc.service';
import { productPhase } from '../../core/merchants/products';
import { ChangeRequest, FieldChange, PROFILE_ACTION_LABEL, ProfileEvent } from '../../core/merchants/change-requests';
import { FieldIssue } from '../../core/merchants/merchant-models';
import { PendingChanges } from '../changes/pending-changes';
import { SubMerchantsPanel } from '../sub-merchants/sub-merchants-panel';
import { HistoryEvent, MerchantDetail, READINESS_STATUSES, STAFF_ROLE_LABEL } from '../../core/merchants/merchant-models';
import { REGISTRATION_COUNTRIES, countryName } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { isStrictValidation } from '../../core/merchants/validation-mode';
import { Icon } from '../../shared/icon';
import { SideSheet } from '../../shared/side-sheet';
import { AuthService } from '../../core/auth/auth.service';
import { CONTROL_CHIP, CONTROL_KEYS, isFraudType, SUSPENSION_TYPE_LABEL, SuspensionScope, SuspensionView, VIA_LABEL } from '../../core/merchants/suspensions';
import { SuspendSheet } from './suspend-sheet';
import { SuspensionMode, SuspensionSheet } from './suspension-sheet';
import { StatusBadge, fmtDate, fmtDateTime } from '../../shared/merchant-ui';

interface ProfileDraft {
  legalName: string;
  registrationCountry: string;
  registrationNumber: string;
  name: string;
  email: string;
  phone: string;
}

interface ProfileRequestDraft {
  legalName: string;
  registrationCountry: string;
  registrationNumber: string;
  mccCode: string;
}

const STAGES = ['draft', 'pending_risk_review', ...READINESS_STATUSES];

@Component({
  selector: 'app-merchant-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, StatusBadge, PendingChanges, SubMerchantsPanel, SideSheet, SuspendSheet, SuspensionSheet],
  templateUrl: './merchant-detail.html',
  styleUrl: './merchant-detail.scss',
})
export class MerchantDetailPage {
  private readonly api = inject(MerchantApi);
  protected readonly roles = inject(StaffRoleService);
  protected readonly mccService = inject(MccService);

  /** Bound from the `:id` route parameter. */
  readonly id = input.required<string>();
  /** `?sub=` opens that sub-merchant's details (links from the Approvals page). */
  readonly sub = input<string | undefined>();
  /** `?suspension=…&action=review|reactivation|settlement` opens that step (links from Approvals). */
  readonly suspension = input<string | undefined>();
  readonly action = input<string | undefined>();
  private readonly auth = inject(AuthService);
  private readonly subPanel = viewChild(SubMerchantsPanel);

  protected readonly detail = signal<MerchantDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly editing = signal(false);
  protected readonly draft = signal<ProfileDraft | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly toast = signal<string | null>(null);
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

  protected readonly handedOff = (status: Parameters<typeof productPhase>[0]) => productPhase(status) === 'post_handoff';
  protected readonly teamLabel = (role: string | null) => (role ? (STAFF_ROLE_LABEL as Record<string, string>)[role] ?? role : '');

  // Profile change request (after Risk approval): legal name, registration country, registration
  // number and MCC in one request. Sales / Operations request; Risk decides in the Profile card.
  protected readonly profileForm = signal(false);
  protected readonly pcDraft = signal<ProfileRequestDraft>({ legalName: '', registrationCountry: '', registrationNumber: '', mccCode: '' });
  protected readonly pcReason = signal('');
  protected readonly pcBusy = signal<'request' | 'approve' | 'reject' | null>(null);
  protected readonly pcError = signal<string | null>(null);
  protected readonly pcIssues = signal<FieldIssue[]>([]);
  protected readonly pcDiscardAsk = signal(false);
  protected readonly pcComment = signal('');
  protected readonly pcDecideError = signal<string | null>(null);
  /** The pending profile change, if any. */
  protected readonly profileRequest = computed(() => (this.detail()?.pendingChanges ?? []).find((c) => c.scope === 'merchant_profile') ?? null);
  /** Country-level change requests (profile changes show in the Profile card). */
  protected readonly countryChanges = computed(() => (this.detail()?.pendingChanges ?? []).filter((c) => c.scope !== 'merchant_profile'));
  /** Countries the MCC must work in: every application that isn't rejected. */
  private readonly mccCountries = computed(() => (this.detail()?.applications ?? []).filter((a) => a.status !== 'rejected').map((a) => a.country));
  /** Catalogue codes available in all of the merchant's countries (restricted ones included, marked). */
  protected readonly mccCandidates = computed(() =>
    this.mccService
      .catalogue()
      .entries.map((e) => ({ ...e, check: mccCountryCheck(this.mccService.catalogue(), e.code, this.mccCountries()) }))
      .filter((e) => !e.check.unavailable.length)
      .sort((a, b) => a.code.localeCompare(b.code)),
  );
  protected readonly mccCountryNames = computed(() => {
    const names = [...new Set(this.mccCountries())].map((c) => countryName(c));
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? 'its countries');
  });

  // ------------------------------------------------------------- suspension
  protected readonly viaLabel = VIA_LABEL;
  protected readonly canSuspend = computed(() => (this.roles.role() === 'sales' || this.roles.role() === 'risk') && this.detail()?.merchant.globalStatus === 'active');
  /** Open = the Suspend sheet (preset scope, or {} for the whole merchant). */
  protected readonly suspendPreset = signal<{ scope?: SuspensionScope; subMerchantId?: string | null } | null>(null);
  protected readonly openSus = signal<{ s: SuspensionView; mode: SuspensionMode } | null>(null);
  /** Active suspensions, and lifted ones still waiting on settlement. Sub-merchant ones show in their row. */
  protected readonly openSuspensions = computed(() => (this.detail()?.suspensions ?? []).filter((s) => s.scope !== 'sub_merchant' && (s.status === 'active' || s.settlement.status === 'held' || s.settlement.status === 'release_pending')));

  protected openSuspend(preset: { scope: SuspensionScope; subMerchantId?: string | null } | null) {
    this.suspendPreset.set(preset ?? {});
  }

  protected openSuspension(s: SuspensionView, mode: SuspensionMode) {
    this.openSus.set({ s, mode });
  }

  protected openSuspensionById(e: { id: string; mode: SuspensionMode }) {
    const s = this.detail()?.suspensions.find((x) => x.id === e.id);
    if (s) this.openSus.set({ s, mode: e.mode });
  }

  protected closeSuspension() {
    this.openSus.set(null);
    this.clearSuspensionLink();
  }

  protected async onSuspensionDone(message: string) {
    this.suspendPreset.set(null);
    this.openSus.set(null);
    this.clearSuspensionLink();
    await this.load();
    this.flash(message);
  }

  protected async requestRelease(s: SuspensionView) {
    try {
      await this.api.suspensionAction(s.id, 'settlement/request');
      await this.load();
      this.flash('Settlement release sent to FinOps');
    } catch (e) {
      this.flash(toMerchantError(e).message ?? "We couldn't send it to FinOps.");
    }
  }

  protected bannerTitle(s: SuspensionView) {
    const what = s.scope === 'country' ? `${s.countryName} suspended` : 'Merchant suspended';
    return s.status === 'active' ? `${what} · ${SUSPENSION_TYPE_LABEL[s.type]}` : `Reactivated · settlement ${s.settlement.status === 'release_pending' ? 'release waiting for FinOps' : 'still on hold'}`;
  }

  protected scopeText(s: SuspensionView) {
    return s.scope === 'merchant' ? 'Whole merchant' : s.scope === 'country' ? `${s.countryName} (with its sub-merchants)` : `${s.subMerchantName}`;
  }

  protected chipsOf(s: SuspensionView) {
    if (s.status !== 'active') return s.settlement.status === 'held' || s.settlement.status === 'release_pending' ? [CONTROL_CHIP.settlement] : [];
    const chips = CONTROL_KEYS.filter((k) => s.controls[k]).map((k) => CONTROL_CHIP[k]);
    if (isFraudType(s.type) || s.type === 'compliance') chips.push('Merchant Portal read only');
    return chips;
  }

  protected pendingText(s: SuspensionView) {
    if (s.status === 'active' && s.review.status === 'pending') return `Second Risk review: waiting · due ${s.review.dueAt ? this.dateTime(s.review.dueAt) : ''} · in Approvals`;
    if (s.reactivation?.status === 'pending') return `Reactivation requested by ${s.reactivation.requestedBy}: waiting for a second Risk approval · in Approvals`;
    if (s.settlement.status === 'release_pending') return 'Settlement release: waiting for FinOps · in Approvals';
    return null;
  }

  /** The step this login can take on a suspension. */
  protected actionsFor(s: SuspensionView): { mode: SuspensionMode; label: string; primary?: boolean }[] {
    const role = this.roles.role();
    const me = this.auth.session()?.user.id;
    const out: { mode: SuspensionMode; label: string; primary?: boolean }[] = [];
    if (role === 'risk' && s.status === 'active') {
      if (s.review.status === 'pending' && s.createdById !== me) out.push({ mode: 'review', label: 'Review' });
      if (s.reactivation?.status === 'pending') {
        if (s.reactivation.requestedById !== me) out.push({ mode: 'approve', label: 'Approve reactivation', primary: true });
      } else out.push({ mode: 'reactivate', label: 'Reactivate', primary: true });
    }
    if (role === 'finops' && s.settlement.status === 'release_pending') out.push({ mode: 'settlement', label: 'Release settlement', primary: true });
    return out;
  }

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
    // Links from Approvals: open the suspension step once the merchant has loaded.
    effect(() => {
      const d = this.detail();
      const id = this.suspension();
      if (!id) this.openedLink = null;
      if (!d || !id) return;
      const s = d.suspensions.find((x) => x.id === id);
      const mode: SuspensionMode = this.action() === 'review' ? 'review' : this.action() === 'reactivation' ? 'approve' : this.action() === 'settlement' ? 'settlement' : 'view';
      // Open once per link: closing the sheet must not open it again.
      const key = `${id}:${mode}`;
      untracked(() => {
        if (s && !this.openSus() && this.openedLink !== key) {
          this.openedLink = key;
          this.openSus.set({ s, mode });
        }
      });
    });
  }

  private readonly router = inject(Router);
  private openedLink: string | null = null;

  /** Drops `?suspension=…&action=…` once the sheet it opened is closed, so a refresh doesn't reopen it. */
  private clearSuspensionLink() {
    if (!this.suspension()) return;
    void this.router.navigate([], { queryParams: { suspension: null, action: null }, queryParamsHandling: 'merge', replaceUrl: true });
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

  /** A field has a change waiting for Risk (shown as "Change requested"). */
  protected requested(field: string) {
    return !!this.profileRequest()?.changes.some((c) => c.field === field);
  }

  protected proposedMccCode(r: ChangeRequest) {
    return r.changes.find((c) => c.field === 'mcc')?.to.split(' ')[0] ?? '';
  }

  protected fieldNames(e: ProfileEvent) {
    return e.changes.map((c) => c.label).join(', ');
  }

  protected mccTo(e: ProfileEvent) {
    return (e.changes[0]?.to ?? '').replace(' – ', ' ');
  }

  /** History values: the MCC shows as its code only. */
  protected histValue(c: FieldChange, side: 'from' | 'to') {
    return c.field === 'mcc' ? c[side].split(' ')[0] : c[side];
  }

  protected openProfileForm() {
    const m = this.detail()!.merchant;
    this.pcDraft.set({ legalName: m.legalName, registrationCountry: m.registrationCountry, registrationNumber: m.registrationNumber, mccCode: m.mcc?.code ?? '' });
    this.pcReason.set('');
    this.pcError.set(null);
    this.pcIssues.set([]);
    this.pcDiscardAsk.set(false);
    this.profileForm.set(true);
  }

  protected pcChanged(key: keyof ProfileRequestDraft) {
    const m = this.detail()?.merchant;
    if (!m) return false;
    const current = key === 'mccCode' ? (m.mcc?.code ?? '') : m[key];
    return this.pcDraft()[key].trim() !== current;
  }

  /** "1 change: MCC 5712 → 5719" */
  protected readonly pcSummary = computed(() => {
    const m = this.detail()?.merchant;
    if (!m) return null;
    const d = this.pcDraft();
    const parts: string[] = [];
    if (d.legalName.trim() !== m.legalName) parts.push(`Legal name ${m.legalName} → ${d.legalName.trim()}`);
    if (d.registrationCountry !== m.registrationCountry) parts.push(`Registration country ${countryName(m.registrationCountry)} → ${countryName(d.registrationCountry)}`);
    if (d.registrationNumber.trim() !== m.registrationNumber) parts.push(`Registration number ${m.registrationNumber} → ${d.registrationNumber.trim()}`);
    if (d.mccCode !== (m.mcc?.code ?? '')) parts.push(`MCC ${m.mcc?.code ?? 'none'} → ${d.mccCode}`);
    return parts.length ? { count: parts.length, text: parts.join('; ') } : null;
  });

  protected readonly pcRestricted = computed(() => {
    const code = this.pcDraft().mccCode;
    if (!code || code === this.detail()?.merchant.mcc?.code) return [];
    return this.mccCandidates().find((e) => e.code === code)?.check.restricted ?? [];
  });

  protected closeProfileForm() {
    if (this.pcBusy()) return;
    if (this.pcDiscardAsk()) return this.pcDiscardAsk.set(false);
    if (this.pcSummary() || this.pcReason().trim()) return this.pcDiscardAsk.set(true);
    this.profileForm.set(false);
  }

  protected setPc(key: keyof ProfileRequestDraft, value: string) {
    this.pcDraft.update((d) => ({ ...d, [key]: value }));
    this.pcError.set(null);
    this.pcIssues.update((list) => list.filter((i) => i.field !== `identity.${key}`));
  }

  protected clearReasonIssue() {
    if (this.pcReason().trim().length >= 10) this.pcIssues.update((list) => list.filter((i) => i.field !== 'reason'));
  }

  protected pcIssue(field: string) {
    return this.pcIssues().find((i) => i.field === field)?.message ?? null;
  }

  protected async requestProfile() {
    if (!this.pcSummary()) return this.pcError.set('Change at least one field before sending to Risk.');
    if (this.pcReason().trim().length < 10) {
      this.pcIssues.set([{ section: 'business', field: 'reason', message: 'Explain why this should change (at least 10 characters).' }]);
      return this.pcError.set(null);
    }
    this.pcBusy.set('request');
    this.pcError.set(null);
    this.pcIssues.set([]);
    try {
      const d = this.pcDraft();
      const mccCode = d.mccCode !== (this.detail()?.merchant.mcc?.code ?? '') ? d.mccCode : undefined;
      const value = { legalName: d.legalName.trim(), registrationCountry: d.registrationCountry, registrationNumber: d.registrationNumber.trim(), ...(mccCode ? { mccCode } : {}) };
      const r = await this.api.requestProfileChange(this.id(), { section: 'identity', value, reason: this.pcReason().trim() });
      this.profileForm.set(false);
      await this.load();
      this.flash(`${r.id} sent to Risk`);
    } catch (e) {
      const err = toMerchantError(e);
      if ('errors' in err && err.errors?.length) {
        this.pcIssues.set(err.errors);
        if (!err.errors.some((i) => ['reason', 'identity.legalName', 'identity.registrationNumber'].includes(i.field))) this.pcError.set(err.errors[0].message);
      } else this.pcError.set(err.message ?? "We couldn't send the change request.");
    } finally {
      this.pcBusy.set(null);
    }
  }

  protected async decideProfile(decision: 'approve' | 'reject') {
    const r = this.profileRequest();
    if (!r) return;
    const comment = this.pcComment().trim();
    if (decision === 'reject' && comment.length < 10) return this.pcDecideError.set('Give the reason for rejecting (at least 10 characters).');
    this.pcBusy.set(decision);
    this.pcDecideError.set(null);
    try {
      await this.api.decideChange(r.id, decision, comment);
      this.pcComment.set('');
      await this.load();
      this.flash(decision === 'approve' ? `${r.id} approved and applied` : `${r.id} rejected; nothing changed`);
    } catch (e) {
      this.pcDecideError.set(toMerchantError(e).message ?? "We couldn't record the decision.");
    } finally {
      this.pcBusy.set(null);
    }
  }

  protected async onChangeAction(message: string) {
    await this.load();
    this.flash(message);
  }

  protected addSubMerchant() {
    this.subPanel()?.startAdd();
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
