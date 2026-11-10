import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { documentFileError, registeredInCountry, SECTION_ORDER, todayIso, validateApplication } from '../../core/merchants/application-rules';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { mccIssue, MerchantMcc } from '../../core/merchants/mcc';
import { MccService } from '../../core/merchants/mcc.service';
import {
  APPROVAL_PRIORITIES,
  APPROVAL_PRIORITY_LABEL,
  ApplicationData,
  CONNECTION_TYPE_LABEL,
  CONNECTION_TYPES,
  CountryApplication,
  Director,
  GlobalMerchant,
  MAX_SETTLEMENT_EMAILS,
  MERCHANT_CATEGORIES,
  MERCHANT_CATEGORY_HINT,
  MERCHANT_CATEGORY_LABEL,
  SECTION_LABEL,
  SectionKey,
} from '../../core/merchants/merchant-models';
import { INDUSTRIES, ONBOARDING_COUNTRIES, countryName } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { isStrictValidation } from '../../core/merchants/validation-mode';
import { ApplicationSummaryView } from './application-summary';
import { MccPicker } from '../../shared/mcc-picker';
import { PhoneField } from '../../shared/phone-field';

type Step = SectionKey | 'review';
const STEPS: Step[] = [...SECTION_ORDER, 'review'];

let uid = 0;
const newId = () => `n${Date.now().toString(36)}${uid++}`;

/** Guided, section-based editor for a draft or returned country application (Sales / Operations). */
@Component({
  selector: 'app-application-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, ApplicationSummaryView, MccPicker, PhoneField],
  templateUrl: './application-form.html',
  styleUrl: './application-form.scss',
})
export class ApplicationForm implements OnInit {
  private readonly api = inject(MerchantApi);
  protected readonly mcc = inject(MccService);

  readonly application = input.required<CountryApplication>();
  readonly merchant = input.required<GlobalMerchant>();
  /** True once Risk has approved the merchant: the MCC then changes only through a Risk-approved request. */
  readonly mccLocked = input(false);
  /** Emits the updated application after a save or submission. */
  readonly saved = output<{ application: CountryApplication; submitted: boolean }>();

  protected readonly data = signal<ApplicationData>(null!);
  private readonly savedJson = signal('');
  protected readonly step = signal<Step>('business');
  protected readonly visited = signal<Set<Step>>(new Set());
  protected readonly touched = signal<Set<string>>(new Set());
  protected readonly attempted = signal(false);
  protected readonly saving = signal(false);
  protected readonly submitting = signal(false);
  protected readonly message = signal<{ tone: 'success' | 'danger'; text: string } | null>(null);
  protected readonly resubmitNote = signal('');
  /** Guided mode: set once the user has seen what's missing and chosen to submit anyway. */
  protected readonly confirmIncomplete = signal(false);
  protected readonly strict = isStrictValidation();
  protected readonly docErrors = signal<Record<string, string>>({});
  /** The "Confirmation" dialog before submitting. */
  protected readonly confirmOpen = signal(false);

  protected readonly steps = STEPS;
  protected readonly label = SECTION_LABEL;
  protected readonly industries = INDUSTRIES;
  protected readonly merchantCategories = MERCHANT_CATEGORIES;
  protected readonly merchantCategoryLabel = MERCHANT_CATEGORY_LABEL;
  protected readonly merchantCategoryHint = MERCHANT_CATEGORY_HINT;
  protected readonly connectionTypes = CONNECTION_TYPES;
  protected readonly connectionTypeLabel = CONNECTION_TYPE_LABEL;
  protected readonly priorities = APPROVAL_PRIORITIES;
  protected readonly priorityLabel = APPROVAL_PRIORITY_LABEL;
  protected readonly maxSettlementEmails = MAX_SETTLEMENT_EMAILS;
  protected readonly today = todayIso();
  protected readonly countryName = countryName;

