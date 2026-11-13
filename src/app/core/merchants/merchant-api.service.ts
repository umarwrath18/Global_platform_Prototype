import type { SuspensionView } from './suspensions';
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
import type { MccChangeRequest } from './mcc';
import type { ApprovalsView, ChangeRequest, CreateChangeRequest } from './change-requests';
import type { CreateSubMerchantRequest, SubMerchantView } from './sub-merchants';
import type { Deactivation, DeactivateRequest, MdrHistoryRow, MerchantPricingList, SubMerchantPricingRow, PricingApprovalsView, PricingAuditEvent, PricingDecisionRequest, PricingVersion, ProductPricingView, SaveProductsRequest, SetPricingRequest } from './products';
import { StaffRoleService } from './staff-role.service';

export type MerchantClientError = MerchantApiError | { code: 'NETWORK_ERROR'; message?: string } | { code: 'UNKNOWN_ERROR'; message?: string };

export function toMerchantError(e: unknown): MerchantClientError {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return { code: 'NETWORK_ERROR', message: 'No connection. Check your network and try again.' };
    if (e.error && typeof e.error === 'object' && 'code' in e.error) return e.error as MerchantApiError;
  }
  return { code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' };
}

type PricingResult = { version: PricingVersion; view: ProductPricingView };

/** Client for the merchant onboarding API (currently answered by the simulated backend). */
@Injectable({ providedIn: 'root' })
export class MerchantApi {
  private readonly http = inject(HttpClient);
  private readonly roles = inject(StaffRoleService);

  private readonly notificationState = signal<PortalNotification[]>([]);
  readonly notifications = this.notificationState.asReadonly();
  readonly myNotifications = computed(() => this.notificationState().filter((n) => n.audience.includes(this.roles.role())));
  private readonly approvalsCountState = signal(0);
  /** Items waiting for the acting team's decision (Risk, FinOps). */
  readonly approvalsCount = this.approvalsCountState.asReadonly();
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

  /** Suspend a merchant, one of its countries or one sub-merchant (MFA code after MFA_CODE_REQUIRED). */
  suspend(gmid: string, body: Record<string, unknown>) {
    return this.run(this.http.post<SuspensionView>(`/api/merchants/${encodeURIComponent(gmid)}/suspensions`, body, { headers: this.headers }), true);
  }

  /** review · reactivation · reactivation/decision · settlement · settlement/request */
  suspensionAction(id: string, step: 'review' | 'reactivation' | 'reactivation/decision' | 'settlement' | 'settlement/request', body: Record<string, unknown> = {}) {
    return this.run(this.http.post<SuspensionView>(`/api/suspensions/${encodeURIComponent(id)}/${step}`, body, { headers: this.headers }), true);
  }

  updateLifecycle(id: string, action: 'suspend' | 'reactivate', reason: string) {
    return this.run(this.http.post<GlobalMerchant>(`/api/merchants/${encodeURIComponent(id)}/lifecycle`, { action, reason }, { headers: this.headers }));
  }

  /** Sets the MCC directly (only before the merchant's first Risk approval). */
  setMcc(merchantId: string, code: string) {
    return this.run(this.http.put<GlobalMerchant>(`/api/merchants/${encodeURIComponent(merchantId)}/mcc`, { code }, { headers: this.headers }));
  }

  requestMccChange(merchantId: string, code: string, reason: string) {
    return this.run(this.http.post<MccChangeRequest>(`/api/merchants/${encodeURIComponent(merchantId)}/mcc-requests`, { code, reason }, { headers: this.headers }), true);
  }

