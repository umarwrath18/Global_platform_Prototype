import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, Observable } from 'rxjs';
import {
  ApplicationData,
  ApplicationDetail,
  ApplicationSummary,
  CountryApplication,
  CreateMerchantRequest,
  GlobalMerchant,
  MerchantApiError,
  MerchantDetail,
  MerchantSummary,
  PortalNotification,
  ReadinessAction,
  ReviewRequest,
  UpdateMerchantRequest,
} from './merchant-models';
import { StaffRoleService } from './staff-role.service';

export type MerchantClientError = MerchantApiError | { code: 'NETWORK_ERROR'; message?: string } | { code: 'UNKNOWN_ERROR'; message?: string };

export function toMerchantError(e: unknown): MerchantClientError {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return { code: 'NETWORK_ERROR', message: 'No connection. Check your network and try again.' };
    if (e.error && typeof e.error === 'object' && 'code' in e.error) return e.error as MerchantApiError;
  }
  return { code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' };
}

/** Client for the merchant onboarding API (currently answered by the simulated backend). */
@Injectable({ providedIn: 'root' })
export class MerchantApi {
  private readonly http = inject(HttpClient);
  private readonly roles = inject(StaffRoleService);

  private readonly notificationState = signal<PortalNotification[]>([]);
  readonly notifications = this.notificationState.asReadonly();
  readonly myNotifications = computed(() => this.notificationState().filter((n) => n.audience.includes(this.roles.role())));
  readonly unreadCount = computed(() => this.myNotifications().filter((n) => !n.readBy.includes(this.roles.role())).length);

  private get headers() {
    // Prototype-only acting role; see StaffRoleService.
    return new HttpHeaders({ 'X-Demo-Role': this.roles.role() });
  }

  private run<T>(obs: Observable<T>, refreshNotifications = false): Promise<T> {
    const p = firstValueFrom(obs);
    if (refreshNotifications) void p.then(() => this.refreshNotifications(), () => undefined);
    return p;
  }

  listMerchants() {
    return this.run(this.http.get<MerchantSummary[]>('/api/merchants', { headers: this.headers }));
  }

  getMerchant(id: string) {
    return this.run(this.http.get<MerchantDetail>(`/api/merchants/${encodeURIComponent(id)}`, { headers: this.headers }));
  }

  createMerchant(req: CreateMerchantRequest) {
    return this.run(this.http.post<GlobalMerchant>('/api/merchants', req, { headers: this.headers }));
  }

  updateMerchant(id: string, req: UpdateMerchantRequest) {
    return this.run(this.http.patch<GlobalMerchant>(`/api/merchants/${encodeURIComponent(id)}`, req, { headers: this.headers }));
  }

  createApplication(merchantId: string, country: string) {
    return this.run(this.http.post<CountryApplication>(`/api/merchants/${encodeURIComponent(merchantId)}/applications`, { country }, { headers: this.headers }));
  }

  listApplications() {
    return this.run(this.http.get<ApplicationSummary[]>('/api/applications', { headers: this.headers }));
  }

  getApplication(id: string) {
    return this.run(this.http.get<ApplicationDetail>(`/api/applications/${encodeURIComponent(id)}`, { headers: this.headers }));
  }

  saveDraft(id: string, data: ApplicationData) {
    return this.run(this.http.put<CountryApplication>(`/api/applications/${encodeURIComponent(id)}`, { data }, { headers: this.headers }));
  }

  submit(id: string, data: ApplicationData, comment: string) {
    return this.run(this.http.post<CountryApplication>(`/api/applications/${encodeURIComponent(id)}/submit`, { data, comment }, { headers: this.headers }), true);
  }

  review(id: string, req: ReviewRequest) {
    return this.run(this.http.post<CountryApplication>(`/api/applications/${encodeURIComponent(id)}/review`, req, { headers: this.headers }), true);
  }

  readiness(id: string, action: ReadinessAction) {
    return this.run(this.http.post<CountryApplication>(`/api/applications/${encodeURIComponent(id)}/readiness`, action, { headers: this.headers }), true);
  }

  async refreshNotifications() {
    try {
      this.notificationState.set(await firstValueFrom(this.http.get<PortalNotification[]>('/api/notifications', { headers: this.headers })));
    } catch {
      // Keep the last known list; 401s are handled by the auth interceptor.
    }
  }

  async markRead(ids?: string[]) {
    await firstValueFrom(this.http.post('/api/notifications/read', ids ? { ids } : {}, { headers: this.headers }));
    await this.refreshNotifications();
  }
}
