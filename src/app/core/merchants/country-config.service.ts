import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CountryConfigDetail, CountryConfigView, UpdateCountryConfigRequest } from './country-config';
import { applyCountryConfigs } from './onboarding-config';
import { StaffRoleService } from './staff-role.service';

/** Client for Country Configuration (currently answered by the simulated backend). */
@Injectable({ providedIn: 'root' })
export class CountryConfigService {
  private readonly http = inject(HttpClient);
  private readonly roles = inject(StaffRoleService);

  /** Increases whenever the live onboarding rules change, so views that list countries can recompute. */
  private readonly revisionState = signal(0);
  readonly revision = this.revisionState.asReadonly();

  /** Only Sales / Operations may edit. The server enforces this; the UI only hides controls. */
  readonly canEdit = computed(() => this.roles.role() === 'sales');

  /** Loads the live rules that the onboarding screens read through ONBOARDING_COUNTRIES. */
  async load(): Promise<CountryConfigView[]> {
    const list = await firstValueFrom(this.http.get<CountryConfigView[]>('/api/config/countries'));
    applyCountryConfigs(list.map((c) => c.config));
    this.revisionState.update((n) => n + 1);
    return list;
  }

  get(code: string) {
    return firstValueFrom(this.http.get<CountryConfigDetail>(`/api/config/countries/${encodeURIComponent(code)}`, { headers: this.headers() }));
  }

  async update(code: string, req: UpdateCountryConfigRequest) {
    const saved = await firstValueFrom(this.http.put<CountryConfigView>(`/api/config/countries/${encodeURIComponent(code)}`, req, { headers: this.headers() }));
    applyCountryConfigs([saved.config]);
    this.revisionState.update((n) => n + 1);
    return saved;
  }

  private headers() {
    return new HttpHeaders({ 'X-Demo-Role': this.roles.role() });
  }
}
