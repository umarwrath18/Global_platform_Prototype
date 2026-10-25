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
  account: { id: string; name: string };
  role: { id: string; name: string };
  permissions: string[];
  countries: CountryAccess[];
  baseCurrency: string;
  landingPath: string;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface LoginRequest {
  loginId: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  session: SessionView;
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
  | 'NOT_FOUND';

export interface ApiErrorBody {
  code: ApiErrorCode;
  retryAfterSec?: number;
  attemptsRemaining?: number;
  violations?: string[];
  countryStatus?: CountryStatus;
}
