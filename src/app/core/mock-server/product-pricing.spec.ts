import { beforeEach, describe, expect, it } from 'vitest';
import { CountryApplication, PortalNotification, StaffRole } from '../merchants/merchant-models';
import { PricingVersion, ProductPricingView, todayIso } from '../merchants/products';

type PricingResult = { version: PricingVersion; view: ProductPricingView };
import { AuthServer } from './auth-server';
import { MerchantDb, MerchantServer } from './merchant-server';
import { completeProductConfig, FlakyStorage } from './testing/merchant-test-data';
import { signIn } from './testing/sign-in';

const KEY = 'mobi.gp.merchantdb';
const DAY = 24 * 60 * 60_000;

// Seed: APP-2026-0010 (Malaysia) is in Product & Payment Config (onboarding): Visa / Mastercard,
// DuitNow QR and Touch 'n Go are on and priced at the default MDR, with no settlement yet;
// APP-2026-0009 (Indonesia) and APP-2026-0007 (Vietnam) are past the handoff, with their first
// three methods switched on at the default MDR; APP-2026-0012 is still with Risk.

describe('Product & Payment Config', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: MerchantServer;
  let guided: MerchantServer;
  let token: string;

  const callOn = (s: MerchantServer) => <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') => s.handle(method, path, body, token, role) as Promise<{ status: number; body: T }>;
  let call: ReturnType<typeof callOn>;
  const view = async (id: string, role: StaffRole = 'cs') => (await call<ProductPricingView>('GET', `/api/applications/${id}/products`, null, role)).body;
  /** Saves products from the current view with changes applied. */
  const save = async (id: string, role: StaffRole, change: { on?: string[]; off?: string[]; settlement?: Record<string, string>; confirm?: boolean; revision?: number }) => {
    const v = await view(id, role);
    const products = v.config.products.map((p) => ({ methodCode: p.methodCode, enabled: change.on?.includes(p.methodCode) ? true : change.off?.includes(p.methodCode) ? false : p.enabled }));
    const settlement = { ...v.config.settlement, ...change.settlement };
    return call<any>('PUT', `/api/applications/${id}/products`, { products, settlement, revision: change.revision ?? v.config.revision, confirmCancelPricing: change.confirm }, role);
  };
  const price = (id: string, role: StaffRole, methodCode: string, mdrPct: number, effectiveDate?: string) =>
    call<any>('POST', `/api/applications/${id}/pricing`, { methodCode, mdrPct, effectiveDate }, role);
  const decide = (id: string, vid: string, decision: string, comment = '', role: StaffRole = 'finops') =>
    call<any>('POST', `/api/applications/${id}/pricing/${vid}/decision`, { decision, comment }, role);
  const ready = (id: string, action: object, s = call) => s<any>('POST', `/api/applications/${id}/readiness`, action, 'cs');
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const app = (id: string) => db().applications.find((a) => a.id === id)!;
  const actions = (id: string) => app(id).history.map((h) => h.action);
  /** Moves the clock and signs in again (sessions expire after 30 idle minutes). */
  const advance = async (ms: number) => {
    now += ms;
    token = await signIn(auth, '123');
  };

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 28, 9);
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new MerchantServer({ storage, now: () => now, auth });
    guided = new MerchantServer({ storage, now: () => now, auth, strictValidation: () => false });
    call = callOn(server);
    token = await signIn(auth, '123');
    await call('GET', '/api/merchants');
  });

  describe('existing data', () => {
    it('starts with every product switched off and no pricing until CS saves, without writing', async () => {
      await call('POST', '/api/applications/APP-2026-0012/review', { decision: 'approve', evidenceReviewed: true }, 'risk');
      await ready('APP-2026-0012', { action: 'start_configuration' });
      const before = storage.getItem(KEY);
      const v = await view('APP-2026-0012');
      expect(v).toMatchObject({ phase: 'onboarding', inferred: true, countryName: 'Malaysia', config: { revision: 0, settlement: {} } });
      expect(v.config.products.some((p) => p.enabled)).toBe(false);
      expect(v.methods.every((m) => m.flow === 'payin')).toBe(true);
      expect(v.versions).toEqual([]);
      expect(v.gaps.map((g) => g.issue)).toEqual(['no_products']);
      expect(storage.getItem(KEY)).toBe(before);
    });

    it('shows the seeded products and pricing of applications past the handoff', async () => {
      const v = await view('APP-2026-0009');
      expect(v.config.products.filter((p) => p.enabled).map((p) => p.methodCode)).toEqual(['ID_QRIS', 'ID_VA', 'ID_OVO']);
      expect(v.versions.map((x) => [x.methodCode, x.status])).toEqual([['ID_QRIS', 'active'], ['ID_VA', 'active'], ['ID_OVO', 'active']]);
    });

    it('is read only before setup starts', async () => {
      const v = await view('APP-2026-0012');
      expect(v).toMatchObject({ phase: 'proposal', versions: [], can: { editProducts: false, editPricing: false, decidePricing: false } });
      expect((await save('APP-2026-0012', 'cs', { settlement: { MY_CARDS: 'T+1' } })).body.code).toBe('INVALID_TRANSITION');
    });
  });

  describe('onboarding gate ("Issue production keys")', () => {
    const tickManual = async (s = call) => {
      for (const key of ['settlement_account', 'merchant_portal']) await s('POST', '/api/applications/APP-2026-0010/readiness', { action: 'set_item', stage: 'configuration', key, done: true }, 'cs');
    };

    it('names every missing item, in strict and in guided mode', async () => {
      await tickManual();
      for (const s of [call, callOn(guided)]) {
        const res = await ready('APP-2026-0010', { action: 'generate_keys' }, s);
        expect(res).toMatchObject({ status: 409, body: { code: 'PRODUCT_CONFIG_INCOMPLETE' } });
        expect(res.body.message).toBe("Finish Product & Payment Config first: Visa / Mastercard: choose a settlement cycle. DuitNow QR: choose a settlement cycle. Touch 'n Go eWallet: choose a settlement cycle.");
      }

      await save('APP-2026-0010', 'cs', { off: ['MY_DUITNOW', 'MY_CARDS', 'MY_TNG'], confirm: true });
      expect((await ready('APP-2026-0010', { action: 'generate_keys' })).body.message).toBe('Finish Product & Payment Config first: Switch on at least one product.');
      await save('APP-2026-0010', 'cs', { on: ['MY_CARDS'], settlement: { MY_CARDS: 'T+2' } });
      expect((await ready('APP-2026-0010', { action: 'generate_keys' }, callOn(guided))).body.message).toBe('Finish Product & Payment Config first: Visa / Mastercard: set pricing.');
      expect(app('APP-2026-0010').status).toBe('cs_configuration');
    });

    it('opens once products, pricing and settlement are complete, and sets the derived checklist items itself', async () => {
      await tickManual();
      expect((await call('POST', '/api/applications/APP-2026-0010/readiness', { action: 'set_item', stage: 'configuration', key: 'pricing_loaded', done: true }, 'cs')).body.message).toMatch(/set automatically/);
      await completeProductConfig(call, 'APP-2026-0010');
      const items = app('APP-2026-0010').readiness.configuration;
      // "Payment methods enabled" was already ticked in the seed; "pricing loaded" is now set by the system.
      expect(items.filter((i) => ['payment_methods', 'pricing_loaded'].includes(i.key)).every((i) => i.done)).toBe(true);
      expect(items.find((i) => i.key === 'pricing_loaded')?.doneBy).toBe('System');
      expect((await ready('APP-2026-0010', { action: 'generate_keys' })).body.status).toBe('keys_generated');
      expect(actions('APP-2026-0010')).toContain('Completed automatically: Approved MDR pricing loaded');
    });
  });

  describe('settlement', () => {
    it('saves and audits settlement without creating or changing any pricing version (onboarding)', async () => {
      const first = await save('APP-2026-0010', 'cs', { settlement: { MY_DUITNOW: 'T+0' } });
      expect(first.body.message).toBe('Settlement saved – DuitNow QR: not set → T+0');
      const versions = () => (db().pricingVersions ?? []).filter((v) => v.applicationId === 'APP-2026-0010');
      // Saving settlement creates no pricing version.
      expect(versions().map((v) => [v.source, v.state, v.settlementCycleAtCreation])).toEqual([
        ['onboarding', 'approved', null],
        ['onboarding', 'approved', null],
        ['onboarding', 'approved', null],
      ]);
      const snapshot = JSON.stringify(versions());
      now += 60_000;
      expect((await save('APP-2026-0010', 'cs', { settlement: { MY_DUITNOW: 'T+1' } })).body.message).toBe('Settlement saved – DuitNow QR: T+0 → T+1');
      expect(JSON.stringify(versions())).toBe(snapshot);
      // Later saves are stored too (not only the first one).
      expect((await view('APP-2026-0010')).config).toMatchObject({ settlement: { MY_DUITNOW: 'T+1' }, revision: 3 });
      expect(db().productConfigs!.find((c) => c.applicationId === 'APP-2026-0010')).toMatchObject({ settlement: { MY_DUITNOW: 'T+1' }, revision: 3 });
      expect(actions('APP-2026-0010')).toEqual(expect.arrayContaining(['Changed settlement cycle – DuitNow QR: not set → T+0', 'Changed settlement cycle – DuitNow QR: T+0 → T+1']));
    });

    it('needs no approval after handoff either', async () => {
      const notesBefore = db().notifications.length;
      expect((await save('APP-2026-0009', 'sales', { settlement: { ID_VA: 'T+3' } })).status).toBe(200);
      expect(db().pricingVersions!.filter((v) => v.applicationId === 'APP-2026-0009').every((v) => v.state === 'approved' && v.source === 'onboarding')).toBe(true);
      expect(db().notifications.length).toBe(notesBefore);
      expect((await view('APP-2026-0009', 'sales')).config.settlement).toEqual({ ID_QRIS: 'T+1', ID_VA: 'T+3', ID_OVO: 'T+1' });
    });

    it('rejects cycles outside T+0 to T+5 and stale saves', async () => {
      expect((await save('APP-2026-0010', 'cs', { settlement: { MY_CARDS: 'T+7' } })).body.errors).toEqual([expect.objectContaining({ field: 'settlement.MY_CARDS' })]);
      await save('APP-2026-0010', 'cs', { settlement: { MY_CARDS: 'T+1' } });
      expect((await save('APP-2026-0010', 'cs', { settlement: { MY_CARDS: 'T+2' }, revision: 0 })).body.code).toBe('CONFIG_CONFLICT');
    });
  });

  describe('switching products off', () => {
    it('during onboarding, asks for confirmation and then cancels the product’s pricing', async () => {
      await save('APP-2026-0010', 'cs', { settlement: { MY_DUITNOW: 'T+1' } });
      const blocked = await save('APP-2026-0010', 'cs', { off: ['MY_DUITNOW'] });
      expect(blocked).toMatchObject({ status: 409, body: { code: 'PRICING_WILL_BE_CANCELLED' } });
      // Switching off also removes the product's settlement cycle, so both are reported and recorded.
      expect((await save('APP-2026-0010', 'cs', { off: ['MY_DUITNOW'], confirm: true })).body.message).toBe('Changes saved');
      const v = await view('APP-2026-0010');
      expect(v.versions.find((x) => x.methodCode === 'MY_DUITNOW')).toMatchObject({ status: 'cancelled', cancelReason: 'Product switched off' });
      expect(v.config.settlement).toEqual({});
      expect(actions('APP-2026-0010')).toEqual(expect.arrayContaining(['Pricing cancelled – DuitNow QR: 0.8% (product switched off)', "Updated products – PayIn: Visa / Mastercard, Touch 'n Go eWallet; PayOut: none", 'Changed settlement cycle – DuitNow QR: T+1 → not set']));
    });

    it('after handoff, refuses to switch off a product with active pricing', async () => {
      const res = await save('APP-2026-0009', 'sales', { off: ['ID_VA'] });
      expect(res).toMatchObject({ status: 409, body: { code: 'PRODUCT_HAS_ACTIVE_PRICING', message: "Bank virtual account has active pricing, so it can't be switched off after onboarding." } });
      expect((await view('APP-2026-0009', 'sales')).config.products.find((p) => p.methodCode === 'ID_VA')!.enabled).toBe(true);
    });

    it('after handoff, cancels pending and scheduled pricing when a product without active pricing is switched off', async () => {
      // APP-2026-0007 (Philippines) has VN_CARDS switched off.
      await save('APP-2026-0007', 'sales', { on: ['VN_CARDS'] });
      const pending = (await price('APP-2026-0007', 'sales', 'VN_CARDS', 2.9)).body.version;
      expect((await save('APP-2026-0007', 'sales', { off: ['VN_CARDS'] })).status).toBe(200);
      expect((await view('APP-2026-0007', 'sales')).versions.find((x) => x.id === pending.id)?.status).toBe('cancelled');

      await save('APP-2026-0007', 'sales', { on: ['VN_CARDS'] });
      const future = (await price('APP-2026-0007', 'sales', 'VN_CARDS', 2.9, todayIso(now + 5 * DAY))).body.version;
      await decide('APP-2026-0007', future.id, 'approve');
      expect((await view('APP-2026-0007', 'sales')).versions.find((x) => x.id === future.id)?.status).toBe('scheduled');
      await save('APP-2026-0007', 'sales', { off: ['VN_CARDS'] });
      expect((await view('APP-2026-0007', 'sales')).versions.find((x) => x.id === future.id)?.status).toBe('cancelled');
    });

    it('offers no PayOut products and refuses unknown ones', async () => {
      const v = await view('APP-2026-0007', 'sales');
      expect(v.methods.filter((m) => m.flow === 'payout')).toEqual([]);
      const res = await call('PUT', '/api/applications/APP-2026-0007/products', { products: [{ methodCode: 'VN_BANK_PAYOUT', enabled: true }], settlement: {}, revision: v.config.revision }, 'sales');
      expect(res.body.message).toMatch(/not a product offered in Vietnam. No payout methods are configured yet./);
    });
  });

  describe('who can change what', () => {
    it('lets only CS change products and pricing during onboarding', async () => {
      for (const role of ['sales', 'risk', 'finops'] as StaffRole[]) {
        expect((await save('APP-2026-0010', role, { settlement: { MY_CARDS: 'T+1' } })).status).toBe(403);
        expect((await price('APP-2026-0010', role, 'MY_CARDS', 2.4)).status).toBe(403);
        expect((await view('APP-2026-0010', role)).can).toEqual({ editProducts: false, editPricing: false, decidePricing: false });
      }
      expect((await view('APP-2026-0010', 'cs')).can).toEqual({ editProducts: true, editPricing: true, decidePricing: false });
    });

    it('after handoff: Sales / Operations change products and propose pricing, FinOps only decides, CS and Risk read', async () => {
      for (const role of ['cs', 'risk', 'finops'] as StaffRole[]) expect((await save('APP-2026-0009', role, { settlement: { ID_VA: 'T+1' } })).status).toBe(403);
      for (const role of ['cs', 'risk', 'finops'] as StaffRole[]) expect((await price('APP-2026-0009', role, 'ID_VA', 1.2)).status).toBe(403);
      const pending = (await price('APP-2026-0009', 'sales', 'ID_VA', 1.2)).body.version;
      for (const role of ['sales', 'cs', 'risk'] as StaffRole[]) expect((await decide('APP-2026-0009', pending.id, 'approve', '', role)).status).toBe(403);
      expect((await view('APP-2026-0009', 'finops')).can).toEqual({ editProducts: false, editPricing: false, decidePricing: true });
      expect((await view('APP-2026-0009', 'finops')).readOnlyReason).toMatch(/FinOps approves or rejects pricing changes/);
    });

    it('lets a suspended merchant’s products and pricing be serviced after onboarding', async () => {
      await call('POST', '/api/merchants/GM-100101/lifecycle', { action: 'suspend', reason: 'Chargeback ratio above threshold' }, 'risk');
      expect((await save('APP-2026-0001', 'sales', { settlement: { MY_CARDS: 'T+2' } })).status).toBe(200);
      const v = (await price('APP-2026-0001', 'sales', 'MY_CARDS', 2.0)).body.version;
      expect((await decide('APP-2026-0001', v.id, 'approve')).body.version.state).toBe('approved');
    });
  });

  describe('pricing', () => {
    it('applies onboarding pricing at once, without approval', async () => {
      const res = await price('APP-2026-0010', 'cs', 'MY_CARDS', 2.5);
      expect(res.body.version).toMatchObject({ state: 'approved', source: 'onboarding', effectiveFrom: now, createdRole: 'cs', decidedBy: null });
      const v = (res.body as PricingResult).view;
      expect(v.versions.filter((x) => x.methodCode === 'MY_CARDS').map((x) => [x.mdrPct, x.status, x.effectiveTo])).toEqual([
        [2.5, 'active', null],
        [2.2, 'superseded', now],
      ]);
      expect(db().notifications.some((n) => n.event === 'pricing_approval_requested')).toBe(false);
      expect(actions('APP-2026-0010')).toContain(`Pricing set – Visa / Mastercard: 2.5% from ${todayIso(now)}`);
    });

    it('accepts MDR only within the country’s range and only for switched-on products', async () => {
      expect((await price('APP-2026-0010', 'cs', 'MY_CARDS', 9)).body.errors).toEqual([expect.objectContaining({ field: 'mdrPct', message: 'Enter an MDR between 1.5% and 3.5%.' })]);
      await save('APP-2026-0010', 'cs', { off: ['MY_CARDS'], confirm: true });
      expect((await price('APP-2026-0010', 'cs', 'MY_CARDS', 2.4)).body.message).toBe('Switch on Visa / Mastercard and save products before pricing it.');
    });

    it('after handoff, waits for FinOps; rejection keeps the current pricing', async () => {
      const pending = (await price('APP-2026-0009', 'sales', 'ID_QRIS', 0.9)).body as PricingResult;
      expect(pending.version).toMatchObject({ state: 'pending_approval', source: 'post_onboarding' });
      expect(pending.view.versions.find((x) => x.methodCode === 'ID_QRIS' && x.status === 'active')?.mdrPct).toBe(0.7);
      expect((await price('APP-2026-0009', 'sales', 'ID_QRIS', 0.95)).body.code).toBe('PRICING_PENDING');
      const note = db().notifications.find((n) => n.event === 'pricing_approval_requested') as PortalNotification;
      expect(note).toMatchObject({ audience: ['finops'], applicationId: 'APP-2026-0009' });
      expect(note.email).toBeUndefined();

      expect((await decide('APP-2026-0009', pending.version.id, 'reject', 'too short')).status).toBe(422);
      const rejected = (await decide('APP-2026-0009', pending.version.id, 'reject', 'Below our floor for QR in Indonesia')).body as PricingResult;
      expect(rejected.version).toMatchObject({ state: 'rejected', decidedRole: 'finops', decisionComment: 'Below our floor for QR in Indonesia' });
      expect(rejected.view.versions.find((x) => x.methodCode === 'ID_QRIS' && x.status === 'active')?.mdrPct).toBe(0.7);
      expect(db().notifications.find((n) => n.event === 'pricing_decided')).toMatchObject({ audience: ['sales'] });
      expect(actions('APP-2026-0009')).toEqual(expect.arrayContaining([`Pricing rejected by FinOps – QRIS: 0.9% from ${todayIso(now)}`]));
    });

    it('after approval, schedules future pricing and supersedes the old version when it takes effect', async () => {
      const startsAt = Date.parse(`${todayIso(now + 2 * DAY)}T00:00:00Z`);
      const v = (await price('APP-2026-0009', 'sales', 'ID_QRIS', 0.9, todayIso(now + 2 * DAY))).body.version;
      expect(((await decide('APP-2026-0009', v.id, 'approve')).body as PricingResult).view.versions.find((x) => x.id === v.id)).toMatchObject({ status: 'scheduled', effectiveFrom: startsAt });
      await advance(3 * DAY);
      const after = (await view('APP-2026-0009', 'sales')).versions.filter((x) => x.methodCode === 'ID_QRIS');
      expect(after.map((x) => [x.mdrPct, x.status, x.effectiveTo])).toEqual([
        [0.9, 'active', null],
        [0.7, 'superseded', startsAt],
      ]);
    });

    it('takes effect at approval time when FinOps approves after the requested date', async () => {
      const v = (await price('APP-2026-0009', 'sales', 'ID_QRIS', 0.9, todayIso(now + DAY))).body.version;
      await advance(3 * DAY);
      expect((await decide('APP-2026-0009', v.id, 'approve')).body.version.effectiveFrom).toBe(now);
    });

    it('cancels only pricing that is pending or scheduled', async () => {
      const active = (await view('APP-2026-0009', 'sales')).versions.find((x) => x.status === 'active')!;
      expect((await call('POST', `/api/applications/APP-2026-0009/pricing/${active.id}/cancel`, {}, 'sales')).body.code).toBe('INVALID_TRANSITION');
      const pending = (await price('APP-2026-0009', 'sales', 'ID_VA', 1.2)).body.version;
      expect((await call<any>('POST', `/api/applications/APP-2026-0009/pricing/${pending.id}/cancel`, { reason: 'Entered by mistake' }, 'sales')).body.version.state).toBe('cancelled');
    });
  });
});
