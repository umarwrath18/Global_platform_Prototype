import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { StaffRoleService } from '../merchants/staff-role.service';
import { HostPerformance, OverrideInput, OverrideView, RouteDecision, RouteInput, RouteView, RoutingActivity, RoutingResponse } from './routing';

export { toHostError as toRoutingError } from '../hosts/host-api.service';

/** Routing API (simulated backend in the prototype). Changes need an authenticator code. */
@Injectable({ providedIn: 'root' })
export class RoutingApi {
  private readonly http = inject(HttpClient);
  private readonly roles = inject(StaffRoleService);

  private get headers() {
    return new HttpHeaders({ 'X-Demo-Role': this.roles.acting() });
  }

  overview() {
    return firstValueFrom(this.http.get<RoutingResponse>('/api/routing', { headers: this.headers }));
  }

  performance() {
    return firstValueFrom(this.http.get<HostPerformance[]>('/api/routing/performance', { headers: this.headers }));
  }

  activity() {
    return firstValueFrom(this.http.get<RoutingActivity[]>('/api/routing/activity', { headers: this.headers }));
  }

  check(body: { merchantId: string | null; subMerchantId: string | null; country: string; methodCode: string; amount?: number | null }) {
    return firstValueFrom(this.http.post<RouteDecision & { route: string; simulated: boolean }>('/api/routing/check', body, { headers: this.headers }));
  }

  saveRoute(country: string, methodCode: string, input: RouteInput, code?: string) {
    return firstValueFrom(this.http.put<RouteView>(`/api/routing/routes/${encodeURIComponent(country)}/${encodeURIComponent(methodCode)}`, { ...input, ...(code ? { code } : {}) }, { headers: this.headers }));
  }

  saveOverride(id: string | null, input: OverrideInput, code?: string) {
    const body = { ...input, ...(code ? { code } : {}) };
    return firstValueFrom(
      id ? this.http.put<OverrideView>(`/api/routing/overrides/${encodeURIComponent(id)}`, body, { headers: this.headers }) : this.http.post<OverrideView>('/api/routing/overrides', body, { headers: this.headers }),
    );
  }

  removeOverride(id: string, code?: string) {
    return firstValueFrom(this.http.post<{ removed: string }>(`/api/routing/overrides/${encodeURIComponent(id)}/remove`, code ? { code } : {}, { headers: this.headers }));
  }
}