  protected readonly cfg = computed(() => ONBOARDING_COUNTRIES[this.application().country]);
  protected readonly sameCountry = computed(() => registeredInCountry(this.merchant(), this.application().country));
  /** The merchant's MCC, including a change made in this form (it is saved to the merchant straight away). */
  private readonly mccSaved = signal<MerchantMcc | null | undefined>(undefined);
  protected readonly currentMcc = computed(() => (this.mccSaved() !== undefined ? this.mccSaved()! : (this.merchant().mcc ?? null)));
  protected readonly mccOptions = computed(() => this.mcc.optionsFor(this.application().country));
  /** False when no MCC catalogue covers the country: the field is then optional and shows an empty state. */
  protected readonly mccConfigured = computed(() => this.mcc.covers(this.application().country));
  protected readonly mccRestricted = computed(() => {
    const m = this.currentMcc();
    return !!m && this.mcc.availability(m.code, this.application().country) === 'restricted';
  });
  protected readonly mccSaving = signal(false);
  /** Confirms that the MCC was saved to the merchant (it doesn't wait for "Save draft"). */
  protected readonly mccSavedNote = signal<string | null>(null);
  protected readonly mccError = signal<string | null>(null);
  protected readonly issues = computed(() => {
    const out = validateApplication(this.application().country, this.data(), this.merchant());
    const mccProblem = mccIssue(this.mcc.catalogue(), this.application().country, this.currentMcc());
    return mccProblem ? [...out, mccProblem] : out;
  });
  protected readonly dirty = computed(() => JSON.stringify(this.data()) !== this.savedJson());
  protected readonly corrections = computed(() => (this.application().status === 'returned' ? this.application().corrections : null));
  protected readonly prefilled = computed(() => {
    const map = new Map<string, string>();
    for (const p of this.application().prefill) {
      map.set(p.field, p.from === 'global_profile' ? 'From profile' : `From ${p.country} application`);
    }
    return map;
  });

  protected readonly sectionState = computed(() => {
    const out = {} as Record<SectionKey, { issues: number; state: 'complete' | 'incomplete' | 'not_required' }>;
    for (const s of SECTION_ORDER) {
      const n = this.issues().filter((i) => i.section === s).length;
      out[s] = { issues: n, state: s === 'directors' && !this.cfg().directors.required ? 'not_required' : n ? 'incomplete' : 'complete' };
    }
    return out;
  });

  protected readonly completeCount = computed(() => SECTION_ORDER.filter((s) => this.sectionState()[s].state !== 'incomplete').length);

  ngOnInit() {
    const d = structuredClone(this.application().data);
    this.data.set(d);
    this.savedJson.set(JSON.stringify(d));
    const flagged = this.corrections()?.sections[0];
    if (flagged) this.step.set(flagged);
  }

  hasUnsavedChanges() {
    return this.dirty();
  }

  // ------------------------------------------------------------ navigation

  protected go(step: Step) {
    this.visited.update((v) => new Set(v).add(this.step()));
    this.step.set(step);
    this.message.set(null);
    queueMicrotask(() => document.getElementById('section-title')?.focus());
  }

  protected next() {
    const i = STEPS.indexOf(this.step());
    if (i < STEPS.length - 1) this.go(STEPS[i + 1]);
  }

  protected back() {
    const i = STEPS.indexOf(this.step());
    if (i > 0) this.go(STEPS[i - 1]);
  }

  // ------------------------------------------------------------ field state

  protected err(field: string): string | null {
    const show = this.attempted() || this.touched().has(field) || this.visited().has(this.sectionOf(field));
    if (!show) return null;
    return this.issues().find((i) => i.field === field)?.message ?? null;
  }

  private sectionOf(field: string): SectionKey {
    return field.split('.')[0] as SectionKey;
  }

  protected touch(field: string) {
    this.touched.update((s) => new Set(s).add(field));
  }

  protected edit(fn: (d: ApplicationData) => void) {
    const d = structuredClone(this.data());
    fn(d);
    this.data.set(d);
    this.message.set(null);
  }

  protected setBusiness(key: keyof ApplicationData['business'], value: string) {
    this.edit((d) => ((d.business[key] as string) = value));
  }

  /** The MCC belongs to the parent merchant, so it is saved to the merchant at once (not with the draft). */
  protected async setMcc(code: string) {
    this.touch('business.mcc');
    if (!code) return;
    this.mccSaving.set(true);
    this.mccError.set(null);
    this.mccSavedNote.set(null);
    try {
      const m = await this.api.setMcc(this.merchant().id, code);
      this.mccSaved.set(m.mcc ?? null);
      this.mccSavedNote.set(m.mcc ? `MCC ${m.mcc.code} saved to ${this.merchant().legalName}.` : null);
    } catch (e) {
      this.mccError.set(toMerchantError(e).message ?? "We couldn't save the MCC. Please try again.");
    } finally {
      this.mccSaving.set(false);
    }
  }

  protected setContact(key: 'phone' | 'email' | 'currentAddress', value: string) {
    this.edit((d) => (d.contact[key] = value));
  }

  protected setSameAddress(on: boolean) {
    this.edit((d) => {
      d.contact.sameAsRegistered = on;
      if (on) d.contact.currentAddress = '';
    });
  }

  protected setSettlementEmail(i: number, value: string) {
    this.edit((d) => (d.contact.settlementEmails[i] = value));
  }

