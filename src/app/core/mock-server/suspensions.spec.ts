import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalsView } from '../merchants/change-requests';
import { MerchantDetail, StaffRole } from '../merchants/merchant-models';
import { SuspensionView } from '../merchants/suspensions';
import { TxnListResponse } from '../transactions/transactions';
import { AuthServer } from './auth-server';
import { MerchantDb, MerchantServer } from './merchant-server';
import { FlakyStorage } from './testing/merchant-test-data';
import { currentCode, signIn } from './testing/sign-in';
import { TransactionServer } from './transaction-server';

const KEY = 'mobi.gp.merchantdb';

// Merchant and sub-merchant suspension (docs/merchant-suspension.md). Seed: Tanjung Global Trading
// (GM-100101) is live in Malaysia, Indonesia and Vietnam; Nusantara Home Retail (GM-109001) is live
// in Malaysia and Indonesia and has two (approved, not live) sub-merchants in Malaysia.

describe('Suspension', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: MerchantServer;
  let txns: TransactionServer;
  const tokens = new Map<string, string>();

  const as = async (login: string) => {
    if (!tokens.has(login)) {
      now += 31_000;
      tokens.set(login, await signIn(auth, login));
    }
    return tokens.get(login)!;
  };
  const code = async (login: string) => {
    const token = await as(login);
    now += 61_000; // a fresh 30-second step, never the one used to sign in
    return currentCode(auth, token);
  };
  /** Calls as a login working as a team (tests switch teams with the role header). */
  const call = async <T = any>(login: string, role: StaffRole, method: string, path: string, body: unknown = null) =>
    server.handle(method, path, body, await as(login), role) as Promise<{ status: number; body: T }>;
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const detail = async (gmid = 'GM-100101') => (await call<MerchantDetail>('123', 'sales', 'GET', `/api/merchants/${gmid}`)).body;
  const fraud = (over: object = {}) => ({ type: 'suspected_fraud', scope: 'merchant', controls: { payins: true, payouts: true, settlement: true, refunds: true }, caseRef: 'RISK-2026-0142', detectedBy: 'Transaction monitoring', reason: 'Card testing pattern on Cards (MY).', ...over });
  const suspendAs = async (login: string, role: StaffRole, body: object, gmid = 'GM-100101') => call<SuspensionView>(login, role, 'POST', `/api/merchants/${gmid}/suspensions`, { ...body, code: await code(login) });

  beforeEach(async () => {
    now = new Date(2026, 10, 13, 10, 0).getTime();
    tokens.clear();
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {}, merchantName: (id) => server.portalProfile(id)?.legalName ?? null });
    server = new MerchantServer({ storage, now: () => now, auth });
    txns = new TransactionServer({ storage, auth, sources: () => server.transactionSources(), now: () => now, fixedTeams: false });
    await detail();
  });

  describe('suspending', () => {
    it('fraud is Risk only, needs an MFA code and a case reference', async () => {
      expect((await call('123', 'sales', 'POST', '/api/merchants/GM-100101/suspensions', { ...fraud(), code: await code('123') })).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED', message: 'Only Risk can suspend for fraud or compliance.' });
      expect((await call('MOBI-RISK', 'risk', 'POST', '/api/merchants/GM-100101/suspensions', fraud())).body).toMatchObject({ code: 'MFA_CODE_REQUIRED' });
      expect((await suspendAs('MOBI-RISK', 'risk', fraud({ caseRef: '' }))).body).toMatchObject({ message: 'Enter a case reference.' });
      expect((await suspendAs('MOBI-RISK', 'risk', fraud({ reason: 'x' }))).body).toMatchObject({ message: 'Enter a reason with at least 5 characters.' });
      const res = await suspendAs('MOBI-RISK', 'risk', fraud());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'active', scope: 'merchant', review: { required: true, status: 'pending' }, settlement: { status: 'held' } });
      expect(res.body.coverage).toContain('3 MIDs');
      expect((await suspendAs('MOBI-RISK', 'risk', fraud())).body).toMatchObject({ message: 'This merchant is already suspended.' });
    });

    it('a whole-merchant suspension covers every country and sub-merchant, and blocks onboarding as before', async () => {
      await suspendAs('MOBI-RISK', 'risk', fraud());
      const d = await detail();
      expect(d.merchant.lifecycleStatus).toBe('suspended');
      expect(Object.values(d.effects.countries).every((e) => e.suspended && e.via === 'merchant' && e.controls.payins && e.controls.settlement)).toBe(true);
      expect(d.lifecycleEvents[0].detail).toContain('Suspected fraud');
      const notes = db().notifications.slice(0, 2);
      expect(notes.map((n) => n.title)).toEqual(['Your account is under review', 'Merchant suspended: Tanjung Global Trading Sdn Bhd']);
      expect(notes[0].body).not.toMatch(/fraud|suspend/i);
    });

    it('Sales / Ops can suspend for commercial reasons only, with no second review', async () => {
      const res = await suspendAs('123', 'sales', { type: 'commercial', scope: 'country', country: 'VN', controls: {}, reason: 'Unpaid platform fees for 3 months', detectedBy: 'Internal review' });
      expect(res.body).toMatchObject({ scope: 'country', country: 'VN', review: { required: false, status: 'not_required' } });
      const d = await detail();
      expect(d.merchant.lifecycleStatus).toBe('active');
      expect(d.effects.countries['VN']).toMatchObject({ suspended: true, via: 'country' });
      expect(d.effects.countries['MY'].suspended).toBe(false);
      expect((await suspendAs('123', 'sales', { type: 'commercial', scope: 'country', country: 'TH', reason: 'Not live there' })).body).toMatchObject({ message: 'Choose a country where the merchant is live.' });
    });

    it('suspends one sub-merchant only', async () => {
      const sub = db().entities!.find((e) => e.gmid === 'GM-109001' && e.kind === 'sub')!;
      const res = await suspendAs('MOBI-RISK', 'risk', { type: 'compliance', scope: 'sub_merchant', subMerchantId: sub.id, controls: { payins: true, payouts: true }, caseRef: 'KYC-77', detectedBy: 'Internal review', reason: 'Trading licence expired' }, 'GM-109001');
      expect(res.status).toBe(201);
      expect(db().entities!.find((e) => e.id === sub.id)!.lifecycleStatus).toBe('suspended');
      const d = await detail('GM-109001');
      expect(d.effects.subMerchants[sub.id]).toMatchObject({ suspended: true, via: 'sub_merchant' });
      expect(d.merchant.lifecycleStatus).toBe('active');
    });
  });

  describe('second review and reactivation (fraud)', () => {
    it('another Risk person reviews within 24 hours; the raiser cannot', async () => {
      const s = (await suspendAs('MOBI-RISK', 'risk', fraud())).body;
      const items = (await call<ApprovalsView>('123', 'risk', 'GET', '/api/approvals')).body.pending;
      expect(items.some((i) => i.kind === 'suspension_review' && i.query?.['suspension'] === s.id)).toBe(true);
      expect((await call('MOBI-RISK', 'risk', 'POST', `/api/suspensions/${s.id}/review`, { decision: 'confirm', note: 'Looks right', code: await code('MOBI-RISK') })).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
      const r = await call<SuspensionView>('123', 'risk', 'POST', `/api/suspensions/${s.id}/review`, { decision: 'confirm', note: 'Pattern confirmed with provider', code: await code('123') });
      expect(r.body.review).toMatchObject({ status: 'confirmed', note: 'Pattern confirmed with provider' });
      expect(r.body.status).toBe('active');
    });

    it('reactivation needs a second Risk approval, keeps own sub-merchant suspensions, and sends settlement to FinOps', async () => {
      const s = (await suspendAs('MOBI-RISK', 'risk', fraud())).body;
      const req = await call<SuspensionView>('MOBI-RISK', 'risk', 'POST', `/api/suspensions/${s.id}/reactivation`, { outcome: 'No fraud found', reason: 'Compromised test key rotated', releaseSettlement: true, code: await code('MOBI-RISK') });
      expect(req.body).toMatchObject({ status: 'active', reactivation: { status: 'pending' } });
      expect((await call('MOBI-RISK', 'risk', 'POST', `/api/suspensions/${s.id}/reactivation/decision`, { decision: 'approve', code: await code('MOBI-RISK') })).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
      const ok = await call<SuspensionView>('123', 'risk', 'POST', `/api/suspensions/${s.id}/reactivation/decision`, { decision: 'approve', code: await code('123') });
      expect(ok.body).toMatchObject({ status: 'lifted', settlement: { status: 'release_pending' } });
      expect((await detail()).merchant.lifecycleStatus).toBe('active');
      // Settlement stays held until FinOps releases it.
      expect((await detail()).effects.countries['MY'].controls).toMatchObject({ payins: false, settlement: true });
      expect((await call('123', 'risk', 'POST', `/api/suspensions/${s.id}/settlement`, { decision: 'release', code: await code('123') })).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
      const fin = await call<SuspensionView>('TANJUNG-ADMIN', 'finops', 'POST', `/api/suspensions/${s.id}/settlement`, { decision: 'release', code: await code('TANJUNG-ADMIN') });
      expect(fin.body.settlement.status).toBe('released');
      expect((await detail()).effects.countries['MY'].controls.settlement).toBe(false);
    });

    it('non-fraud reactivation is immediate (Risk only)', async () => {
      const s = (await suspendAs('123', 'sales', { type: 'merchant_request', scope: 'merchant', controls: { payins: true, payouts: true }, reason: 'Merchant asked to pause trading' })).body;
      expect((await call('123', 'sales', 'POST', `/api/suspensions/${s.id}/reactivation`, { outcome: 'Resolved with the merchant', reason: 'Merchant asked to resume', code: await code('123') })).status).toBe(403);
      const r = await call<SuspensionView>('MOBI-RISK', 'risk', 'POST', `/api/suspensions/${s.id}/reactivation`, { outcome: 'Resolved with the merchant', reason: 'Merchant asked to resume', code: await code('MOBI-RISK') });
      expect(r.body.status).toBe('lifted');
    });
  });

  describe('effects', () => {
    it('blocks new pay-ins and payouts at Mobi and holds settlement in Transactions', async () => {
      const before = ((await txns.handle('GET', '/api/transactions/payin?range=24h&merchant=GM-100101&pageSize=50', null, await as('123'), 'sales')).body as TxnListResponse).total;
      await suspendAs('MOBI-RISK', 'risk', fraud());
      now += 6 * 3_600_000;
      tokens.clear();
      const list = (await txns.handle('GET', '/api/transactions/payin?range=1h&merchant=GM-100101&pageSize=50', null, await as('123'), 'sales')).body as TxnListResponse;
      const blocked = (await txns.handle('GET', '/api/transactions/payin?range=24h&merchant=GM-100101&flag=merchant_suspended&pageSize=50', null, await as('123'), 'sales')).body as TxnListResponse;
      expect(before).toBeGreaterThan(0);
      expect(blocked.total).toBeGreaterThan(0);
      expect(blocked.items.every((t) => t.status === 'failed' && t.flags.includes('merchant_suspended'))).toBe(true);
      expect(list.items.every((t) => t.status === 'failed')).toBe(true);
    });
  });

  it('the earlier one-step Suspend / Reactivate still works (commercial, no payment controls)', async () => {
    expect((await call('123', 'sales', 'POST', '/api/merchants/GM-100101/lifecycle', { action: 'suspend', reason: 'Chargeback ratio above threshold' })).body).toMatchObject({ lifecycleStatus: 'suspended' });
    const d = await detail();
    expect(d.suspensions[0]).toMatchObject({ type: 'commercial', legacy: true, controls: { payins: false } });
    expect((await call('MOBI-RISK', 'risk', 'POST', '/api/merchants/GM-100101/lifecycle', { action: 'reactivate', reason: 'Reviewed and cleared' })).body).toMatchObject({ lifecycleStatus: 'active' });
  });
});
