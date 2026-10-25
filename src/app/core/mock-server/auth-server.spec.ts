import { beforeEach, describe, expect, it } from 'vitest';
import { checkPassword } from '../api/password-policy';
import { AUTH_POLICY, AuthServer, DemoEmail } from './auth-server';
import { DEMO_PASSWORD } from './seed';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

describe('AuthServer', () => {
  let now: number;
  let emails: DemoEmail[];
  let server: AuthServer;

  const login = (loginId: string, password = DEMO_PASSWORD) => server.handle('POST', '/api/auth/login', { loginId, password }, null);
  const tokenFor = async (loginId: string) => ((await login(loginId)).body as { token: string }).token;
  const advance = (ms: number) => (now += ms);

  beforeEach(() => {
    now = Date.UTC(2026, 9, 23);
    emails = [];
    server = new AuthServer({ storage: new MemoryStorage(), now: () => now, pbkdf2Iterations: 1000, sendEmail: (e) => emails.push(e) });
  });

  describe('login', () => {
    it('signs in an active user and returns role, countries and landing page', async () => {
      const res = await login('123');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(body.session.landingPath).toBe('/dashboard');
      expect(body.session.baseCurrency).toBe('USD');
      expect(body.session.countries.map((c: any) => `${c.code}:${c.status}`)).toEqual(['MY:active', 'ID:active', 'VN:active', 'TH:pending', 'PH:failed']);
    });

    it('treats the Global Account ID case-insensitively and trims it', async () => {
      expect((await login('  tanjung-admin ')).status).toBe(200);
    });

    it('rejects missing fields', async () => {
      expect((await login('', '')).body).toEqual({ code: 'VALIDATION_FAILED' });
    });

    it('gives the same response for a wrong password and an unknown ID', async () => {
      const a = await login('123', 'wrong');
      const b = await login('NOPE', 'wrong');
      expect(a).toEqual({ status: 401, body: { code: 'INVALID_CREDENTIALS' } });
      expect(b).toEqual(a);
    });

    it('locks progressively after repeated failures, then recovers', async () => {
      for (let i = 0; i < 3; i++) await login('123', 'wrong');
      expect((await login('123', 'wrong')).body).toEqual({ code: 'INVALID_CREDENTIALS', attemptsRemaining: 1 });
      expect((await login('123', 'wrong')).body).toEqual({ code: 'LOGIN_LOCKED', retryAfterSec: 60 });
      // Correct password is still refused while locked.
      expect((await login('123')).status).toBe(429);
      advance(61_000);
      expect((await login('123', 'wrong')).body).toEqual({ code: 'LOGIN_LOCKED', retryAfterSec: 300 });
      advance(301_000);
      expect((await login('123')).status).toBe(200);
      expect((await login('123', 'wrong')).body).toEqual({ code: 'INVALID_CREDENTIALS' });
    });

    it('locks unknown IDs the same way, so lockout does not reveal registration', async () => {
      for (let i = 0; i < 4; i++) await login('GHOST', 'x');
      expect((await login('GHOST', 'x')).body).toEqual({ code: 'LOGIN_LOCKED', retryAfterSec: 60 });
    });

    it.each([
      ['SERIMUTIARA-ADMIN', 'ACCOUNT_SUSPENDED'],
      ['NUSAPANGAN-ADMIN', 'ACCOUNT_INACTIVE'],
      ['TANJUNG-RAVI', 'USER_DISABLED'],
    ])('denies %s with %s only after valid credentials', async (id, code) => {
      expect((await login(id, 'wrong')).body).toEqual({ code: 'INVALID_CREDENTIALS' });
      expect(await login(id)).toEqual({ status: 403, body: { code } });
    });

    it('reports a service outage', async () => {
      expect((await login('TANJUNG-KEVIN')).status).toBe(503);
    });
  });

  describe('sessions and authorisation', () => {
    it('rejects protected calls without a valid token', async () => {
      expect((await server.handle('GET', '/api/auth/session', null, null)).body).toEqual({ code: 'UNAUTHENTICATED' });
      expect((await server.handle('GET', '/api/workspace/context', null, 'forged')).status).toBe(401);
    });

    it('expires idle sessions and keeps active ones alive', async () => {
      const token = await tokenFor('123');
      advance(AUTH_POLICY.sessionIdleMs - 1000);
      expect((await server.handle('GET', '/api/auth/session', null, token)).status).toBe(200);
      advance(AUTH_POLICY.sessionIdleMs - 1000);
      expect((await server.handle('GET', '/api/auth/session', null, token)).status).toBe(200);
      advance(AUTH_POLICY.sessionIdleMs + 1);
      expect((await server.handle('GET', '/api/auth/session', null, token)).body).toEqual({ code: 'SESSION_EXPIRED' });
    });

    it('does not extend the idle timer for background status checks', async () => {
      const token = await tokenFor('123');
      advance(AUTH_POLICY.sessionIdleMs - 1000);
      await server.handle('GET', '/api/auth/session?touch=false', null, token);
      advance(2000);
      expect((await server.handle('GET', '/api/auth/session', null, token)).body).toEqual({ code: 'SESSION_EXPIRED' });
    });

    it('invalidates the session on logout', async () => {
      const token = await tokenFor('123');
      await server.handle('POST', '/api/auth/logout', {}, token);
      expect((await server.handle('GET', '/api/auth/session', null, token)).status).toBe(401);
    });

    it('scopes country access to active, approved countries', async () => {
      const token = await tokenFor('123');
      const ctx = (c: string) => server.handle('GET', `/api/workspace/context?country=${c}`, null, token);
      expect((await ctx('VN')).body).toMatchObject({ scope: 'country', currency: 'VND' });
      expect((await server.handle('GET', '/api/workspace/context', null, token)).body).toMatchObject({ scope: 'global', currency: 'USD' });
      expect((await ctx('TH')).body).toEqual({ code: 'COUNTRY_NOT_ACTIVE', countryStatus: 'pending' });
      expect((await ctx('PH')).body).toEqual({ code: 'COUNTRY_NOT_ACTIVE', countryStatus: 'failed' });
      expect((await ctx('SG')).body).toEqual({ code: 'COUNTRY_NOT_AUTHORISED' });
    });

    it('suspending a Global Account revokes every session of its users immediately', async () => {
      const a = await tokenFor('123');
      const b = await tokenFor('TANJUNG-VIEWER');
      const other = await tokenFor('LUMI-ADMIN');
      await server.setAccountStatus('GA-1001', 'suspended');
      for (const t of [a, b]) expect((await server.handle('GET', '/api/auth/session', null, t)).body).toEqual({ code: 'ACCOUNT_SUSPENDED' });
      expect((await server.handle('GET', '/api/auth/session', null, other)).status).toBe(200);
      expect((await login('123')).body).toEqual({ code: 'ACCOUNT_SUSPENDED' });
    });

    it('disabling one user does not affect other users on the account', async () => {
      const a = await tokenFor('123');
      const b = await tokenFor('TANJUNG-ADMIN');
      await server.setUserStatus('123', 'disabled');
      expect((await server.handle('GET', '/api/auth/session', null, a)).body).toEqual({ code: 'USER_DISABLED' });
      expect((await server.handle('GET', '/api/auth/session', null, b)).status).toBe(200);
    });
  });

  describe('password recovery', () => {
    const requestOtp = (email: string) => server.handle('POST', '/api/auth/password/otp', { email }, null);
    const verify = (requestId: string, code: string) => server.handle('POST', '/api/auth/password/otp/verify', { requestId, code }, null);
    const reset = (resetToken: string, pw: string, confirm = pw) =>
      server.handle('POST', '/api/auth/password/reset', { resetToken, newPassword: pw, confirmPassword: confirm }, null);

    async function verified(email = 'sarah.lim@tanjungtrading.example') {
      const { requestId } = (await requestOtp(email)).body as any;
      const res = await verify(requestId, emails.at(-1)!.code);
      return (res.body as any).resetToken as string;
    }

    it('returns the same response for registered and unregistered emails', async () => {
      const a = await requestOtp('sarah.lim@tanjungtrading.example');
      const b = await requestOtp('nobody@example.com');
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(Object.keys(a.body as object)).toEqual(Object.keys(b.body as object));
      expect(emails.map((e) => e.to)).toEqual(['sarah.lim@tanjungtrading.example']);
    });

    it('does not send codes to suspended or disabled users', async () => {
      await requestOtp('izzah@serimutiara.example');
      await requestOtp('ravi@tanjungtrading.example');
      expect(emails).toHaveLength(0);
    });

    it('issues uniformly formatted 6-digit codes', async () => {
      await requestOtp('sarah.lim@tanjungtrading.example');
      expect(emails[0].code).toMatch(/^\d{6}$/);
    });

    it('limits verification attempts', async () => {
      const { requestId } = (await requestOtp('sarah.lim@tanjungtrading.example')).body as any;
      const wrong = emails[0].code === '000000' ? '111111' : '000000';
      for (let i = 4; i >= 1; i--) expect((await verify(requestId, wrong)).body).toEqual({ code: 'OTP_INVALID', attemptsRemaining: i });
      expect((await verify(requestId, wrong)).body).toEqual({ code: 'OTP_ATTEMPTS_EXCEEDED' });
      expect((await verify(requestId, emails[0].code)).body).toEqual({ code: 'OTP_ATTEMPTS_EXCEEDED' });
    });

    it('rejects expired and reused codes', async () => {
      const { requestId } = (await requestOtp('sarah.lim@tanjungtrading.example')).body as any;
      advance(AUTH_POLICY.otpTtlMs + 1);
      expect((await verify(requestId, emails[0].code)).body).toEqual({ code: 'OTP_EXPIRED' });

      advance(AUTH_POLICY.otpResendCooldownMs);
      const second = (await requestOtp('sarah.lim@tanjungtrading.example')).body as any;
      expect((await verify(second.requestId, emails[1].code)).status).toBe(200);
      expect((await verify(second.requestId, emails[1].code)).body).toEqual({ code: 'OTP_USED' });
    });

    it('enforces resend cooldown, invalidates the previous code and caps sends per hour', async () => {
      const { requestId } = (await requestOtp('sarah.lim@tanjungtrading.example')).body as any;
      const resend = () => server.handle('POST', '/api/auth/password/otp/resend', { requestId }, null);
      expect((await resend()).body).toEqual({ code: 'OTP_COOLDOWN', retryAfterSec: 60 });
      advance(60_000);
      expect((await resend()).status).toBe(202);
      const oldCode = emails[0].code;
      if (oldCode !== emails[1].code) expect((await verify(requestId, oldCode)).body).toMatchObject({ code: 'OTP_INVALID' });
      for (let i = 0; i < 3; i++) {
        advance(60_000);
        expect((await resend()).status).toBe(202);
      }
      advance(60_000);
      expect((await resend()).body).toMatchObject({ code: 'OTP_SEND_LIMIT' });
    });

    it('reports delivery failure', async () => {
      expect((await requestOtp('farid@tanjungtrading.example')).body).toEqual({ code: 'OTP_DELIVERY_FAILED' });
    });

    it('enforces the password policy and confirmation', async () => {
      const token = await verified();
      expect((await reset(token, 'short')).body).toMatchObject({ code: 'PASSWORD_POLICY', violations: ['too_short'] });
      expect((await reset(token, 'qwertyuiop12')).body).toMatchObject({ code: 'PASSWORD_POLICY', violations: ['common'] });
      expect((await reset(token, 'sarah.lim-is-my-name')).body).toMatchObject({ code: 'PASSWORD_POLICY', violations: ['contains_identity'] });
      expect((await reset(token, 'a long passphrase', 'different')).body).toEqual({ code: 'VALIDATION_FAILED' });
    });

    it('replaces the password, revokes sessions and makes the reset token single-use', async () => {
      const session = await tokenFor('123');
      const token = await verified();
      expect((await reset(token, 'correct horse battery')).status).toBe(204);
      expect((await reset(token, 'another good phrase')).body).toEqual({ code: 'RESET_TOKEN_INVALID' });
      expect((await server.handle('GET', '/api/auth/session', null, session)).status).toBe(401);
      expect((await login('123')).status).toBe(401);
      expect((await login('123', 'correct horse battery')).status).toBe(200);
    });

    it('expires the reset token', async () => {
      const token = await verified();
      advance(AUTH_POLICY.resetTokenTtlMs + 1);
      expect((await reset(token, 'correct horse battery')).body).toEqual({ code: 'RESET_TOKEN_INVALID' });
    });
  });

  it('records audit events without secrets', async () => {
    await login('123', 'wrong');
    await login('123');
    await server.handle('POST', '/api/auth/password/otp', { email: 'sarah.lim@tanjungtrading.example' }, null);
    const log = await server.auditLog();
    expect(log.map((e) => e.type)).toEqual(['LOGIN_FAILED', 'LOGIN_SUCCESS', 'OTP_SENT']);
    const serialised = JSON.stringify(log);
    expect(serialised).not.toContain('wrong');
    expect(serialised).not.toContain(DEMO_PASSWORD);
    expect(serialised).not.toContain(emails[0].code);
  });
});

describe('checkPassword', () => {
  it('accepts long passphrases without composition rules', () => {
    expect(checkPassword('correct horse battery')).toEqual([]);
  });
  it('flags common, short and repetitive passwords', () => {
    expect(checkPassword('Mobi@123')).toEqual(['too_short', 'common']);
    expect(checkPassword('aaaaaaaaaaaa')).toEqual(['repetitive']);
    expect(checkPassword('123456789012')).toEqual(['common']);
  });
});
