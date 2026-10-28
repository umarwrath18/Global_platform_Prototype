import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CountryConfigView } from '../../core/merchants/country-config';
import { CountryConfigService } from '../../core/merchants/country-config.service';
import { Icon } from '../../shared/icon';
import { fmtDate } from '../../shared/merchant-ui';

/** Country configuration (MVP feature 5): onboarding rules per country. */
@Component({
  selector: 'app-country-config-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  templateUrl: './country-config-list.html',
  styleUrl: './country-config.scss',
})
export class CountryConfigList {
  protected readonly service = inject(CountryConfigService);

  protected readonly countries = signal<CountryConfigView[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly date = fmtDate;

  constructor() {
    void this.load();
  }

  protected async load() {
    this.loading.set(true);
    this.error.set(false);
    try {
      this.countries.set(await this.service.load());
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected requiredDocs(c: CountryConfigView) {
    return c.config.documents.filter((d) => d.required).length;
  }

  protected requiredBank(c: CountryConfigView) {
    return c.config.bankFields.filter((f) => f.required).length;
  }
}
