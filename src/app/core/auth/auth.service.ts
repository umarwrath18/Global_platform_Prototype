import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { APP_PORTAL } from '../app-portal';
import { firstValueFrom } from 'rxjs';
import {
  ApiErrorCode,
  AuthenticatorEnrolment,
  LoginResponse,
  MfaChallenge,
  MfaRecoveryResponse,
  MfaStage,
  RecoveryCodesResponse,
  SessionView,
  SignedInResponse,
  WorkspaceContext,
} from '../api/models';

const TOKEN_KEY = 'mobi.gp.session';
const CHALLENGE_KEY = 'mobi.gp.mfaChallenge';
const REMEMBERED_ID_KEY = 'mobi.gp.rememberedLoginId';
const STATUS_POLL_MS = 30_000;
const ACTIVITY_TOUCH_MS = 60_000;

export type SignedOutReason =
  | 'signed-out'
  | 'session-expired'
  | 'account-suspended'
  | 'account-inactive'
  | 'user-disabled'
  | 'signin-required'
  | 'mfa-required'
  | 'mfa-blocked'
  | 'mfa-reset'
  | 'wrong-portal';

const REASON_BY_CODE: Partial<Record<ApiErrorCode, SignedOutReason>> = {
  SESSION_EXPIRED: 'session-expired',
  UNAUTHENTICATED: 'session-expired',
  ACCOUNT_SUSPENDED: 'account-suspended',
  ACCOUNT_INACTIVE: 'account-inactive',
  USER_DISABLED: 'user-disabled',
  MFA_REQUIRED: 'mfa-required',
  MFA_BLOCKED: 'mfa-blocked',
  MFA_RESET: 'mfa-reset',
};

/** The sign-in in progress between the password step and the second factor. */
export interface PendingSignIn extends MfaChallenge {
  /** Recovery codes from setup, kept in memory only until acknowledged. */
  recoveryCodes?: string[];
  /** True once a recovery code was used and a new authenticator must be registered. */
  usedRecoveryCode?: boolean;
  expiresAt: number;
}

