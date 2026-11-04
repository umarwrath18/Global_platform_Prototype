import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CountryConfigView } from './country-config';
import { applyCountryConfigs } from './onboarding-config';

/**
 * Client for the stored country onboarding rules (currently answered by the simulated backend).
 * Read-only: the rules are no longer edited in the portal.
 */
@Injectable({ providedIn: 'root' })
export class CountryConfigService {
  private readonly http = inject(HttpClient);

  /** Increases whenever the live onboarding rules change, so views that list countries can recompute. */
  private readonly revisionState = signal(0);
  readonly revision = this.revisionState.asReadonly();

  /** Loads the live rules that the onboarding screens read through ONBOARDING_COUNTRIES. */
  async load(): Promise<CountryConfigView[]> {
    const list = await firstValueFrom(this.http.get<CountryConfigView[]>('/api/config/countries'));
    applyCountryConfigs(list.map((c) => c.config));
    this.revisionState.update((n) => n + 1);
    return list;
  }
}
