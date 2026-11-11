import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { documentFileError, validateApplication } from '../../core/merchants/application-rules';
import { CHANGE_SECTION_LABEL, ChangeSection, maskValue } from '../../core/merchants/change-requests';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import {
  APPROVAL_PRIORITIES,
  APPROVAL_PRIORITY_LABEL,
  ApplicationData,
  CONNECTION_TYPE_LABEL,
  CONNECTION_TYPES,
  CountryApplication,
  Director,
  FieldIssue,
  GlobalMerchant,
  MERCHANT_CATEGORIES,
  MERCHANT_CATEGORY_LABEL,
} from '../../core/merchants/merchant-models';
import { PhoneField } from '../../shared/phone-field';
import { INDUSTRIES, ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';

type CountrySection = Exclude<ChangeSection, 'identity'>;
const SECTIONS: CountrySection[] = ['business', 'bank', 'transaction', 'directors', 'documents'];
let uid = 0;
const newId = () => `c${Date.now().toString(36)}${uid++}`;

/** Requests a change to an approved country's details. Nothing changes until Risk approves it. */
@Component({
  selector: 'app-change-request-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PhoneField],
  templateUrl: './change-request-form.html',
  styleUrl: './changes.scss',
  host: { class: 'cr-sheet' },
})
export class ChangeRequestForm implements OnInit {
  private readonly api = inject(MerchantApi);

  readonly application = input.required<CountryApplication>();
  readonly merchant = input.required<GlobalMerchant>();
  readonly submitted = output<string>();
  readonly closed = output<void>();

  protected readonly sections = SECTIONS;
  protected readonly sectionLabel = CHANGE_SECTION_LABEL;
  protected readonly industries = INDUSTRIES;
  protected readonly merchantCategories = MERCHANT_CATEGORIES;
  protected readonly merchantCategoryLabel = MERCHANT_CATEGORY_LABEL;
  protected readonly connectionTypes = CONNECTION_TYPES;
  protected readonly connectionTypeLabel = CONNECTION_TYPE_LABEL;
  protected readonly priorities = APPROVAL_PRIORITIES;
  protected readonly priorityLabel = APPROVAL_PRIORITY_LABEL;
  protected readonly section = signal<CountrySection>('bank');
  protected readonly draft = signal<ApplicationData>(null!);
  protected readonly reason = signal('');
  protected readonly attempted = signal(false);
  protected readonly saving = signal(false);
  protected readonly serverIssues = signal<FieldIssue[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly docErrors = signal<Record<string, string>>({});
  private baseline = '';

  protected readonly cfg = computed(() => ONBOARDING_COUNTRIES[this.application().country]);
  /** The current account number, masked; the input starts blank and blank keeps it. */
  protected readonly currentAccount = computed(() => maskValue(this.application().data.bank['accountNumber'] ?? ''));
  /** What would be sent: a blank account number keeps the current one. */
  private readonly composed = computed<ApplicationData>(() => {
    const d = this.draft();
    const current = this.application().data;
    return { ...current, [this.section()]: this.section() === 'bank' ? { ...d.bank, accountNumber: d.bank['accountNumber']?.trim() || current.bank['accountNumber'] || '' } : d[this.section()] };
  });
  protected readonly issues = computed(() => {
    const local = validateApplication(this.application().country, this.composed(), this.merchant()).filter((i) => i.section === this.section());
    return [...local, ...this.serverIssues().filter((s) => !local.some((l) => l.field === s.field))];
  });
  protected readonly dirty = computed(() => !!this.draft() && (this.sectionJson() !== this.baseline || this.reason().trim() !== ''));

  ngOnInit() {
    this.reset();
  }

  hasUnsavedChanges() {
    return this.dirty();
  }

  private sectionJson() {
    return JSON.stringify(this.draft()[this.section()]);
  }

  /** Starts the chosen section from the current (approved) values. */
  protected reset(section = this.section()) {
    const d = structuredClone(this.application().data);
    d.bank = { ...d.bank, accountNumber: '' };
    this.draft.set(d);
    this.section.set(section);
    this.baseline = this.sectionJson();
    this.reason.set('');
    this.attempted.set(false);
    this.serverIssues.set([]);
    this.error.set(null);
  }

  protected chooseSection(s: CountrySection) {
    if (s === this.section()) return;
    if (this.dirty()) this.askDiscard.set({ section: s });
    else this.reset(s);
  }

  protected err(field: string) {
    return this.attempted() ? (this.issues().find((i) => i.field === field)?.message ?? null) : null;
  }

  private edit(fn: (d: ApplicationData) => void) {
    const d = structuredClone(this.draft());
    fn(d);
    this.draft.set(d);
    this.serverIssues.set([]);
  }

  protected setBusiness(key: keyof ApplicationData['business'], value: string) {
    this.edit((d) => ((d.business[key] as string) = value));
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

  /** Bank fields may be missing on older data. */
  protected bankValue(key: string): string {
    return this.draft().bank[key] ?? '';
  }

  protected setBank(key: string, value: string) {
    this.edit((d) => (d.bank[key] = value));
  }

  protected setDirector(i: number, key: Exclude<keyof Director, 'id'>, value: string) {
    this.edit((d) => (d.directors[i][key] = value));
  }

  protected addDirector() {
    this.edit((d) => d.directors.push({ id: newId(), name: '', contactNumber: '', nationality: '', profileUrl: '', idNumber: '' }));
  }

  protected removeDirector(i: number) {
    this.edit((d) => d.directors.splice(i, 1));
  }

  protected filesFor(type: string) {
    return this.draft().documents.filter((d) => d.type === type);
  }

  protected attachFile(type: string, el: HTMLInputElement) {
    const file = el.files?.[0];
    el.value = '';
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

  protected docError(type: string): string | null {
    return this.docErrors()[type] ?? this.err(`documents.${type}`);
  }

  protected removeDoc(id: string) {
    this.edit((d) => (d.documents = d.documents.filter((x) => x.id !== id)));
  }

  /** Inline confirmation in the sheet footer: close the form, or switch to another section. */
  protected readonly askDiscard = signal<{ section: CountrySection | null } | null>(null);

  protected cancel() {
    if (this.dirty()) this.askDiscard.set({ section: null });
    else this.closed.emit();
  }

  /** Esc or a click outside the sheet. */
  requestClose() {
    if (this.askDiscard()) this.askDiscard.set(null);
    else this.cancel();
  }

  protected discard() {
    const q = this.askDiscard();
    this.askDiscard.set(null);
    if (q?.section) this.reset(q.section);
    else this.closed.emit();
  }

  protected async submit() {
    this.attempted.set(true);
    this.error.set(null);
    if (this.issues().length) return;
    if (this.reason().trim().length < 10) {
      this.error.set('Explain why this should change (at least 10 characters).');
      return;
    }
    this.saving.set(true);
    try {
      const s = this.section();
      const r = await this.api.requestCountryChange(this.application().id, { section: s, value: this.draft()[s], reason: this.reason().trim() });
      this.submitted.emit(`${r.id} sent to Risk`);
    } catch (e) {
      const err = toMerchantError(e);
      if ('errors' in err && err.errors?.length) this.serverIssues.set(err.errors);
      this.error.set(err.message ?? "We couldn't send the change request.");
    } finally {
      this.saving.set(false);
    }
  }
}
