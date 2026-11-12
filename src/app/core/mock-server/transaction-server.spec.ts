import { beforeEach, describe, expect, it } from 'vitest';
import { MerchantTxnDetail, MerchantTxnListResponse, TxnDetail, TxnExport, TxnListResponse } from '../transactions/transactions';
import { AuthServer } from './auth-server';
import { MerchantPortalServer } from './merchant-portal-server';
import { MerchantServer } from './merchant-server';
import { generateTables, HISTORY_DAYS } from './transaction-data';
import { TransactionServer } from './transaction-server';
import { signIn } from './testing/sign-in';

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

// Transaction Management phase 1: sample records for live MIDs, lists per flow, details, export,
// notes and investigation flags (internal), and the merchant's own view (Merchant Portal).

describe('Transactions', () => {
  let now: number;
  let storage: MemoryStorage;
  let auth: AuthServer;
  let merchants: MerchantServer;
  let txns: TransactionServer;
  let portal: MerchantPortalServer;
  const tokens = new Map<string, string>();

  const as = async (loginId: string) => {
    if (!tokens.has(loginId)) {
      now += 31_000;
      tokens.set(loginId, await signIn(auth, loginId));
    }
    return tokens.get(loginId)!;
  };
  const call = async <T = any>(loginId: string, method: string, path: string, body: unknown = null, role: string | null = null) =>
    txns.handle(method, path, body, await as(loginId), role) as Promise<{ status: number; body: T }>;
  const list = (loginId: string, flow: string, query = '', role: string | null = null) => call<TxnListResponse>(loginId, 'GET', `/api/transactions/${flow}?${query}`, null, role);
  const mget = async <T = any>(loginId: string, path: string) => portal.handle('GET', path, await as(loginId)) as Promise<{ status: number; body: T }>;

  beforeEach(async () => {
    now = new Date(2026, 10, 12, 15, 30).getTime();
    tokens.clear();
    storage = new MemoryStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {}, fixedTeams: true, merchantName: (id) => merchants.portalProfile(id)?.legalName ?? null });
    merchants = new MerchantServer({ storage, now: () => now, auth, fixedTeams: true });
    txns = new TransactionServer({ storage, auth, sources: () => merchants.transactionSources(), now: () => now });
    portal = new MerchantPortalServer({ storage, auth, profile: (id) => merchants.portalProfile(id), transactions: txns, now: () => now });
  });

  describe('sample records', () => {
    it('exist only for live MIDs and their switched-on methods, one table per flow', async () => {
      const sources = merchants.transactionSources();
      expect(sources.length).toBeGreaterThan(0);
      const r = (await list('123', 'payin', 'range=30d&pageSize=50')).body;
      expect(r.total).toBeGreaterThan(50);
      expect(r.sampleData).toBe(true);
      const enabled = new Set(sources.flatMap((s) => s.products.filter((p) => p.flow === 'payin').map((p) => `${s.mid}:${p.methodCode}`)));
      const mids = new Map(sources.map((s) => [s.gmid + s.country, s.mid]));
      for (const t of r.items) {
        expect(t.flow).toBe('payin');
        expect(t.createdAt).toBeLessThanOrEqual(now);
        expect(enabled.has(`${mids.get(t.gmid + t.country)}:${t.methodCode}`)).toBe(true);
      }
      const payouts = (await list('123', 'payout', 'range=30d')).body;
      expect(payouts.items.every((t) => t.flow === 'payout' && t.transactionId.startsWith('PYO'))).toBe(true);
    });

    it('are the same on every load (deterministic) and progress with time', async () => {
      const a = (await list('123', 'payin', 'range=7d&pageSize=50')).body.items.map((t) => t.transactionId);
      const other = new TransactionServer({ storage: new MemoryStorage(), auth, sources: () => merchants.transactionSources(), now: () => now });
      const b = ((await other.handle('GET', '/api/transactions/payin?range=7d&pageSize=50', null, await as('123'), null)).body as TxnListResponse).items.map((t) => t.transactionId);
      expect(b).toEqual(a);
      // Nothing is pending a day later: every record has reached its outcome.
      now += 2 * 86_400_000;
      tokens.clear(); // sessions don't last two days
      const later = (await list('123', 'payin', `range=custom&from=${new Date(now - 4 * 86_400_000).toISOString()}&to=${new Date(now - 2 * 86_400_000).toISOString()}&pageSize=50`)).body;
      expect(later.summary.byStatus.pending.count + later.summary.byStatus.processing.count).toBe(0);
    });

    it('give live sub-merchants their own pay-ins (with their MID); payouts stay with the MID', async () => {
      const [src] = merchants.transactionSources().filter((s) => s.gmid === 'GM-109001' && s.country === 'MY');
      const withSub = { ...src, subMerchants: [{ id: 'ME-TEST', name: 'Test Outlet', mid: 'MID-TEST', issuedAt: 0, demo: true }] };
      const t = generateTables([withSub], now);
      const subRows = t.payin.filter((r) => r.subMerchantId === 'ME-TEST');
      expect(subRows.length).toBeGreaterThan(0);
      expect(subRows.every((r) => r.subMerchantMid === 'MID-TEST' && r.masterMid === src.mid)).toBe(true);
      expect(t.payout.every((r) => r.subMerchantId === null)).toBe(true);
      // Approved but not live sub-merchants (no MID) take no transactions.
      expect(src.subMerchants).toEqual([]);
    });

    it('charge the fee of the pricing version in effect, only once Successful', async () => {
      const r = (await list('123', 'payin', 'range=30d&pageSize=50')).body;
      for (const t of r.items) {
        if (t.status === 'successful') {
          expect(t.fee).not.toBeUndefined();
          if (t.fee !== null) expect(t.net).toBeCloseTo(t.amount - t.fee!, 2);
        } else expect(t.fee ?? null).toBeNull();
      }
    });
  });

  describe('lists', () => {
    it('summarise per status and per currency, never converted', async () => {
      const r = (await list('123', 'payin', 'range=30d')).body;
      const counted = Object.values(r.summary.byStatus).reduce((s, x) => s + x.count, 0);
      expect(counted).toBe(r.total);
      expect(new Set(r.summary.totalAmounts.map((a) => a.currency)).size).toBe(r.summary.totalAmounts.length);
    });

    it('filter by payment type and add that type’s own columns', async () => {
      const all = (await list('123', 'payin', 'range=30d&country=MY')).body;
      expect(all.typeColumns).toEqual([]);
      expect(all.options.paymentTypes).toContain('ewallet');
      const ew = (await list('123', 'payin', 'range=30d&country=MY&type=ewallet')).body;
      expect(ew.items.every((t) => t.paymentType === 'ewallet')).toBe(true);
      expect(ew.typeColumns.map((c) => c.label)).toEqual(['Wallet account']);
      expect(ew.items[0].typeValues!['walletAccount']).toMatch(/^•••• \d{4}$/);
      const bank = (await list('123', 'payout', 'range=30d&type=bank_transfer')).body;
      expect(bank.typeColumns.map((c) => c.label)).toEqual(['Beneficiary bank', 'Beneficiary account']);
      expect((await list('123', 'payin', 'type=bank_transfer_payout')).status).toBe(400);
    });

    it('find an ID whatever the other filters, and say when it is in the other flow', async () => {
      const r = (await list('123', 'payin', 'range=30d')).body;
      const old = r.items[r.items.length - 1];
      const found = (await list('123', 'payin', `range=1h&status=expired&q=${old.transactionId}`)).body;
      expect(found.items.map((t) => t.transactionId)).toEqual([old.transactionId]);
      const byInvoice = (await list('123', 'payin', `q=${old.invoiceId}`)).body;
      expect(byInvoice.items.some((t) => t.transactionId === old.transactionId)).toBe(true);
      const elsewhere = (await list('123', 'payout', `q=${old.transactionId}`)).body;
      expect(elsewhere.total).toBe(0);
      expect(elsewhere.otherFlowMatch).toBe('payin');
    });

    it('default to the last 24 hours and paginate with the shared page sizes', async () => {
      const r = (await list('123', 'payin')).body;
      expect(r.items.every((t) => t.createdAt >= now - 86_400_000)).toBe(true);
      expect(r.pageSize).toBe(25);
      expect((await list('123', 'payin', 'pageSize=100')).status).toBe(400);
    });

    it('validate filters', async () => {
      expect((await list('123', 'payin', 'range=forever')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await list('123', 'payin', 'status=refunded')).status).toBe(400);
      expect((await list('123', 'payin', 'amountMin=10')).body).toMatchObject({ message: 'Choose one country or currency to filter by amount.' });
      expect((await list('123', 'payin', 'range=custom&from=2026-01-01T00:00:00Z&to=2026-11-01T00:00:00Z')).body).toMatchObject({ message: 'Choose a range of 93 days or less.' });
      expect((await list('123', 'payin', "q=' OR 1=1")).status).toBe(400);
    });
  });

  describe('permissions (proposed §4 matrix)', () => {
    it('Security Admin has no access; Mobi Support can view but not export', async () => {
      expect((await list('MOBI-SECURITY', 'payin')).status).toBe(403);
      const support = (await list('MOBI-SUPPORT', 'payin', 'range=7d')).body;
      expect(support.can).toEqual({ export: false, seeFees: false });
      expect((await call('MOBI-SUPPORT', 'GET', '/api/transactions/payin/export?range=7d')).status).toBe(403);
    });

    it('fees only for Sales / Ops, CS and FinOps; IP and device only for Risk and Mobi Support', async () => {
      const id = (await list('123', 'payin', 'range=7d&status=successful')).body.items[0].transactionId;
      const fieldsOf = async (login: string) => (await call<TxnDetail>(login, 'GET', `/api/transactions/payin/${id}`)).body.sections.flatMap((s) => s.fields.map((f) => f.label));
      expect(await fieldsOf('123')).toContain('Fee');
      expect(await fieldsOf('TANJUNG-ADMIN')).toContain('Pricing version');
      const risk = await fieldsOf('MOBI-RISK');
      expect(risk).not.toContain('Fee');
      expect(risk).not.toContain('Pricing version');
      expect((await list('MOBI-RISK', 'payin', 'range=7d')).body.items[0].fee).toBeUndefined();
      expect(await fieldsOf('123')).not.toContain('IP address');
    });

    it('only the prototype admin can switch teams with the role header', async () => {
      expect((await list('123', 'payin', '', 'support')).body.can.seeFees).toBe(true); // still Sales / Ops
      expect((await list('MOBI-ADMIN', 'payin', '', 'support')).body.can.seeFees).toBe(false);
      expect((await list('MOBI-ADMIN', 'payin', '', 'security')).status).toBe(403);
    });

    it('merchant users cannot use the internal API', async () => {
      expect((await txns.handle('GET', '/api/transactions/payin', null, await as('NUSANTARA-MERCHANT'), null)).status).toBe(403);
    });
  });

  describe('details', () => {
    it('follow the payment path and mask customer data for staff', async () => {
      const r = (await list('123', 'payin', 'range=30d&pageSize=50')).body;
      const ok = r.items.find((t) => t.status === 'successful')!;
      const d = (await call<TxnDetail>('123', 'GET', `/api/transactions/payin/${ok.transactionId}`)).body;
      expect(d.path.map((s) => s.key)).toEqual(['customer', 'merchant', 'mobi', 'provider', 'bank']);
      expect(d.path.every((s) => s.state === 'done')).toBe(true);
      expect(d.sections.map((s) => s.key)).toEqual(expect.arrayContaining(['customer', 'merchant', 'mobi', 'provider', 'bank']));
      const email = d.sections.find((s) => s.key === 'customer')!.fields.find((f) => f.label === 'Customer email');
      if (email) expect(email.value).toContain('•••••@');
      expect(d.timeline[d.timeline.length - 1].title).toBe('Created');
      expect(d.ipn.attempts.length).toBeGreaterThan(0);
      const failed = r.items.find((t) => t.status === 'failed');
      if (failed) {
        const f = (await call<TxnDetail>('123', 'GET', `/api/transactions/payin/${failed.transactionId}`)).body;
        expect(f.path.some((s) => s.state === 'failed')).toBe(true);
        expect(f.statusReason).toBeTruthy();
      }
    });

    it('are not found in the wrong flow', async () => {
      const id = (await list('123', 'payin', 'range=7d')).body.items[0].transactionId;
      expect((await call('123', 'GET', `/api/transactions/payout/${id}`)).status).toBe(404);
      expect((await call('123', 'GET', '/api/transactions/payin/TXN000')).status).toBe(404);
    });
  });

  describe('notes, flags and audit', () => {
    it('adds notes, flags and clears with a resolution; everything is audited', async () => {
      const id = (await list('123', 'payin', 'range=7d')).body.items[0].transactionId;
      expect((await call('123', 'POST', `/api/transactions/payin/${id}/notes`, { text: ' ' })).body).toMatchObject({ message: 'Enter a note.' });
      expect((await call('123', 'POST', `/api/transactions/payin/${id}/notes`, { text: 'Merchant asked about this payment.' })).status).toBe(201);
      expect((await call('MOBI-RISK', 'POST', `/api/transactions/payin/${id}/flag`, { reason: '' })).body).toMatchObject({ message: 'Enter a reason for the investigation.' });
      expect((await call('MOBI-RISK', 'POST', `/api/transactions/payin/${id}/flag`, { reason: 'Possible duplicate', ticket: 'OPS-1234' })).status).toBe(201);
      expect((await call('MOBI-RISK', 'POST', `/api/transactions/payin/${id}/flag`, { reason: 'Again' })).status).toBe(409);
      const flagged = (await list('123', 'payin', 'range=7d&flag=investigation')).body;
      expect(flagged.items.map((t) => t.transactionId)).toEqual([id]);
      expect((await call('123', 'POST', `/api/transactions/payin/${id}/flag/clear`, { resolution: '' })).status).toBe(422);
      expect((await call('123', 'POST', `/api/transactions/payin/${id}/flag/clear`, { resolution: 'Not a duplicate.' })).status).toBe(200);
      const d = (await call<TxnDetail>('123', 'GET', `/api/transactions/payin/${id}`)).body;
      expect(d.notes.map((n) => n.text)).toEqual(['Merchant asked about this payment.']);
      expect(d.flags).toEqual([]);
      expect(d.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['Added a note', 'Flagged for investigation', 'Cleared the investigation flag', 'Viewed details']));
    });

    it('viewers cannot add notes or flags', async () => {
      const id = (await list('TANJUNG-VIEWER', 'payin', 'range=7d')).body.items[0].transactionId;
      expect((await call<TxnDetail>('TANJUNG-VIEWER', 'GET', `/api/transactions/payin/${id}`)).body.can).toEqual({ addNote: false, flag: false });
      expect((await call('TANJUNG-VIEWER', 'POST', `/api/transactions/payin/${id}/notes`, { text: 'x' })).status).toBe(403);
    });

    it('exports every matching row with role fields, and audits the export', async () => {
      const r = (await list('123', 'payin', 'range=30d&country=MY')).body;
      const e = (await call<TxnExport>('123', 'GET', '/api/transactions/payin/export?range=30d&country=MY')).body;
      expect(e.rows).toBe(r.total);
      expect(e.filename).toMatch(/^mobi-transactions-payin-my-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/);
      expect(e.csv.split('\r\n')[0]).toContain('Net amount');
      const risk = (await call<TxnExport>('MOBI-RISK', 'GET', '/api/transactions/payin/export?range=30d')).body;
      expect(risk.csv.split('\r\n')[0]).not.toContain('Fee');
      expect(txns.auditLog()[0].action).toBe('Exported transactions');
    });
  });

  describe('Merchant Portal view', () => {
    it('shows the merchant’s own records with fee and net, and no provider details', async () => {
      const r = (await mget<MerchantTxnListResponse>('NUSANTARA-MERCHANT', '/api/merchant-portal/transactions?flow=payin&range=30d&pageSize=50')).body;
      expect(r.total).toBeGreaterThan(0);
      const internal = (await list('123', 'payin', 'range=30d&merchant=GM-109001')).body;
      expect(r.total).toBe(internal.total);
      const ok = r.items.find((t) => t.status === 'successful')!;
      expect(ok.fee).not.toBeUndefined();
      const d = (await mget<MerchantTxnDetail>('NUSANTARA-MERCHANT', `/api/merchant-portal/transactions/payin/${ok.transactionId}`)).body;
      expect(d).not.toHaveProperty('path');
      const labels = d.sections.flatMap((s) => s.fields.map((f) => f.label));
      expect(labels).not.toContain('Provider');
      expect(labels).not.toContain('Mobi request ID');
      expect(labels).not.toContain('Pricing version');
      expect(labels).toEqual(expect.arrayContaining(['Fee', 'Net amount', 'Payment reference']));
    });

    it('never shows another merchant’s transaction', async () => {
      const tanjungTxn = (await list('123', 'payin', 'range=30d&merchant=GM-100101')).body.items[0];
      if (!tanjungTxn) return;
      expect((await mget('NUSANTARA-MERCHANT', `/api/merchant-portal/transactions/payin/${tanjungTxn.transactionId}`)).status).toBe(404);
    });

    it('uses the five statuses only (no Refunded)', async () => {
      const r = await mget('NUSANTARA-MERCHANT', '/api/merchant-portal/transactions?flow=payin&status=refunded');
      expect(r.status).toBe(400);
      expect(HISTORY_DAYS).toBeGreaterThanOrEqual(30);
    });
  });
});
