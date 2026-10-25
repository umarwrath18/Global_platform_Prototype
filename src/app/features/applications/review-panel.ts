import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { SECTION_ORDER } from '../../core/merchants/application-rules';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { CountryApplication, ReviewDecision, SECTION_LABEL, SectionKey } from '../../core/merchants/merchant-models';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

/** Risk decision on a submitted application. Verification evidence informs, but never makes, the decision. */
@Component({
  selector: 'app-review-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './review-panel.html',
  styleUrl: './panels.scss',
})
export class ReviewPanel {
  private readonly api = inject(MerchantApi);

  readonly application = input.required<CountryApplication>();
  readonly decided = output<CountryApplication>();

  protected readonly decision = signal<ReviewDecision | null>(null);
  protected readonly comment = signal('');
  protected readonly sections = signal<Set<SectionKey>>(new Set());
  protected readonly reviewed = signal(false);
  protected readonly attempted = signal(false);
  protected readonly confirmReject = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly sectionKeys = SECTION_ORDER;
  protected readonly label = SECTION_LABEL;
  protected readonly dateTime = fmtDateTime;

  protected readonly evidence = computed(() => this.application().verification);
  protected readonly flags = computed(() => this.evidence()?.checks.filter((c) => c.result !== 'pass').length ?? 0);
  /** The previous Risk return and the Sales/Ops response, when this is a resubmission. */
  protected readonly lastReturn = computed(() => [...this.application().history].reverse().find((h) => h.action === 'Returned for correction') ?? null);
  protected readonly lastResubmit = computed(() => [...this.application().history].reverse().find((h) => h.action === 'Resubmitted after correction') ?? null);

  protected readonly problems = computed(() => {
    const p: Record<string, string> = {};
    const d = this.decision();
    if (!d) p['decision'] = 'Choose a decision.';
    if (!this.reviewed()) p['reviewed'] = 'Confirm you have reviewed the documents and verification evidence.';
    if (d && d !== 'approve' && this.comment().trim().length < 10) {
      p['comment'] = d === 'return' ? 'Explain what must be corrected (at least 10 characters).' : 'Give the reason for rejection (at least 10 characters).';
    }
    if (d === 'return' && !this.sections().size) p['sections'] = 'Select at least one section to correct.';
    return p;
  });

  protected toggleSection(s: SectionKey, on: boolean) {
    this.sections.update((set) => {
      const next = new Set(set);
      if (on) next.add(s);
      else next.delete(s);
      return next;
    });
  }

  protected choose(d: ReviewDecision) {
    this.decision.set(d);
    this.confirmReject.set(false);
  }

  protected async submit() {
    this.attempted.set(true);
    if (Object.keys(this.problems()).length) return;
    if (this.decision() === 'reject' && !this.confirmReject()) {
      this.confirmReject.set(true);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const app = await this.api.review(this.application().id, {
        decision: this.decision()!,
        comment: this.comment().trim(),
        sections: [...this.sections()],
        evidenceReviewed: this.reviewed(),
      });
      this.decided.emit(app);
    } catch (e) {
      const err = toMerchantError(e);
      this.error.set(('errors' in err && err.errors?.[0]?.message) || err.message || 'We could not record the decision. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
