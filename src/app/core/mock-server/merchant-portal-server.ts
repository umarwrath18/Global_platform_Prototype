import {
  CURRENCY_DECIMALS,
  DatePreset,
  MerchantPortalOverview,
  MerchantTransaction,
  PortalPaymentMethod,
  TRANSACTION_STATUS_LABEL,
  TransactionExport,
  TransactionPage,
  TransactionStatus,
  TransactionSummary,
} from '../merchants/merchant-portal';
import type { AuthServer } from './auth-server';
import type { MerchantPortalProfile } from './merchant-server';

/**
 * Simulated backend for the merchant-facing portal (Dashboard, My Transactions).
 *
 * There is no transaction or balance source in this codebase, so this service generates SAMPLE
 * data per merchant, only for its live countries and switched-on payment methods, and every
 * response says `sampleData: true`. It replaces nothing real; swap it for Mobi's transaction and
 * balance APIs (same contract, see merchant-portal.ts) when they exist.
 *
 * Isolation: the merchant is always taken from the signed-in session, never from the request.
 */

const STORAGE_KEY = 'mobi.gp.merchantportal';
const DB_VERSION = 1;
const HISTORY_DAYS = 90;
const MAX_EXPORT_ROWS = 10_000;
const PAGE_SIZES = [10, 25, 50, 100];
const STATUSES: TransactionStatus[] = ['successful', 'failed', 'pending', 'refunded'];

interface StoredTxn {
  invoiceId: string;
  transactionId: string;
  method: string;
  createdAt: number;
  amount: number;
  currency: string;
  status: TransactionStatus;
}

interface PortalDb {
  version: number;
  merchants: Record<string, { generatedAt: number; transactions: StoredTxn[] }>;
}

interface Reply {
  status: number;
  body: unknown;
}

class PortalError {
  constructor(
    readonly status: number,
    readonly body: { code: string; message?: string },
  ) {}
}

const fail = (status: number, code: string, message?: string): never => {
  throw new PortalError(status, message ? { code, message } : { code });
};

export interface MerchantPortalServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  auth: Pick<AuthServer, 'authenticate'>;
  profile: (merchantId: string) => MerchantPortalProfile | null;
  now?: () => number;
}

/** Amount range per currency for sample data, in major units. */
const AMOUNT_RANGE: Record<string, [number, number]> = {
  MYR: [8, 900],
  IDR: [25_000, 4_500_000],
  VND: [50_000, 9_000_000],
  THB: [60, 9_000],
  PHP: [100, 15_000],
};

export class MerchantPortalServer {
  private readonly now: () => number;

  constructor(private readonly opts: MerchantPortalServerOptions) {
    this.now = opts.now ?? Date.now;
  }

  static handles(path: string) {
    return /^\/api\/merchant-portal(\/|\?|$)/.test(path);
  }

  async handle(method: string, path: string, token: string | null): Promise<Reply> {
    const auth = await this.opts.auth.authenticate(token, 'merchant');
    if (!auth.ok) return auth.response;
    try {
      const merchantId = auth.caller.merchantId!;
      const profile = this.opts.profile(merchantId);
      if (!profile) fail(404, 'NOT_FOUND');
      const [rawPath, rawQuery] = path.split('?');
      const q = new URLSearchParams(rawQuery ?? '');
      const route = `${method.toUpperCase()} ${rawPath}`;
      switch (route) {
        case 'GET /api/merchant-portal/settings':
          return { status: 200, body: profile!.settings };
        case 'GET /api/merchant-portal/overview':
          return { status: 200, body: this.overview(profile!) };
        case 'GET /api/merchant-portal/summary':
          return { status: 200, body: this.summary(profile!, q) };
        case 'GET /api/merchant-portal/transactions':
          return { status: 200, body: this.list(profile!, q) };
        case 'GET /api/merchant-portal/transactions/export':
          return { status: 200, body: this.export(profile!, q) };
        default:
          return fail(404, 'NOT_FOUND');
      }
    } catch (e) {
      if (e instanceof PortalError) return { status: e.status, body: e.body };
      throw e;
    }
  }

  // ----------------------------------------------------------------- reads

  private overview(profile: MerchantPortalProfile): MerchantPortalOverview {
    const txns = this.transactions(profile);
    const since = this.now() - 7 * 86_400_000;
    // SAMPLE balance: successful minus refunded amounts of the last 7 days, per currency.
    // A real available balance comes from the ledger (settlements, reserves, fees), not from this.
    const balances = profile.countries.map((c) => {
      const sum = txns
        .filter((t) => t.currency === c.currency && t.createdAt >= since)
        .reduce((s, t) => s + (t.status === 'successful' ? t.amount : t.status === 'refunded' ? -t.amount : 0), 0);
      return { currency: c.currency, available: round(Math.max(0, sum), c.currency) };
    });
    return { merchant: { id: profile.id, name: profile.legalName }, balances, asOf: this.now(), paymentMethods: methodsOf(profile), sampleData: true };
  }

