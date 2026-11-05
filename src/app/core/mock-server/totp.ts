// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30-second period) and the helpers the simulated
// backend needs around it: Base32 secrets, otpauth:// URIs, recovery codes and
// encryption of secrets at rest. Uses only the Web Crypto API.

export const TOTP = {
  digits: 6,
  periodSec: 30,
  /** Accepted clock drift either side of "now", in periods (±30 s). */
  driftSteps: 1,
  issuer: 'Mobi Global Platform',
} as const;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid Base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new 160-bit secret, as recommended by RFC 4226 §4. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP.periodSec);
}

export function secondsLeftInStep(nowMs: number): number {
  return TOTP.periodSec - (Math.floor(nowMs / 1000) % TOTP.periodSec);
}

/** RFC 4226 HOTP for one counter value. */
export async function hotp(secretBase32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretBase32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return (bin % 10 ** TOTP.digits).toString().padStart(TOTP.digits, '0');
}

export function totpAt(secretBase32: string, nowMs: number): Promise<string> {
  return hotp(secretBase32, timeStep(nowMs));
}

/**
 * Checks a code against the current step and the allowed drift window.
 * Returns the matched step, or null. Steps at or before `lastUsedStep` are not accepted
 * (each code works once), and `replay` reports a code that matched an already-used step.
 */
export async function verifyTotp(secretBase32: string, code: string, nowMs: number, lastUsedStep: number): Promise<{ step: number | null; replay: boolean }> {
  if (!/^\d{6}$/.test(code)) return { step: null, replay: false };
  const current = timeStep(nowMs);
  let replay = false;
  for (let d = -TOTP.driftSteps; d <= TOTP.driftSteps; d++) {
    const step = current + d;
    if ((await hotp(secretBase32, step)) === code) {
      if (step > lastUsedStep) return { step, replay: false };
      replay = true;
    }
  }
  return { step: null, replay };
}

export function otpauthUri(secretBase32: string, accountLabel: string): string {
  const label = encodeURIComponent(`${TOTP.issuer}:${accountLabel}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer: TOTP.issuer, algorithm: 'SHA1', digits: String(TOTP.digits), period: String(TOTP.periodSec) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Groups a Base32 secret in fours so it is easier to type by hand. */
export function formatSecret(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, '$1 ').trim();
}

// ------------------------------------------------------------ recovery codes

// No 0/O, 1/I/L, so codes can be read and typed without ambiguity.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A recovery code like "K7QM-2XRP-H9WD" (60 bits of entropy). */
export function generateRecoveryCode(): string {
  const chars: string[] = [];
  const buf = new Uint8Array(1);
  while (chars.length < 12) {
    crypto.getRandomValues(buf);
    // Rejection sampling keeps every character equally likely.
    if (buf[0] < 248) chars.push(RECOVERY_ALPHABET[buf[0] % RECOVERY_ALPHABET.length]);
  }
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join('')).join('-');
}

export function normaliseRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

// ------------------------------------------------------ secrets at rest

/**
 * Encrypts authenticator secrets with AES-GCM. In production the key lives in a KMS/HSM
 * that only the verification service can use; the prototype keeps a generated key in
 * browser storage, which simulates the separation but is not secure.
 */
export class SecretVault {
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>, private readonly storageKey = 'mobi.gp.mockkms') {}

  private getKey(): Promise<CryptoKey> {
    return (this.key ??= (async () => {
      const raw = this.storage.getItem(this.storageKey);
      if (raw) return crypto.subtle.importKey('jwk', JSON.parse(raw), 'AES-GCM', true, ['encrypt', 'decrypt']);
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      this.storage.setItem(this.storageKey, JSON.stringify(await crypto.subtle.exportKey('jwk', key)));
      return key;
    })());
  }

  async encrypt(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.getKey(), new TextEncoder().encode(plain)));
    return `${toB64(iv)}.${toB64(ct)}`;
  }

  async decrypt(sealed: string): Promise<string> {
    const [iv, ct] = sealed.split('.');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await this.getKey(), fromB64(ct));
    return new TextDecoder().decode(plain);
  }
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
