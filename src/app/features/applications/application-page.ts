import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import {
  ApplicationDetail,
  ApplicationStatus,
  CountryApplication,
  HistoryEvent,
  READINESS_STATUSES,
  SECTION_LABEL,
  STAFF_ROLE_LABEL,
  StaffRole,
} from '../../core/merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { StatusBadge, fmtDate, fmtDateTime } from '../../shared/merchant-ui';
import { ApplicationForm } from './application-form';
import { ApplicationSummaryView } from './application-summary';
import { ReadinessPanel } from './readiness-panel';
import { ReviewPanel } from './review-panel';
import { StatusTracker } from './status-tracker';
import { HasUnsavedChanges } from './unsaved-changes.guard';

/** Which team owns the next step for each status. */
const NEXT_OWNER: Partial<Record<ApplicationStatus, { role: StaffRole; text: string }>> = {
  draft: { role: 'sales', text: 'Sales / Operations finishes the application and submits it.' },
  returned: { role: 'sales', text: 'Sales / Operations makes the requested changes and resubmits.' },
  pending_risk_review: { role: 'risk', text: 'Risk reviews the application.' },
  risk_approved: { role: 'cs', text: 'Customer Success starts setup.' },
  cs_configuration: { role: 'cs', text: 'Customer Success completes setup and issues production keys.' },
  keys_generated: { role: 'cs', text: 'Customer Success starts the integration.' },
  integration: { role: 'cs', text: 'The merchant integrates while Customer Success tracks progress.' },
  go_live_verification: { role: 'cs', text: 'Customer Success runs the go-live checks.' },
};

@Component({
  selector: 'app-application-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, StatusBadge, StatusTracker, ApplicationForm, ApplicationSummaryView, ReviewPanel, ReadinessPanel],
  templateUrl: './application-page.html',
  styleUrl: './application-page.scss',
})
export class ApplicationPage implements HasUnsavedChanges {
  private readonly api = inject(MerchantApi);
  private readonly router = inject(Router);
  protected readonly roles = inject(StaffRoleService);

  /** Bound from the `:id` route parameter. */
  readonly id = input.required<string>();

  private readonly form = viewChild(ApplicationForm);

  protected readonly detail = signal<ApplicationDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly toast = signal<string | null>(null);
  protected readonly retrying = signal(false);
  protected readonly retryError = signal<string | null>(null);

  protected readonly roleLabel = { ...STAFF_ROLE_LABEL, system: 'System' } as Record<HistoryEvent['role'], string>;
  protected readonly sectionLabel = SECTION_LABEL;
  protected readonly date = fmtDate;
  protected readonly dateTime = fmtDateTime;

  protected readonly app = computed(() => this.detail()?.application ?? null);
  protected readonly cfg = computed(() => (this.app() ? ONBOARDING_COUNTRIES[this.app()!.country] : null));
  protected readonly role = this.roles.role;
  protected readonly editable = computed(() => this.role() === 'sales' && ['draft', 'returned'].includes(this.app()?.status ?? ''));
  protected readonly reviewing = computed(() => this.role() === 'risk' && this.app()?.status === 'pending_risk_review');
  protected readonly inReadiness = computed(() => READINESS_STATUSES.includes(this.app()?.status as ApplicationStatus));
  protected readonly next = computed(() => NEXT_OWNER[this.app()?.status as ApplicationStatus] ?? null);
  protected readonly history = computed(() => [...(this.app()?.history ?? [])].reverse());
  protected readonly rejectionReason = computed(() => this.app()?.history.find((h) => h.toStatus === 'rejected')?.comment ?? '');

  constructor() {
    effect(() => void this.load(this.id()));
  }

  hasUnsavedChanges() {
    return this.form()?.hasUnsavedChanges() ?? false;
  }

  protected async load(id = this.id()) {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.detail.set(await this.api.getApplication(id));
    } catch (e) {
      this.error.set(toMerchantError(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected switchRole(role: StaffRole) {
    this.roles.set(role);
  }

  protected onSaved(e: { application: CountryApplication; submitted: boolean }) {
    this.replace(e.application);
    if (e.submitted) this.flash(e.application.submissionCount > 1 ? 'Resubmitted for Risk review' : 'Submitted for Risk review');
  }

  protected onDecided(app: CountryApplication) {
    this.replace(app);
    this.flash(app.status === 'risk_approved' ? 'Approved. Customer Success has been notified.' : app.status === 'returned' ? 'Returned to Sales / Operations' : 'Application rejected');
  }

  protected onReadiness(e: { application: CountryApplication; message?: string }) {
    this.replace(e.application);
    // Go-live links a Global Account to the merchant, so refresh the merchant record too.
    if (e.application.status === 'operational') void this.load();
    if (e.message) this.flash(e.message);
  }

  /** After a rejection, a retry is a new application linked to the same Global Merchant. */
  protected async startNewApplication() {
    const a = this.app()!;
    this.retrying.set(true);
    this.retryError.set(null);
    try {
      const created = await this.api.createApplication(a.merchantId, a.country);
      this.router.navigate(['/applications', created.id]);
    } catch (e) {
      const err = toMerchantError(e);
      if (err.code === 'APPLICATION_EXISTS' && 'existingApplicationId' in err && err.existingApplicationId) {
        this.router.navigate(['/applications', err.existingApplicationId]);
      } else {
        this.retryError.set(err.message ?? "We couldn't start a new application.");
      }
    } finally {
      this.retrying.set(false);
    }
  }

  private replace(application: CountryApplication) {
    this.detail.update((d) => (d ? { ...d, application } : d));
  }

  private flash(msg: string) {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(null), 3500);
  }
}
