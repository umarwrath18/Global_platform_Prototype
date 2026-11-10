import { beforeEach, describe, expect, it } from 'vitest';
import { StaffRole } from '../merchants/merchant-models';
import { addDays, MdrHistoryRow, MerchantPricingList, PricingAuditEvent, PricingDraft, ProductPricingView, SubMerchantPricingRow, todayIso } from '../merchants/products';
import { AuthServer } from './auth-server';
import { MerchantDb, MerchantServer } from './merchant-server';
import { FlakyStorage, percentageDraft } from './testing/merchant-test-data';
import { signIn } from './testing/sign-in';

const KEY = 'mobi.gp.merchantdb';

// Seed (Malaysia): Tanjung (APP-2026-0001) and Nusantara (APP-2026-9001) are live; Nusantara has two
// approved sub-merchants, the Online Store (own Cards rule, 1.9%) and the Penang Outlet (no rules).
// PT Rasa Bali Kuliner's Malaysia MID (APP-2026-0010) is still in onboarding, so it isn't listed.

describe('Merchant Pricing (Part A)', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: MerchantServer;
  let maker: string;
  let checker: string;

  const callAs = (token: () => string) => <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') => server.handle(method, path, body, token(), role) as Promise<{ status: number; body: T }>;
  let call: ReturnType<typeof callAs>;
  let asChecker: ReturnType<typeof callAs>;
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const subs = () => db().entities!.filter((e) => e.kind === 'sub' && e.gmid === 'GM-109001');
  const online = () => subs().find((s) => s.displayName!.includes('Online'))!;
  const penang = () => subs().find((s) => s.displayName!.includes('Penang'))!;
  const today = () => todayIso(now);
  const price = (draft: PricingDraft, editOf: string | null = null, id = 'APP-2026-9001') => call<any>('POST', `/api/applications/${id}/pricing`, { draft, editOf }, 'sales');
  const decide = async (vid: string, decision: 'approve' | 'reject', reason = '') => {
    now += 31_000;
    const code = (await auth.demoAuthenticator('session', checker))!.code;
    return asChecker<any>('POST', `/api/applications/APP-2026-9001/pricing/${vid}/decision`, { decision, reason, code }, 'finops');
  };

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 10, 9);
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new MerchantServer({ storage, now: () => now, auth });
    maker = await signIn(auth, '123');
    now += 31_000;
    checker = await signIn(auth, 'TANJUNG-ADMIN');
    call = callAs(() => maker);
    asChecker = callAs(() => checker);
    await call('GET', '/api/merchants');
  });

  it('lists confirmed MIDs in the corridor with counts, MDR range and role actions (§7.1)', async () => {
    const list = (await call<MerchantPricingList>('GET', '/api/pricing/merchants?country=MY')).body;
    expect(list.rows.map((r) => [r.merchantName, r.mid !== null, r.subMerchantCount, r.status, `${r.activeRules}/${r.totalRules}`, r.mdr, r.pendingCount])).toEqual([
      ['Nusantara Home Retail Sdn Bhd', true, 2, 'active', '5/5', '0.8%–2.2%', 0],
      ['Tanjung Global Trading Sdn Bhd', true, 0, 'active', '4/5', '0.8%–2.2%', 1],
    ]);
    expect([list.activeRules, list.pendingApprovals, list.canConfigure]).toEqual([9, 1, true]);
    expect((await call<MerchantPricingList>('GET', '/api/pricing/merchants?country=MY', null, 'finops')).body.canConfigure).toBe(false);
    expect((await call('GET', '/api/pricing/merchants')).body.code).toBe('COUNTRY_NOT_SUPPORTED');
  });

  it('resolves sub-merchant pricing: own rule first, else the merchant-level rule (§7.3, §7.9)', async () => {
    const rows = (await call<SubMerchantPricingRow[]>('GET', '/api/pricing/sub-merchants?country=MY')).body;
    const row = (sub: string, method: string) => rows.find((r) => r.subMerchantName.includes(sub) && r.methodName === method)!;
    expect(row('Online', 'Cards')).toMatchObject({ level: 'sub_merchant', pricing: 'Percentage: 1.9%', status: 'active' });
    expect(row('Online', 'FPX')).toMatchObject({ level: 'merchant', pricing: 'Percentage: 1%' });
    expect(row('Penang', 'Cards')).toMatchObject({ level: 'merchant', pricing: 'Percentage: 2.2%' });
    expect(new Set(rows.map((r) => r.subMerchantId)).size).toBe(2);
  });

  it('prices a sub-merchant as its own scope, approved by FinOps, and shows it in history and audit', async () => {
    const res = await price(percentageDraft('cards', 2.0, addDays(today(), 1), 'payin', { subMerchantId: penang().id }));
    expect(res.status).toBe(201);
    expect(res.body.version).toMatchObject({ subMerchantId: penang().id, version: 1, status: 'pending_approval' });
    // A merchant-level change for the same method is a different scope, so it isn't blocked.
    expect((await price(percentageDraft('cards', 2.1, addDays(today(), 1)))).status).toBe(201);
    expect((await decide(res.body.version.id, 'approve')).body.version.status).toBe('scheduled');
    const audit = (await call<PricingAuditEvent[]>('GET', '/api/pricing/audit')).body[0];
    expect(audit).toMatchObject({ role: 'Finance', subMerchantName: 'Nusantara Home – Penang Outlet', methodName: 'Cards' });
    const history = (await call<MdrHistoryRow[]>('GET', '/api/pricing/history?country=MY')).body.filter((r) => r.merchantName.startsWith('Nusantara') && r.methodName === 'Cards');
    expect(history.map((r) => [r.subMerchantName, r.version.version])).toEqual([[null, 2], [null, 1], ['Nusantara Home – Online Store', 1], ['Nusantara Home – Penang Outlet', 1]]);
  });

  it('checks overlap within the sub-merchant scope and names the sub-merchant', async () => {
    // A later start on the Online Store's open-ended rule supersedes it (allowed)…
    expect((await price(percentageDraft('cards', 2.0, addDays(today(), 3), 'payin', { subMerchantId: online().id }))).status).toBe(201);
    // …but a bounded Penang rule followed by one that overlaps it is blocked.
    expect((await price(percentageDraft('cards', 2.0, addDays(today(), 1), 'payin', { subMerchantId: penang().id, endDate: addDays(today(), 30) }))).status).toBe(201);
    const res = await price(percentageDraft('cards', 2.1, addDays(today(), 10), 'payin', { subMerchantId: penang().id }));
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Percentage pricing is already configured for Nusantara Home Retail Sdn Bhd → Nusantara Home – Penang Outlet → Cards from');
  });

  it('only prices the merchant’s own sub-merchants in the corridor, after onboarding, and keeps the sub-merchant on edit', async () => {
    expect((await price(percentageDraft('cards', 2.0, addDays(today(), 1), 'payin', { subMerchantId: 'ME-999999' }))).body.message).toBe("That sub-merchant isn't part of Nusantara Home Retail Sdn Bhd in Malaysia.");
    const view = (await call<ProductPricingView>('GET', '/api/applications/APP-2026-9001/products')).body;
    expect(view.subMerchants.map((s) => s.name)).toEqual(['Nusantara Home – Online Store', 'Nusantara Home – Penang Outlet']);
    const own = view.versions.find((v) => v.subMerchantId === online().id)!;
    const moved = await price(percentageDraft('cards', 1.8, addDays(today(), 1), 'payin', { subMerchantId: penang().id }), own.id);
    expect(moved.body.message).toBe('The scope of an edited version cannot change.');
    const edit = await price(percentageDraft('cards', 1.8, addDays(today(), 1), 'payin', { subMerchantId: online().id }), own.id);
    expect(edit.body.version).toMatchObject({ version: 2, subMerchantId: online().id, editOf: own.id });
  });

  it('refuses sub-merchant pricing during onboarding', async () => {
    const d = db();
    d.applications.find((a) => a.id === 'APP-2026-9001')!.status = 'cs_configuration';
    storage.setItem(KEY, JSON.stringify(d));
    const res = await call<any>('POST', '/api/applications/APP-2026-9001/pricing', { draft: percentageDraft('cards', 2, today(), 'payin', { subMerchantId: penang().id }) }, 'cs');
    expect(res.body.message).toBe('Sub-merchant pricing can be set once onboarding is confirmed.');
  });
});
