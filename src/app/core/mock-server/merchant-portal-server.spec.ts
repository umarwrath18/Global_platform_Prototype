import { beforeEach, describe, expect, it } from 'vitest';
import { MerchantPortalOverview, TransactionExport, TransactionPage, TransactionSummary } from '../merchants/merchant-portal';
import { TransactionServer } from './transaction-server';
import { AuthServer } from './auth-server';
import { MerchantPortalServer } from './merchant-portal-server';
import { MerchantServer } from './merchant-server';
import { signIn } from './testing/sign-in';

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

describe('Merchant portal', () => {
  let now: number;
  let auth: AuthServer;
  let merchants: MerchantServer;
  let portal: MerchantPortalServer;
  let tanjung: string;

  const get = <T>(path: string, token: string | null = tanjung) => portal.handle('GET', path, token) as Promise<{ status: number; body: T }>;
  const list = (query: string, token?: string) => get<TransactionPage>(`/api/merchant-portal/transactions?flow=payin&${query}`, token);

  beforeEach(async () => {
    now = new Date(2026, 10, 5, 15, 30).getTime();
    const storage = new MemoryStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {}, merchantName: (id) => merchants.portalProfile(id)?.legalName ?? null });
    merchants = new MerchantServer({ storage, now: () => now, auth });
    const transactions = new TransactionServer({ storage, auth, sources: () => merchants.transactionSources(), now: () => now });
    portal = new MerchantPortalServer({ storage, auth, profile: (id) => merchants.portalProfile(id), transactions, now: () => now });
    tanjung = await signIn(auth, 'TANJUNG-MERCHANT');
  });

  describe('session', () => {
    it('marks merchant users and lands them on the merchant dashboard', async () => {
      const s = (await auth.handle('GET', '/api/auth/session', null, tanjung)).body as any;
      expect(s).toMatchObject({ portal: 'merchant', landingPath: '/dashboard', merchant: { id: 'GM-100101', name: 'Tanjung Global Trading Sdn Bhd' } });
      const internal = (await auth.handle('GET', '/api/auth/session', null, await signIn(auth, '123'))).body as any;
      expect(internal).toMatchObject({ portal: 'internal', landingPath: '/dashboard', merchant: null });
    });

    it('each app signs in only its own kind of user (checked after the password)', async () => {
      const login = (loginId: string, portal: string, password = 'Mobi@123') => auth.handle('POST', '/api/auth/login', { loginId, password, portal }, null);
      expect(await login('TANJUNG-MERCHANT', 'internal')).toEqual({ status: 403, body: { code: 'WRONG_PORTAL' } });
      expect(await login('123', 'merchant')).toEqual({ status: 403, body: { code: 'WRONG_PORTAL' } });
      // A wrong password gives the usual answer, so the check reveals nothing about the account.
      expect((await login('TANJUNG-MERCHANT', 'internal', 'wrong')).body).toEqual({ code: 'INVALID_CREDENTIALS' });
      expect((await login('TANJUNG-MERCHANT', 'merchant')).status).toBe(200);
      expect((await login('123', 'internal')).status).toBe(200);
    });

    it('requires completed 2FA: a password alone gives no access', async () => {
      const login = await auth.handle('POST', '/api/auth/login', { loginId: 'TANJUNG-MERCHANT', password: 'Mobi@123' }, null);
      expect(login.body).not.toHaveProperty('token');
      expect((await get('/api/merchant-portal/overview', null)).status).toBe(401);
    });
  });

  describe('dashboard', () => {
    it('shows an available balance per live currency, from the merchant’s own data only', async () => {
      const o = (await get<MerchantPortalOverview>('/api/merchant-portal/overview')).body;
      expect(o.merchant).toEqual({ id: 'GM-100101', name: 'Tanjung Global Trading Sdn Bhd' });
      expect(o.balances.map((b) => b.currency)).toEqual(['MYR', 'IDR', 'VND']);
      o.balances.forEach((b) => expect(b.available).toBeGreaterThanOrEqual(0));
      expect(o.sampleData).toBe(true);
    });

    it('lists only payment methods switched on in the merchant’s live countries', async () => {
      const o = (await get<MerchantPortalOverview>('/api/merchant-portal/overview')).body;
      const profile = merchants.portalProfile('GM-100101')!;
      expect(o.paymentMethods.map((m) => m.code)).toEqual(profile.countries.flatMap((c) => c.methods.map((m) => m.code)));
      expect(new Set(o.paymentMethods.map((m) => m.country))).toEqual(new Set(['MY', 'ID', 'VN']));
    });

    it('summarises total, successful and failed for each date range', async () => {
      const s = async (range: string) => (await get<TransactionSummary>(`/api/merchant-portal/summary?range=${range}`)).body;
      const [today, week, month] = [await s('today'), await s('7d'), await s('30d')];
      expect(today.total).toBeLessThanOrEqual(week.total);
      expect(week.total).toBeLessThanOrEqual(month.total);
      expect(month.total).toBeGreaterThan(0);
      for (const x of [today, week, month]) expect(x.successful + x.failed).toBeLessThanOrEqual(x.total);
      // The summary matches the list for the same range.
      const all = (await list('range=7d&pageSize=50')).body;
      expect(all.total).toBe(week.total);
      expect((await list('range=7d&status=failed')).body.total).toBe(week.failed);
      expect((await get('/api/merchant-portal/summary?range=year')).status).toBe(400);
    });
  });

  describe('transactions', () => {
    it('returns records newest first with the required fields, and no provider details', async () => {
      const p = (await list('range=30d')).body;
      expect(p.items.length).toBe(25);
      const t = p.items[0];
      expect(Object.keys(t).sort()).toEqual(['amount', 'createdAt', 'currency', 'fee', 'flow', 'invoiceId', 'methodCode', 'methodName', 'net', 'paymentType', 'status', 'subMerchantName', 'transactionId']);
      for (let i = 1; i < p.items.length; i++) expect(p.items[i - 1].createdAt).toBeGreaterThanOrEqual(p.items[i].createdAt);
      expect(JSON.stringify(p.items)).not.toMatch(/host|provider|acquirer|route/i);
    });

    it('filters by payment method, status and transaction ID', async () => {
      const method = (await get<MerchantPortalOverview>('/api/merchant-portal/overview')).body.paymentMethods[0].code;
      const byMethod = (await list(`range=30d&method=${method}&pageSize=50`)).body;
      expect(byMethod.items.every((t) => t.methodCode === method)).toBe(true);
      const failed = (await list('range=30d&status=failed&pageSize=50')).body;
      expect(failed.items.every((t) => t.status === 'failed')).toBe(true);
      const target = byMethod.items[0].transactionId;
      const found = (await list(`range=30d&q=${target.slice(3, 12).toLowerCase()}`)).body;
      expect(found.items.map((t) => t.transactionId)).toContain(target);
      expect((await list('range=30d&q=NOPE-NOT-THERE')).body.total).toBe(0);
    });

    it('supports custom date ranges and rejects invalid filters', async () => {
      const from = new Date(2026, 10, 1).toISOString();
      const to = new Date(2026, 10, 1, 23, 59, 59).toISOString();
      const day = (await list(`range=custom&from=${from}&to=${to}&pageSize=50`)).body;
      day.items.forEach((t) => expect(new Date(t.createdAt).getDate()).toBe(1));
      expect((await list(`range=custom&from=${to}&to=${from}`)).status).toBe(400);
      expect((await list('range=custom&from=bad&to=2026-11-01')).status).toBe(400);
      expect((await list('range=30d&status=chargeback')).status).toBe(400);
      expect((await list('range=30d&status=refunded')).status).toBe(400);
      expect((await list('range=30d&q=%3Cscript%3E')).status).toBe(400);
      expect((await get('/api/merchant-portal/transactions?flow=refunds')).status).toBe(400);
    });

    it('paginates', async () => {
      const first = (await list('range=30d&pageSize=10&page=1')).body;
      const second = (await list('range=30d&pageSize=10&page=2')).body;
      expect(second.items[0].transactionId).not.toBe(first.items[0].transactionId);
      expect((await list('range=30d&pageSize=7')).status).toBe(400);
    });

    it('lists payouts separately', async () => {
      const p = (await get<TransactionPage>('/api/merchant-portal/transactions?flow=payout&range=30d')).body;
      expect(p.items.every((t) => t.flow === 'payout')).toBe(true);
    });
  });

  describe('CSV export', () => {
    it('exports all filtered records with the displayed fields and a clear file name', async () => {
      const e = (await get<TransactionExport>('/api/merchant-portal/transactions/export?flow=payin&range=7d&status=successful')).body;
      const total = (await list('range=7d&status=successful')).body.total;
      expect(e.rows).toBe(total);
      expect(e.filename).toBe('tanjung-global-trading-sdn-bhd-payin-transactions-2026-11-05.csv');
      const lines = e.csv.trim().split('\r\n');
      expect(lines[0]).toBe('Date & Time,Invoice ID,Transaction ID,Flow,Sub-merchant,Payment Method,Amount,Fee,Net Amount,Currency,Status');
      expect(lines).toHaveLength(total + 1);
      lines.slice(1).forEach((l) => expect(l).toMatch(/,(MYR|IDR|VND),Successful$/));
    });

    it('returns zero rows when nothing matches', async () => {
      const e = (await get<TransactionExport>('/api/merchant-portal/transactions/export?flow=payin&range=today&q=ZZZZ')).body;
      expect(e.rows).toBe(0);
    });
  });

  describe('Nusantara Home Retail (live in Malaysia and Indonesia)', () => {
    it('signs in with 2FA already on and sees MYR and IDR balances and both countries’ methods', async () => {
      const t = await signIn(auth, 'NUSANTARA-MERCHANT');
      const o = (await get<MerchantPortalOverview>('/api/merchant-portal/overview', t)).body;
      expect(o.merchant).toEqual({ id: 'GM-109001', name: 'Nusantara Home Retail Sdn Bhd' });
      expect(o.balances.map((b) => b.currency)).toEqual(['MYR', 'IDR']);
      expect(o.paymentMethods.map((m) => m.code)).toEqual(['fpx', 'duitnow_qr', 'tng', 'cards', 'va', 'qris', 'ovo']);
      const page = (await list('range=30d&pageSize=50', t)).body;
      expect(page.total).toBeGreaterThan(0);
      expect(new Set(page.items.map((x) => x.currency))).toEqual(new Set(['MYR', 'IDR']));
      const e = (await get<TransactionExport>('/api/merchant-portal/transactions/export?flow=payin&range=30d', t)).body;
      expect(e.filename).toBe('nusantara-home-retail-sdn-bhd-payin-transactions-2026-11-05.csv');
      expect(e.rows).toBe(page.total);
    });

    it('never sees Tanjung’s transactions, and Tanjung never sees Nusantara’s', async () => {
      const t = await signIn(auth, 'NUSANTARA-MERCHANT');
      const mine = new Set((await list('range=30d&pageSize=50', t)).body.items.map((x) => x.transactionId));
      const theirs = (await list('range=30d&pageSize=50')).body.items.map((x) => x.transactionId);
      expect(theirs.some((id) => mine.has(id))).toBe(false);
      expect((await list(`range=30d&q=${theirs[0]}`, t)).body.total).toBe(0);
    });

    it('is fully onboarded in the internal app, with its own Global Account', async () => {
      const internal = await signIn(auth, '123');
      const detail = (await merchants.handle('GET', '/api/merchants/GM-109001', null, internal, 'sales')).body as any;
      expect(detail.merchant.linkedAccountId).toBe('GA-1005');
      expect(detail.applications.map((a: any) => `${a.country}:${a.status}`)).toEqual(['MY:operational', 'ID:operational']);
    });
  });

  describe('isolation and access control', () => {
    it('a merchant only ever sees its own data, whatever the request says', async () => {
      const lumi = await signIn(auth, 'LUMI-MERCHANT');
      const o = (await get<MerchantPortalOverview>('/api/merchant-portal/overview?merchantId=GM-100101', lumi)).body;
      expect(o.merchant.id).toBe('GM-100102');
      expect(o.balances).toEqual([]);
      expect((await list('range=30d&merchantId=GM-100101', lumi)).body.total).toBe(0);
      const tanjungTxn = (await list('range=30d')).body.items[0].transactionId;
      expect((await list(`range=30d&q=${tanjungTxn}`, lumi)).body.total).toBe(0);
      expect((await get<TransactionExport>('/api/merchant-portal/transactions/export?flow=payin&range=30d', lumi)).body.rows).toBe(0);
    });

    it('internal users cannot use the merchant portal APIs', async () => {
      const internal = await signIn(auth, '123');
      expect((await get('/api/merchant-portal/overview', internal)).body).toEqual({ code: 'ROLE_NOT_PERMITTED' });
    });

    it('merchant users cannot use internal APIs, whatever role header they send', async () => {
      expect((await merchants.handle('GET', '/api/merchants', null, tanjung, 'risk')).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
      expect((await auth.handle('GET', '/api/security/overview', null, tanjung, 'security')).body).toEqual({ code: 'ROLE_NOT_PERMITTED' });
      expect((await auth.handle('GET', '/api/workspace/context', null, tanjung)).body).toEqual({ code: 'ROLE_NOT_PERMITTED' });
    });
  });
});