  protected addSettlementEmail() {
    this.edit((d) => d.contact.settlementEmails.length < MAX_SETTLEMENT_EMAILS && d.contact.settlementEmails.push(''));
    const i = this.data().contact.settlementEmails.length - 1;
    queueMicrotask(() => document.getElementById(`settle-${i}`)?.focus());
  }

  protected removeSettlementEmail(i: number) {
    this.edit((d) => {
      d.contact.settlementEmails.splice(i, 1);
      if (!d.contact.settlementEmails.length) d.contact.settlementEmails.push('');
    });
  }

  protected setBank(key: string, value: string) {
    this.edit((d) => (d.bank[key] = value));
  }

  protected setAmount(key: 'dailyLimit' | 'minTransactionValue', value: string) {
    const v = value.replace(/,/g, '').trim();
    this.edit((d) => (d.transaction[key] = v === '' ? null : Number(v)));
  }

  protected setTransaction(key: 'merchantCategory' | 'connectionType' | 'ipnCallbackUrl', value: string) {
    this.edit((d) => ((d.transaction[key] as string) = value));
  }

  protected setReceipts(on: boolean) {
    this.edit((d) => (d.transaction.sendReceipts = on));
  }

  protected addPerson() {
    this.edit((d) => d.directors.push({ id: newId(), name: '', contactNumber: '', nationality: '', profileUrl: '', idNumber: '' }));
  }

  protected removePerson(id: string) {
    this.edit((d) => (d.directors = d.directors.filter((p) => p.id !== id)));
  }

  protected setPerson(id: string, key: Exclude<keyof Director, 'id'>, value: string) {
    this.edit((d) => (d.directors.find((x) => x.id === id)![key] = value));
  }

  protected filesFor(type: string) {
    return this.data().documents.filter((d) => d.type === type);
  }

  /** Adds the chosen file to the application's document list. */
  protected attachFile(type: string, input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const sizeKb = Math.max(1, Math.round(file.size / 1024));
    const problem = documentFileError(file.name, sizeKb);
    if (problem) {
      this.docErrors.update((e) => ({ ...e, [type]: `${file.name}: ${problem}` }));
      return;
    }
    this.docErrors.update(({ [type]: _, ...rest }) => rest);
    // One file per document type: a new file replaces the current one.
    this.edit((d) => (d.documents = [...d.documents.filter((x) => x.type !== type), { id: newId(), type, fileName: file.name, sizeKb, uploadedAt: Date.now(), sample: false }]));
  }

  protected removeDoc(id: string) {
    this.edit((d) => (d.documents = d.documents.filter((x) => x.id !== id)));
  }

  protected issuesBySection = computed(() => SECTION_ORDER.map((s) => ({ section: s, items: this.issues().filter((i) => i.section === s) })).filter((g) => g.items.length));

  // --------------------------------------------------------------- actions

  protected async saveDraft() {
    this.saving.set(true);
    this.message.set(null);
    try {
      const app = await this.api.saveDraft(this.application().id, this.data());
      this.savedJson.set(JSON.stringify(this.data()));
      this.message.set({ tone: 'success', text: 'Draft saved. You can come back to it any time.' });
      this.saved.emit({ application: app, submitted: false });
    } catch (e) {
      this.message.set({ tone: 'danger', text: toMerchantError(e).message ?? "We couldn't save the draft. Your changes are still here, so please try again." });
    } finally {
      this.saving.set(false);
    }
  }

  /** Submit: checks what's missing first (guided mode can continue), then asks for confirmation. */
  protected submit() {
    this.attempted.set(true);
    const open = this.issues().length;
    if (open && this.strict) {
      this.message.set({ tone: 'danger', text: `Complete ${open} item${open === 1 ? '' : 's'} before submitting.` });
      return;
    }
    if (open && !this.confirmIncomplete()) {
      this.confirmIncomplete.set(true);
      return;
    }
    this.confirmOpen.set(true);
    queueMicrotask(() => document.getElementById('confirm-register')?.focus());
  }

  protected closeConfirm() {
    if (this.submitting()) return;
    this.confirmOpen.set(false);
    queueMicrotask(() => document.getElementById('submit-application')?.focus());
  }

  protected async confirmSubmit() {
    this.submitting.set(true);
    this.message.set(null);
    try {
      const app = await this.api.submit(this.application().id, this.data(), this.resubmitNote());
      this.savedJson.set(JSON.stringify(this.data()));
      this.confirmOpen.set(false);
      this.saved.emit({ application: app, submitted: true });
    } catch (e) {
      const err = toMerchantError(e);
      this.confirmOpen.set(false);
      this.message.set({ tone: 'danger', text: err.message ?? "We couldn't submit the application. Please try again." });
    } finally {
      this.submitting.set(false);
    }
  }
}