  private summary(profile: MerchantPortalProfile, q: URLSearchParams): TransactionSummary {
    const range = q.get('range') ?? 'today';
    if (!['today', '7d', '30d'].includes(range)) fail(400, 'VALIDATION_FAILED', 'Unknown date range.');
    const { from, to } = this.presetBounds(range as DatePreset);
    const inRange = this.transactions(profile).filter((t) => t.createdAt >= from && t.createdAt <= to);
    return {
      from,
      to,
      total: inRange.length,
      successful: inRange.filter((t) => t.status === 'successful').length,
      failed: inRange.filter((t) => t.status === 'failed').length,
      sampleData: true,
    };
  }

  private list(profile: MerchantPortalProfile, q: URLSearchParams): TransactionPage {
    const rows = this.filtered(profile, q);
    const pageSize = Number(q.get('pageSize') ?? 25);
    const page = Number(q.get('page') ?? 1);
    if (!PAGE_SIZES.includes(pageSize) || !Number.isInteger(page) || page < 1) fail(400, 'VALIDATION_FAILED', 'Invalid page.');
    const start = (page - 1) * pageSize;
    return { items: rows.slice(start, start + pageSize), total: rows.length, page, pageSize, sampleData: true };
  }

  private export(profile: MerchantPortalProfile, q: URLSearchParams): TransactionExport {
    const rows = this.filtered(profile, q);
    if (rows.length > MAX_EXPORT_ROWS) fail(413, 'EXPORT_TOO_LARGE', `Exports are limited to ${MAX_EXPORT_ROWS.toLocaleString('en-US')} rows. Narrow the filters and try again.`);
    const header = ['Invoice ID', 'Transaction ID', 'Payment Method', 'Date & Time', 'Amount', 'Currency', 'Status'];
    const lines = [header, ...rows.map((t) => [t.invoiceId, t.transactionId, t.paymentMethod.name, localDateTime(t.createdAt), t.amount.toFixed(CURRENCY_DECIMALS[t.currency] ?? 2), t.currency, TRANSACTION_STATUS_LABEL[t.status]])];
    const csv = lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
    return { filename: `${slug(profile.legalName)}-transactions-${localDate(this.now())}.csv`, csv, rows: rows.length };
  }

  /** Validates the filters and returns the merchant's matching transactions, newest first. */
  private filtered(profile: MerchantPortalProfile, q: URLSearchParams): MerchantTransaction[] {
    const range = q.get('range') ?? '30d';
    let bounds: { from: number; to: number };
    if (range === 'custom') {
      const from = parseLocalDate(q.get('from'));
      const to = parseLocalDate(q.get('to'));
      if (from === null || to === null || from > to) fail(400, 'VALIDATION_FAILED', 'Choose a valid date range.');
      if (to! - from! > 366 * 86_400_000) fail(400, 'VALIDATION_FAILED', 'Choose a range of one year or less.');
      bounds = { from: from!, to: to! + 86_400_000 - 1 };
    } else if (['today', '7d', '30d'].includes(range)) {
      bounds = this.presetBounds(range as DatePreset);
    } else {
      return fail(400, 'VALIDATION_FAILED', 'Unknown date range.');
    }

    const methods = methodsOf(profile);
    const method = q.get('method') || null;
    // Only the merchant's own enabled payment methods can be filtered on.
    if (method && !methods.some((m) => m.code === method)) fail(400, 'VALIDATION_FAILED', 'Unknown payment method.');
    const status = q.get('status') || null;
    if (status && !STATUSES.includes(status as TransactionStatus)) fail(400, 'VALIDATION_FAILED', 'Unknown status.');
    const search = (q.get('q') ?? '').trim().toUpperCase();
    if (search.length > 64 || /[^A-Z0-9-]/.test(search)) fail(400, 'VALIDATION_FAILED', 'Transaction IDs contain only letters, numbers and dashes.');

    const names = new Map(methods.map((m) => [m.code, m.name]));
    return this.transactions(profile)
      .filter((t) => t.createdAt >= bounds.from && t.createdAt <= bounds.to)
      .filter((t) => !method || t.method === method)
      .filter((t) => !status || t.status === status)
      .filter((t) => !search || t.transactionId.includes(search))
      .map((t) => ({ invoiceId: t.invoiceId, transactionId: t.transactionId, paymentMethod: { code: t.method, name: names.get(t.method) ?? t.method }, createdAt: t.createdAt, amount: t.amount, currency: t.currency, status: t.status }));
  }

