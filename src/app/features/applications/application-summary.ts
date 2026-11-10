import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { registeredInCountry } from '../../core/merchants/application-rules';
import { APPROVAL_PRIORITY_LABEL, ApplicationData, connectionTypeLabel, CountryApplication, FieldIssue, GlobalMerchant, merchantCategoryLabel, SECTION_LABEL, SectionKey } from '../../core/merchants/merchant-models';
import { MccService } from '../../core/merchants/mcc.service';
import type { MccRef } from '../../core/merchants/mcc';
import { countryName, rulesFor } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { fmtDate } from '../../shared/merchant-ui';
import { DecimalPipe } from '@angular/common';

/** Read-only view of a country application, used for review and after submission. */
@Component({
  selector: 'app-application-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, DecimalPipe],
  templateUrl: './application-summary.html',
  styleUrl: './application-summary.scss',
})
export class ApplicationSummaryView {
  private readonly mccService = inject(MccService);
  readonly application = input.required<CountryApplication>();
  readonly merchant = input.required<GlobalMerchant>();
  /** Working copy to show instead of the saved data (used on the Review & submit step). */
  readonly data = input<ApplicationData | null>(null);
  readonly editable = input(false);
  /** Open validation issues: required fields that are missing are highlighted (Preview). */
  readonly issues = input<FieldIssue[]>([]);
  /** The MCC as just changed in the form (it is saved to the merchant straight away). */
  readonly currentMcc = input<MccRef | null | undefined>(undefined);
  readonly edit = output<SectionKey>();

  protected readonly d = computed(() => this.data() ?? this.application().data);
  protected readonly cfg = computed(() => rulesFor(this.application()));
  protected readonly profile = computed(() => this.application().submittedProfile ?? this.merchant());
  protected readonly sameCountry = computed(() => registeredInCountry(this.profile(), this.application().country));
  /** The MCC Risk reviewed (once submitted) or the merchant's current one (drafts). */
  protected readonly mcc = computed(() => (this.currentMcc() !== undefined ? this.currentMcc()! : (this.profile().mcc ?? null)));
  protected readonly mccRestricted = computed(() => {
    const m = this.mcc();
    return !!m && this.mccService.availability(m.code, this.application().country) === 'restricted';
  });
  protected readonly flagged = computed(() => new Set(this.application().status === 'returned' ? this.application().corrections?.sections ?? [] : []));
  protected readonly label = SECTION_LABEL;
  protected readonly categoryLabel = merchantCategoryLabel;
  protected readonly connectionLabel = connectionTypeLabel;
  protected readonly priorityLabel = APPROVAL_PRIORITY_LABEL;
  private readonly issueFields = computed(() => new Map(this.issues().map((i) => [i.field, i.message])));
  protected readonly sectionIssues = computed(() => {
    const out: Partial<Record<SectionKey, number>> = {};
    for (const i of this.issues()) if (i.section !== 'pricing') out[i.section] = (out[i.section] ?? 0) + 1;
    return out;
  });
  protected readonly countryName = countryName;
  protected readonly date = fmtDate;

  protected readonly docs = computed(() =>
    this.cfg().documents.map((rule) => ({ rule, files: this.d().documents.filter((f) => f.type === rule.type) })),
  );

  /** The problem with a field, if any (shown in place of the value). */
  protected miss(field: string): string | null {
    return this.issueFields().get(field) ?? null;
  }

  protected settlementEmails() {
    return this.d().contact.settlementEmails.filter((e) => e.trim());
  }

  /** A YYYY-MM-DD date in the portal's date format. */
  protected isoDate(v: string) {
    const t = Date.parse(`${v}T00:00:00`);
    return Number.isNaN(t) ? v : this.date(t);
  }

  protected bankValue(key: string) {
    return this.d().bank[key] || '—';
  }

  protected maskAccount(v: string | undefined) {
    if (!v) return '—';
    return v.length > 4 ? `•••• ${v.slice(-4)}` : v;
  }
}
