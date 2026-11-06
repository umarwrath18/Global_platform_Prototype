import {
  AccountSecurityView,
  AccountStatus,
  ApiErrorBody,
  ApiErrorCode,
  AuthenticatorEnrolment,
  CountryAccess,
  LoginResponse,
  MfaStage,
  OtpRequestResponse,
  OtpVerifyResponse,
  ReplaceAuthenticatorStart,
  SecurityAuditView,
  SecurityOverview,
  SecurityRole,
  SessionView,
  SignedInResponse,
  StepUpResponse,
  UserStatus,
  WorkspaceContext,
} from '../api/models';
import { checkPassword } from '../api/password-policy';
import { constantTimeEqual, DEFAULT_PBKDF2_ITERATIONS, hashPassword, randomOtp, randomToken, sha256Hex, verifyPassword } from './crypto';
import { BASE_CURRENCY, COUNTRY_CATALOGUE, DEMO_PASSWORD, ROLES, SEED_ACCOUNTS, SEED_USERS, SeedAccount, SeedUser } from './seed';
import { generateTotpSecret, otpauthUri, SecretVault, secondsLeftInStep, TOTP, totpAt, verifyTotp } from './totp';

/** FR-08 events shown in the security audit log. */
const SECURITY_EVENT_TYPES = new Set([
  'MFA_ROLLOUT_SESSIONS_REVOKED',
  'MFA_REGISTRATION_STARTED',
  'MFA_REGISTRATION_COMPLETED',
  'MFA_SETUP_CODE_FAILED',
  'MFA_VERIFIED',
  'MFA_CODE_FAILED',
  'MFA_CODE_REUSED',
  'MFA_BLOCKED',
  'TECH_ALERT_RAISED',
  'MFA_BLOCK_WAIVED',
  'LOGIN_BLOCKED_MFA',
  'AUTHENTICATOR_REPLACEMENT_STARTED',
  'AUTHENTICATOR_REPLACED',
  'ADMIN_STEP_UP_VERIFIED',
  'MFA_RESET_REQUESTED',
  'IDENTITY_VERIFIED',
  'MFA_RESET',
  'NOTIFICATION_SENT',
]);

const SECURITY_ROLE_LABEL: Record<SecurityRole, string> = { support: 'Mobi Support', security: 'Security Admin' };

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

/** Two-factor authentication rules (PRD: Merchant Portal MFA, Phase 1). */
export const MFA_POLICY = {
  /** FR-03: block after MORE than this many consecutive failed codes, until Security Admin waives it. */
  maxConsecutiveFailures: 3,
  /** How long the password-verified, second-factor-pending step stays valid. */
  challengeTtlMs: 5 * 60_000,
  /** Wrong codes allowed while confirming a NEW authenticator (setup / replacement) before starting again. */
  setupMaxAttempts: 5,
  /** How long an admin's "confirm it's you" check, or a started replacement, stays valid. */
  stepUpTtlMs: 5 * 60_000,
} as const;

const DB_VERSION = 8;

interface AccountRec extends SeedAccount {
  /** GMID that created this account at go-live. Only on accounts created after this field existed. */
  merchantId?: string;
}
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
/**
 * A user's second factor. The secret is only ever stored encrypted. There are no recovery codes:
 * a user who loses their authenticator contacts Mobi Support for an admin-assisted reset (FR-04/FR-05).
 */
interface MfaRec {
  status: 'not_enrolled' | 'active';
  secretEnc: string | null;
  enrolledAt: number | null;
  lastUsedAt: number | null;
  /** Last accepted TOTP time step, so each code works only once. */
  lastStep: number;
  /** Consecutive failed second-factor checks. */
  failures: number;
  blockedAt: number | null;
}
/** Password verified, second factor pending. No session exists yet. */
interface ChallengeRec {
  tokenHash: string;
  userId: string;
  stage: MfaStage;
  expiresAt: number;
  /** New authenticator being registered during setup, encrypted. */
  pendingSecretEnc: string | null;
  setupAttempts: number;
}
/** A fresh second-factor check made while signed in: admin actions, or a started authenticator replacement. */
interface StepUpRec {
  tokenHash: string;
  userId: string;
  purpose: 'admin' | 'replace';
  expiresAt: number;
  pendingSecretEnc: string | null;
  attempts: number;
}
interface ResetRequestRec {
  id: string;
  userId: string;
  status: 'open' | 'completed';
  reason: string;
  reference: string;
  requestedBy: string;
  requestedAt: number;
  completedBy: string | null;
  completedAt: number | null;
  verificationMethod: string | null;
}
interface AlertRec {
  id: string;
  at: number;
  userId: string;
  accountId: string;
  failedAttempts: number;
  status: 'open' | 'resolved';
  resolvedBy: string | null;
  resolvedAt: number | null;
  resolution: string | null;
}
export interface AuditEvent {
  at: number;
  type: string;
  userId?: string;
  accountId?: string;
  detail?: string;
  /** Who performed an administrative action (name and acting role). */
  actor?: string;
  reason?: string;
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
  mfa: Record<string, MfaRec>;
  challenges: ChallengeRec[];
  stepUps: StepUpRec[];
  resetRequests: ResetRequestRec[];
  alerts: AlertRec[];
}