function safeStorage<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly app = inject(APP_PORTAL);

  private readonly sessionState = signal<SessionView | null>(null);
  private restored: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastTouch = 0;

  readonly session = this.sessionState.asReadonly();
  readonly isAuthenticated = computed(() => this.sessionState() !== null);

  get token(): string | null {
    return safeStorage(() => sessionStorage.getItem(TOKEN_KEY), null);
  }

  get rememberedLoginId(): string {
    return safeStorage(() => localStorage.getItem(REMEMBERED_ID_KEY) ?? '', '');
  }

  private readonly pendingState = signal<PendingSignIn | null>(this.readPending());
  /** Password verified, second factor not yet. Never grants access on its own. */
  readonly pending = this.pendingState.asReadonly();

  /**
   * Step 1: checks the password. Returns the 2FA step the user must complete next.
   * "Remember this device" only remembers the Global Account ID; it never skips 2FA.
   */
  async login(loginId: string, password: string, rememberDevice: boolean): Promise<PendingSignIn> {
    const res = await firstValueFrom(this.http.post<LoginResponse>('/api/auth/login', { loginId, password, portal: this.app.portal }));
    safeStorage(() => (rememberDevice ? localStorage.setItem(REMEMBERED_ID_KEY, loginId) : localStorage.removeItem(REMEMBERED_ID_KEY)), undefined);
    const pending: PendingSignIn = { ...res, expiresAt: Date.now() + res.expiresInSec * 1000 };
    this.setPending(pending);
    return pending;
  }

  startSetup() {
    return firstValueFrom(this.http.post<AuthenticatorEnrolment>('/api/auth/mfa/setup', { challengeToken: this.challengeToken() }));
  }

  async confirmSetup(code: string) {
    const res = await firstValueFrom(this.http.post<RecoveryCodesResponse>('/api/auth/mfa/setup/verify', { challengeToken: this.challengeToken(), code }));
    this.updatePending({ stage: 'acknowledge', recoveryCodes: res.recoveryCodes });
    return res.recoveryCodes;
  }

  async completeSetup() {
    const res = await firstValueFrom(this.http.post<SignedInResponse>('/api/auth/mfa/setup/complete', { challengeToken: this.challengeToken(), acknowledged: true }));
    return this.signedIn(res);
  }

  async verifyCode(code: string) {
    const res = await firstValueFrom(this.http.post<SignedInResponse>('/api/auth/mfa/verify', { challengeToken: this.challengeToken(), code }));
    return this.signedIn(res);
  }

  async useRecoveryCode(code: string) {
    const res = await firstValueFrom(this.http.post<MfaRecoveryResponse>('/api/auth/mfa/recovery', { challengeToken: this.challengeToken(), code }));
    // A recovery code means the device is likely lost: a new authenticator is required before access.
    this.updatePending({ stage: 'rebind', usedRecoveryCode: true, expiresAt: Date.now() + (this.pendingState()?.expiresInSec ?? 300) * 1000 });
    return res;
  }

  /** Abandons the 2FA step (sign out before access was granted). */
  cancelPending() {
    this.setPending(null);
  }

  private challengeToken() {
    return this.pendingState()?.challengeToken ?? '';
  }

  private signedIn(res: SignedInResponse): SessionView {
    this.setPending(null);
    safeStorage(() => sessionStorage.setItem(TOKEN_KEY, res.token), undefined);
    this.sessionState.set(res.session);
    this.restored = Promise.resolve();
    this.startMonitoring();
    return res.session;
  }

  private updatePending(patch: Partial<PendingSignIn> & { stage?: MfaStage }) {
    const cur = this.pendingState();
    if (cur) this.setPending({ ...cur, ...patch });
  }

  private setPending(p: PendingSignIn | null) {
    this.pendingState.set(p);
    // Recovery codes are never persisted; everything else survives a page refresh in this tab.
    safeStorage(() => (p ? sessionStorage.setItem(CHALLENGE_KEY, JSON.stringify({ ...p, recoveryCodes: undefined })) : sessionStorage.removeItem(CHALLENGE_KEY)), undefined);
  }

  private readPending(): PendingSignIn | null {
    const p = safeStorage(() => JSON.parse(sessionStorage.getItem(CHALLENGE_KEY) ?? 'null') as PendingSignIn | null, null);
    return p && p.expiresAt > Date.now() ? p : null;
  }

  /** Restores the session for the stored token once per page load. */
  restore(): Promise<void> {
    this.restored ??= (async () => {
      if (!this.token) return;
      try {
        this.sessionState.set(await firstValueFrom(this.http.get<SessionView>('/api/auth/session')));
        this.startMonitoring();
      } catch {
        this.clearLocal();
      }
    })();
    return this.restored;
  }

  async logout() {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } catch {
      // The local session is cleared regardless; the server session expires on its own.
    }
    this.endSession('signed-out');
  }

  workspaceContext(country: string | null) {
    const query = country ? `?country=${encodeURIComponent(country)}` : '';
    return firstValueFrom(this.http.get<WorkspaceContext>(`/api/workspace/context${query}`));
  }

  /** Re-reads the session (e.g. after a country is activated) without extending it. */
  refresh() {
    return this.checkStatus(false);
  }

  /** Ends a session that belongs to the other portal (e.g. restored from an older build). */
  signOutWrongPortal() {
    void firstValueFrom(this.http.post('/api/auth/logout', {})).catch(() => undefined);
    this.endSession('wrong-portal');
  }

  /** Called by the HTTP interceptor when a protected request is rejected as unauthenticated. */
  handleUnauthenticated(code: ApiErrorCode) {
    if (!this.sessionState() && !this.token) return;
    this.endSession(REASON_BY_CODE[code] ?? 'session-expired');
  }

  private endSession(reason: SignedOutReason) {
    this.clearLocal();
    this.router.navigate(['/login'], { queryParams: { reason } });
  }

  private clearLocal() {
    this.stopMonitoring();
    safeStorage(() => sessionStorage.removeItem(TOKEN_KEY), undefined);
    this.sessionState.set(null);
    this.restored = Promise.resolve();
  }

  // Polls without extending the session so suspension or expiry is picked up promptly,
  // and reports user activity (throttled) so active users are not timed out.
  private startMonitoring() {
    this.stopMonitoring();
    this.lastTouch = Date.now();
    this.pollTimer = setInterval(() => this.checkStatus(false), STATUS_POLL_MS);
    for (const evt of ['pointerdown', 'keydown']) window.addEventListener(evt, this.onActivity, { passive: true });
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private stopMonitoring() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const evt of ['pointerdown', 'keydown']) window.removeEventListener(evt, this.onActivity);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private readonly onActivity = () => {
    if (Date.now() - this.lastTouch < ACTIVITY_TOUCH_MS) return;
    this.lastTouch = Date.now();
    this.checkStatus(true);
  };

  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.checkStatus(false);
  };

  private async checkStatus(touch: boolean) {
    try {
      const s = await firstValueFrom(this.http.get<SessionView>(`/api/auth/session${touch ? '' : '?touch=false'}`));
      this.sessionState.set(s);
    } catch {
      // 401s are handled by the interceptor; transient network errors are ignored until the next poll.
    }
  }
}
