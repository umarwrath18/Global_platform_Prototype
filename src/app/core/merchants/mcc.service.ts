import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { catalogueCovers, EMPTY_MCC_CATALOGUE, MccCatalogue, mccAvailability, mccOptionsFor } from './mcc';

/** Client for the MCC catalogue (currently answered by the simulated backend). Read-only. */
@Injectable({ providedIn: 'root' })
export class MccService {
  private readonly http = inject(HttpClient);
  private readonly state = signal<MccCatalogue>(EMPTY_MCC_CATALOGUE);

  readonly catalogue = this.state.asReadonly();
  readonly isTestFixture = computed(() => this.state().source?.kind === 'test_fixture');

  async load(): Promise<MccCatalogue> {
    const catalogue = await firstValueFrom(this.http.get<MccCatalogue>('/api/config/mcc'));
    this.state.set(catalogue);
    return catalogue;
  }

  covers(country: string) {
    return catalogueCovers(this.state(), country);
  }

  optionsFor(country: string) {
    return mccOptionsFor(this.state(), country);
  }

  availability(code: string, country: string) {
    return mccAvailability(this.state(), code, country);
  }
}
