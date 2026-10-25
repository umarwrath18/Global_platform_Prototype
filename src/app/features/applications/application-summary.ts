import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { registeredInCountry } from '../../core/merchants/application-rules';
import { ApplicationData, CountryApplication, GlobalMerchant, SECTION_LABEL, SectionKey } from '../../core/merchants/merchant-models';
import { ONBOARDING_COUNTRIES, countryName } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { fmtDate } from '../../shared/merchant-ui';

const ROLE_LABEL = { director: 'Director', beneficial_owner: 'Beneficial owner', director_and_owner: 'Director & owner' } as const;

/** Read-only view of a country application, used for review and after submission. */
@Component({
  selector: 'app-application-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './application-summary.html',
  styleUrl: './application-summary.scss',
})
export class ApplicationSummaryView {
  readonly application = input.required<CountryApplication>();
  readonly merchant = input.required<GlobalMerchant>();
  /** Working copy to show instead of the saved data (used on the Review & submit step). */
  readonly data = input<ApplicationData | null>(null);
  readonly editable = input(false);
  readonly edit = output<SectionKey>();

  protected readonly d = computed(() => this.data() ?? this.application().data);
  protected readonly cfg = computed(() => ONBOARDING_COUNTRIES[this.application().country]);
  protected readonly profile = computed(() => this.application().submittedProfile ?? this.merchant());
  protected readonly sameCountry = computed(() => registeredInCountry(this.profile(), this.application().country));
  protected readonly flagged = computed(() => new Set(this.application().status === 'returned' ? this.application().corrections?.sections ?? [] : []));
  protected readonly label = SECTION_LABEL;
  protected readonly roleLabel = ROLE_LABEL;
  protected readonly countryName = countryName;
  protected readonly date = fmtDate;

  protected readonly docs = computed(() =>
    this.cfg().documents.map((rule) => ({ rule, files: this.d().documents.filter((f) => f.type === rule.type) })),
  );

  protected readonly pricing = computed(() =>
    this.cfg().paymentMethods.map((m) => ({ m, line: this.d().pricing.find((p) => p.code === m.code) })).filter((x) => x.line?.enabled),
  );

  protected bankValue(key: string) {
    return this.d().bank[key] || '—';
  }

  protected maskAccount(v: string | undefined) {
    if (!v) return '—';
    return v.length > 4 ? `•••• ${v.slice(-4)}` : v;
  }
}
