import { beforeEach, describe, expect, it } from 'vitest';
import { AuthServer, DemoEmail, MFA_POLICY } from './auth-server';
import { DEMO_PASSWORD } from './seed';
import { signIn } from './testing/sign-in';
import { base32Encode, hotp, totpAt, TOTP } from './totp';

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

describe('TOTP (RFC 6238 test vectors, SHA-1)', () => {
  // RFC 6238 Appendix B secret "12345678901234567890"; 6-digit codes are the last 6 digits of the 8-digit vectors.
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('time %i → %s', async (t, code) => {
    expect(await totpAt(secret, t * 1000)).toBe(code);
  });
  it('matches HOTP for the time step', async () => {
    expect(await hotp(secret, Math.floor(59 / TOTP.periodSec))).toBe('287082');
  });
});

describe('Two-factor authentication', () => {
  let now: number;
  let emails: DemoEmail[];
  let storage: MemoryStorage;
  let server: AuthServer;

  const call = (method: string, path: string, body: unknown = null, token: string | null = null, role: string | null = null) => server.handle(method, path, body, token, role);
  const login = (loginId: string, password = DEMO_PASSWORD) => call('POST', '/api/auth/login', { loginId, password });
  const advance = (ms: number) => (now += ms);
  const nextStep = () => advance(TOTP.periodSec * 1000);

  /** Signs in up to the challenge and returns its token. */
  async function challenge(loginId: string) {
    const res = await login(loginId);
    expect(res.status).toBe(200);
    return (res.body as any).challengeToken as string;
  }
  const demoCode = async (kind: 'challenge' | 'session' | 'replace', token: string) => (await server.demoAuthenticator(kind, token))!.code;
  const wrong = (code: string) => String((Number(code) + 500_000) % 1_000_000).padStart(6, '0');

  /** First-time setup for a user without 2FA; returns the secret and recovery codes. */
  async function enrol(loginId: string) {
    const token = await challenge(loginId);
    const enrol = (await call('POST', '/api/auth/mfa/setup', { challengeToken: token })).body as any;
    const verified = await call('POST', '/api/auth/mfa/setup/verify', { challengeToken: token, code: await totpAt(enrol.secret, now) });
    const done = await call('POST', '/api/auth/mfa/setup/complete', { challengeToken: token, acknowledged: true });
    return { secret: enrol.secret as string, codes: (verified.body as any).recoveryCodes as string[], session: (done.body as any).token as string };
  }

  beforeEach(() => {
    now = Date.UTC(2026, 10, 5, 9, 0, 0);
    emails = [];
    storage = new MemoryStorage();
    server = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: (e) => emails.push(e) });
  });

  describe('FR-01 / FR-02 mandatory setup', () => {
    it('routes a user without an authenticator to setup, with a QR URI and manual key', async () => {
      const token = await challenge('123');
      const res = await call('POST', '/api/auth/mfa/setup', { challengeToken: token });
      expect(res.status).toBe(200);
      const e = res.body as any;
      expect(e.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(e.otpauthUri).toBe(`otpauth://totp/Mobi%20Global%20Platform%3A123?secret=${e.secret}&issuer=Mobi+Global+Platform&algorithm=SHA1&digits=6&period=30`);
    });

    it('does not activate 2FA or grant access with an invalid code', async () => {
      const token = await challenge('123');
      const e = (await call('POST', '/api/auth/mfa/setup', { challengeToken: token })).body as any;
      const bad = await call('POST', '/api/auth/mfa/setup/verify', { challengeToken: token, code: wrong(await totpAt(e.secret, now)) });
      expect(bad).toEqual({ status: 400, body: { code: 'MFA_CODE_INVALID', attemptsRemaining: MFA_POLICY.setupMaxAttempts - 1 } });
      expect((await call('POST', '/api/auth/mfa/setup/complete', { challengeToken: token, acknowledged: true })).body).toEqual({ code: 'MFA_STAGE_INVALID' });
      // Still not enrolled on the next sign-in.
      expect(((await login('123')).body as any).stage).toBe('setup');
    });

    it('cannot be skipped: verify and recovery are refused during setup', async () => {
      const token = await challenge('123');
      expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: token, code: '123456' })).body).toEqual({ code: 'MFA_STAGE_INVALID' });
      expect((await call('POST', '/api/auth/mfa/recovery', { challengeToken: token, code: 'AAAA-BBBB-CCCC' })).body).toEqual({ code: 'MFA_STAGE_INVALID' });
    });

    it('activates on a valid code, issues 2 unique recovery codes, and needs acknowledgement before a session', async () => {
      const token = await challenge('123');
      const e = (await call('POST', '/api/auth/mfa/setup', { challengeToken: token })).body as any;
      const res = await call('POST', '/api/auth/mfa/setup/verify', { challengeToken: token, code: await totpAt(e.secret, now) });
      const codes = (res.body as any).recoveryCodes as string[];
      expect(codes).toHaveLength(2);
      expect(new Set(codes).size).toBe(2);
      codes.forEach((c) => expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/));
      expect((await call('POST', '/api/auth/mfa/setup/complete', { challengeToken: token })).body).toEqual({ code: 'ACK_REQUIRED' });
      const done = await call('POST', '/api/auth/mfa/setup/complete', { challengeToken: token, acknowledged: true });
      expect(done.status).toBe(200);
      expect((await call('GET', '/api/auth/session', null, (done.body as any).token)).status).toBe(200);
      // Next sign-in asks for a code instead.
      expect(((await login('123')).body as any).stage).toBe('verify');
    });

    it('abandons setup after too many wrong codes', async () => {
      const token = await challenge('123');
      await call('POST', '/api/auth/mfa/setup', { challengeToken: token });
      for (let i = 1; i < MFA_POLICY.setupMaxAttempts; i++) await call('POST', '/api/auth/mfa/setup/verify', { challengeToken: token, code: '000000' });
      expect((await call('POST', '/api/auth/mfa/setup/verify', { challengeToken: token, code: '000000' })).body).toEqual({ code: 'MFA_SETUP_ATTEMPTS_EXCEEDED' });
      expect((await call('POST', '/api/auth/mfa/setup', { challengeToken: token })).body).toEqual({ code: 'MFA_CHALLENGE_EXPIRED' });
    });

    it('stores the secret encrypted and recovery codes only as hashes', async () => {
      const { secret, codes } = await enrol('123');
      const raw = [...storage.data.values()].join('\n');
      expect(raw).not.toContain(secret);
      codes.forEach((c) => {
        expect(raw).not.toContain(c);
        expect(raw).not.toContain(c.replace(/-/g, ''));
      });
    });
  });

  describe('FR-03 sign-in verification', () => {
    it('requires a valid code after the password; password alone gives no session', async () => {
      const token = await challenge('TANJUNG-ADMIN');
      expect(await call('POST', '/api/auth/mfa/verify', { challengeToken: token, code: wrong(await demoCode('challenge', token)) })).toEqual({ status: 400, body: { code: 'MFA_CODE_INVALID', attemptsRemaining: 3 } });
      const ok = await call('POST', '/api/auth/mfa/verify', { challengeToken: token, code: await demoCode('challenge', token) });
      expect(ok.status).toBe(200);
      expect((ok.body as any).session.user.loginId).toBe('TANJUNG-ADMIN');
    });

    it('accepts ±30 s of clock drift but not more', async () => {
      const { secret } = await enrol('123');
      nextStep();
      nextStep();
      const token = await challenge('123');
      const earlier = await totpAt(secret, now - 30_000);
      expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: token, code: earlier })).status).toBe(200);
      nextStep();
      nextStep();
      const t2 = await challenge('123');
      const tooOld = await totpAt(secret, now - 60_000);
      expect(((await call('POST', '/api/auth/mfa/verify', { challengeToken: t2, code: tooOld })).body as any).code).toBe('MFA_CODE_INVALID');
    });

    it('accepts each code only once', async () => {
      const { secret } = await enrol('123');
      nextStep();
      const code = await totpAt(secret, now);
      const a = await challenge('123');
      expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: a, code })).status).toBe(200);
      const b = await challenge('123');
      expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: b, code })).body).toEqual({ code: 'MFA_CODE_REUSED' });
    });

    it('expires the second step after 5 minutes', async () => {
      const token = await challenge('TANJUNG-ADMIN');
      const code = await demoCode('challenge', token);
      advance(MFA_POLICY.challengeTtlMs + 1);
      expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: token, code })).body).toEqual({ code: 'MFA_CHALLENGE_EXPIRED' });
    });

    it('blocks after more than 3 consecutive failures, alerts Tech, and stays blocked until waived', async () => {
      let token = await challenge('TANJUNG-ADMIN');
      for (let i = 3; i >= 1; i--) {
        expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: token, code: '000000' })).body).toEqual({ code: 'MFA_CODE_INVALID', attemptsRemaining: i });
      }
      expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: token, code: '000000' })).body).toEqual({ code: 'MFA_BLOCKED' });
      // Correct password still can't continue, even much later.
      advance(24 * 60 * 60_000);
      expect((await login('TANJUNG-ADMIN')).body).toEqual({ code: 'MFA_BLOCKED' });
      // Other users on the same Global Account are unaffected.
      expect(((await login('TANJUNG-VIEWER')).body as any).stage).toBe('verify');

      const admin = await signIn(server, 'TANJUNG-VIEWER');
      nextStep();
      const step = ((await call('POST', '/api/security/step-up', { code: await demoCode('session', admin) }, admin, 'security')).body as any).stepUpToken;
      const overview = (await call('GET', '/api/security/overview', null, admin, 'security')).body as any;
      expect(overview.alerts).toHaveLength(1);
      expect(overview.alerts[0]).toMatchObject({ status: 'open', loginId: 'TANJUNG-ADMIN', failedAttempts: 4 });
      expect((await call('POST', '/api/security/users/U-2/waive', { stepUpToken: step }, admin, 'security')).body).toEqual({ code: 'VALIDATION_FAILED' });
      expect((await call('POST', '/api/security/users/U-2/waive', { stepUpToken: step, reason: 'User confirmed typo on new phone' }, admin, 'security')).status).toBe(204);

      token = await challenge('TANJUNG-ADMIN');
      expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: token, code: await demoCode('challenge', token) })).status).toBe(200);
      const after = (await call('GET', '/api/security/overview', null, admin, 'security')).body as any;
      expect(after.alerts[0]).toMatchObject({ status: 'resolved', resolution: 'Block waived' });
    });

    it('a successful code resets the consecutive-failure count', async () => {
      await enrol('123');
      for (let round = 0; round < 2; round++) {
        nextStep();
        const t = await challenge('123');
        for (let i = 0; i < 3; i++) await call('POST', '/api/auth/mfa/verify', { challengeToken: t, code: '000000' });
        expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: t, code: await demoCode('challenge', t) })).status).toBe(200);
      }
    });
  });

  describe('FR-04 recovery codes', () => {
    it('lets a code replace the TOTP once, then forces a new authenticator before access', async () => {
      const { secret: oldSecret, codes } = await enrol('123');
      nextStep();
      const token = await challenge('123');
      const used = await call('POST', '/api/auth/mfa/recovery', { challengeToken: token, code: codes[0].toLowerCase() });
      expect(used.body).toEqual({ stage: 'rebind', recoveryCodesRemaining: 1 });
      // No session yet: a new authenticator must be registered.
      expect((await call('POST', '/api/auth/mfa/setup/complete', { challengeToken: token, acknowledged: true })).body).toEqual({ code: 'MFA_STAGE_INVALID' });
      const e = (await call('POST', '/api/auth/mfa/setup', { challengeToken: token })).body as any;
      expect(e.secret).not.toBe(oldSecret);
      const verified = await call('POST', '/api/auth/mfa/setup/verify', { challengeToken: token, code: await totpAt(e.secret, now) });
      const fresh = (verified.body as any).recoveryCodes as string[];
      expect(fresh).toHaveLength(2);
      expect((await call('POST', '/api/auth/mfa/setup/complete', { challengeToken: token, acknowledged: true })).status).toBe(200);
      expect(emails.at(-1)).toMatchObject({ subject: 'Your Mobi authenticator was replaced' });

      // The old authenticator and old recovery codes no longer work.
      nextStep();
      const t2 = await challenge('123');
      expect(((await call('POST', '/api/auth/mfa/verify', { challengeToken: t2, code: await totpAt(oldSecret, now) })).body as any).code).toBe('MFA_CODE_INVALID');
      expect(((await call('POST', '/api/auth/mfa/recovery', { challengeToken: t2, code: codes[1] })).body as any).code).toBe('MFA_CODE_INVALID');
    });

    it('rejects a used recovery code', async () => {
      const { codes } = await enrol('123');
      const t = await challenge('123');
      await call('POST', '/api/auth/mfa/recovery', { challengeToken: t, code: codes[0] });
      // Abandon the rebind (no new authenticator) and try the same code again.
      const t2 = await challenge('123');
      expect((await call('POST', '/api/auth/mfa/recovery', { challengeToken: t2, code: codes[0] })).body).toEqual({ code: 'RECOVERY_CODE_USED', attemptsRemaining: 3 });
    });

    it('reports when all recovery codes are used', async () => {
      const { codes } = await enrol('123');
      for (const c of codes) await call('POST', '/api/auth/mfa/recovery', { challengeToken: await challenge('123'), code: c });
      expect((await call('POST', '/api/auth/mfa/recovery', { challengeToken: await challenge('123'), code: 'AAAA-BBBB-CCCC' })).body).toEqual({ code: 'RECOVERY_CODES_EXHAUSTED' });
    });

    it('regenerating codes requires the current code and invalidates the old ones', async () => {
      const { codes, session } = await enrol('123');
      nextStep();
      expect((await call('POST', '/api/account/security/recovery-codes', { code: '000000' }, session)).body).toEqual({ code: 'MFA_CODE_INVALID', attemptsRemaining: 3 });
      const res = await call('POST', '/api/account/security/recovery-codes', { code: await demoCode('session', session) }, session);
      const fresh = (res.body as any).recoveryCodes as string[];
      expect(fresh).toHaveLength(2);
      expect(fresh).not.toContain(codes[0]);
      const t = await challenge('123');
      expect(((await call('POST', '/api/auth/mfa/recovery', { challengeToken: t, code: codes[0] })).body as any).code).toBe('MFA_CODE_INVALID');
    });
  });

  describe('FR-06 authenticator replacement', () => {
    it('verifies the current authenticator, then the new one, before revoking the old one', async () => {
      const { secret: oldSecret, session } = await enrol('123');
      nextStep();
      expect((await call('POST', '/api/account/security/authenticator/replace', { code: '000000' }, session)).status).toBe(400);
      const start = (await call('POST', '/api/account/security/authenticator/replace', { code: await totpAt(oldSecret, now) }, session)).body as any;
      expect(start.secret).not.toBe(oldSecret);
      // A wrong code for the new authenticator leaves the old one active.
      expect((await call('POST', '/api/account/security/authenticator/replace/confirm', { replaceToken: start.replaceToken, code: wrong(await totpAt(start.secret, now)) }, session)).status).toBe(400);
      expect((await call('POST', '/api/account/security/authenticator/replace/confirm', { replaceToken: start.replaceToken, code: await totpAt(start.secret, now) }, session)).status).toBe(204);
      expect(emails.at(-1)).toMatchObject({ to: 'sarah.lim@tanjungtrading.example', subject: 'Your Mobi authenticator was replaced' });

      nextStep();
      const t = await challenge('123');
      expect(((await call('POST', '/api/auth/mfa/verify', { challengeToken: t, code: await totpAt(oldSecret, now) })).body as any).code).toBe('MFA_CODE_INVALID');
      expect((await call('POST', '/api/auth/mfa/verify', { challengeToken: t, code: await totpAt(start.secret, now) })).status).toBe(200);
    });
  });

  describe('FR-05 / FR-07 admin reset', () => {
    async function staff(loginId = 'TANJUNG-VIEWER') {
      const token = await signIn(server, loginId);
      return token;
    }
    async function stepUp(token: string, role: string) {
      // A code is accepted once, so wait for the next one after signing in.
      nextStep();
      return ((await call('POST', '/api/security/step-up', { code: await demoCode('session', token) }, token, role)).body as any).stepUpToken as string;
    }

    it('enforces roles: no role, Support, Security Admin', async () => {
      const t = await staff();
      expect((await call('GET', '/api/security/overview', null, t, null)).body).toEqual({ code: 'ROLE_NOT_PERMITTED' });
      expect((await call('GET', '/api/security/overview', null, t, 'sales')).body).toEqual({ code: 'ROLE_NOT_PERMITTED' });
      expect((await call('GET', '/api/security/overview', null, t, 'support')).status).toBe(200);
      expect((await call('GET', '/api/security/overview', null, null, 'security')).status).toBe(401);
      const step = await stepUp(t, 'support');
      // Support can't reset or waive; Security Admin can't open requests.
      expect((await call('POST', '/api/security/users/U-2/reset', { stepUpToken: step }, t, 'support')).body).toEqual({ code: 'ROLE_NOT_PERMITTED' });
      expect((await call('POST', '/api/security/users/U-2/waive', { stepUpToken: step }, t, 'support')).body).toEqual({ code: 'ROLE_NOT_PERMITTED' });
      expect((await call('POST', '/api/security/reset-requests', { userId: 'U-2', reason: 'x', reference: 'y', stepUpToken: step }, t, 'security')).body).toEqual({ code: 'ROLE_NOT_PERMITTED' });
    });

    it('requires the admin to confirm their own identity first', async () => {
      const t = await staff();
      expect((await call('POST', '/api/security/reset-requests', { userId: 'U-2', reason: 'Lost phone', reference: 'CS-1' }, t, 'support')).body).toEqual({ code: 'STEP_UP_REQUIRED' });
      const step = await stepUp(t, 'support');
      advance(MFA_POLICY.stepUpTtlMs + 1);
      expect((await call('POST', '/api/security/reset-requests', { userId: 'U-2', reason: 'Lost phone', reference: 'CS-1', stepUpToken: step }, t, 'support')).body).toEqual({ code: 'STEP_UP_REQUIRED' });
    });

    it('never shows secrets or recovery codes to admins', async () => {
      const { secret, codes } = await enrol('123');
      const t = await staff();
      const raw = JSON.stringify((await call('GET', '/api/security/overview', null, t, 'security')).body) + JSON.stringify((await call('GET', '/api/security/audit', null, t, 'security')).body);
      expect(raw).not.toContain(secret);
      codes.forEach((c) => expect(raw).not.toContain(c));
      expect(raw).not.toMatch(/secret/i);
    });

    it('Support opens a request, Security Admin verifies identity and resets; user must register again', async () => {
      const user = await signIn(server, 'TANJUNG-ADMIN');
      const support = await staff('TANJUNG-VIEWER');
      nextStep();
      const sStep = await stepUp(support, 'support');
      const created = await call('POST', '/api/security/reset-requests', { userId: 'U-2', reason: 'User lost phone and codes', reference: 'CS-48213', stepUpToken: sStep }, support, 'support');
      expect(created).toEqual({ status: 201, body: { id: 'RST-0001' } });
      expect((await call('POST', '/api/security/reset-requests', { userId: 'U-2', reason: 'again', reference: 'CS-2', stepUpToken: sStep }, support, 'support')).body).toEqual({ code: 'RESET_REQUEST_EXISTS' });

      // A different person acts as Security Admin.
      await enrol('123');
      const sec = (await login('123')).body as any;
      nextStep();
      const secToken = ((await call('POST', '/api/auth/mfa/verify', { challengeToken: sec.challengeToken, code: await demoCode('challenge', sec.challengeToken) })).body as any).token;
      nextStep();
      const aStep = await stepUp(secToken, 'security');
      const body = { requestId: 'RST-0001', identityVerified: true, verificationMethod: 'Video call, photo ID matched', reason: 'Lost device, verified', stepUpToken: aStep };
      expect((await call('POST', '/api/security/users/U-2/reset', { ...body, identityVerified: false }, secToken, 'security')).body).toEqual({ code: 'VALIDATION_FAILED' });
      expect((await call('POST', '/api/security/users/U-2/reset', { ...body, requestId: 'RST-9999' }, secToken, 'security')).body).toEqual({ code: 'RESET_REQUEST_REQUIRED' });
      expect((await call('POST', '/api/security/users/U-2/reset', body, secToken, 'security')).status).toBe(204);

      // The user's sessions end, they must set up a new authenticator, and they're told by email.
      expect((await call('GET', '/api/auth/session', null, user)).body).toEqual({ code: 'MFA_RESET' });
      expect(((await login('TANJUNG-ADMIN')).body as any).stage).toBe('setup');
      expect(emails.at(-1)).toMatchObject({ to: 'aisyah@tanjungtrading.example', subject: 'Your Mobi two-factor authentication was reset' });

      const audit = (await call('GET', '/api/security/audit', null, secToken, 'security')).body as any[];
      const reset = audit.find((e) => e.type === 'MFA_RESET');
      expect(reset).toMatchObject({ actor: 'Sarah Lim (Security Admin)', loginId: 'TANJUNG-ADMIN', reason: 'Lost device, verified' });
      expect(audit.find((e) => e.type === 'IDENTITY_VERIFIED').detail).toContain('Video call, photo ID matched');
      expect(audit.find((e) => e.type === 'MFA_RESET_REQUESTED')).toMatchObject({ actor: 'Budi Santoso (Mobi Support)', reason: 'User lost phone and codes' });
    });

    it('nobody can act on their own account', async () => {
      const t = await staff();
      const step = await stepUp(t, 'support');
      expect((await call('POST', '/api/security/reset-requests', { userId: 'U-3', reason: 'self', reference: 'X', stepUpToken: step }, t, 'support')).body).toEqual({ code: 'ROLE_NOT_PERMITTED' });
    });

    it('too many wrong codes while signed in blocks the user and ends their sessions', async () => {
      const t = await staff();
      for (let i = 0; i < 3; i++) await call('POST', '/api/security/step-up', { code: '000000' }, t, 'security');
      expect((await call('POST', '/api/security/step-up', { code: '000000' }, t, 'security')).body).toEqual({ code: 'MFA_BLOCKED' });
      expect((await call('GET', '/api/auth/session', null, t)).body).toEqual({ code: 'MFA_BLOCKED' });
    });
  });

  describe('FR-09 rollout of existing sessions', () => {
    it('keeps data but ends every existing session when upgrading from the pre-2FA store', async () => {
      const key = 'mobi.gp.mockdb';
      // Simulate a pre-2FA (version 4) store with a live session.
      await server.resetAll();
      const db = JSON.parse(storage.getItem(key)!);
      const { mfa, challenges, stepUps, resetRequests, alerts, ...v4 } = db;
      void mfa, challenges, stepUps, resetRequests, alerts;
      v4.version = 4;
      v4.sessions = [{ tokenHash: 'abc', userId: 'U-1', createdAt: now, lastSeenAt: now, absoluteExpiresAt: now + 3_600_000 }];
      storage.setItem(key, JSON.stringify(v4));

      const upgraded = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => undefined });
      expect(((await upgraded.handle('POST', '/api/auth/login', { loginId: '123', password: DEMO_PASSWORD }, null)).body as any).stage).toBe('setup');
      const after = JSON.parse(storage.getItem(key)!);
      expect(after.version).toBe(5);
      expect(after.sessions).toEqual([]);
      expect(after.revokedSessions.at(-1)).toMatchObject({ tokenHash: 'abc', reason: 'MFA_REQUIRED' });
      expect(after.users).toHaveLength(v4.users.length);
    });
  });
});
