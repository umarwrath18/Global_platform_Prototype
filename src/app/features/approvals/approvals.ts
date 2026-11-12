import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApprovalItem, ApprovalsView } from '../../core/merchants/change-requests';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { STAFF_ROLE_LABEL } from '../../core/merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { PricingApprovalItem } from '../../core/merchants/products';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';
import { Pager, pageOf } from '../../shared/pager';
import { PricingDecisionSheet } from '../pricing/pricing-decision-sheet';

type Kind = ApprovalItem['kind'];
type View = 'mine' | 'open' | 'decided';

const KIND_LABEL: Record<Kind, string> = { pricing: 'Pricing', change: 'Profile & bank', mcc: 'MCC', sub_merchant: 'Sub-merchant' };
const STATUS: Record<ApprovalItem['status'], { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: '' },
};

/**
 * The one Approvals inbox for every team: what is waiting for me, everything open, and what was
 * decided, filtered by type and country. Pricing is decided right here in a side sheet (with an
 * authenticator code); Risk items open the merchant or application page where the decision is made.
 */
@Component({
  selector: 'app-approvals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Pager, PricingDecisionSheet],
  templateUrl: './approvals.html',
  styleUrl: './approvals.scss',
})
export class Approvals {
  private readonly api = inject(MerchantApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly roles = inject(StaffRoleService);
  protected readonly view = signal<ApprovalsView | null>(null);
  protected readonly pricing = signal<PricingApprovalItem[]>([]);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly tab = signal<View>('mine');
  protected readonly kind = signal<Kind | ''>('');
  protected readonly country = signal('');
  protected readonly page = signal(0);
  protected readonly pageSize = signal(25);
  protected readonly open = signal<{ item: PricingApprovalItem; start: 'approve' | 'reject' | null } | null>(null);
  protected readonly toast = signal<{ tone: 'success' | 'danger'; text: string } | null>(null);

  protected readonly kindLabel = KIND_LABEL;
  protected readonly kinds = Object.keys(KIND_LABEL) as Kind[];
  protected readonly status = STATUS;
  protected readonly teamLabel = STAFF_ROLE_LABEL as Record<string, string>;
  protected readonly dateTime = fmtDateTime;
  protected readonly countries = Object.entries(ONBOARDING_COUNTRIES).map(([code, c]) => ({ code, name: c.name }));
  protected readonly countryName = (code: string | null) => (code ? (ONBOARDING_COUNTRIES[code]?.name ?? code) : '—');

  protected readonly canDecide = computed(() => !!this.view()?.canDecide);
  protected readonly mineLabel = computed(() => {
    const r = this.roles.role();
    return r === 'risk' ? 'Waiting for Risk' : r === 'finops' ? 'Waiting for FinOps' : r === 'sales' ? 'My open requests' : 'Waiting';
  });
  private readonly all = computed(() => this.view()?.all ?? [...(this.view()?.pending ?? []), ...(this.view()?.recent ?? [])]);
  private readonly filter = (i: ApprovalItem) => (!this.kind() || i.kind === this.kind()) && (!this.country() || i.country === this.country());
  protected readonly counts = computed(() => ({
    mine: (this.view()?.pending ?? []).filter(this.filter).length,
    open: this.all().filter((i) => i.status === 'pending' && this.filter(i)).length,
  }));
  protected readonly rows = computed(() => {
    const t = this.tab();
    const base = t === 'mine' ? (this.view()?.pending ?? []) : this.all().filter((i) => (t === 'open' ? i.status === 'pending' : i.status !== 'pending'));
    return base.filter(this.filter);
  });
  protected readonly visible = computed(() => pageOf(this.rows(), this.page(), this.pageSize()));

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    const type = q.get('type');
    if (type && type in KIND_LABEL) this.kind.set(type as Kind);
    effect(() => {
      this.roles.role();
      void this.load(q.get('pricing'));
    });
  }

  protected async load(openPricing: string | null = null) {
    this.error.set(null);
    try {
      const [view, pricing] = await Promise.all([this.api.getApprovals(), this.api.pricingApprovals()]);
      this.view.set(view);
      this.pricing.set(pricing.items);
      if (openPricing) {
        const item = pricing.items.find((p) => p.version.id === openPricing);
        if (item) this.open.set({ item, start: null });
      }
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }

  protected setTab(t: View) {
    this.tab.set(t);
    this.page.set(0);
  }

  protected setKind(k: string) {
    this.kind.set(k as Kind | '');
    this.page.set(0);
  }

  protected setCountry(c: string) {
    this.country.set(c);
    this.page.set(0);
  }

  /** Pricing opens the decision sheet here; anything else goes to the page where it's decided. */
  protected review(i: ApprovalItem, start: 'approve' | 'reject' | null = null) {
    if (i.kind === 'pricing') {
      const item = this.pricing().find((p) => p.version.id === i.id);
      if (item) this.open.set({ item, start });
      return;
    }
    void this.router.navigate(i.link, { queryParams: i.query ?? undefined });
  }

  protected async onDecided(text: string) {
    this.open.set(null);
    this.flash('success', text);
    await this.load();
  }

  protected onFailed(text: string) {
    this.open.set(null);
    this.flash('danger', text);
  }

  private flash(tone: 'success' | 'danger', text: string) {
    this.toast.set({ tone, text });
    setTimeout(() => this.toast.set(null), tone === 'success' ? 2500 : 5000);
  }
}
