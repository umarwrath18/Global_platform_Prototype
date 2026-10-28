import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApprovalItem, ApprovalsView } from '../../core/merchants/change-requests';
import { MerchantApi, MerchantClientError, toMerchantError } from '../../core/merchants/merchant-api.service';
import { STAFF_ROLE_LABEL } from '../../core/merchants/merchant-models';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

const KIND_LABEL: Record<ApprovalItem['kind'], string> = { change: 'Change request', mcc: 'MCC change', pricing: 'Pricing change' };
const STATUS: Record<ApprovalItem['status'], { label: string; tone: string }> = {
  pending: { label: 'Pending', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: '' },
};

/** One place to see what is waiting for a decision. Decisions are made on the linked page. */
@Component({
  selector: 'app-approvals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  templateUrl: './approvals.html',
  styleUrl: './approvals.scss',
})
export class Approvals {
  private readonly api = inject(MerchantApi);
  protected readonly roles = inject(StaffRoleService);
  protected readonly view = signal<ApprovalsView | null>(null);
  protected readonly error = signal<MerchantClientError | null>(null);
  protected readonly kindLabel = KIND_LABEL;
  protected readonly status = STATUS;
  protected readonly teamLabel = STAFF_ROLE_LABEL as Record<string, string>;
  protected readonly dateTime = fmtDateTime;

  constructor() {
    effect(() => {
      this.roles.role();
      void this.load();
    });
  }

  protected async load() {
    this.error.set(null);
    try {
      this.view.set(await this.api.getApprovals());
    } catch (e) {
      this.error.set(toMerchantError(e));
    }
  }
}
