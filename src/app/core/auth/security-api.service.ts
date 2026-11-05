import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AccountSecurityView,
  RecoveryCodesResponse,
  ReplaceAuthenticatorStart,
  SecurityAuditView,
  SecurityOverview,
  StepUpResponse,
} from '../api/models';
import { StaffRoleService } from '../merchants/staff-role.service';

/** Account security (any signed-in user) and security administration (Support / Security Admin). */
@Injectable({ providedIn: 'root' })
export class SecurityApi {
  private readonly http = inject(HttpClient);
  private readonly roles = inject(StaffRoleService);

  // ---- My account ----

  accountSecurity() {
    return firstValueFrom(this.http.get<AccountSecurityView>('/api/account/security'));
  }

  startReplacement(code: string) {
    return firstValueFrom(this.http.post<ReplaceAuthenticatorStart>('/api/account/security/authenticator/replace', { code }));
  }

  confirmReplacement(replaceToken: string, code: string) {
    return firstValueFrom(this.http.post<void>('/api/account/security/authenticator/replace/confirm', { replaceToken, code }));
  }

  regenerateRecoveryCodes(code: string) {
    return firstValueFrom(this.http.post<RecoveryCodesResponse>('/api/account/security/recovery-codes', { code }));
  }

  // ---- Administration ----

  /** Prototype-only acting role; see StaffRoleService. */
  private headers() {
    return new HttpHeaders({ 'X-Demo-Role': this.roles.securityRole() ?? 'none' });
  }

  overview() {
    return firstValueFrom(this.http.get<SecurityOverview>('/api/security/overview', { headers: this.headers() }));
  }

  audit() {
    return firstValueFrom(this.http.get<SecurityAuditView[]>('/api/security/audit', { headers: this.headers() }));
  }

  stepUp(code: string) {
    return firstValueFrom(this.http.post<StepUpResponse>('/api/security/step-up', { code }, { headers: this.headers() }));
  }

  createResetRequest(userId: string, reason: string, reference: string, stepUpToken: string) {
    return firstValueFrom(this.http.post<{ id: string }>('/api/security/reset-requests', { userId, reason, reference, stepUpToken }, { headers: this.headers() }));
  }

  resetAuthenticator(userId: string, body: { requestId: string; identityVerified: boolean; verificationMethod: string; reason: string; stepUpToken: string }) {
    return firstValueFrom(this.http.post<void>(`/api/security/users/${encodeURIComponent(userId)}/reset`, body, { headers: this.headers() }));
  }

  waiveBlock(userId: string, reason: string, stepUpToken: string) {
    return firstValueFrom(this.http.post<void>(`/api/security/users/${encodeURIComponent(userId)}/waive`, { reason, stepUpToken }, { headers: this.headers() }));
  }
}