  private presetBounds(range: DatePreset) {
    const now = this.now();
    const days = range === 'today' ? 0 : range === '7d' ? 6 : 29;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days);
    return { from: start.getTime(), to: now };
  }

  // ------------------------------------------------------- sample data store

  /**
   * The merchant's stored sample transactions (newest first). Generated on first use and again
   * each new day, so "Today" and the rolling ranges always have sample activity.
   */
  private transactions(profile: MerchantPortalProfile): StoredTxn[] {
    const db = this.load();
    let entry = db.merchants[profile.id];
    if (!entry || localDate(entry.generatedAt) !== localDate(this.now())) {
      entry = { generatedAt: this.now(), transactions: generate(profile, this.now()) };
      db.merchants[profile.id] = entry;
      this.opts.storage.setItem(STORAGE_KEY, JSON.stringify(db));
    }
    return entry.transactions.filter((t) => t.createdAt <= this.now());
  }

  private load(): PortalDb {
    try {
      const db = JSON.parse(this.opts.storage.getItem(STORAGE_KEY) ?? 'null') as PortalDb | null;
      if (db?.version === DB_VERSION) return db;
    } catch {
      // Unreadable sample data is simply regenerated; it holds nothing a user entered.
    }
    return { version: DB_VERSION, merchants: {} };
  }

  resetAll() {
    this.opts.storage.removeItem(STORAGE_KEY);
  }
}

// ------------------------------------------------------------------ helpers

function methodsOf(profile: MerchantPortalProfile): PortalPaymentMethod[] {
  return profile.countries.flatMap((c) => c.methods.map((m) => ({ code: m.code, name: m.name, country: c.code })));
}

/** Deterministic PRNG so a merchant's sample data is stable across resets. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function round(n: number, currency: string) {
  const d = CURRENCY_DECIMALS[currency] ?? 2;
  return Math.round(n * 10 ** d) / 10 ** d;
}

/** About 2–3 transactions a day over 90 days, spread over the merchant's live methods. */
export function generate(profile: MerchantPortalProfile, now: number): StoredTxn[] {
  const methods = profile.countries.flatMap((c) => c.methods.map((m) => ({ code: m.code, currency: c.currency })));
  if (!methods.length) return [];
  const rand = mulberry32(hash(profile.id));
  const out: StoredTxn[] = [];
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let seq = 0;
  for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
    const dayStart = today.getTime() - d * 86_400_000;
    const count = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < count; i++) {
      const at = dayStart + Math.floor((8 + rand() * 14) * 3_600_000) + Math.floor(rand() * 3_600_000);
      // Today's sample transactions are spread over the hours already passed.
      const createdAt = d === 0 ? Math.min(at, dayStart + Math.floor(rand() * Math.max(1, now - dayStart))) : at;
      const m = methods[Math.floor(rand() * methods.length)];
      const [min, max] = AMOUNT_RANGE[m.currency] ?? [10, 1000];
      const raw = min + rand() * rand() * (max - min);
      const amount = m.currency === 'IDR' ? Math.round(raw / 100) * 100 : m.currency === 'VND' ? Math.round(raw / 1000) * 1000 : round(raw, m.currency);
      const r = rand();
      const recent = now - createdAt < 2 * 86_400_000;
      const status: TransactionStatus = r < 0.1 ? 'failed' : r < 0.14 ? (recent ? 'pending' : 'successful') : r < 0.17 ? 'refunded' : 'successful';
      seq++;
      const date = localDate(createdAt).replace(/-/g, '');
      out.push({
        invoiceId: `INV-${date}-${String(seq).padStart(4, '0')}`,
        transactionId: `TXN${date}${Math.floor(rand() * 0xffffff).toString(16).toUpperCase().padStart(6, '0')}${String(seq % 100).padStart(2, '0')}`,
        method: m.code,
        createdAt,
        amount,
        currency: m.currency,
        status,
      });
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

const pad = (n: number) => String(n).padStart(2, '0');

function localDate(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDateTime(t: number) {
  const d = new Date(t);
  return `${localDate(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseLocalDate(v: string | null): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : null;
}

/** Quotes a CSV cell and neutralises spreadsheet formulas (CSV injection). */
function csvCell(v: string) {
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'merchant'
  );
}
