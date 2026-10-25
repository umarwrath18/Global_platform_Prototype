import {
  AccountStatus,
  ApiErrorBody,
  ApiErrorCode,
  CountryAccess,
  LoginResponse,
  OtpRequestResponse,
  OtpVerifyResponse,
  SessionView,
  UserStatus,
  WorkspaceContext,
} from '../api/models';
import { checkPassword } from '../api/password-policy';
import { constantTimeEqual, DEFAULT_PBKDF2_ITERATIONS, hashPassword, randomOtp, randomToken, sha256Hex, verifyPassword } from './crypto';
import { BASE_CURRENCY, COUNTRY_CATALOGUE, DEMO_PASSWORD, ROLES, SEED_ACCOUNTS, SEED_USERS, SeedAccount, SeedUser } from './seed';

// Simulated Mobi authentication backend. It runs in the browser for the prototype,
// but is written as the server would be: every rule is enforced here, never only in the UI.

export const AUTH_POLICY = {
  sessionIdleMs: 30 * 60_000,
  sessionAbsoluteMs: 12 * 60 * 60_000,
  loginFreeAttempts: 5,
  /** Lock duration applied on the 5th, 6th, 7th and later consecutive failure. */
  loginLockMinutes: [1, 5, 15, 30],
  otpTtlMs: 10 * 60_000,
  otpMaxAttempts: 5,
  otpResendCooldownMs: 60_000,
  otpMaxSendsPerHour: 5,
  resetTokenTtlMs: 10 * 60_000,
} as const;

const DB_VERSION = 3;

interface AccountRec extends SeedAccount {}
interface UserRec extends Omit<SeedUser, 'status'> {
  status: UserStatus;
  passwordHash: string;
  passwordChangedAt: number;
}
interface SessionRec {
  tokenHash: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
}
/** Remembers why a session was revoked so the client can explain the sign-out. */
interface RevokedSessionRec {
  tokenHash: string;
  reason: ApiErrorCode;
  at: number;
}
interface OtpRec {
  requestId: string;
  email: string;
  userId: string | null;
  codeHash: string | null;
  expiresAt: number;
  attempts: number;
  status: 'pending' | 'verified' | 'locked';
  lastSentAt: number;
}
interface ResetRec {
  tokenHash: string;
  userId: string;
  expiresAt: number;
  used: boolean;
}
interface ThrottleRec {
  failures: number;
  lockedUntil: number;
}
export interface AuditEvent {
  at: number;
  type: string;
  userId?: string;
  accountId?: string;
  detail?: string;
}
interface Db {
  version: number;
  accounts: AccountRec[];
  users: UserRec[];
  sessions: SessionRec[];
  revokedSessions: RevokedSessionRec[];
  otps: OtpRec[];
  resets: ResetRec[];
  loginThrottle: Record<string, ThrottleRec>;
  otpSends: Record<string, number[]>;
  audit: AuditEvent[];
}

export interface ServerResponse<T = unknown> {
  status: number;
  body: T | ApiErrorBody | null;
}

export interface DemoEmail {
  to: string;
  subject: string;
  code: string;
  expiresInMin: number;
}

export interface AuthServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey?: string;
  now?: () => number;
  pbkdf2Iterations?: number;
  /** Stand-in for the configured email service. */
  sendEmail: (email: DemoEmail) => void;
}

class HttpError {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {}
}

const fail = (status: number, code: ApiErrorCode, extra: Omit<ApiErrorBody, 'code'> = {}): never => {
  throw new HttpError(status, { code, ...extra });
};

