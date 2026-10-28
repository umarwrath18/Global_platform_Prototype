import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CountryConfigDetail, CountryConfigInput, readCountryConfigInput, toConfigInput } from '../../core/merchants/country-config';
import { CountryConfigService } from '../../core/merchants/country-config.service';
import { MccService } from '../../core/merchants/mcc.service';
import { MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { FieldIssue, STAFF_ROLE_LABEL } from '../../core/merchants/merchant-models';
import { DocumentRule, FieldRule, subMerchantRoutes } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { HasUnsavedChanges } from '../applications/unsaved-changes.guard';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

/** One country's onboarding rules, its change history and (with permission) the edit form. */
@Component({
  selector: 'app-country-config-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  templateUrl: './country-config-detail.html',
  styleUrl: './country-config.scss',
})
export class CountryConfigDetailPage implements HasUnsavedChanges {
  private readonly service = inject(CountryConfigService);
  private readonly roles = inject(StaffRoleService);
  protected readonly mcc = inject(MccService);

  /** Bound from the `:code` route parameter. */
  readonly code = input.required<string>();

  protected readonly detail = signal<CountryConfigDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly editing = signal(false);
  protected readonly draft = signal<CountryConfigInput | null>(null);
  protected readonly businessTypes = signal('');
  protected readonly reason = signal('');
  protected readonly issues = signal<FieldIssue[]>([]);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<MerchantClientError | null>(null);
  protected readonly toast = signal<string | null>(null);
  protected readonly dateTime = fmtDateTime;
  protected readonly roleLabel = STAFF_ROLE_LABEL;
  private baseline = '';

  /** The server decides; this only hides controls that would be refused. */
  protected readonly canEdit = computed(() => !!this.detail()?.canEdit);
  protected readonly cfg = computed(() => this.detail()?.config ?? null);
  protected readonly mccOptions = computed(() => this.mcc.optionsFor(this.code().toUpperCase()));
  protected readonly errorFor = computed(() => Object.fromEntries(this.issues().map((i) => [i.field, i.message])) as Record<string, string>);
  /** Problems that aren't tied to a single input (e.g. "can't remove"), shown in the summary only. */
  protected readonly generalIssues = computed(() => this.issues().filter((i) => !/\.\d+\.|\.(label|pattern|minCount|ownershipThresholdPct)$/.test(i.field) && i.field !== 'reason'));

  constructor() {
    // Reload when the acting team changes, so the server's edit permission is current.
    effect(() => {
      this.roles.role();
      void this.load(this.code());
    });
  }

  hasUnsavedChanges(): boolean {
    return this.editing() && JSON.stringify(this.request()) !== this.baseline;
  }

  unsavedChangesMessage() {
    return 'You have unsaved changes to this country configuration. Leave without saving?';
  }

  protected async load(code = this.code()) {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.detail.set(await this.service.get(code));
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected startEdit() {
    const d = this.detail();
    if (!d) return;
    const input = toConfigInput(d.config);
    this.draft.set(input);
    this.businessTypes.set(input.businessTypes.join('\n'));
    this.reason.set('');
    this.issues.set([]);
    this.saveError.set(null);
    this.editing.set(true);
    this.baseline = JSON.stringify(this.request());
  }

  protected cancel() {
    this.editing.set(false);
    this.draft.set(null);
  }

  /** Applies a change to a copy of the draft so signals see a new value. */
  protected patch(change: (d: CountryConfigInput) => void) {
    const next = JSON.parse(JSON.stringify(this.draft())) as CountryConfigInput;
    change(next);
    this.draft.set(next);
  }

  protected setEnabled(on: boolean) {
    this.patch((d) => (d.onboardingEnabled = on));
  }

  protected setRoute(key: 'opsInitiated' | 'parentInitiated', on: boolean) {
    this.patch((d) => (d.subMerchantCreation[key] = on));
  }

  protected readonly routesText = computed(() => {
    const r = subMerchantRoutes(this.cfg() ?? undefined);
    const on = [r.opsInitiated && 'Sales / Operations', r.parentInitiated && 'the parent merchant'].filter(Boolean);
    return on.length ? `Created by ${on.join(' or ')}.` : 'Sub-merchants cannot be created in this country.';
  });

  protected setRule(key: string, prop: keyof FieldRule, value: string | boolean) {
    this.patch((d) => Object.assign(d[key as 'localRegistration' | 'taxId'], { [prop]: value }));
  }

  protected setBank(i: number, prop: keyof FieldRule, value: string | boolean) {
    this.patch((d) => Object.assign(d.bankFields[i], { [prop]: value }));
  }

  protected setDocument(i: number, prop: keyof DocumentRule, value: string | boolean) {
    this.patch((d) => Object.assign(d.documents[i], { [prop]: value }));
  }

  protected setDirectors(prop: keyof CountryConfigInput['directors'], value: string | boolean | number | null) {
    this.patch((d) => Object.assign(d.directors, { [prop]: value }));
  }

  protected addBankField() {
    this.patch((d) => d.bankFields.push({ key: '', label: '', required: false }));
  }

  protected addDocument() {
    this.patch((d) => d.documents.push({ type: '', label: '', required: false }));
  }

  /** New rows (not yet saved) can be removed again; saved ones can only be made optional. */
  protected isNewBankField(i: number) {
    return i >= (this.detail()?.config.bankFields.length ?? 0);
  }

  protected isNewDocument(i: number) {
    return i >= (this.detail()?.config.documents.length ?? 0);
  }

  protected removeBankField(i: number) {
    this.patch((d) => d.bankFields.splice(i, 1));
  }

  protected removeDocument(i: number) {
    this.patch((d) => d.documents.splice(i, 1));
  }

  protected num(v: string): number | null {
    return v.trim() === '' ? null : Number(v);
  }

  private request() {
    const d = this.draft()!;
    return {
      ...d,
      businessTypes: this.businessTypes()
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean),
      version: this.detail()!.version,
      reason: this.reason().trim(),
    };
  }

  protected async save() {
    const detail = this.detail();
    if (!detail || !this.draft()) return;
    const req = this.request();
    // Same checks the server runs, so most problems show without a round trip.
    const { errors } = readCountryConfigInput(detail.config, req);
    if (req.reason.length < 5) errors.push({ section: 'business', field: 'reason', message: 'Enter a reason with at least 5 characters.' });
    this.issues.set(errors);
    this.saveError.set(null);
    if (errors.length) return;

    this.saving.set(true);
    try {
      await this.service.update(detail.config.code, req);
      this.editing.set(false);
      this.draft.set(null);
      await this.load();
      this.flash(`${detail.config.name} configuration saved`);
    } catch (e) {
      const err = toMerchantError(e);
      if (err.code === 'VALIDATION_FAILED' && 'errors' in err && err.errors?.length) this.issues.set(err.errors);
      else this.saveError.set(err);
    } finally {
      this.saving.set(false);
    }
  }

  private flash(msg: string) {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(null), 3000);
  }
}
