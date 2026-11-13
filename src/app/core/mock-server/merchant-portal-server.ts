import { DatePreset, MerchantPortalOverview, PortalPaymentMethod, TransactionSummary } from '../merchants/merchant-portal';
import { TXN_FLOWS, TxnFlow } from '../transactions/transactions';
import type { AuthServer } from './auth-server';
import type { MerchantPortalProfile } from './merchant-server';
import type { TransactionServer } from './transaction-server';

/**
 * Simulated backend for the merchant-facing portal (Dashboard, My Transactions).
 *
 * Transactions come from the same records as the Global Platform's Transactions page (see
 * transaction-server.ts and transaction-data.ts), so both views always agree. They are SAMPLE data
 * for the merchant's live countries and switched-on payment methods, and every response says
 * `sampleData: true`.
 *
 * Isolation: the merchant is always taken from the signed-in session, never from the request.
 */

/** Old per-merchant sample store (before the shared transaction records); removed on first use. */
const LEGACY_KEY = 'mobi.gp.merchantportal';

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
  transactions: Pick<TransactionServer, 'merchantList' | 'merchantDetail' | 'merchantExport' | 'merchantRows'>;
  now?: () => number;
}

export class MerchantPortalServer {
  private readonly now: () => number;

  constructor(private readonly opts: MerchantPortalServerOptions) {
    this.now = opts.now ?? Date.now;
    opts.storage.removeItem(LEGACY_KEY);
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
      if (method.toUpperCase() !== 'GET') return fail(404, 'NOT_FOUND');
      const seg = rawPath.split('/').filter(Boolean); // api, merchant-portal, ...
      const flowOf = (v: string | null): TxnFlow => (TXN_FLOWS.includes((v ?? 'payin') as TxnFlow) ? ((v ?? 'payin') as TxnFlow) : fail(400, 'VALIDATION_FAILED', 'Unknown flow.'));
      switch (seg.slice(2).join('/')) {
        case 'settings':
          return { status: 200, body: profile!.settings };
        case 'overview':
          return { status: 200, body: this.overview(profile!) };
        case 'summary':
          return { status: 200, body: this.summary(profile!, q) };
        case 'transactions':
          return { status: 200, body: { ...this.opts.transactions.merchantList(profile!.id, flowOf(q.get('flow')), q), underReview: profile!.underReview } };
        case 'transactions/export':
          // Under review (fraud or compliance suspension): read only, no exports.
          if (profile!.underReview) fail(403, 'ACCOUNT_UNDER_REVIEW', 'Not available while your account is under review.');
          return { status: 200, body: this.opts.transactions.merchantExport(profile!.id, profile!.legalName, flowOf(q.get('flow')), q) };
      }
      // GET /api/merchant-portal/transactions/{flow}/{id}
      if (seg[2] === 'transactions' && seg.length === 5) return { status: 200, body: this.opts.transactions.merchantDetail(profile!.id, flowOf(seg[3]), seg[4]) };
      return fail(404, 'NOT_FOUND');
    } catch (e: any) {
      if (e instanceof PortalError) return { status: e.status, body: e.body };
      // Errors from the transaction service have the same shape.
      if (e && typeof e.status === 'number' && e.body && typeof e.body.code === 'string') return { status: e.status, body: e.body };
      throw e;
    }
  }

  // ----------------------------------------------------------------- reads

  private overview(profile: MerchantPortalProfile): MerchantPortalOverview {
    const since = this.now() - 7 * 86_400_000;
    const rows = this.opts.transactions.merchantRows(profile.id, 'payin').filter((t) => t.createdAt >= since && t.status === 'successful');
    // SAMPLE balance: net of the last 7 days' successful pay-ins, per currency. A real available
    // balance comes from the ledger (settlements, payouts, reserves), not from this.
    const balances = profile.countries.map((c) => {
      const sum = rows.filter((t) => t.currency === c.currency).reduce((s, t) => s + (t.net ?? t.amount), 0);
      return { currency: c.currency, available: round(Math.max(0, sum), c.currency) };
    });
    return { merchant: { id: profile.id, name: profile.legalName }, balances, asOf: this.now(), paymentMethods: methodsOf(profile), underReview: profile.underReview, sampleData: true };
  }

  /** Dashboard figures: pay-ins in the period. */
  private summary(profile: MerchantPortalProfile, q: URLSearchParams): TransactionSummary {
    const range = q.get('range') ?? 'today';
    if (!['today', '7d', '30d'].includes(range)) fail(400, 'VALIDATION_FAILED', 'Unknown date range.');
    const { from, to } = this.presetBounds(range as DatePreset);
    const inRange = this.opts.transactions.merchantRows(profile.id, 'payin').filter((t) => t.createdAt >= from && t.createdAt <= to);
    return {
      from,
      to,
      total: inRange.length,
      successful: inRange.filter((t) => t.status === 'successful').length,
      failed: inRange.filter((t) => t.status === 'failed').length,
      sampleData: true,
    };
  }

  private presetBounds(range: DatePreset) {
    const now = this.now();
    const days = range === 'today' ? 0 : range === '7d' ? 6 : 29;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days);
    return { from: start.getTime(), to: now };
  }

  /** Prototype/QA: the transaction records are generated, so there is nothing to reset here. */
  resetAll() {
    this.opts.storage.removeItem(LEGACY_KEY);
  }
}

// ------------------------------------------------------------------ helpers

function methodsOf(profile: MerchantPortalProfile): PortalPaymentMethod[] {
  return profile.countries.flatMap((c) => c.methods.map((m) => ({ code: m.code, name: m.name, country: c.code })));
}

function round(n: number, currency: string) {
  const d = currency === 'IDR' || currency === 'VND' ? 0 : 2;
  return Math.round(n * 10 ** d) / 10 ** d;
}
