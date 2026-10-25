// Placeholder global password policy, modelled on NIST SP 800-63B and OWASP ASVS:
// length-based, no arbitrary composition rules, blocklist of common/breached values.
// Values are pending Product approval.

export const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 128,
} as const;

export type PasswordViolation = 'too_short' | 'too_long' | 'common' | 'repetitive' | 'contains_identity';

export const PASSWORD_VIOLATION_TEXT: Record<PasswordViolation, string> = {
  too_short: `Use at least ${PASSWORD_POLICY.minLength} characters.`,
  too_long: `Use no more than ${PASSWORD_POLICY.maxLength} characters.`,
  common: 'This password is too common or has appeared in a data breach.',
  repetitive: 'Avoid repeated or sequential characters such as "aaaa" or "1234".',
  contains_identity: 'Don’t include your Global Account ID or email address.',
};

// Prototype stand-in for a breached-password service (e.g. a k-anonymity lookup).
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'password@123',
  'passwordpassword', 'p@ssw0rd', 'p@ssw0rd1234', '123456', '12345678', '123456789',
  '1234567890', '123456789012', '111111111111', '000000000000', 'qwerty', 'qwerty123',
  'qwerty123456', 'qwertyuiop', 'qwertyuiop12', 'iloveyou', 'iloveyou1234', 'admin',
  'admin123', 'admin1234567', 'administrator', 'welcome', 'welcome123', 'welcome12345',
  'letmein', 'letmein12345', 'changeme', 'changeme1234', 'abc123', 'abcdefghijkl',
  'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'trustno1',
  'mobi', 'mobi@123', 'mobi123', 'mobi@1234', 'mobi@12345', 'mobi@123456', 'mobiplatform',
  'mobiplatform1', 'mobiglobal', 'mobiglobal123', 'globalplatform', 'mobi@2026',
]);

function isRepetitiveOrSequential(pw: string): boolean {
  if (/^(.)\1+$/.test(pw)) return true;
  const seqs = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl'];
  const lower = pw.toLowerCase();
  return seqs.some((s) => s.includes(lower) || [...s].reverse().join('').includes(lower));
}

export interface PasswordContext {
  loginId?: string;
  email?: string;
}

export function checkPassword(raw: string, ctx: PasswordContext = {}): PasswordViolation[] {
  const pw = raw.normalize('NFKC');
  const violations: PasswordViolation[] = [];
  const length = [...pw].length;
  if (length < PASSWORD_POLICY.minLength) violations.push('too_short');
  if (length > PASSWORD_POLICY.maxLength) violations.push('too_long');

  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) violations.push('common');
  if (pw.length > 0 && isRepetitiveOrSequential(pw)) violations.push('repetitive');

  const identityParts = [ctx.loginId, ctx.email?.split('@')[0]]
    .filter((p): p is string => !!p && p.length >= 3)
    .map((p) => p.toLowerCase());
  if (identityParts.some((p) => lower.includes(p))) violations.push('contains_identity');

  return violations;
}