export interface ServerResponse<T = unknown> {
  status: number;
  body: T | ApiErrorBody | null;
}

export interface DemoEmail {
  to: string;
  subject: string;
  /** One-time code emails (password recovery). */
  code?: string;
  expiresInMin?: number;
  /** Security notification emails (authenticator replaced, 2FA reset). */
  body?: string;
}

export interface AuthServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey?: string;
  now?: () => number;
  pbkdf2Iterations?: number;
  /** Stand-in for the configured email service. */
  sendEmail: (email: DemoEmail) => void;
  /** Looks up a merchant's legal name for merchant users' sessions. */
  merchantName?: (merchantId: string) => string | null;
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

const emptyMfa = (): MfaRec => ({
  status: 'not_enrolled',
  secretEnc: null,
  enrolledAt: null,
  lastUsedAt: null,
  lastStep: -1,
  failures: 0,
  blockedAt: null,
});

const normaliseLoginId = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : '');
const normaliseEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthServer {
  private readonly storageKey: string;
  private readonly now: () => number;
  private readonly iterations: number;
  private seeded: Promise<void> | null = null;
  private dummyHash: Promise<string> | null = null;
  /** Encrypts authenticator secrets at rest; only this service can decrypt them. */
  private readonly vault: SecretVault;

  constructor(private readonly opts: AuthServerOptions) {
    this.storageKey = opts.storageKey ?? 'mobi.gp.mockdb';
    this.now = opts.now ?? Date.now;
    this.iterations = opts.pbkdf2Iterations ?? DEFAULT_PBKDF2_ITERATIONS;
    this.vault = new SecretVault(opts.storage, `${this.storageKey}.kms`);
  }

  // ---------------------------------------------------------------- routing

  async handle(method: string, path: string, body: any, token: string | null, roleHeader: string | null = null): Promise<ServerResponse> {
    await this.ensureSeeded();
    try {
      const route = `${method.toUpperCase()} ${path.split('?')[0]}`;
      const query = new URLSearchParams(path.split('?')[1] ?? '');
      const userAction = /^POST \/api\/security\/users\/([^/]+)\/(reset|waive)$/.exec(route);
      if (userAction) {
        const userId = decodeURIComponent(userAction[1]);
        return userAction[2] === 'reset'
          ? { status: 204, body: await this.adminReset(token, roleHeader, userId, body) }
          : { status: 204, body: await this.adminWaive(token, roleHeader, userId, body) };
      }
      switch (route) {
        case 'POST /api/auth/login':
          return { status: 200, body: await this.login(body) };
        case 'POST /api/auth/mfa/setup':
          return { status: 200, body: await this.setupStart(body) };
        case 'POST /api/auth/mfa/setup/verify':
          return { status: 200, body: await this.setupVerify(body) };
        case 'POST /api/auth/mfa/verify':
          return { status: 200, body: await this.verifyLoginCode(body) };
        case 'GET /api/account/security':
          return { status: 200, body: await this.accountSecurity(token) };
        case 'POST /api/account/security/authenticator/replace':
          return { status: 200, body: await this.replaceStart(token, body) };
        case 'POST /api/account/security/authenticator/replace/confirm':
          return { status: 204, body: await this.replaceConfirm(token, body) };
        case 'GET /api/security/overview':
          return { status: 200, body: await this.securityOverview(token, roleHeader) };
        case 'GET /api/security/audit':
          return { status: 200, body: await this.securityAudit(token, roleHeader) };
        case 'POST /api/security/step-up':
          return { status: 200, body: await this.adminStepUp(token, roleHeader, body) };
        case 'POST /api/security/reset-requests':
          return { status: 201, body: await this.createResetRequest(token, roleHeader, body) };
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

    // Each app (Global Platform, Merchant Portal) only signs in its own kind of user.
    const userPortal = u.portal === 'merchant' ? 'merchant' : 'internal';
    if ((body?.portal === 'internal' || body?.portal === 'merchant') && body.portal !== userPortal) {
      this.audit(db, 'LOGIN_WRONG_PORTAL', { userId: u.id, accountId: account.id, detail: `${userPortal}_user_at_${body.portal}_portal` });
      this.save(db);
      fail(403, 'WRONG_PORTAL');
    }

    // FR-01/FR-03: a correct password never creates a session on its own.
    const mfa = db.mfa[u.id];
    if (mfa.blockedAt) {
      this.audit(db, 'LOGIN_BLOCKED_MFA', { userId: u.id, accountId: account.id });
      this.save(db);
      fail(423, 'MFA_BLOCKED');
    }
    this.audit(db, 'LOGIN_PASSWORD_VERIFIED', { userId: u.id, accountId: account.id });
    return this.createChallenge(db, u, mfa.status === 'active' ? 'verify' : 'setup');
  }

  // ------------------------------------------------- second factor at sign-in

  private async createChallenge(db: Db, user: UserRec, stage: MfaStage): Promise<LoginResponse> {
    const token = randomToken();
    db.challenges = db.challenges.filter((c) => c.userId !== user.id && c.expiresAt > this.now());
    db.challenges.push({ tokenHash: await sha256Hex(token), userId: user.id, stage, expiresAt: this.now() + MFA_POLICY.challengeTtlMs, pendingSecretEnc: null, setupAttempts: 0 });
    this.save(db);
    return { challengeToken: token, stage, expiresInSec: MFA_POLICY.challengeTtlMs / 1000, user: { name: user.name, loginId: user.loginId } };
  }

  private async requireChallenge(db: Db, token: unknown, stages: MfaStage[]) {
    const hash = typeof token === 'string' && token ? await sha256Hex(token) : '';
    const rec = db.challenges.find((c) => c.tokenHash === hash);
    if (!rec || rec.expiresAt <= this.now()) {
      if (rec) {
        db.challenges = db.challenges.filter((c) => c !== rec);
        this.save(db);
      }
      fail(410, 'MFA_CHALLENGE_EXPIRED');
    }
    const r = rec!;
    if (!stages.includes(r.stage)) fail(409, 'MFA_STAGE_INVALID');
    const user = db.users.find((u) => u.id === r.userId)!;
    const account = db.accounts.find((a) => a.id === user.accountId)!;
    const denial = this.statusDenial(account.status, user.status);
    if (denial) {
      db.challenges = db.challenges.filter((c) => c !== r);
      this.save(db);
      fail(403, denial);
    }
    const mfa = db.mfa[user.id];
    if (mfa.blockedAt) fail(423, 'MFA_BLOCKED');
    return { rec: r, user, account, mfa };
  }

  /** Starts (or re-shows) first-time registration of an authenticator. */
  private async setupStart(body: any): Promise<AuthenticatorEnrolment> {
    const db = this.load();
    const { rec, user, account } = await this.requireChallenge(db, body?.challengeToken, ['setup']);
    if (!rec.pendingSecretEnc) {
      rec.pendingSecretEnc = await this.vault.encrypt(generateTotpSecret());
      this.audit(db, 'MFA_REGISTRATION_STARTED', { userId: user.id, accountId: account.id });
      this.save(db);
    }
    return this.enrolment(await this.vault.decrypt(rec.pendingSecretEnc), user);
  }

  /**
   * FR-02: 2FA is activated only when a valid code from the new authenticator is verified here.
   * Activation completes sign-in: the session is created now.
   */
  private async setupVerify(body: any): Promise<SignedInResponse> {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) fail(400, 'VALIDATION_FAILED');
    const db = this.load();
    const { rec, user, account, mfa } = await this.requireChallenge(db, body?.challengeToken, ['setup']);
    if (!rec.pendingSecretEnc) fail(409, 'MFA_STAGE_INVALID');
    const secret = await this.vault.decrypt(rec.pendingSecretEnc!);
    const { step } = await verifyTotp(secret, code, this.now(), -1);
    if (step === null) {
      rec.setupAttempts += 1;
      this.audit(db, 'MFA_SETUP_CODE_FAILED', { userId: user.id, accountId: account.id });
      if (rec.setupAttempts >= MFA_POLICY.setupMaxAttempts) {
        db.challenges = db.challenges.filter((c) => c !== rec);
        this.save(db);
        fail(429, 'MFA_SETUP_ATTEMPTS_EXCEEDED');
      }
      this.save(db);
      fail(400, 'MFA_CODE_INVALID', { attemptsRemaining: MFA_POLICY.setupMaxAttempts - rec.setupAttempts });
    }

    mfa.status = 'active';
    mfa.secretEnc = rec.pendingSecretEnc;
    mfa.enrolledAt = this.now();
    mfa.lastUsedAt = this.now();
    mfa.lastStep = step!;
    mfa.failures = 0;
    db.challenges = db.challenges.filter((c) => c !== rec);
    this.audit(db, 'MFA_REGISTRATION_COMPLETED', { userId: user.id, accountId: account.id });
    this.audit(db, 'LOGIN_SUCCESS', { userId: user.id, accountId: account.id, detail: 'after_2fa_setup' });
    return this.createSession(db, user);
  }

  /** FR-03: TOTP check at sign-in. */
  private async verifyLoginCode(body: any): Promise<SignedInResponse> {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) fail(400, 'VALIDATION_FAILED');
    const db = this.load();
    const { rec, user, account } = await this.requireChallenge(db, body?.challengeToken, ['verify']);
    await this.checkCurrentCode(db, user, code, 'sign_in');
    db.challenges = db.challenges.filter((c) => c !== rec);
    this.audit(db, 'LOGIN_SUCCESS', { userId: user.id, accountId: account.id });
    return this.createSession(db, user);
  }

  /**
   * Verifies a code from the user's active authenticator. A wrong code counts towards the
   * block; a code that was already used is refused without counting (it is usually a double submit).
   */
  private async checkCurrentCode(db: Db, user: UserRec, code: string, context: 'sign_in' | 'step_up') {
    const mfa = db.mfa[user.id];
    if (mfa.status !== 'active' || !mfa.secretEnc) fail(409, 'MFA_REQUIRED');
    if (mfa.blockedAt) fail(423, 'MFA_BLOCKED');
    const { step, replay } = await verifyTotp(await this.vault.decrypt(mfa.secretEnc!), code, this.now(), mfa.lastStep);
    if (step === null) {
      if (replay) {
        this.audit(db, 'MFA_CODE_REUSED', { userId: user.id, accountId: user.accountId, detail: context });
        this.save(db);
        fail(400, 'MFA_CODE_REUSED');
      }
      this.registerFailure(db, user, context);
    }
    mfa.lastStep = step!;
    mfa.lastUsedAt = this.now();
    mfa.failures = 0;
    this.audit(db, 'MFA_VERIFIED', { userId: user.id, accountId: user.accountId, detail: context });
  }

  /** Counts a failed second-factor check; on the 4th consecutive failure blocks the user and alerts Tech. */
  private registerFailure(db: Db, user: UserRec, context: string): never {
    const mfa = db.mfa[user.id];
    mfa.failures += 1;
    this.audit(db, 'MFA_CODE_FAILED', { userId: user.id, accountId: user.accountId, detail: `${context}; consecutive=${mfa.failures}` });
    if (mfa.failures > MFA_POLICY.maxConsecutiveFailures) {
      mfa.blockedAt = this.now();
      db.challenges = db.challenges.filter((c) => c.userId !== user.id);
      db.stepUps = db.stepUps.filter((s) => s.userId !== user.id);
      const revoked = this.revokeSessions(db, (s) => s.userId === user.id, 'MFA_BLOCKED');
      const alert: AlertRec = { id: `ALR-${randomToken(4).toUpperCase()}`, at: this.now(), userId: user.id, accountId: user.accountId, failedAttempts: mfa.failures, status: 'open', resolvedBy: null, resolvedAt: null, resolution: null };
      db.alerts.unshift(alert);
      this.audit(db, 'MFA_BLOCKED', { userId: user.id, accountId: user.accountId, detail: `failures=${mfa.failures}; sessions_revoked=${revoked}` });
      this.audit(db, 'TECH_ALERT_RAISED', { userId: user.id, accountId: user.accountId, detail: alert.id });
      this.save(db);
      fail(423, 'MFA_BLOCKED');
    }
    this.save(db);
    return fail(400, 'MFA_CODE_INVALID', { attemptsRemaining: MFA_POLICY.maxConsecutiveFailures + 1 - mfa.failures });
  }

  private async createSession(db: Db, user: UserRec): Promise<SignedInResponse> {
    const token = randomToken();
    const now = this.now();
    const session: SessionRec = { tokenHash: await sha256Hex(token), userId: user.id, createdAt: now, lastSeenAt: now, absoluteExpiresAt: now + AUTH_POLICY.sessionAbsoluteMs };
    db.sessions.push(session);
    this.save(db);
    return { token, session: this.sessionView(db, user, session) };
  }

  private enrolment(secret: string, user: UserRec): AuthenticatorEnrolment {
    return { secret, otpauthUri: otpauthUri(secret, user.loginId), issuer: TOTP.issuer, accountLabel: user.loginId };
  }

  /** Sends a security notification through the (simulated) approved channel: email. */
  private notify(db: Db, user: UserRec, subject: string, body: string) {
    this.audit(db, 'NOTIFICATION_SENT', { userId: user.id, accountId: user.accountId, actor: 'System (email)', detail: subject });
    this.opts.sendEmail({ to: user.email, subject, body });
  }

  // ------------------------------------------------- account security (signed in)

  private async accountSecurity(token: string | null): Promise<AccountSecurityView> {
    const db = this.load();
    const { user } = await this.requireSession(db, token, true);
    const m = db.mfa[user.id];
    return {
      status: m.blockedAt ? 'blocked' : m.status,
      enrolledAt: m.enrolledAt,
      lastUsedAt: m.lastUsedAt,
    };
  }

  /** FR-06 step 1: verify the current authenticator, then show a new one to register. */
  private async replaceStart(token: string | null, body: any): Promise<ReplaceAuthenticatorStart> {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) fail(400, 'VALIDATION_FAILED');
    const db = this.load();
    const { user } = await this.requireSession(db, token, true);
    await this.checkCurrentCode(db, user, code, 'step_up');
    const secret = generateTotpSecret();
    const replaceToken = randomToken();
    db.stepUps = db.stepUps.filter((s) => !(s.userId === user.id && s.purpose === 'replace'));
    db.stepUps.push({ tokenHash: await sha256Hex(replaceToken), userId: user.id, purpose: 'replace', expiresAt: this.now() + MFA_POLICY.stepUpTtlMs, pendingSecretEnc: await this.vault.encrypt(secret), attempts: 0 });
    this.audit(db, 'AUTHENTICATOR_REPLACEMENT_STARTED', { userId: user.id, accountId: user.accountId });
    this.save(db);
    return { replaceToken, ...this.enrolment(secret, user) };
  }

  /** FR-06 step 2: the new authenticator must be verified before it replaces (and revokes) the old one. */
  private async replaceConfirm(token: string | null, body: any): Promise<null> {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) fail(400, 'VALIDATION_FAILED');
    const db = this.load();
    const { user } = await this.requireSession(db, token, true);
    const rec = await this.findStepUp(db, user.id, 'replace', body?.replaceToken);
    const { step } = await verifyTotp(await this.vault.decrypt(rec.pendingSecretEnc!), code, this.now(), -1);
    if (step === null) {
      rec.attempts += 1;
      this.audit(db, 'MFA_SETUP_CODE_FAILED', { userId: user.id, accountId: user.accountId, detail: 'replacement' });
      if (rec.attempts >= MFA_POLICY.setupMaxAttempts) {
        db.stepUps = db.stepUps.filter((s) => s !== rec);
        this.save(db);
        fail(429, 'MFA_SETUP_ATTEMPTS_EXCEEDED');
      }
      this.save(db);
      fail(400, 'MFA_CODE_INVALID', { attemptsRemaining: MFA_POLICY.setupMaxAttempts - rec.attempts });
    }
    const mfa = db.mfa[user.id];
    mfa.secretEnc = rec.pendingSecretEnc;
    mfa.enrolledAt = this.now();
    mfa.lastStep = step!;
    db.stepUps = db.stepUps.filter((s) => s !== rec);
    this.audit(db, 'AUTHENTICATOR_REPLACED', { userId: user.id, accountId: user.accountId, detail: 'previous authenticator revoked' });
    this.notify(db, user, 'Your Mobi authenticator was replaced', `A new authenticator app was registered for ${user.loginId}, and the previous one no longer works. If this wasn't you, contact Mobi Support immediately.`);
    this.save(db);
    return null;
  }

  private async findStepUp(db: Db, userId: string, purpose: StepUpRec['purpose'], token: unknown): Promise<StepUpRec> {
    const hash = typeof token === 'string' && token ? await sha256Hex(token) : '';
    const rec = db.stepUps.find((s) => s.tokenHash === hash && s.userId === userId && s.purpose === purpose);
    if (!rec || rec.expiresAt <= this.now()) fail(403, 'STEP_UP_REQUIRED');
    return rec!;
  }

  // ------------------------------------------- security administration (staff)

  private async requireStaff(db: Db, token: string | null, roleHeader: string | null, allowed: SecurityRole[]) {
    const { user } = await this.requireSession(db, token, true);
    // Merchant users never reach internal administration, whatever role header they send.
    if (user.portal === 'merchant') fail(403, 'ROLE_NOT_PERMITTED');
    const role = roleHeader === 'support' || roleHeader === 'security' ? roleHeader : null;
    if (!role || !allowed.includes(role)) fail(403, 'ROLE_NOT_PERMITTED');
    return { user, role: role!, actor: `${user.name} (${SECURITY_ROLE_LABEL[role!]})` };
  }

  private targetUser(db: Db, staff: UserRec, userId: string): UserRec {
    const target = db.users.find((u) => u.id === userId);
    if (!target) fail(404, 'NOT_FOUND');
    // Nobody can reset or unblock their own second factor.
    if (target!.id === staff.id) fail(403, 'ROLE_NOT_PERMITTED');
    return target!;
  }

  private async securityOverview(token: string | null, roleHeader: string | null): Promise<SecurityOverview> {
    const db = this.load();
    await this.requireStaff(db, token, roleHeader, ['support', 'security']);
    const users = new Map(db.users.map((u) => [u.id, u]));
    return {
      // Admins see status only, never authenticator secrets (FR-07).
      users: db.users.map((u) => {
        const m = db.mfa[u.id];
        const account = db.accounts.find((a) => a.id === u.accountId)!;
        return {
          userId: u.id,
          loginId: u.loginId,
          name: u.name,
          email: u.email,
          accountId: account.id,
          accountName: account.name,
          userStatus: u.status,
          accountStatus: account.status,
          mfaStatus: m.blockedAt ? 'blocked' : m.status,
          enrolledAt: m.enrolledAt,
          lastUsedAt: m.lastUsedAt,
          failedAttempts: m.failures,
          blockedAt: m.blockedAt,
          openRequestId: db.resetRequests.find((r) => r.userId === u.id && r.status === 'open')?.id ?? null,
        };
      }),
      requests: db.resetRequests.map((r) => ({ ...r, userName: users.get(r.userId)?.name ?? r.userId, loginId: users.get(r.userId)?.loginId ?? '' })),
      alerts: db.alerts.map((a) => ({ ...a, type: 'MFA_BLOCKED' as const, userName: users.get(a.userId)?.name ?? a.userId, loginId: users.get(a.userId)?.loginId ?? '' })),
    };
  }

  private async securityAudit(token: string | null, roleHeader: string | null): Promise<SecurityAuditView[]> {
    const db = this.load();
    await this.requireStaff(db, token, roleHeader, ['support', 'security']);
    const users = new Map(db.users.map((u) => [u.id, u]));
    return db.audit
      .filter((e) => SECURITY_EVENT_TYPES.has(e.type))
      .reverse()
      .map((e) => ({
        at: e.at,
        type: e.type,
        actor: e.actor ?? null,
        userName: e.userId ? (users.get(e.userId)?.name ?? null) : null,
        loginId: e.userId ? (users.get(e.userId)?.loginId ?? null) : null,
        accountId: e.accountId ?? null,
        reason: e.reason ?? null,
        detail: e.detail ?? null,
      }));
  }

  /** FR-07 identity verification of the administrator: a fresh code from their own authenticator. */
  private async adminStepUp(token: string | null, roleHeader: string | null, body: any): Promise<StepUpResponse> {
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) fail(400, 'VALIDATION_FAILED');
    const db = this.load();
    const { user, actor } = await this.requireStaff(db, token, roleHeader, ['support', 'security']);
    await this.checkCurrentCode(db, user, code, 'step_up');
    const stepUpToken = randomToken();
    db.stepUps = db.stepUps.filter((s) => !(s.userId === user.id && s.purpose === 'admin'));
    db.stepUps.push({ tokenHash: await sha256Hex(stepUpToken), userId: user.id, purpose: 'admin', expiresAt: this.now() + MFA_POLICY.stepUpTtlMs, pendingSecretEnc: null, attempts: 0 });
    this.audit(db, 'ADMIN_STEP_UP_VERIFIED', { userId: user.id, accountId: user.accountId, actor });
    this.save(db);
    return { stepUpToken, expiresInSec: MFA_POLICY.stepUpTtlMs / 1000 };
  }

  /** FR-05: Mobi Support opens the lost-device request. */
  private async createResetRequest(token: string | null, roleHeader: string | null, body: any) {
    const db = this.load();
    const { user: staff, actor } = await this.requireStaff(db, token, roleHeader, ['support']);
    await this.findStepUp(db, staff.id, 'admin', body?.stepUpToken);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const reference = typeof body?.reference === 'string' ? body.reference.trim() : '';
    if (!reason || reason.length > 500 || !reference || reference.length > 64) fail(400, 'VALIDATION_FAILED');
    const target = this.targetUser(db, staff, body?.userId);
    if (db.resetRequests.some((r) => r.userId === target.id && r.status === 'open')) fail(409, 'RESET_REQUEST_EXISTS');
    const rec: ResetRequestRec = {
      id: `RST-${String(db.resetRequests.length + 1).padStart(4, '0')}`,
      userId: target.id,
      status: 'open',
      reason,
      reference,
      requestedBy: actor,
      requestedAt: this.now(),
      completedBy: null,
      completedAt: null,
      verificationMethod: null,
    };
    db.resetRequests.unshift(rec);
    this.audit(db, 'MFA_RESET_REQUESTED', { userId: target.id, accountId: target.accountId, actor, reason, detail: `${rec.id}; ref=${reference}` });
    this.save(db);
    return { id: rec.id };
  }

  /** FR-05/FR-07: Security Admin completes identity verification and resets the authenticator. */
  private async adminReset(token: string | null, roleHeader: string | null, userId: string, body: any): Promise<null> {
    const db = this.load();
    const { user: staff, actor } = await this.requireStaff(db, token, roleHeader, ['security']);
    await this.findStepUp(db, staff.id, 'admin', body?.stepUpToken);
    const target = this.targetUser(db, staff, userId);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const method = typeof body?.verificationMethod === 'string' ? body.verificationMethod.trim() : '';
    if (body?.identityVerified !== true || !method || method.length > 200 || !reason || reason.length > 500) fail(400, 'VALIDATION_FAILED');
    const request = db.resetRequests.find((r) => r.userId === target.id && r.status === 'open' && r.id === body?.requestId);
    if (!request) fail(409, 'RESET_REQUEST_REQUIRED');

    // The old secret is deleted; the user must register a new authenticator.
    db.mfa[target.id] = emptyMfa();
    db.challenges = db.challenges.filter((c) => c.userId !== target.id);
    db.stepUps = db.stepUps.filter((s) => s.userId !== target.id);
    const revoked = this.revokeSessions(db, (s) => s.userId === target.id, 'MFA_RESET');
    request!.status = 'completed';
    request!.completedBy = actor;
    request!.completedAt = this.now();
    request!.verificationMethod = method;
    this.resolveAlerts(db, target.id, actor, 'Authenticator reset');
    this.audit(db, 'IDENTITY_VERIFIED', { userId: target.id, accountId: target.accountId, actor, detail: `${request!.id}; method=${method}` });
    this.audit(db, 'MFA_RESET', { userId: target.id, accountId: target.accountId, actor, reason, detail: `${request!.id}; sessions_revoked=${revoked}` });
    this.notify(db, target, 'Your Mobi two-factor authentication was reset', `Mobi reset two-factor authentication for ${target.loginId} (request ${request!.id}). The next time you sign in you must register a new authenticator app. If you didn't ask for this, contact Mobi Support immediately.`);
    this.save(db);
    return null;
  }

  /** FR-03/FR-07: authorised manual waive-off of a security block, with a recorded reason. */
  private async adminWaive(token: string | null, roleHeader: string | null, userId: string, body: any): Promise<null> {
    const db = this.load();
    const { user: staff, actor } = await this.requireStaff(db, token, roleHeader, ['security']);
    await this.findStepUp(db, staff.id, 'admin', body?.stepUpToken);
    const target = this.targetUser(db, staff, userId);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 500) fail(400, 'VALIDATION_FAILED');
    const mfa = db.mfa[target.id];
    if (!mfa.blockedAt) fail(409, 'NOT_BLOCKED');
    mfa.blockedAt = null;
    mfa.failures = 0;
    this.resolveAlerts(db, target.id, actor, 'Block waived');
    this.audit(db, 'MFA_BLOCK_WAIVED', { userId: target.id, accountId: target.accountId, actor, reason });
    this.save(db);
    return null;
  }

  private resolveAlerts(db: Db, userId: string, actor: string, resolution: string) {
    for (const a of db.alerts) {
      if (a.userId === userId && a.status === 'open') {
        a.status = 'resolved';
        a.resolvedBy = actor;
        a.resolvedAt = this.now();
        a.resolution = resolution;
      }
    }
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
      // Each app has its own /dashboard (Global Platform or Merchant Portal).
      landingPath: '/dashboard',
      portal: user.portal === 'merchant' ? 'merchant' : 'internal',
      merchant: user.portal === 'merchant' && user.merchantId ? { id: user.merchantId, name: this.opts.merchantName?.(user.merchantId) ?? account.name } : null,
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
    if (user.portal === 'merchant') fail(403, 'ROLE_NOT_PERMITTED');
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

  /**
   * Validates a bearer token with the same session rules as the auth APIs (used by the other
   * simulated services). `portal` says which kind of user the calling service serves: internal
   * services refuse merchant users, and the merchant portal refuses internal users.
   */
  async authenticate(
    token: string | null,
    portal: 'internal' | 'merchant' = 'internal',
  ): Promise<{ ok: true; caller: { userId: string; name: string; accountId: string; merchantId: string | null } } | { ok: false; response: ServerResponse }> {
    await this.ensureSeeded();
    const db = this.load();
    try {
      const { user } = await this.requireSession(db, token, true);
      const userPortal = user.portal === 'merchant' ? 'merchant' : 'internal';
      if (userPortal !== portal || (portal === 'merchant' && !user.merchantId)) fail(403, 'ROLE_NOT_PERMITTED');
      return { ok: true, caller: { userId: user.id, name: user.name, accountId: user.accountId, merchantId: user.merchantId ?? null } };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, response: { status: e.status, body: e.body } };
      throw e;
    }
  }

  /**
   * Activates a country on a merchant's Global Account after go-live, creating the account
   * (with no users) if the merchant doesn't have one yet. Returns the Global Account ID.
   */
  /**
   * Safe to repeat for the same go-live: `merchantId` finds an account an earlier attempt created
   * before its merchant record was saved, and a country that is already active is left as it is
   * (no second audit event). A new account's ID is unique among existing accounts and never one of
   * `reservedIds`, so it can't collide with an ID merchant data still refers to.
   */
  async activateCountry(accountId: string | null, accountName: string, countryCode: string, opts: { merchantId?: string; reservedIds?: string[] } = {}): Promise<string> {
    await this.ensureSeeded();
    const db = this.load();
    const { merchantId } = opts;
    let account = accountId ? db.accounts.find((a) => a.id === accountId) : undefined;
    if (!account && merchantId) account = db.accounts.find((a) => a.merchantId === merchantId);
    if (!account) {
      const taken = new Set([...db.accounts.map((a) => a.id), ...(opts.reservedIds ?? [])]);
      let next = Math.max(5000, ...[...taken].map((id) => Number(id.replace(/\D/g, '')) || 0)) + 1;
      while (taken.has(`GA-${next}`)) next++;
      account = { id: `GA-${next}`, name: accountName, status: 'active', countries: [], ...(merchantId ? { merchantId } : {}) };
      db.accounts.push(account);
      this.audit(db, 'ACCOUNT_CREATED', { accountId: account.id, detail: 'merchant_go_live' });
    }
    const existing = account.countries.find((c) => c.code === countryCode);
    if (existing?.status === 'active') return account.id;
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

  /**
   * PROTOTYPE ONLY — the "Demo authenticator" card. Returns the current code of the
   * authenticator that a sign-in challenge, signed-in session or started replacement is
   * waiting for, so the flow can be tested without a phone. A real backend never exposes this.
   */
  async demoAuthenticator(kind: 'challenge' | 'session' | 'replace', token: string): Promise<{ code: string; secondsLeft: number; label: string; isNew: boolean } | null> {
    await this.ensureSeeded();
    const db = this.load();
    const hash = await sha256Hex(token);
    const now = this.now();
    let userId: string | undefined;
    let secretEnc: string | null = null;
    let isNew = false;
    if (kind === 'challenge') {
      const c = db.challenges.find((x) => x.tokenHash === hash && x.expiresAt > now);
      if (!c) return null;
      userId = c.userId;
      isNew = c.stage === 'setup';
      secretEnc = isNew ? c.pendingSecretEnc : db.mfa[c.userId]?.secretEnc;
    } else if (kind === 'session') {
      userId = db.sessions.find((s) => s.tokenHash === hash)?.userId;
      secretEnc = userId ? db.mfa[userId]?.secretEnc : null;
    } else {
      const s = db.stepUps.find((x) => x.tokenHash === hash && x.purpose === 'replace' && x.expiresAt > now);
      userId = s?.userId;
      secretEnc = s?.pendingSecretEnc ?? null;
      isNew = true;
    }
    if (!userId || !secretEnc) return null;
    const user = db.users.find((u) => u.id === userId)!;
    return { code: await totpAt(await this.vault.decrypt(secretEnc), now), secondsLeft: secondsLeftInStep(now), label: user.loginId, isNew };
  }

  /** QA hook: forget a user's authenticator so the setup flow can be tested again. */
  async demoClearAuthenticator(loginId: string): Promise<string> {
    await this.ensureSeeded();
    const db = this.load();
    const user = db.users.find((u) => u.loginId.toUpperCase() === normaliseLoginId(loginId));
    if (!user) return `No user ${loginId}`;
    db.mfa[user.id] = emptyMfa();
    this.revokeSessions(db, (s) => s.userId === user.id, 'MFA_RESET');
    this.save(db);
    return `${user.loginId} has no authenticator now; they will be asked to set one up at next sign-in`;
  }

  // ---------------------------------------------------------------- storage

  private ensureSeeded(): Promise<void> {
    if (!this.seeded) {
      this.seeded = (async () => {
        const raw = this.opts.storage.getItem(this.storageKey);
        const existing = raw ? JSON.parse(raw) : null;
        if (existing?.version === DB_VERSION) return;
        if (existing?.version === 4) {
          await this.migrateToMfa(existing);
          await this.addMissingSeedUsers();
          this.removeRecoveryCodes();
          return;
        }
        if (existing?.version === 5 || existing?.version === 6 || existing?.version === 7) {
          await this.addMissingSeedUsers();
          this.removeRecoveryCodes();
          return;
        }
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
          mfa: await this.seedMfa(users),
          challenges: [],
          stepUps: [],
          resetRequests: [],
          alerts: [],
        });
      })();
    }
    return this.seeded;
  }

  /** Demo users marked `mfaEnrolled` start with an authenticator; everyone else must set one up. */
  private async seedMfa(users: UserRec[]): Promise<Record<string, MfaRec>> {
    const out: Record<string, MfaRec> = {};
    for (const u of users) {
      const enrolled = SEED_USERS.find((s) => s.id === u.id)?.mfaEnrolled;
      out[u.id] = emptyMfa();
      if (enrolled) {
        const m = out[u.id];
        m.status = 'active';
        m.secretEnc = await this.vault.encrypt(generateTotpSecret());
        m.enrolledAt = this.now();
      }
    }
    return out;
  }

  /**
   * FR-09 rollout: keeps accounts, users and history, adds 2FA records, and ends every
   * existing session so all users must sign in again and complete 2FA.
   */
  private async migrateToMfa(old: Omit<Db, 'mfa' | 'challenges' | 'stepUps' | 'resetRequests' | 'alerts'>) {
    const db: Db = { ...old, version: DB_VERSION, mfa: await this.seedMfa(old.users), challenges: [], stepUps: [], resetRequests: [], alerts: [] };
    const revoked = this.revokeSessions(db, () => true, 'MFA_REQUIRED');
    this.audit(db, 'MFA_ROLLOUT_SESSIONS_REVOKED', { detail: `sessions_revoked=${revoked}` });
    this.save(db);
  }

  /** Adds demo accounts and users introduced by later builds (e.g. merchant portal users). Existing data is kept. */
  private async addMissingSeedUsers() {
    const db = this.load();
    for (const a of SEED_ACCOUNTS) {
      if (!db.accounts.some((x) => x.id === a.id)) db.accounts.push(structuredClone(a));
    }
    const added: UserRec[] = [];
    for (const u of SEED_USERS) {
      if (db.users.some((x) => x.id === u.id)) continue;
      added.push({ ...u, passwordHash: await hashPassword(DEMO_PASSWORD, this.iterations), passwordChangedAt: this.now() });
    }
    db.users.push(...added);
    Object.assign(db.mfa, await this.seedMfa(added));
    db.version = DB_VERSION;
    if (added.length) this.audit(db, 'SEED_USERS_ADDED', { detail: added.map((u) => u.loginId).join(',') });
    this.save(db);
  }

  /**
   * Recovery codes were removed (lost authenticator → contact Mobi Support). Deletes stored code
   * hashes and any sign-in step that was waiting on them. Everything else is kept.
   */
  private removeRecoveryCodes() {
    const db = this.load() as Db & { mfa: Record<string, MfaRec & { recovery?: unknown; recoveryGeneratedAt?: unknown }> };
    let removed = 0;
    for (const m of Object.values(db.mfa)) {
      if (Array.isArray(m.recovery) && m.recovery.length) removed++;
      delete m.recovery;
      delete m.recoveryGeneratedAt;
    }
    db.challenges = db.challenges.filter((c) => c.stage === 'verify' || c.stage === 'setup');
    this.audit(db, 'RECOVERY_CODES_REMOVED', { detail: `users=${removed}` });
    this.save(db);
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