const normaliseLoginId = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : '');
const normaliseEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthServer {
  private readonly storageKey: string;
  private readonly now: () => number;
  private readonly iterations: number;
  private seeded: Promise<void> | null = null;
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly opts: AuthServerOptions) {
    this.storageKey = opts.storageKey ?? 'mobi.gp.mockdb';
    this.now = opts.now ?? Date.now;
    this.iterations = opts.pbkdf2Iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  }

  // ---------------------------------------------------------------- routing

  async handle(method: string, path: string, body: any, token: string | null): Promise<ServerResponse> {
    await this.ensureSeeded();
    try {
      const route = `${method.toUpperCase()} ${path.split('?')[0]}`;
      const query = new URLSearchParams(path.split('?')[1] ?? '');
      switch (route) {
        case 'POST /api/auth/login':
          return { status: 200, body: await this.login(body) };
        case 'POST /api/auth/logout':
          return { status: 204, body: await this.logout(token) };
        case 'GET /api/auth/session':
          return { status: 200, body: await this.getSession(token, query.get('touch') !== 'false') };
        case 'GET /api/workspace/context':
          return { status: 200, body: await this.workspaceContext(token, query.get('country')) };
        case 'POST /api/auth/password/otp':
          return { status: 202, body: await this.requestOtp(body) };
        case 'POST /api/auth/password/otp/resend':
          return { status: 202, body: await this.resendOtp(body) };
        case 'POST /api/auth/password/otp/verify':
          return { status: 200, body: await this.verifyOtp(body) };
        case 'POST /api/auth/password/reset':
          return { status: 204, body: await this.resetPassword(body) };
        default:
          return fail(404, 'NOT_FOUND');
      }
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: e.body };
      throw e;
    }
  }

  // ----------------------------------------------------------------- login

  private async login(body: any): Promise<LoginResponse> {
    const loginId = normaliseLoginId(body?.loginId);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!loginId || !password || loginId.length > 64 || password.length > 256) fail(400, 'VALIDATION_FAILED');

    const db = this.load();
    const user = db.users.find((u) => u.loginId.toUpperCase() === loginId);
    if (user?.demo === 'service-outage') fail(503, 'SERVICE_UNAVAILABLE');

    // Throttle is keyed on the submitted ID, whether or not it exists, so lockout
    // behaviour does not reveal which IDs are registered.
    const t = db.loginThrottle[loginId] ?? { failures: 0, lockedUntil: 0 };
    const now = this.now();
    if (t.lockedUntil > now) {
      this.audit(db, 'LOGIN_BLOCKED_LOCKED', { userId: user?.id, accountId: user?.accountId });
      this.save(db);
      fail(429, 'LOGIN_LOCKED', { retryAfterSec: Math.ceil((t.lockedUntil - now) / 1000) });
    }

    // Always run a hash comparison to keep response timing similar for unknown IDs.
    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : (await verifyPassword(password, await this.getDummyHash()), false);

    if (!ok) {
      t.failures += 1;
      const overLimit = t.failures - AUTH_POLICY.loginFreeAttempts;
      if (overLimit >= 0) {
        const mins = AUTH_POLICY.loginLockMinutes[Math.min(overLimit, AUTH_POLICY.loginLockMinutes.length - 1)];
        t.lockedUntil = now + mins * 60_000;
      }
      db.loginThrottle[loginId] = t;
      this.audit(db, 'LOGIN_FAILED', { userId: user?.id, accountId: user?.accountId, detail: user ? 'bad_password' : 'unknown_id' });
      this.save(db);
      if (t.lockedUntil > now) fail(429, 'LOGIN_LOCKED', { retryAfterSec: Math.ceil((t.lockedUntil - now) / 1000) });
      const remaining = AUTH_POLICY.loginFreeAttempts - t.failures;
      fail(401, 'INVALID_CREDENTIALS', remaining <= 2 ? { attemptsRemaining: remaining } : {});
    }

    // Credentials are valid from here on, so account status can be disclosed safely.
    delete db.loginThrottle[loginId];
    const u = user!;
    const account = db.accounts.find((a) => a.id === u.accountId)!;
    const denial = this.statusDenial(account.status, u.status);
    if (denial) {
      this.audit(db, 'LOGIN_DENIED', { userId: u.id, accountId: account.id, detail: denial });
      this.save(db);
      fail(403, denial);
    }

    const token = randomToken();
    db.sessions.push({
      tokenHash: await sha256Hex(token),
      userId: u.id,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + AUTH_POLICY.sessionAbsoluteMs,
    });
    this.audit(db, 'LOGIN_SUCCESS', { userId: u.id, accountId: account.id });
    this.save(db);
    return { token, session: this.sessionView(db, u, db.sessions[db.sessions.length - 1]) };
  }

  private statusDenial(account: AccountStatus, user: UserStatus): ApiErrorCode | null {
    if (account === 'suspended') return 'ACCOUNT_SUSPENDED';
    if (account === 'inactive') return 'ACCOUNT_INACTIVE';
    if (user === 'disabled') return 'USER_DISABLED';
    return null;
  }

  private async logout(token: string | null): Promise<null> {
    const db = this.load();
    if (token) {
      const hash = await sha256Hex(token);
      const s = db.sessions.find((x) => x.tokenHash === hash);
      if (s) {
        db.sessions = db.sessions.filter((x) => x !== s);
        this.audit(db, 'LOGOUT', { userId: s.userId });
        this.save(db);
      }
    }
    return null;
  }

  // --------------------------------------------------------------- sessions

  /** Validates the bearer token on every protected request. */
  private async requireSession(db: Db, token: string | null, touch: boolean) {
    if (!token) fail(401, 'UNAUTHENTICATED');
    const hash = await sha256Hex(token!);
    const session = db.sessions.find((s) => s.tokenHash === hash);
    if (!session) fail(401, db.revokedSessions.find((r) => r.tokenHash === hash)?.reason ?? 'UNAUTHENTICATED');
    const s = session!;
    const now = this.now();
    if (now - s.lastSeenAt > AUTH_POLICY.sessionIdleMs || now > s.absoluteExpiresAt) {
      db.sessions = db.sessions.filter((x) => x !== s);
      this.audit(db, 'SESSION_EXPIRED', { userId: s.userId });
      this.save(db);
      fail(401, 'SESSION_EXPIRED');
    }
    const user = db.users.find((u) => u.id === s.userId)!;
    const account = db.accounts.find((a) => a.id === user.accountId)!;
    // Defence in depth: status is re-checked even though suspension already revokes sessions.
    const denial = this.statusDenial(account.status, user.status);
    if (denial) {
      db.sessions = db.sessions.filter((x) => x !== s);
      this.save(db);
      fail(401, denial);
    }
    if (touch) {
      s.lastSeenAt = now;
      this.save(db);
    }
    return { session: s, user, account };
  }

  private async getSession(token: string | null, touch: boolean): Promise<SessionView> {
    const db = this.load();
    const { session, user } = await this.requireSession(db, token, touch);
    return this.sessionView(db, user, session);
  }

  private sessionView(db: Db, user: UserRec, session: SessionRec): SessionView {
    const account = db.accounts.find((a) => a.id === user.accountId)!;
    const role = ROLES[user.roleId];
    return {
      user: { id: user.id, loginId: user.loginId, name: user.name, email: user.email },
      account: { id: account.id, name: account.name },
      role: { id: user.roleId, name: role.name },
      permissions: role.permissions,
      countries: this.countriesFor(account),
      baseCurrency: BASE_CURRENCY,
      landingPath: '/dashboard',
      idleExpiresAt: session.lastSeenAt + AUTH_POLICY.sessionIdleMs,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  private countriesFor(account: AccountRec): CountryAccess[] {
    return account.countries.map((c) => ({ ...COUNTRY_CATALOGUE[c.code], status: c.status }));
  }

  private async workspaceContext(token: string | null, countryCode: string | null): Promise<WorkspaceContext> {
    const db = this.load();
    const { user, account } = await this.requireSession(db, token, true);
    if (!countryCode) return { scope: 'global', country: null, currency: BASE_CURRENCY };

    const country = this.countriesFor(account).find((c) => c.code === countryCode.toUpperCase());
    if (!country) {
      this.audit(db, 'ACCESS_DENIED_COUNTRY', { userId: user.id, accountId: account.id, detail: countryCode });
      this.save(db);
      fail(403, 'COUNTRY_NOT_AUTHORISED');
    }
    if (country!.status !== 'active') {
      this.audit(db, 'ACCESS_DENIED_COUNTRY', { userId: user.id, accountId: account.id, detail: `${country!.code}:${country!.status}` });
      this.save(db);
      fail(403, 'COUNTRY_NOT_ACTIVE', { countryStatus: country!.status });
    }
    return { scope: 'country', country: country!, currency: country!.currency };
  }

  // -------------------------------------------------------- password recovery

  private async requestOtp(body: any): Promise<OtpRequestResponse> {
    const email = normaliseEmail(body?.email);
    if (!EMAIL_RE.test(email) || email.length > 254) fail(400, 'VALIDATION_FAILED');

    const db = this.load();
    const now = this.now();
    const existing = db.otps.find((o) => o.email === email && o.status === 'pending' && o.expiresAt > now);
    if (existing && now - existing.lastSentAt < AUTH_POLICY.otpResendCooldownMs) {
      fail(429, 'OTP_COOLDOWN', { retryAfterSec: Math.ceil((existing.lastSentAt + AUTH_POLICY.otpResendCooldownMs - now) / 1000) });
    }
    this.checkSendLimit(db, email);

    // Supersede any earlier request for this email.
    db.otps = db.otps.filter((o) => o.email !== email);
    const user = db.users.find((u) => u.email.toLowerCase() === email) ?? null;
    const rec: OtpRec = {
      requestId: randomToken(16),
      email,
      userId: null,
      codeHash: null,
      expiresAt: now + AUTH_POLICY.otpTtlMs,
      attempts: 0,
      status: 'pending',
      lastSentAt: now,
    };
    db.otps.push(rec);
    await this.issueCode(db, rec, user);
    return { requestId: rec.requestId, expiresInSec: AUTH_POLICY.otpTtlMs / 1000, resendAvailableInSec: AUTH_POLICY.otpResendCooldownMs / 1000 };
  }

  private async resendOtp(body: any): Promise<OtpRequestResponse> {
    const db = this.load();
    const rec = db.otps.find((o) => o.requestId === body?.requestId);
    if (!rec) fail(410, 'OTP_EXPIRED');
    const r = rec!;
    if (r.status === 'verified') fail(409, 'OTP_USED');
    const now = this.now();
    if (now - r.lastSentAt < AUTH_POLICY.otpResendCooldownMs) {
      fail(429, 'OTP_COOLDOWN', { retryAfterSec: Math.ceil((r.lastSentAt + AUTH_POLICY.otpResendCooldownMs - now) / 1000) });
    }
    this.checkSendLimit(db, r.email);
    r.status = 'pending';
    r.attempts = 0;
    r.expiresAt = now + AUTH_POLICY.otpTtlMs;
    r.lastSentAt = now;
    const user = r.userId ? db.users.find((u) => u.id === r.userId)! : db.users.find((u) => u.email.toLowerCase() === r.email) ?? null;
    await this.issueCode(db, r, user);
    return { requestId: r.requestId, expiresInSec: AUTH_POLICY.otpTtlMs / 1000, resendAvailableInSec: AUTH_POLICY.otpResendCooldownMs / 1000 };
  }

  private checkSendLimit(db: Db, email: string) {
    const now = this.now();
    const recent = (db.otpSends[email] ?? []).filter((t) => now - t < 60 * 60_000);
    if (recent.length >= AUTH_POLICY.otpMaxSendsPerHour) {
      fail(429, 'OTP_SEND_LIMIT', { retryAfterSec: Math.ceil((recent[0] + 60 * 60_000 - now) / 1000) });
    }
    db.otpSends[email] = [...recent, now];
  }

  /** Generates and "emails" a fresh code. Unknown or blocked users get no code, but an identical response. */
  private async issueCode(db: Db, rec: OtpRec, user: UserRec | null) {
    const account = user ? db.accounts.find((a) => a.id === user.accountId)! : null;
    const eligible = user && account && !this.statusDenial(account.status, user.status);
    if (!eligible) {
      rec.userId = null;
      rec.codeHash = null;
      this.audit(db, 'OTP_REQUEST_NOT_SENT', { userId: user?.id, accountId: account?.id, detail: user ? 'not_eligible' : 'unknown_email' });
      this.save(db);
      return;
    }
    if (user!.demo === 'otp-delivery-failure') {
      this.audit(db, 'OTP_DELIVERY_FAILED', { userId: user!.id, accountId: account!.id });
      db.otps = db.otps.filter((o) => o !== rec);
      this.save(db);
      fail(502, 'OTP_DELIVERY_FAILED');
    }
    const code = randomOtp();
    rec.userId = user!.id;
    rec.codeHash = await sha256Hex(`${rec.requestId}:${code}`);
    this.audit(db, 'OTP_SENT', { userId: user!.id, accountId: account!.id });
    this.save(db);
    this.opts.sendEmail({ to: user!.email, subject: 'Your Mobi password reset code', code, expiresInMin: AUTH_POLICY.otpTtlMs / 60_000 });
  }

  private async verifyOtp(body: any): Promise<OtpVerifyResponse> {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) fail(400, 'VALIDATION_FAILED');
    const db = this.load();
    const rec = db.otps.find((o) => o.requestId === body?.requestId);
    if (!rec) fail(410, 'OTP_EXPIRED');
    const r = rec!;
    const now = this.now();
    if (r.status === 'verified') fail(409, 'OTP_USED');
    if (r.status === 'locked') fail(429, 'OTP_ATTEMPTS_EXCEEDED');
    if (now > r.expiresAt) fail(410, 'OTP_EXPIRED');

    const matches = r.codeHash !== null && constantTimeEqual(await sha256Hex(`${r.requestId}:${code}`), r.codeHash);
    if (!matches) {
      r.attempts += 1;
      this.audit(db, 'OTP_VERIFY_FAILED', { userId: r.userId ?? undefined });
      if (r.attempts >= AUTH_POLICY.otpMaxAttempts) {
        r.status = 'locked';
        this.save(db);
        fail(429, 'OTP_ATTEMPTS_EXCEEDED');
      }
      this.save(db);
      fail(400, 'OTP_INVALID', { attemptsRemaining: AUTH_POLICY.otpMaxAttempts - r.attempts });
    }

    r.status = 'verified';
    const resetToken = randomToken();
    db.resets = db.resets.filter((x) => x.userId !== r.userId);
    db.resets.push({ tokenHash: await sha256Hex(resetToken), userId: r.userId!, expiresAt: now + AUTH_POLICY.resetTokenTtlMs, used: false });
    this.audit(db, 'OTP_VERIFIED', { userId: r.userId! });
    this.save(db);
    return { resetToken };
  }

  private async resetPassword(body: any): Promise<null> {
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
    const confirm = typeof body?.confirmPassword === 'string' ? body.confirmPassword : '';
    const db = this.load();
    const hash = typeof body?.resetToken === 'string' ? await sha256Hex(body.resetToken) : '';
    const rec = db.resets.find((r) => r.tokenHash === hash);
    const now = this.now();
    if (!rec || rec.used || now > rec.expiresAt) fail(410, 'RESET_TOKEN_INVALID');
    const user = db.users.find((u) => u.id === rec!.userId)!;
    const account = db.accounts.find((a) => a.id === user.accountId)!;
    if (this.statusDenial(account.status, user.status)) fail(403, 'RESET_NOT_ALLOWED');
    if (newPassword !== confirm) fail(400, 'VALIDATION_FAILED');
    const violations = checkPassword(newPassword, { loginId: user.loginId, email: user.email });
    if (violations.length) fail(422, 'PASSWORD_POLICY', { violations });

    user.passwordHash = await hashPassword(newPassword, this.iterations);
    user.passwordChangedAt = now;
    rec!.used = true;
    const revoked = db.sessions.filter((s) => s.userId === user.id).length;
    db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    delete db.loginThrottle[user.loginId.toUpperCase()];
    this.audit(db, 'PASSWORD_RESET', { userId: user.id, accountId: account.id, detail: `sessions_revoked=${revoked}` });
    this.save(db);
    return null;
  }

  // ----------------------------------------- bridge for other simulated services

  /** Validates a bearer token with the same session rules as the auth APIs (used by the merchant service). */
  async authenticate(token: string | null): Promise<{ ok: true; caller: { userId: string; name: string } } | { ok: false; response: ServerResponse }> {
    await this.ensureSeeded();
    const db = this.load();
    try {
      const { user } = await this.requireSession(db, token, true);
      return { ok: true, caller: { userId: user.id, name: user.name } };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, response: { status: e.status, body: e.body } };
      throw e;
    }
  }

  /**
   * Activates a country on a merchant's Global Account after go-live, creating the account
   * (with no users) if the merchant doesn't have one yet. Returns the Global Account ID.
   */
  async activateCountry(accountId: string | null, accountName: string, countryCode: string): Promise<string> {
    await this.ensureSeeded();
    const db = this.load();
    let account = accountId ? db.accounts.find((a) => a.id === accountId) : undefined;
    if (!account) {
      const next = Math.max(5000, ...db.accounts.map((a) => Number(a.id.replace(/\D/g, '')) || 0)) + 1;
      account = { id: `GA-${next}`, name: accountName, status: 'active', countries: [] };
      db.accounts.push(account);
      this.audit(db, 'ACCOUNT_CREATED', { accountId: account.id, detail: 'merchant_go_live' });
    }
    const existing = account.countries.find((c) => c.code === countryCode);
    if (existing) existing.status = 'active';
    else account.countries.push({ code: countryCode, status: 'active' });
    this.audit(db, 'ACCOUNT_COUNTRY_ACTIVATED', { accountId: account.id, detail: countryCode });
    this.save(db);
    return account.id;
  }

  // ------------------------------------------- admin hooks (prototype / QA only)

  async setAccountStatus(accountId: string, status: AccountStatus): Promise<string> {
    await this.ensureSeeded();
    const db = this.load();
    const account = db.accounts.find((a) => a.id === accountId);
    if (!account) return `No Global Account ${accountId}`;
    account.status = status;
    let revoked = 0;
    if (status !== 'active') {
      const userIds = new Set(db.users.filter((u) => u.accountId === accountId).map((u) => u.id));
      revoked = this.revokeSessions(db, (s) => userIds.has(s.userId), status === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_INACTIVE');
    }
    this.audit(db, status === 'suspended' ? 'ACCOUNT_SUSPENDED' : `ACCOUNT_${status.toUpperCase()}`, { accountId, detail: `sessions_revoked=${revoked}` });
    this.save(db);
    return `${accountId} is now ${status}; ${revoked} session(s) revoked`;
  }

  async setUserStatus(loginId: string, status: UserStatus): Promise<string> {
    await this.ensureSeeded();
    const db = this.load();
    const user = db.users.find((u) => u.loginId.toUpperCase() === normaliseLoginId(loginId));
    if (!user) return `No user ${loginId}`;
    user.status = status;
    const revoked = status === 'disabled' ? this.revokeSessions(db, (s) => s.userId === user.id, 'USER_DISABLED') : 0;
    this.audit(db, status === 'disabled' ? 'USER_DISABLED' : 'USER_REACTIVATED', { userId: user.id, accountId: user.accountId });
    this.save(db);
    return `${user.loginId} is now ${status}; ${revoked} session(s) revoked`;
  }

  private revokeSessions(db: Db, match: (s: SessionRec) => boolean, reason: ApiErrorCode): number {
    const now = this.now();
    const revoked = db.sessions.filter(match);
    db.sessions = db.sessions.filter((s) => !match(s));
    db.revokedSessions = [
      ...db.revokedSessions.filter((r) => now - r.at < AUTH_POLICY.sessionAbsoluteMs),
      ...revoked.map((s) => ({ tokenHash: s.tokenHash, reason, at: now })),
    ];
    return revoked.length;
  }

  async expireSessions(): Promise<string> {
    await this.ensureSeeded();
    const db = this.load();
    db.sessions.forEach((s) => (s.lastSeenAt = this.now() - AUTH_POLICY.sessionIdleMs - 1));
    this.save(db);
    return `${db.sessions.length} session(s) marked idle-expired`;
  }

  async auditLog(): Promise<AuditEvent[]> {
    await this.ensureSeeded();
    return this.load().audit;
  }

  async resetAll(): Promise<void> {
    this.opts.storage.removeItem(this.storageKey);
    this.seeded = null;
    await this.ensureSeeded();
  }

  // ---------------------------------------------------------------- storage

  private ensureSeeded(): Promise<void> {
    if (!this.seeded) {
      this.seeded = (async () => {
        const raw = this.opts.storage.getItem(this.storageKey);
        if (raw && JSON.parse(raw).version === DB_VERSION) return;
        const users: UserRec[] = [];
        for (const u of SEED_USERS) {
          users.push({ ...u, passwordHash: await hashPassword(DEMO_PASSWORD, this.iterations), passwordChangedAt: this.now() });
        }
        this.save({
          version: DB_VERSION,
          accounts: structuredClone(SEED_ACCOUNTS),
          users,
          sessions: [],
          revokedSessions: [],
          otps: [],
          resets: [],
          loginThrottle: {},
          otpSends: {},
          audit: [],
        });
      })();
    }
    return this.seeded;
  }

  private getDummyHash(): Promise<string> {
    return (this.dummyHash ??= hashPassword(randomToken(), this.iterations));
  }

  // Re-read on every request so changes made in another tab (e.g. a suspension) apply immediately.
  private load(): Db {
    return JSON.parse(this.opts.storage.getItem(this.storageKey)!);
  }

  private save(db: Db) {
    db.audit = db.audit.slice(-500);
    this.opts.storage.setItem(this.storageKey, JSON.stringify(db));
  }

  private audit(db: Db, type: string, e: Omit<AuditEvent, 'at' | 'type'> = {}) {
    db.audit.push({ at: this.now(), type, ...e });
  }
}
