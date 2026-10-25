import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiErrorCode, LoginResponse, SessionView, WorkspaceContext } from '../api/models';

const TOKEN_KEY = 'mobi.gp.session';
const REMEMBERED_ID_KEY = 'mobi.gp.rememberedLoginId';
const STATUS_POLL_MS = 30_000;
const ACTIVITY_TOUCH_MS = 60_000;

export type SignedOutReason = 'signed-out' | 'session-expired' | 'account-suspended' | 'account-inactive' | 'user-disabled' | 'signin-required';

const REASON_BY_CODE: Partial<Record<ApiErrorCode, SignedOutReason>> = {
  SESSION_EXPIRED: 'session-expired',
  UNAUTHENTICATED: 'session-expired',
  ACCOUNT_SUSPENDED: 'account-suspended',
  ACCOUNT_INACTIVE: 'account-inactive',
  USER_DISABLED: 'user-disabled',
};

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

  async login(loginId: string, password: string, rememberDevice: boolean): Promise<SessionView> {
    const res = await firstValueFrom(this.http.post<LoginResponse>('/api/auth/login', { loginId, password }));
    safeStorage(() => sessionStorage.setItem(TOKEN_KEY, res.token), undefined);
    safeStorage(() => (rememberDevice ? localStorage.setItem(REMEMBERED_ID_KEY, loginId) : localStorage.removeItem(REMEMBERED_ID_KEY)), undefined);
    this.sessionState.set(res.session);
    this.restored = Promise.resolve();
    this.startMonitoring();
    return res.session;
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
