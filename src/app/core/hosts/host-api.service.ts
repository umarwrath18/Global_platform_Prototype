import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { StaffRoleService } from '../merchants/staff-role.service';
import { AvailabilityStatus, CostVersion, HostActivity, HostDetailResponse, HostDraftInput, HostFieldError, HostListResponse, SecretKind } from './hosts';
import type { PricingDraft } from '../merchants/products';

export interface HostApiError {
  code: string;
  message: string | null;
  errors: HostFieldError[];
  attemptsRemaining?: number;
}

/** Turns an HTTP error into the host API's error shape (code, message, field errors). */
export function toHostError(e: unknown): HostApiError {
  if (e instanceof HttpErrorResponse) {
    const b = (e.error ?? {}) as Partial<HostApiError>;
    if (e.status === 0) return { code: 'NETWORK_ERROR', message: 'You appear to be offline. Check your connection and try again.', errors: [] };
    return { code: b.code ?? 'SERVICE_UNAVAILABLE', message: b.message ?? null, errors: b.errors ?? [], attemptsRemaining: b.attemptsRemaining };
  }
  return { code: 'SERVICE_UNAVAILABLE', message: null, errors: [] };
}

/** Host Management API (simulated backend in the prototype). */
@Injectable({ providedIn: 'root' })
export class HostApi {
  private readonly http = inject(HttpClient);
  private readonly roles = inject(StaffRoleService);

  private get headers() {
    // Prototype-only acting role (Tech Ops manages hosts); see StaffRoleService.
    return new HttpHeaders({ 'X-Demo-Role': this.roles.acting() });
  }

  list() {
    return firstValueFrom(this.http.get<HostListResponse>('/api/hosts', { headers: this.headers }));
  }

  activity(hostId?: string) {
    return firstValueFrom(this.http.get<HostActivity[]>('/api/hosts/activity', { headers: this.headers, params: hostId ? { host: hostId } : {} }));
  }

  detail(id: string) {
    return firstValueFrom(this.http.get<HostDetailResponse>(`/api/hosts/${encodeURIComponent(id)}`, { headers: this.headers }));
  }

  create(input: HostDraftInput) {
    return firstValueFrom(this.http.post<HostDetailResponse>('/api/hosts', input, { headers: this.headers }));
  }

  update(id: string, input: HostDraftInput) {
    return firstValueFrom(this.http.put<HostDetailResponse>(`/api/hosts/${encodeURIComponent(id)}`, input, { headers: this.headers }));
  }

  addCapability(id: string, body: { countryCode: string; paymentMethodCode: string; availabilityStatus: AvailabilityStatus }) {
    return firstValueFrom(this.http.post<HostDetailResponse>(`/api/hosts/${encodeURIComponent(id)}/capabilities`, body, { headers: this.headers }));
  }

  setAvailability(id: string, capabilityId: string, availabilityStatus: AvailabilityStatus) {
    return firstValueFrom(this.http.put<HostDetailResponse>(`/api/hosts/${encodeURIComponent(id)}/capabilities/${encodeURIComponent(capabilityId)}`, { availabilityStatus }, { headers: this.headers }));
  }

  /** Write-only: the value goes to the server once and is never returned. */
  setSecret(id: string, kind: SecretKind, value: string, code?: string) {
    return firstValueFrom(this.http.post<HostDetailResponse>(`/api/hosts/${encodeURIComponent(id)}/secrets`, { kind, value, ...(code ? { code } : {}) }, { headers: this.headers }));
  }

  setCost(id: string, country: string, draft: PricingDraft, editOf: string | null) {
    return firstValueFrom(this.http.post<CostVersion>(`/api/hosts/${encodeURIComponent(id)}/cost-pricing`, { country, draft, editOf }, { headers: this.headers }));
  }

  decideCost(id: string, versionId: string, decision: 'approve' | 'reject', reason = '') {
    return firstValueFrom(this.http.post<CostVersion>(`/api/hosts/${encodeURIComponent(id)}/cost-pricing/${encodeURIComponent(versionId)}/decision`, { decision, reason }, { headers: this.headers }));
  }

  cancelCost(id: string, versionId: string) {
    return firstValueFrom(this.http.post<CostVersion>(`/api/hosts/${encodeURIComponent(id)}/cost-pricing/${encodeURIComponent(versionId)}/cancel`, {}, { headers: this.headers }));
  }

  changeStatus(id: string, body: { action: 'enable' | 'disable' | 'maintenance'; reason?: string; until?: number | null; confirm?: boolean; code?: string }) {
    return firstValueFrom(this.http.post<HostDetailResponse>(`/api/hosts/${encodeURIComponent(id)}/status`, body, { headers: this.headers }));
  }
}
