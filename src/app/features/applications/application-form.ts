import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { documentFileError, registeredInCountry, SECTION_ORDER, validateApplication } from '../../core/merchants/application-rules';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { ApplicationData, CountryApplication, Director, GlobalMerchant, SECTION_LABEL, SectionKey } from '../../core/merchants/merchant-models';
import { INDUSTRIES, ONBOARDING_COUNTRIES, countryName } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { isStrictValidation } from '../../core/merchants/validation-mode';
import { ApplicationSummaryView } from './application-summary';

type Step = SectionKey | 'review';
const STEPS: Step[] = [...SECTION_ORDER, 'review'];

let uid = 0;
const newId = () => `n${Date.now().toString(36)}${uid++}`;

/** Guided, section-based editor for a draft or returned country application (Sales / Operations). */
@Component({
  selector: 'app-application-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, ApplicationSummaryView],
  templateUrl: './application-form.html',
  styleUrl: './application-form.scss',
})
export class ApplicationForm implements OnInit {
  private readonly api = inject(MerchantApi);

  readonly application = input.required<CountryApplication>();
  readonly merchant = input.required<GlobalMerchant>();
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

  protected readonly steps = STEPS;
  protected readonly label = SECTION_LABEL;
  protected readonly industries = INDUSTRIES;
  protected readonly countryName = countryName;

  protected readonly cfg = computed(() => ONBOARDING_COUNTRIES[this.application().country]);
  protected readonly sameCountry = computed(() => registeredInCountry(this.merchant(), this.application().country));
  protected readonly issues = computed(() => validateApplication(this.application().country, this.data(), this.merchant()));
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
    this.edit((d) => {
      if (key === 'expectedMonthlyVolume') d.business.expectedMonthlyVolume = value === '' ? null : Number(value);
      else (d.business[key] as string) = value;
    });
  }

  protected setContact(key: keyof ApplicationData['contact'], value: string) {
    this.edit((d) => (d.contact[key] = value));
  }

  protected setBank(key: string, value: string) {
    this.edit((d) => (d.bank[key] = value));
  }

  protected addPerson() {
    this.edit((d) => d.directors.push({ id: newId(), name: '', nationality: '', idNumber: '', role: 'director', ownershipPct: null }));
  }

  protected removePerson(id: string) {
    this.edit((d) => (d.directors = d.directors.filter((p) => p.id !== id)));
  }

  protected setPerson(id: string, key: keyof Director, value: string) {
    this.edit((d) => {
      const p = d.directors.find((x) => x.id === id)!;
      if (key === 'ownershipPct') p.ownershipPct = value === '' ? null : Number(value);
      else if (key === 'role') {
        p.role = value as Director['role'];
        if (p.role === 'director') p.ownershipPct = null;
      } else (p[key] as string) = value;
    });
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
    this.edit((d) => d.documents.push({ id: newId(), type, fileName: file.name, sizeKb, uploadedAt: Date.now(), sample: false }));
  }

  protected removeDoc(id: string) {
    this.edit((d) => (d.documents = d.documents.filter((x) => x.id !== id)));
  }

  protected line(code: string) {
    return this.data().pricing.find((p) => p.code === code)!;
  }

  protected setPricing(code: string, key: 'enabled' | 'mdr', value: boolean | string) {
    this.edit((d) => {
      const l = d.pricing.find((p) => p.code === code)!;
      if (key === 'enabled') l.enabled = value as boolean;
      else l.mdr = value === '' ? null : Number(value);
    });
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

  protected async submit() {
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
    this.submitting.set(true);
    this.message.set(null);
    try {
      const app = await this.api.submit(this.application().id, this.data(), this.resubmitNote());
      this.savedJson.set(JSON.stringify(this.data()));
      this.saved.emit({ application: app, submitted: true });
    } catch (e) {
      const err = toMerchantError(e);
      this.message.set({ tone: 'danger', text: err.message ?? "We couldn't submit the application. Please try again." });
    } finally {
      this.submitting.set(false);
    }
  }
}
