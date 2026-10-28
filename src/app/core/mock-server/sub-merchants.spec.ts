import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toConfigInput } from '../merchants/country-config';
import { CountryApplication, MerchantDetail, StaffRole } from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES, resetCountryConfigs } from '../merchants/onboarding-config';
import { SubMerchantView } from '../merchants/sub-merchants';
import { AuthServer } from './auth-server';
import { CountryConfigServer } from './country-config-server';
import { entityProblems } from './merchant-identity';
import { MerchantDb, MerchantServer } from './merchant-server';
import { DEMO_PASSWORD } from './seed';
import { FlakyStorage } from './testing/merchant-test-data';

const KEY = 'mobi.gp.merchantdb';

// Seed: GM-100101 is live in MY, ID and VN (TH in setup, PH rejected). GM-100106 (Manila) is in
// go-live verification in PH with a MY draft. GM-100108 has no applications.

describe('Sub-merchants', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let config: CountryConfigServer;
  let server: MerchantServer;
  let guided: MerchantServer;
  let token: string;

  const callOn = (s: MerchantServer) => <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') => s.handle(method, path, body, token, role) as Promise<{ status: number; body: T }>;
  let call: ReturnType<typeof callOn>;
  const create = (gmid: string, body: object, role: StaffRole = 'sales') => call<any>('POST', `/api/merchants/${gmid}/sub-merchants`, body, role);
  const act = (id: string, action: string, body: object = {}, role: StaffRole = 'sales', s = call) => s<any>('POST', `/api/sub-merchants/${id}/${action}`, body, role);
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const subs = async (gmid: string) => (await call<MerchantDetail>('GET', `/api/merchants/${gmid}`)).body.subMerchants;
  /** A sub-merchant of GM-100106 in the Philippines, approved by Risk. */
  const approvedPh = async (name = 'Manila Learning Hub – Makati') => {
    const s = (await create('GM-100106', { country: 'PH', displayName: name, legalEntity: null, submit: true })).body as SubMerchantView;
    await act(s.id, 'review', { decision: 'approve' }, 'risk');
    return s;
  };
  /** Takes the parent's Philippines application (APP-2026-0007) live. */
  const parentLiveInPh = async () => {
    for (const key of ['settlement_test', 'merchant_signoff']) await call('POST', '/api/applications/APP-2026-0007/readiness', { action: 'set_item', stage: 'go_live', key, done: true }, 'cs');
    expect((await call<CountryApplication>('POST', '/api/applications/APP-2026-0007/readiness', { action: 'confirm_go_live' }, 'cs')).body.status).toBe('operational');
  };

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 28, 9);
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    config = new CountryConfigServer({ storage, now: () => now, auth });
    server = new MerchantServer({ storage, now: () => now, auth, countryConfig: config });
    guided = new MerchantServer({ storage, now: () => now, auth, countryConfig: config, strictValidation: () => false });
    call = callOn(server);
    token = ((await auth.handle('POST', '/api/auth/login', { loginId: '123', password: DEMO_PASSWORD }, null)).body as any).token;
    await call('GET', '/api/merchants');
  });

  afterEach(() => resetCountryConfigs());

  describe('creation', () => {
    it('creates a lightweight child of the parent, optionally a separate legal entity', async () => {
      const plain = await create('GM-100101', { country: 'MY', displayName: 'Tanjung Outlet KL', legalEntity: null });
      expect(plain.status).toBe(201);
      expect(plain.body).toMatchObject({ status: 'draft', country: 'MY', legalEntity: null, createdVia: 'ops', lifecycleStatus: 'active', mid: null });
      const separate = await create('GM-100101', { country: 'MY', displayName: 'Tanjung Penang', legalEntity: { legalName: 'Tanjung Penang Sdn Bhd', registrationNumber: '202401000555' } });
      expect(separate.body.legalEntity).toEqual({ legalName: 'Tanjung Penang Sdn Bhd', registrationNumber: '202401000555' });

      const d = db();
      const parent = d.entities!.find((e) => e.gmid === 'GM-100101' && e.kind === 'parent')!;
      const children = d.entities!.filter((e) => e.kind === 'sub');
      expect(children.map((c) => [c.gmid, c.parentEntityId])).toEqual([['GM-100101', parent.id], ['GM-100101', parent.id]]);
      for (const c of children) {
        expect(entityProblems(c, d.entities!)).toEqual([]);
        expect('mcc' in c).toBe(false); // the parent's MCC applies
      }
      expect((await subs('GM-100101')).map((s) => s.displayName)).toEqual(['Tanjung Outlet KL', 'Tanjung Penang']);
      expect((await create('GM-100101', { country: 'MY', displayName: 'tanjung outlet kl', legalEntity: null })).body.code).toBe('DUPLICATE_MERCHANT');
    });

    it('validates the name, legal entity and country, and only Sales / Operations can create', async () => {
      for (const role of ['risk', 'cs', 'finops'] as StaffRole[]) expect((await create('GM-100101', { country: 'MY', displayName: 'Outlet', legalEntity: null }, role)).status).toBe(403);
      expect((await create('GM-100108', { country: 'MY', displayName: 'Outlet', legalEntity: null })).body.message).toMatch(/has no application in Malaysia/);
      expect((await create('GM-100101', { country: 'PH', displayName: 'Outlet', legalEntity: null })).body.message).toMatch(/has no application in Philippines/); // only rejected there
      expect((await create('GM-100101', { country: 'MY', displayName: 'X', legalEntity: null })).body.errors).toEqual([expect.objectContaining({ field: 'displayName' })]);
      const bad = await create('GM-100101', { country: 'MY', displayName: 'Outlet', legalEntity: { legalName: '', registrationNumber: '123' } });
      expect(bad.body.errors.map((e: any) => e.field)).toEqual(['legalEntity.legalName', 'legalEntity.registrationNumber']);
      expect((await create('GM-100101', { country: 'MY', displayName: 'Outlet', legalEntity: { legalName: 'Copy Sdn Bhd', registrationNumber: '201901012345' } })).body.errors[0].message).toMatch(/parent's registration number/);
    });

    it('is blocked while the parent is suspended', async () => {
      await call('POST', '/api/merchants/GM-100101/lifecycle', { action: 'suspend', reason: 'Chargeback ratio above threshold' }, 'risk');
      expect((await create('GM-100101', { country: 'MY', displayName: 'Outlet', legalEntity: null })).body.code).toBe('MERCHANT_SUSPENDED');
    });

    it('follows the creation routes in Country configuration, with each change audited', async () => {
      const put = (routes: object, version: number) =>
        config.handle('PUT', '/api/config/countries/MY', { ...toConfigInput(ONBOARDING_COUNTRIES['MY']), subMerchantCreation: routes, version, reason: 'Sub-merchant policy update' }, token, 'sales');
      expect((await create('GM-100101', { country: 'MY', displayName: 'Outlet', legalEntity: null, route: 'parent' })).body.code).toBe('SUB_MERCHANT_ROUTE_NOT_ALLOWED');

      expect((await put({ opsInitiated: false, parentInitiated: true }, 1)).status).toBe(200);
      expect((await create('GM-100101', { country: 'MY', displayName: 'Outlet', legalEntity: null })).body.code).toBe('SUB_MERCHANT_ROUTE_NOT_ALLOWED');
      expect((await create('GM-100101', { country: 'MY', displayName: 'Outlet', legalEntity: null, route: 'parent' })).body.message).toMatch(/merchant-facing portal/);
      const history = ((await config.handle('GET', '/api/config/countries/MY', null, token, 'sales')).body as any).history;
      expect(history[0]).toMatchObject({ reason: 'Sub-merchant policy update', changes: ['Sub-merchant creation routes: parent merchant'] });

      await put({ opsInitiated: true, parentInitiated: false }, 2);
      expect((await create('GM-100101', { country: 'MY', displayName: 'Outlet', legalEntity: null })).status).toBe(201);
    });
  });

  describe('Risk review', () => {
    it('submits to Risk, who approves or rejects with a reason; Risk sees it on the Approvals page', async () => {
      const s = (await create('GM-100101', { country: 'MY', displayName: 'Tanjung Outlet KL', legalEntity: null })).body;
      expect((await act(s.id, 'submit', {}, 'cs')).status).toBe(403);
      expect((await act(s.id, 'submit')).body.status).toBe('pending_risk_review');
      expect(db().notifications[0]).toMatchObject({ event: 'sub_merchant_submitted', audience: ['risk'], merchantId: 'GM-100101' });
      const risk = (await call<any>('GET', '/api/approvals', null, 'risk')).body;
      expect(risk.pending).toEqual([expect.objectContaining({ kind: 'sub_merchant', id: s.id, summary: 'Tanjung Outlet KL (trades under the parent)', link: ['/merchants', 'GM-100101'] })]);

      expect((await act(s.id, 'review', { decision: 'approve' }, 'sales')).status).toBe(403);
      expect((await act(s.id, 'review', { decision: 'reject', comment: 'short' }, 'risk')).status).toBe(422);
      const rejected = (await act(s.id, 'review', { decision: 'reject', comment: 'Outlet is not part of the approved group structure' }, 'risk')).body;
      expect(rejected.status).toBe('rejected');
      expect(rejected.history[0]).toMatchObject({ action: 'Rejected by Risk', role: 'risk', comment: 'Outlet is not part of the approved group structure' });
      expect((await act(s.id, 'review', { decision: 'approve' }, 'risk')).body.code).toBe('INVALID_TRANSITION');
      expect((await call<any>('GET', '/api/approvals', null, 'risk')).body.recent[0]).toMatchObject({ kind: 'sub_merchant', status: 'rejected' });
    });
  });

  describe('go-live', () => {
    it('needs the parent live in the country, then issues the child its own MID without touching Global Accounts', async () => {
      const s = await approvedPh();
      expect((await act(s.id, 'go-live', {}, 'cs')).body.code).toBe('PARENT_NOT_OPERATIONAL');
      expect((await subs('GM-100106'))[0].goLiveBlocker).toMatch(/can't go live until Manila Learning Hub Inc. is operational/);
      await parentLiveInPh();

      for (const role of ['sales', 'risk', 'finops'] as StaffRole[]) expect((await act(s.id, 'go-live', {}, role)).status).toBe(403);
      expect((await act(s.id, 'go-live', {}, 'cs')).body.code).toBe('CHECKLIST_INCOMPLETE');
      for (const key of ['live_transaction', 'merchant_signoff']) await act(s.id, 'checks', { key, done: true }, 'cs');
      const accounts = JSON.parse(storage.getItem('mobi.gp.mockdb')!).accounts;
      const live = (await act(s.id, 'go-live', {}, 'cs')).body as SubMerchantView;
      expect(live.status).toBe('live');
      const mids = db().mids!.filter((m) => m.regionCode === 'PH' && m.gmid === 'GM-100106');
      expect(mids).toHaveLength(2);
      expect(new Set(mids.map((m) => m.mid)).size).toBe(2);
      expect(mids.find((m) => m.entityId === s.id)).toMatchObject({ applicationId: null, country: 'PH', source: 'go_live' });
      expect(live.mid?.mid).toBe(mids.find((m) => m.entityId === s.id)!.mid);
      expect(JSON.parse(storage.getItem('mobi.gp.mockdb')!).accounts).toEqual(accounts);

      // Repeating go-live returns the same result and writes nothing.
      const before = storage.getItem(KEY);
      expect((await act(s.id, 'go-live', {}, 'cs')).body.mid.mid).toBe(live.mid!.mid);
      expect(storage.getItem(KEY)).toBe(before);
    });

    it('in guided mode completes open checks, recording who did it', async () => {
      await parentLiveInPh();
      const s = await approvedPh();
      const live = (await act(s.id, 'go-live', {}, 'cs', callOn(guided))).body as SubMerchantView;
      expect(live.status).toBe('live');
      expect(live.goLiveChecks.every((c) => c.done && c.doneBy === 'Sarah Lim')).toBe(true);
    });

    it('is blocked while the parent or the child is suspended; suspensions stay separate', async () => {
      await parentLiveInPh();
      const a = await approvedPh('Makati');
      const b = await approvedPh('Cebu');

      expect((await act(a.id, 'lifecycle', { action: 'suspend', reason: 'x' }, 'sales')).status).toBe(400);
      expect((await act(a.id, 'lifecycle', { action: 'suspend', reason: 'Unusual refunds' }, 'cs')).status).toBe(403);
      expect((await act(a.id, 'lifecycle', { action: 'suspend', reason: 'Unusual refunds' }, 'sales')).body.lifecycleStatus).toBe('suspended');
      expect((await act(a.id, 'go-live', {}, 'cs')).body.code).toBe('MERCHANT_SUSPENDED');
      const detail = (await call<MerchantDetail>('GET', '/api/merchants/GM-100106')).body;
      expect(detail.merchant.lifecycleStatus).toBe('active');
      expect(detail.subMerchants.find((s) => s.id === b.id)!.lifecycleStatus).toBe('active');
      expect((await act(a.id, 'lifecycle', { action: 'reactivate', reason: 'Reviewed and cleared' }, 'sales')).status).toBe(403);
      expect((await act(a.id, 'lifecycle', { action: 'reactivate', reason: 'Reviewed and cleared' }, 'risk')).body.lifecycleStatus).toBe('active');

      await call('POST', '/api/merchants/GM-100106/lifecycle', { action: 'suspend', reason: 'Card scheme investigation' }, 'risk');
      expect((await act(b.id, 'go-live', {}, 'cs')).body.code).toBe('MERCHANT_SUSPENDED');
      expect((await subs('GM-100106')).map((s) => s.lifecycleStatus)).toEqual(['active', 'active']); // no cascade
    });
  });

  it('shows the parent’s products, pricing and settlement for that country', async () => {
    await call('PUT', '/api/applications/APP-2026-0001/products', { products: [{ methodCode: 'MY_CARDS', enabled: true }, { methodCode: 'MY_FPX', enabled: true }, { methodCode: 'MY_DUITNOW', enabled: true }], settlement: { MY_FPX: 'T+1' }, revision: 0 }, 'sales');
    const s = (await create('GM-100101', { country: 'MY', displayName: 'Tanjung Outlet KL', legalEntity: null })).body as SubMerchantView;
    expect(s.parentApplicationId).toBe('APP-2026-0001');
    expect(s.inherited.products).toEqual([
      { name: 'Visa / Mastercard', mdrPct: 2.2, settlement: null },
      { name: 'FPX online banking', mdrPct: 1, settlement: 'T+1' },
      { name: 'DuitNow QR', mdrPct: 0.8, settlement: null },
    ]);
  });

  it('leaves the parent’s applications, MIDs and data upgrade untouched', async () => {
    const keep = () => JSON.stringify({ apps: db().applications, mids: db().mids });
    const before = keep();
    const s = (await create('GM-100101', { country: 'MY', displayName: 'Outlet', legalEntity: null, submit: true })).body;
    await act(s.id, 'review', { decision: 'approve' }, 'risk');
    expect(keep()).toBe(before);
    expect(server.dataReport().flags).toEqual([]);
  });
});
