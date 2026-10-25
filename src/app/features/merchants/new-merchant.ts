import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { isEmail, isPhone, validateRegistrationNumber } from '../../core/merchants/application-rules';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { GlobalMerchant } from '../../core/merchants/merchant-models';
import { ONBOARDING_COUNTRIES, REGISTRATION_COUNTRIES } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { isStrictValidation } from '../../core/merchants/validation-mode';
import { Icon } from '../../shared/icon';
import { CountryPicker } from './country-picker';

interface Draft {
  legalName: string;
  registrationCountry: string;
  registrationNumber: string;
  name: string;
  email: string;
  phone: string;
}

type Field = keyof Draft;

/** Flow A: create the Global Merchant (ID issued immediately), then open its first country application. */
@Component({
  selector: 'app-new-merchant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, CountryPicker],
  templateUrl: './new-merchant.html',
  styleUrl: './merchant-forms.scss',
})
export class NewMerchant {
  private readonly api = inject(MerchantApi);
  private readonly router = inject(Router);
  protected readonly roles = inject(StaffRoleService);

  protected readonly draft = signal<Draft>({ legalName: '', registrationCountry: '', registrationNumber: '', name: '', email: '', phone: '' });
  protected readonly touched = signal<Set<Field>>(new Set());
  protected readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly serverErrors = signal<Partial<Record<Field, string>>>({});
  protected readonly created = signal<GlobalMerchant | null>(null);
  protected readonly regCountries = REGISTRATION_COUNTRIES;

  protected readonly regHint = computed(() => {
    const rule = ONBOARDING_COUNTRIES[this.draft().registrationCountry]?.localRegistration;
    return rule ? `${rule.label}${rule.hint ? ` · ${rule.hint}` : ''}` : 'As shown on the certificate of incorporation';
  });

  protected readonly errors = computed<Partial<Record<Field, string>>>(() => {
    const d = this.draft();
    const e: Partial<Record<Field, string>> = {};
    if (!d.legalName.trim()) e.legalName = 'Enter the registered legal name.';
    else if (d.legalName.length > 160) e.legalName = 'Use 160 characters or fewer.';
    if (!d.registrationCountry) e.registrationCountry = 'Select the country of registration.';
    else {
      const r = validateRegistrationNumber(d.registrationCountry, d.registrationNumber);
      if (r) e.registrationNumber = r;
    }
    if (!d.name.trim()) e.name = 'Enter the primary contact name.';
    if (!d.email.trim()) e.email = 'Enter the primary contact email.';
    else if (!isEmail(d.email)) e.email = 'Enter a valid email address, e.g. name@company.com';
    if (!d.phone.trim()) e.phone = 'Enter the primary contact phone number.';
    else if (!isPhone(d.phone)) e.phone = 'Enter a valid phone number including the country code, e.g. +60 12 345 6789';
    return { ...e, ...this.serverErrors() };
  });

  protected show(field: Field) {
    return (this.submitted() || this.touched().has(field)) && this.errors()[field];
  }

  protected set(field: Field, value: string) {
    this.draft.update((d) => ({ ...d, [field]: value }));
    this.serverErrors.update(({ [field]: _, ...rest }) => rest);
    if (this.error()?.code === 'POSSIBLE_DUPLICATE' || this.error()?.code === 'DUPLICATE_MERCHANT') this.error.set(null);
  }

  protected touch(field: Field) {
    this.touched.update((s) => new Set(s).add(field));
  }

  protected async create(confirmNotDuplicate = false) {
    this.submitted.set(true);
    // Guided mode: errors are shown, but never stop the flow (see validation-mode.ts).
    if (Object.keys(this.errors()).length && isStrictValidation()) {
      document.querySelector<HTMLElement>('.invalid')?.focus();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const d = this.draft();
    try {
      this.created.set(
        await this.api.createMerchant({
          legalName: d.legalName.trim(),
          registrationCountry: d.registrationCountry,
          registrationNumber: d.registrationNumber.trim(),
          primaryContact: { name: d.name.trim(), email: d.email.trim(), phone: d.phone.trim() },
          confirmNotDuplicate,
        }),
      );
    } catch (e) {
      const err = toMerchantError(e);
      if (err.code === 'VALIDATION_FAILED' && 'errors' in err && err.errors) {
        const map: Record<string, Field> = { legalName: 'legalName', registrationCountry: 'registrationCountry', registrationNumber: 'registrationNumber', 'primaryContact.name': 'name', 'primaryContact.email': 'email', 'primaryContact.phone': 'phone' };
        this.serverErrors.set(Object.fromEntries(err.errors.map((x) => [map[x.field] ?? 'legalName', x.message])));
      } else {
        this.error.set(err);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected opened(applicationId: string) {
    this.router.navigate(['/applications', applicationId]);
  }
}
