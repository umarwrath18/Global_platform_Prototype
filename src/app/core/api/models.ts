// Shared API contract between the portal and the (currently simulated) auth backend.
// When Mobi's real backend is connected, only the mock server is replaced; these
// shapes are what the UI depends on.

export type AccountStatus = 'active' | 'inactive' | 'suspended';
export type UserStatus = 'active' | 'disabled';
export type CountryStatus = 'active' | 'pending' | 'failed';

export interface CountryAccess {
  code: string;
  name: string;
  currency: string;
  status: CountryStatus;
}

export interface SessionView {
  user: { id: string; loginId: string; name: string; email: string };
  /** Internal users: the team this login works as (`admin` may switch). Null for merchant users. */
  team: 'sales' | 'risk' | 'cs' | 'finops' | 'support' | 'security' | 'admin' | null;
  account: { id: string; name: string };
  role: { id: string; name: string };
  permissions: string[];
  countries: CountryAccess[];
  baseCurrency: string;
  landingPath: string;
  /** `merchant`: a merchant's own user (Merchant Portal only). `internal`: Global Platform staff view. */
  portal: 'internal' | 'merchant';
  /** The merchant a merchant user belongs to; null for internal users. */
  merchant: { id: string; name: string } | null;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface LoginRequest {
  loginId: string;
  password: string;
  /** The app signing in; a user of the other kind is refused with WRONG_PORTAL. */
  portal?: 'internal' | 'merchant';
}

/**
 * A password-only sign-in never creates a session. It returns a short-lived 2FA challenge:
 * - `verify`: the user has an authenticator and must enter a code.
 * - `setup`: the user has no authenticator yet and must register one (mandatory).
 * There are no recovery codes: a user who loses their authenticator contacts Mobi Support.
 */
export type MfaStage = 'verify' | 'setup';

export interface MfaChallenge {
  challengeToken: string;
  stage: MfaStage;
  expiresInSec: number;
  user: { name: string; loginId: string };
}

/** Response to a successful password check. */
export type LoginResponse = MfaChallenge;

/** Issued only after both factors are verified. */
export interface SignedInResponse {
  token: string;
  session: SessionView;
}

export interface AuthenticatorEnrolment {
  /** Base32 secret for manual entry. Shown during setup only, never again. */
  secret: string;
  otpauthUri: string;
  issuer: string;
  accountLabel: string;
}

export type MfaStatus = 'not_enrolled' | 'active' | 'blocked';

export interface AccountSecurityView {
  status: MfaStatus;
  enrolledAt: number | null;
  lastUsedAt: number | null;
}

export interface ReplaceAuthenticatorStart extends AuthenticatorEnrolment {
  replaceToken: string;
}

// ---- Security administration (Mobi Support and Security Admin) ----

export type SecurityRole = 'support' | 'security';

export interface SecurityUserRow {
  userId: string;
  loginId: string;
  name: string;
  email: string;
  accountId: string;
  accountName: string;
  userStatus: UserStatus;
  accountStatus: AccountStatus;
  mfaStatus: MfaStatus;
  enrolledAt: number | null;
  lastUsedAt: number | null;
  failedAttempts: number;
  blockedAt: number | null;
  openRequestId: string | null;
}

export interface ResetRequestView {
  id: string;
  userId: string;
  userName: string;
  loginId: string;
  status: 'open' | 'completed';
  reason: string;
  reference: string;
  requestedBy: string;
  requestedAt: number;
  completedBy: string | null;
  completedAt: number | null;
  verificationMethod: string | null;
}

export interface SecurityAlertView {
  id: string;
  at: number;
  userId: string;
  userName: string;
  loginId: string;
  accountId: string;
  type: 'MFA_BLOCKED';
  failedAttempts: number;
  /** Email sent to the Tech team (simulated in the prototype). */
  email?: { to: string; subject: string; status: 'simulated' };
  status: 'open' | 'resolved';
  resolvedBy: string | null;
  resolvedAt: number | null;
  resolution: string | null;
}

export interface SecurityAuditView {
  at: number;
  type: string;
  actor: string | null;
  userName: string | null;
  loginId: string | null;
  accountId: string | null;
  reason: string | null;
  detail: string | null;
}

export interface SecurityOverview {
  users: SecurityUserRow[];
  requests: ResetRequestView[];
  alerts: SecurityAlertView[];
}

export interface StepUpResponse {
  stepUpToken: string;
  expiresInSec: number;
}

export interface WorkspaceContext {
  scope: 'global' | 'country';
  country: CountryAccess | null;
  currency: string;
}

export interface OtpRequestResponse {
  requestId: string;
  expiresInSec: number;
  resendAvailableInSec: number;
}

export interface OtpVerifyResponse {
  resetToken: string;
}

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'MFA_CODE_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'LOGIN_LOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_INACTIVE'
  | 'USER_DISABLED'
  | 'SERVICE_UNAVAILABLE'
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'COUNTRY_NOT_AUTHORISED'
  | 'COUNTRY_NOT_ACTIVE'
  | 'OTP_COOLDOWN'
  | 'OTP_SEND_LIMIT'
  | 'OTP_DELIVERY_FAILED'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_USED'
  | 'OTP_ATTEMPTS_EXCEEDED'
  | 'RESET_TOKEN_INVALID'
  | 'RESET_NOT_ALLOWED'
  | 'PASSWORD_POLICY'
  | 'NOT_FOUND'
  | 'MFA_REQUIRED'
  | 'MFA_CHALLENGE_EXPIRED'
  | 'MFA_STAGE_INVALID'
  | 'MFA_CODE_INVALID'
  | 'MFA_CODE_REUSED'
  | 'MFA_BLOCKED'
  | 'MFA_RESET'
  | 'MFA_SETUP_ATTEMPTS_EXCEEDED'
  | 'STEP_UP_REQUIRED'
  | 'ROLE_NOT_PERMITTED'
  | 'RESET_REQUEST_REQUIRED'
  | 'RESET_REQUEST_EXISTS'
  | 'NOT_BLOCKED'
  | 'WRONG_PORTAL';

export interface ApiErrorBody {
  code: ApiErrorCode;
  retryAfterSec?: number;
  attemptsRemaining?: number;
  violations?: string[];
  countryStatus?: CountryStatus;
}
