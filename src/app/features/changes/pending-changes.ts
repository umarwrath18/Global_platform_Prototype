import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { CHANGE_SECTION_LABEL, CHANGE_STATUS_LABEL, ChangeRequest } from '../../core/merchants/change-requests';
import { MerchantApi, toMerchantError } from '../../core/merchants/merchant-api.service';
import { STAFF_ROLE_LABEL } from '../../core/merchants/merchant-models';
import { countryName } from '../../core/merchants/onboarding-config';
import { StaffRoleService } from '../../core/merchants/staff-role.service';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

/** Change requests with their field-by-field changes (bank numbers masked). Risk decides here. */
@Component({
  selector: 'app-pending-changes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './pending-changes.html',
  styleUrl: './changes.scss',
})
export class PendingChanges {
  private readonly api = inject(MerchantApi);
  protected readonly roles = inject(StaffRoleService);

  readonly changes = input.required<ChangeRequest[]>();
  readonly title = input('Changes waiting for Risk');
  readonly changed = output<string>();

  protected readonly sectionLabel = CHANGE_SECTION_LABEL;
  protected readonly statusLabel = CHANGE_STATUS_LABEL;
  protected readonly teamLabel = STAFF_ROLE_LABEL as Record<string, string>;
  protected readonly countryName = countryName;
  protected readonly dateTime = fmtDateTime;
  protected readonly comment = signal<Record<string, string>>({});
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<{ id: string; message: string } | null>(null);

  protected commentFor(id: string): string {
    return this.comment()[id] ?? '';
  }

  protected setComment(id: string, value: string) {
    this.comment.update((c) => ({ ...c, [id]: value }));
  }

  protected async decide(r: ChangeRequest, decision: 'approve' | 'reject') {
    const comment = (this.comment()[r.id] ?? '').trim();
    if (decision === 'reject' && comment.length < 10) {
      this.error.set({ id: r.id, message: 'Give the reason for rejecting (at least 10 characters).' });
      return;
    }
    await this.act(r.id, () => this.api.decideChange(r.id, decision, comment), decision === 'approve' ? `${r.id} approved and applied` : `${r.id} rejected; nothing changed`);
  }

  protected async withdraw(r: ChangeRequest) {
    if (!confirm(`Withdraw ${r.id}? Nothing will change.`)) return;
    await this.act(r.id, () => this.api.withdrawChange(r.id), `${r.id} withdrawn`);
  }

  private async act(id: string, run: () => Promise<unknown>, message: string) {
    this.busy.set(id);
    this.error.set(null);
    try {
      await run();
      this.changed.emit(message);
    } catch (e) {
      this.error.set({ id, message: toMerchantError(e).message ?? "We couldn't update this change request." });
    } finally {
      this.busy.set(null);
    }
  }
}