  decideMccChange(merchantId: string, requestId: string, decision: 'approve' | 'reject', comment: string) {
    return this.run(
      this.http.post<MccChangeRequest>(`/api/merchants/${encodeURIComponent(merchantId)}/mcc-requests/${encodeURIComponent(requestId)}/decision`, { decision, comment }, { headers: this.headers }),
      true,
    );
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

  // ------------------------------------------ Change requests and approvals

  requestProfileChange(merchantId: string, req: CreateChangeRequest) {
    return this.run(this.http.post<ChangeRequest>(`/api/merchants/${encodeURIComponent(merchantId)}/changes`, req, { headers: this.headers }), true);
  }

  requestCountryChange(applicationId: string, req: CreateChangeRequest) {
    return this.run(this.http.post<ChangeRequest>(`/api/applications/${encodeURIComponent(applicationId)}/changes`, req, { headers: this.headers }), true);
  }

  decideChange(id: string, decision: 'approve' | 'reject', comment: string) {
    return this.run(this.http.post<ChangeRequest>(`/api/changes/${encodeURIComponent(id)}/decision`, { decision, comment }, { headers: this.headers }), true);
  }

  withdrawChange(id: string) {
    return this.run(this.http.post<ChangeRequest>(`/api/changes/${encodeURIComponent(id)}/withdraw`, {}, { headers: this.headers }), true);
  }

  // ------------------------------------------------------------ sub-merchants

  createSubMerchant(merchantId: string, req: CreateSubMerchantRequest) {
    return this.run(this.http.post<SubMerchantView>(`/api/merchants/${encodeURIComponent(merchantId)}/sub-merchants`, req, { headers: this.headers }), true);
  }

  subMerchantAction(id: string, action: 'submit' | 'review' | 'checks' | 'go-live' | 'lifecycle', body: object = {}) {
    return this.run(this.http.post<SubMerchantView>(`/api/sub-merchants/${encodeURIComponent(id)}/${action}`, body, { headers: this.headers }), true);
  }

  getApprovals() {
    return this.run(this.http.get<ApprovalsView>('/api/approvals', { headers: this.headers }));
  }

  // ---------------------------------------------- Product & Payment Config

  /** CS or Sales / Operations: change the IPN callback URL directly (recorded in the history). */
  setIpn(applicationId: string, url: string) {
    return this.run(this.http.put<CountryApplication>(`/api/applications/${encodeURIComponent(applicationId)}/ipn`, { url }, { headers: this.headers }));
  }

  getProducts(applicationId: string) {
    return this.run(this.http.get<ProductPricingView>(`/api/applications/${encodeURIComponent(applicationId)}/products`, { headers: this.headers }));
  }

  saveProducts(applicationId: string, req: SaveProductsRequest) {
    return this.run(this.http.put<{ message: string; view: ProductPricingView }>(`/api/applications/${encodeURIComponent(applicationId)}/products`, req, { headers: this.headers }));
  }

  setPricing(applicationId: string, req: SetPricingRequest) {
    return this.run(this.http.post<PricingResult>(`/api/applications/${encodeURIComponent(applicationId)}/pricing`, req, { headers: this.headers }), true);
  }

  cancelPricing(applicationId: string, versionId: string, reason = '') {
    const url = `/api/applications/${encodeURIComponent(applicationId)}/pricing/${encodeURIComponent(versionId)}/cancel`;
    return this.run(this.http.post<PricingResult>(url, { reason }, { headers: this.headers }));
  }

  /** Ops: stop a live payment method for the whole MID or one sub-merchant (needs an MFA code). */
  deactivateMethod(applicationId: string, req: DeactivateRequest) {
    return this.run(this.http.post<{ deactivation: Deactivation; view: ProductPricingView }>(`/api/applications/${encodeURIComponent(applicationId)}/deactivations`, req, { headers: this.headers }), true);
  }

  /** Ops: cancel a scheduled deactivation, or reactivate a method for a sub-merchant (needs an MFA code). */
  deactivationAction(applicationId: string, deactivationId: string, action: 'cancel' | 'reactivate', code?: string) {
    const url = `/api/applications/${encodeURIComponent(applicationId)}/deactivations/${encodeURIComponent(deactivationId)}/${action}`;
    return this.run(this.http.post<{ deactivation: Deactivation; view: ProductPricingView }>(url, code ? { code } : {}, { headers: this.headers }), true);
  }

  /** FinOps decision; `code` is the approver's current authenticator code (re-authentication). */
  decidePricing(applicationId: string, versionId: string, req: PricingDecisionRequest) {
    const url = `/api/applications/${encodeURIComponent(applicationId)}/pricing/${encodeURIComponent(versionId)}/decision`;
    return this.run(this.http.post<PricingResult>(url, req, { headers: this.headers }), true);
  }

  pricingApprovals(country?: string) {
    return this.run(this.http.get<PricingApprovalsView>(`/api/pricing/approvals${country ? `?country=${encodeURIComponent(country)}` : ''}`, { headers: this.headers }));
  }

  merchantPricing(country: string) {
    return this.run(this.http.get<MerchantPricingList>(`/api/pricing/merchants?country=${encodeURIComponent(country)}`, { headers: this.headers }));
  }

  subMerchantPricing(country: string) {
    return this.run(this.http.get<SubMerchantPricingRow[]>(`/api/pricing/sub-merchants?country=${encodeURIComponent(country)}`, { headers: this.headers }));
  }

  mdrHistory(country: string) {
    return this.run(this.http.get<MdrHistoryRow[]>(`/api/pricing/history?country=${encodeURIComponent(country)}`, { headers: this.headers }));
  }

  pricingAudit() {
    return this.run(this.http.get<PricingAuditEvent[]>('/api/pricing/audit', { headers: this.headers }));
  }

  async refreshNotifications() {
    try {
      this.notificationState.set(await firstValueFrom(this.http.get<PortalNotification[]>('/api/notifications', { headers: this.headers })));
      const approvals = await firstValueFrom(this.http.get<ApprovalsView>('/api/approvals', { headers: this.headers }));
      this.approvalsCountState.set(approvals.canDecide ? approvals.pending.length : 0);
    } catch {
      // Keep the last known list; 401s are handled by the auth interceptor.
    }
  }

  async markRead(ids?: string[]) {
    await firstValueFrom(this.http.post('/api/notifications/read', ids ? { ids } : {}, { headers: this.headers }));
    await this.refreshNotifications();
  }
}
