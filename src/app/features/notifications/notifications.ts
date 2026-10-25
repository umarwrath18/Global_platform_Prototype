import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MerchantApi } from '../../core/merchants/merchant-api.service';
import { NotificationEvent, PortalNotification, STAFF_ROLE_LABEL, StaffRole } from '../../core/merchants/merchant-models';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { GlobalFilters } from '../../core/merchants/global-filters.service';
import { ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

const EVENT_LABEL: Record<NotificationEvent, string> = {
  submitted: 'Submitted',
  resubmitted: 'Resubmitted',
  returned: 'Returned for correction',
  approved: 'Risk approved',
  rejected: 'Rejected',
  configuration_ready: 'Configuration ready',
  go_live: 'Go-live',
};

/** In-portal notification history, with the target (simulated) email for each event. */
@Component({
  selector: 'app-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  templateUrl: './notifications.html',
  styleUrl: './notifications.scss',
})
export class Notifications {
  protected readonly api = inject(MerchantApi);
  protected readonly roles = inject(StaffRoleService);
  protected readonly filters = inject(GlobalFilters);

  protected readonly scope = signal<'mine' | 'all'>('mine');
  protected readonly event = signal<'' | NotificationEvent>('');
  protected readonly eventLabel = EVENT_LABEL;
  protected readonly events = Object.entries(EVENT_LABEL) as [NotificationEvent, string][];
  protected readonly roleLabel = STAFF_ROLE_LABEL;
  protected readonly dateTime = fmtDateTime;

  protected readonly items = computed(() =>
    (this.scope() === 'mine' ? this.api.myNotifications() : this.api.notifications()).filter((n) => (!this.event() || n.event === this.event()) && this.passesTopBar(n)),
  );

  constructor() {
    void this.api.refreshNotifications();
  }

  /** Records without a country (older data) are only filtered by merchant and date. */
  private passesTopBar(n: PortalNotification) {
    const f = this.filters;
    const currency = n.country ? ONBOARDING_COUNTRIES[n.country]?.currency : undefined;
    return (
      (!f.merchantId() || n.merchantId === f.merchantId()) &&
      n.at >= f.since() &&
      (!f.country() || !n.country || n.country === f.country()) &&
      (!f.currency() || !currency || currency === f.currency())
    );
  }

  protected unread(n: PortalNotification) {
    return n.audience.includes(this.roles.role()) && !n.readBy.includes(this.roles.role());
  }

  protected audience(roles: StaffRole[]) {
    return roles.map((r) => this.roleLabel[r]).join(', ');
  }

  protected open(n: PortalNotification) {
    if (this.unread(n)) void this.api.markRead([n.id]);
  }
}
