import { beforeEach, describe, expect, it } from 'vitest';
import { StaffRole } from '../merchants/merchant-models';
import { addDays, Deactivation, ProductPricingView, SubMerchantPricingRow, todayIso } from '../merchants/products';
import { AuthServer } from './auth-server';
import { MerchantDb, MerchantServer } from './merchant-server';
import { FlakyStorage, percentageDraft } from './testing/merchant-test-data';
import { currentCode, signIn } from './testing/sign-in';

const KEY = 'mobi.gp.merchantdb';
const DAY = 86_400_000;

// Seed (Malaysia, live, change mode): Tanjung APP-2026-0001 (FPX, DuitNow QR, Touch 'n Go, Cards;
// Cards v2 waiting for FinOps; Bank Transfer and Touch 'n Go payouts). Nusantara APP-2026-9001 has two
// sub-merchants: the Online Store (own Cards rule, 1.9%) and the Penang Outlet (inherits everything).

describe('Payment-method deactivation and re-authentication', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: MerchantServer;
  let ops: string;

  const call = <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales', token = () => ops) =>
    server.handle(method, path, body, token(), role) as Promise<{ status: number; body: T }>;
  const code = async () => {
    now += 31_000;
    return currentCode(auth, ops);
  };
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const versions = (app: string, method: string) => db().pricingVersions!.filter((v) => v.applicationId === app && v.methodCode === method);
  const config = (app: string) => db().productConfigs!.find((c) => c.applicationId === app)!;
  const view = async (app: string) => (await call<ProductPricingView>('GET', `/api/applications/${app}/products`)).body;
  const subs = () => db().entities!.filter((e) => e.kind === 'sub' && e.gmid === 'GM-109001');
  const online = () => subs().find((s) => s.displayName!.includes('Online'))!.id;
  const penang = () => subs().find((s) => s.displayName!.includes('Penang'))!.id;
  const today = () => todayIso(now);
  const deactivate = async (app: string, body: object, withCode = true) => call<any>('POST', `/api/applications/${app}/deactivations`, { flow: 'payin', subMerchantId: null, reason: 'Provider contract ended', ...body, ...(withCode ? { code: await code() } : {}) });

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 10, 9);
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new MerchantServer({ storage, now: () => now, auth });
    ops = await signIn(auth, '123');
    await call('GET', '/api/merchants');
  });

  describe('re-authentication (5-minute window)', () => {
    const saveSettlement = async (cycle: string, extra: object = {}) => {
      const v = await view('APP-2026-0001');
      return call<any>('PUT', '/api/applications/APP-2026-0001/products', { products: v.config.products.map((p) => ({ methodCode: p.methodCode, enabled: p.enabled })), settlement: { ...v.config.settlement, fpx: cycle }, revision: v.config.revision, ...extra });
    };

    it('asks for a code to change settlement, then not again for 5 minutes', async () => {
      expect(await saveSettlement('T+2')).toMatchObject({ status: 403, body: { code: 'MFA_CODE_REQUIRED' } });
      expect(config('APP-2026-0001').settlement['fpx']).toBe('T+1');
      expect((await saveSettlement('T+2', { code: '000000' })).body.code).toBe('MFA_CODE_INVALID');
      expect((await saveSettlement('T+2', { code: await code() })).status).toBe(200);
      now += 4 * 60_000;
      expect((await saveSettlement('T+3')).status).toBe(200);
      now += 2 * 60_000;
      expect((await saveSettlement('T+1')).body.code).toBe('MFA_CODE_REQUIRED');
    });

    it('asks for a code for a USD fixed fee, not for local-currency pricing', async () => {
      const usd = { ...percentageDraft('bank_transfer_payout', 0, addDays(today(), 1), 'payout'), technique: 'fixed_fee' as const, currency: 'USD', mdrPct: null, minimumFee: null, fixedFee: 0.25 };
      expect((await call<any>('POST', '/api/applications/APP-2026-0001/pricing', { draft: usd })).body.code).toBe('MFA_CODE_REQUIRED');
      expect((await call<any>('POST', '/api/applications/APP-2026-0001/pricing', { draft: usd, code: await code() })).status).toBe(201);
      expect((await call<any>('POST', '/api/applications/APP-2026-0001/pricing', { draft: percentageDraft('fpx', 1.1, addDays(today(), 1)) })).status).toBe(201);
    });
  });

  describe('whole MID', () => {
    it('stops a method immediately: pricing ends today, pending pricing is cancelled, the product switches off', async () => {
      const res = await deactivate('APP-2026-0001', { methodCode: 'cards', when: 'immediate' });
      expect(res.status).toBe(201);
      expect(res.body.deactivation).toMatchObject({ status: 'done', immediate: true, effectiveDate: today(), subMerchantId: null });
      const cards = versions('APP-2026-0001', 'cards');
      expect(cards.map((v) => [v.version, v.status, v.endDate])).toEqual([[1, 'expired', today()], [2, 'cancelled', null]]);
      expect(config('APP-2026-0001').products.find((p) => p.methodCode === 'cards')!.enabled).toBe(false);
      expect(config('APP-2026-0001').settlement['cards']).toBeUndefined();
      const note = db().notifications[0];
      expect(note).toMatchObject({ event: 'payment_method_deactivated', audience: ['finops'], title: 'Cards deactivated: Tanjung Global Trading Sdn Bhd', email: { to: ['finops@mobi.xyz'], status: 'simulated' } });
      expect(db().applications.find((a) => a.id === 'APP-2026-0001')!.history.at(-1)).toMatchObject({ action: 'Deactivated Cards (PayIn) for the Master Merchant and all sub-merchants immediately', comment: 'Provider contract ended' });
      // Pricing for it can't be set again until the product is switched back on.
      expect((await call<any>('POST', '/api/applications/APP-2026-0001/pricing', { draft: percentageDraft('cards', 2, addDays(today(), 1)) })).status).toBe(422);
    });

    it('schedules a stop: pricing ends the day before, nothing else changes until the date, then the daily job applies it', async () => {
      const stop = addDays(today(), 7);
      const res = await deactivate('APP-2026-0001', { methodCode: 'fpx', when: 'scheduled', effectiveDate: stop });
      expect(res.body.deactivation).toMatchObject({ status: 'scheduled', effectiveDate: stop });
      expect(versions('APP-2026-0001', 'fpx')[0]).toMatchObject({ status: 'active', endDate: addDays(stop, -1) });
      expect(config('APP-2026-0001').products.find((p) => p.methodCode === 'fpx')!.enabled).toBe(true);
      // New open-ended pricing can't run past the stop.
      const blocked = await call<any>('POST', '/api/applications/APP-2026-0001/pricing', { draft: percentageDraft('fpx', 1.2, addDays(today(), 2)) });
      expect(blocked.body.message).toMatch(/^FPX stops for the Master Merchant and all sub-merchants from .+\. Set an end date up to .+, or cancel the deactivation first\.$/);
      now += 7 * DAY;
      ops = await signIn(auth, '123'); // the old session timed out
      // The daily job runs on every load (like the pricing status job); the API shows its result.
      const after = await view('APP-2026-0001');
      expect(after.config.products.find((p) => p.methodCode === 'fpx')!.enabled).toBe(false);
      expect(after.config.deactivations![0].status).toBe('done');
      expect(after.versions.find((v) => v.methodCode === 'fpx')!.status).toBe('expired');
    });

    it('cancels a scheduled stop and gives the pricing its end date back', async () => {
      const d = (await deactivate('APP-2026-0001', { methodCode: 'fpx', when: 'scheduled', effectiveDate: addDays(today(), 3) })).body.deactivation as Deactivation;
      const res = await call<any>('POST', `/api/applications/APP-2026-0001/deactivations/${d.id}/cancel`, {});
      expect(res.body.deactivation.status).toBe('cancelled');
      expect(versions('APP-2026-0001', 'fpx')[0]).toMatchObject({ status: 'active', endDate: null });
      expect((await call<any>('POST', `/api/applications/APP-2026-0001/deactivations/${d.id}/cancel`, {})).status).toBe(409);
    });
  });

  describe('one sub-merchant', () => {
    it('stops a method for one sub-merchant only; it no longer inherits, others keep it; reactivating restores inheritance', async () => {
      const res = await deactivate('APP-2026-9001', { methodCode: 'fpx', subMerchantId: penang(), when: 'immediate' });
      expect(res.status).toBe(201);
      const rows = (await call<SubMerchantPricingRow[]>('GET', '/api/pricing/sub-merchants?country=MY')).body;
      const row = (sub: string, method: string) => rows.find((r) => r.subMerchantId === sub && r.methodName === method)!;
      expect(row(penang(), 'FPX')).toMatchObject({ level: null, pricing: null, deactivated: { scope: 'sub_merchant', effectiveDate: today() } });
      expect(row(online(), 'FPX')).toMatchObject({ level: 'merchant', pricing: 'Percentage: 1%', deactivated: null });
      expect(config('APP-2026-9001').products.find((p) => p.methodCode === 'fpx')!.enabled).toBe(true);
      expect((await call<any>('POST', '/api/applications/APP-2026-9001/pricing', { draft: percentageDraft('fpx', 1.1, addDays(today(), 1), 'payin', { subMerchantId: penang() }) })).body.message).toBe(
        'FPX is deactivated for Nusantara Home – Penang Outlet. Reactivate it first.',
      );
      const back = await call<any>('POST', `/api/applications/APP-2026-9001/deactivations/${res.body.deactivation.id}/reactivate`, {});
      expect(back.body.deactivation.status).toBe('reactivated');
      const after = (await call<SubMerchantPricingRow[]>('GET', '/api/pricing/sub-merchants?country=MY')).body.find((r) => r.subMerchantId === penang() && r.methodName === 'FPX')!;
      expect(after).toMatchObject({ level: 'merchant', pricing: 'Percentage: 1%', deactivated: null });
    });

    it('ends only that sub-merchant’s own rule', async () => {
      const stop = addDays(today(), 5);
      await deactivate('APP-2026-9001', { methodCode: 'cards', subMerchantId: online(), when: 'scheduled', effectiveDate: stop });
      const cards = versions('APP-2026-9001', 'cards');
      expect(cards.find((v) => v.subMerchantId === online())!.endDate).toBe(addDays(stop, -1));
      expect(cards.find((v) => !v.subMerchantId)!.endDate).toBeNull();
      expect((await call<SubMerchantPricingRow[]>('GET', '/api/pricing/sub-merchants?country=MY')).body.find((r) => r.subMerchantId === online() && r.methodName === 'Cards')!.stopsOn).toBe(stop);
    });
  });

  describe('rules', () => {
    it('is for Ops after onboarding only, needs a reason and a date from tomorrow, and asks for a code after the checks', async () => {
      const finops = await signIn(auth, 'TANJUNG-ADMIN');
      expect((await call<any>('POST', '/api/applications/APP-2026-0001/deactivations', { methodCode: 'fpx', flow: 'payin', when: 'immediate', reason: 'x' }, 'finops', () => finops)).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED', message: 'Only Ops can deactivate payment methods.' });
      const invalid = await deactivate('APP-2026-0001', { methodCode: 'fpx', when: 'scheduled', effectiveDate: today(), reason: '' }, false);
      expect(invalid.body.errors.map((e: any) => e.message)).toEqual(['Choose a date from tomorrow.', 'Enter a reason for the deactivation.']);
      expect((await deactivate('APP-2026-0001', { methodCode: 'fpx', when: 'immediate' }, false)).body.code).toBe('MFA_CODE_REQUIRED');
      expect((await deactivate('APP-2026-0001', { methodCode: 'boost', when: 'immediate' })).body.message).toBe("Boost isn't switched on for this MID.");
      const d = db();
      d.applications.find((a) => a.id === 'APP-2026-0010')!.status = 'cs_configuration';
      storage.setItem(KEY, JSON.stringify(d));
      expect((await deactivate('APP-2026-0010', { methodCode: 'fpx', when: 'immediate' })).body.message).toBe('Payment methods can be deactivated once onboarding is confirmed. During onboarding, CS switches the product off.');
    });

    it('allows one scheduled stop per scope at a time', async () => {
      await deactivate('APP-2026-0001', { methodCode: 'fpx', when: 'scheduled', effectiveDate: addDays(today(), 4) });
      expect((await deactivate('APP-2026-0001', { methodCode: 'fpx', when: 'immediate' })).body.code).toBe('DEACTIVATION_SCHEDULED');
    });
  });

  describe('unusual-change alerts to FinOps', () => {
    const submit = (method: string, mdr: number, flow: 'payin' | 'payout' = 'payin') => call<any>('POST', '/api/applications/APP-2026-0001/pricing', { draft: percentageDraft(method, mdr, addDays(today(), 1), flow) });
    const alerts = () => db().notifications.filter((n) => n.event === 'pricing_alert');

    it('flags a drop of 30% or more and pricing that charges nothing; a smaller drop is not flagged', async () => {
      await submit('duitnow_qr', 0.7); // 0.8% → 0.7%: −12.5%
      expect(alerts()).toHaveLength(0);
      expect((await submit('fpx', 0.6)).status).toBe(201); // 1% → 0.6%: −40%, still submitted
      expect(alerts()[0]).toMatchObject({
        audience: ['finops'],
        title: 'Unusual pricing change: Tanjung Global Trading Sdn Bhd',
        email: { to: ['finops@mobi.xyz'], subject: '[Mobi pricing] Unusual pricing change: Tanjung Global Trading Sdn Bhd', status: 'simulated' },
      });
      expect(alerts()[0].body).toContain('FPX rate drops from 1% to 0.6% (−40%)');
      await submit('tng', 0);
      expect(alerts()[0].body).toContain("Touch 'n Go pricing set to 0 (no fee charged)");
      expect(db().applications.find((a) => a.id === 'APP-2026-0001')!.history.at(-1)!.action).toContain('Unusual pricing change flagged for FinOps');
    });

    it('flags the fifth pricing change for one merchant within an hour, once', async () => {
      for (const [m, flow] of [['fpx', 'payin'], ['duitnow_qr', 'payin'], ['tng', 'payin'], ['bank_transfer_payout', 'payout']] as const) await submit(m, 0.9, flow);
      expect(alerts().filter((a) => a.body.includes('in the last hour'))).toHaveLength(0);
      await submit('tng_payout', 0.9, 'payout');
      expect(alerts().filter((a) => a.body.includes('5 pricing changes for Tanjung Global Trading Sdn Bhd in the last hour'))).toHaveLength(1);
    });
  });
});
