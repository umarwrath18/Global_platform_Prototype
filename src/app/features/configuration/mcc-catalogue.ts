import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MccService } from '../../core/merchants/mcc.service';
import { ONBOARDING_COUNTRIES } from '../../core/merchants/onboarding-config';
import { Icon } from '../../shared/icon';
import { fmtDateTime } from '../../shared/merchant-ui';

/** Read-only MCC catalogue with per-country availability. Entries come only from the catalogue source. */
@Component({
  selector: 'app-mcc-catalogue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './mcc-catalogue.html',
  styleUrl: './mcc-catalogue.scss',
})
export class MccCataloguePage {
  protected readonly service = inject(MccService);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly dateTime = fmtDateTime;
  protected readonly countries = Object.values(ONBOARDING_COUNTRIES).map((c) => ({ code: c.code, name: c.name }));
  protected readonly catalogue = this.service.catalogue;
  protected readonly entries = computed(() => [...this.catalogue().entries].sort((a, b) => a.code.localeCompare(b.code)));

  constructor() {
    void this.load();
  }

  protected async load() {
    this.loading.set(true);
    this.error.set(false);
    try {
      await this.service.load();
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
