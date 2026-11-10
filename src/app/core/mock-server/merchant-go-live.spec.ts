import { beforeEach, describe, expect, it } from 'vitest';
import { ApplicationDetail, ApplicationSummary, CountryApplication, GlobalMerchant, MerchantDetail, MerchantSummary, StaffRole } from '../merchants/merchant-models';
import { AuthServer } from './auth-server';
import { MerchantEntity } from './merchant-identity';
import { MerchantDb, MerchantServer } from './merchant-server';
import { completeApplicationData, completeProductConfig, FlakyStorage } from './testing/merchant-test-data';
import { signIn } from './testing/sign-in';

const KEY = 'mobi.gp.merchantdb';
const AUTH_KEY = 'mobi.gp.mockdb';

describe('go-live and live MIDs', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: MerchantServer;
  let token: string;

  const call = <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') => server.handle(method, path, body, token, role) as Promise<{ status: number; body: T }>;
  const ready = (id: string, action: object) => call<CountryApplication>('POST', `/api/applications/${id}/readiness`, action, 'cs');
  const goLive = (id: string) => ready(id, { action: 'confirm_go_live' });
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const authDb = () => JSON.parse(storage.getItem(AUTH_KEY)!) as { accounts: { id: string; merchantId?: string; countries: { code: string; status: string }[] }[]; audit: { type: string; accountId?: string; detail?: string }[] };
  const tick = async (id: string, stage: string, keys: string[]) => {
    for (const key of keys) expect((await ready(id, { action: 'set_item', stage, key, done: true })).status).toBe(200);
  };
  /** GM-109001 (Nusantara, linked to GA-1005, live in MY and ID) applies for Vietnam; takes it to go-live verification. */
  const prepareFurther = async () => {
    const id = (await call<CountryApplication>('POST', '/api/merchants/GM-109001/applications', { country: 'VN' })).body.id;
    await call('POST', `/api/applications/${id}/submit`, { data: completeApplicationData('VN', 'Nusantara Home Retail Sdn Bhd') });
    await call('POST', `/api/applications/${id}/review`, { decision: 'approve', evidenceReviewed: true }, 'risk');
    await ready(id, { action: 'start_configuration' });
    await completeProductConfig(call, id);
    await tick(id, 'configuration', ['settlement_account', 'merchant_portal']);
    await ready(id, { action: 'generate_keys' });
    await ready(id, { action: 'start_integration' });
    await tick(id, 'integration', ['docs_shared', 'sandbox_tests', 'webhook_verified']);
    await ready(id, { action: 'request_go_live' });
    await tick(id, 'go_live', ['live_transaction', 'settlement_test', 'merchant_signoff']);
    return id;
  };
  /** APP-2026-0007 (GM-100106, Vietnam, no Global Account yet) is in go-live verification with one check done. */
  const prepareVietnam = () => tick('APP-2026-0007', 'go_live', ['settlement_test', 'merchant_signoff']);

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 28);
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new MerchantServer({ storage, now: () => now, auth });
    token = await signIn(auth, '123');
    await call('GET', '/api/merchants');
  });

  it('issues no MID before go-live', async () => {
    // Tanjung (MY/ID/VN) and Nusantara Home Retail (MY/ID) are live in the seed.
    const live = new Set(['APP-2026-0001', 'APP-2026-0002', 'APP-2026-0003', 'APP-2026-9001', 'APP-2026-9002']);
    for (const a of db().applications) {
      const detail = (await call<ApplicationDetail>('GET', `/api/applications/${a.id}`)).body;
      expect(!!detail.mid).toBe(live.has(a.id));
    }
    expect(db().mids!.every((m) => m.source === 'migrated')).toBe(true);
  });

  it('issues exactly one live MID at go-live and creates one Global Account for a merchant without one', async () => {
    await prepareVietnam();
    const accountsBefore = authDb().accounts.length;
    const res = await goLive('APP-2026-0007');
    expect(res.body.status).toBe('operational');

    const mids = db().mids!.filter((m) => m.applicationId === 'APP-2026-0007');
    expect(mids).toEqual([expect.objectContaining({ source: 'go_live', regionCode: 'VN', country: 'VN', environment: 'live', gmid: 'GM-100106', issuedBy: 'Sarah Lim', issuedAt: now })]);
    expect(res.body.history.map((h) => h.action)).toEqual(expect.arrayContaining(['Go-live verified; country is operational', `Live MID ${mids[0].mid} issued for Vietnam`]));

    const merchant = (await call<MerchantDetail>('GET', '/api/merchants/GM-100106')).body;
    expect(merchant.merchant.linkedAccountId).toBe('GA-5001');
    expect(merchant.mids.map((m) => m.mid)).toEqual([mids[0].mid]);
    expect(authDb().accounts).toHaveLength(accountsBefore + 1);
    expect(authDb().accounts.find((a) => a.id === 'GA-5001')).toMatchObject({ merchantId: 'GM-100106', countries: [{ code: 'VN', status: 'active' }] });
    expect(db().goLiveIntents).toEqual([]);
  });

  it('shows each application its own live MID in the merchant and application lists', async () => {
    await prepareVietnam();
    await goLive('APP-2026-0007');
    const list = (await call<MerchantSummary[]>('GET', '/api/merchants')).body;
    const apps = list.flatMap((m) => m.applications);
    const byId = new Map(apps.map((a) => [a.id, a.liveMid]));
    expect(byId.get('APP-2026-0001')).toMatchObject({ source: 'migrated', mid: expect.stringMatching(/^MID-\d{9}$/) });
    expect(byId.get('APP-2026-0007')).toMatchObject({ source: 'go_live', mid: db().mids!.find((m) => m.applicationId === 'APP-2026-0007')!.mid });
    for (const a of apps.filter((x) => x.status !== 'operational')) expect(a.liveMid).toBeNull();
    // Key-set references are never presented as MIDs.
    expect(apps.every((a) => !a.liveMid?.mid.startsWith('KS-'))).toBe(true);
    expect((await call<ApplicationSummary[]>('GET', '/api/applications')).body.find((a) => a.id === 'APP-2026-0007')!.liveMid).toEqual(byId.get('APP-2026-0007'));
  });

  it('returns the existing result when a completed go-live is repeated, writing nothing', async () => {
    await prepareVietnam();
    const first = (await goLive('APP-2026-0007')).body;
    const merchantBefore = storage.getItem(KEY);
    const authBefore = authDb();

    const again = await goLive('APP-2026-0007');
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first);
    expect(storage.getItem(KEY)).toBe(merchantBefore); // no new MID, history or notification
    expect(authDb().accounts).toEqual(authBefore.accounts);
    expect(authDb().audit.filter((e) => e.type.startsWith('ACCOUNT_'))).toEqual(authBefore.audit.filter((e) => e.type.startsWith('ACCOUNT_')));
  });

  it('finishes cleanly after a failure between account activation and the final save', async () => {
    await prepareVietnam();
    storage.failWrite(KEY, 1); // the go-live start is saved; the final save fails
    await expect(goLive('APP-2026-0007')).rejects.toThrow(/Simulated storage failure/);

    // Nothing half-done on the merchant side: still in verification, no MID, account not linked yet.
    let d = db();
    expect(d.applications.find((a) => a.id === 'APP-2026-0007')!.status).toBe('go_live_verification');
    expect(d.mids!.some((m) => m.applicationId === 'APP-2026-0007')).toBe(false);
    expect(d.merchants.find((m) => m.id === 'GM-100106')!.linkedAccountId).toBeNull();
    expect(d.goLiveIntents).toEqual([expect.objectContaining({ applicationId: 'APP-2026-0007', by: 'Sarah Lim' })]);
    expect(server.dataReport().flags).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'GO_LIVE_INCOMPLETE', recordId: 'APP-2026-0007' })]));
    expect(authDb().accounts.filter((a) => a.merchantId === 'GM-100106')).toHaveLength(1);

    // The retry reuses that account and completes with one MID.
    const retry = await goLive('APP-2026-0007');
    expect(retry.body.status).toBe('operational');
    d = db();
    expect(d.mids!.filter((m) => m.applicationId === 'APP-2026-0007')).toHaveLength(1);
    expect(d.merchants.find((m) => m.id === 'GM-100106')!.linkedAccountId).toBe('GA-5001');
    expect(d.goLiveIntents).toEqual([]);
    expect(authDb().accounts.filter((a) => a.merchantId === 'GM-100106')).toHaveLength(1);
    expect(authDb().audit.filter((e) => e.type === 'ACCOUNT_CREATED')).toHaveLength(1);
    expect(authDb().audit.filter((e) => e.type === 'ACCOUNT_COUNTRY_ACTIVATED' && e.detail === 'VN')).toHaveLength(1);
    expect(retry.body.history.filter((h) => h.toStatus === 'operational')).toHaveLength(1);
    expect(retry.body.history.map((h) => h.action)).toContain('Vietnam activated on Global Account GA-5001 (account created)');
  });

  describe('when merchant and auth data are out of sync', () => {
    const linkTo = (merchantId: string, accountId: string) => {
      const d = db();
      d.merchants.find((m) => m.id === merchantId)!.linkedAccountId = accountId;
      storage.setItem(KEY, JSON.stringify(d));
    };
    const linksAreUnique = () => {
      const links = db().merchants.map((m) => m.linkedAccountId).filter(Boolean);
      expect(new Set(links).size).toBe(links.length);
      const ids = authDb().accounts.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    };

    it('never gives a new account an ID another merchant still refers to', async () => {
      linkTo('GM-100103', 'GA-5001'); // refers to an account the auth data doesn't have
      expect(authDb().accounts.some((a) => a.id === 'GA-5001')).toBe(false);
      await prepareVietnam();

      expect((await goLive('APP-2026-0007')).body.status).toBe('operational');
      const linked = db().merchants.find((m) => m.id === 'GM-100106')!.linkedAccountId;
      expect(linked).toBe('GA-5002');
      expect(authDb().accounts.find((a) => a.id === 'GA-5002')).toMatchObject({ merchantId: 'GM-100106' });
      linksAreUnique();
    });

    it('creates a new unique account when the merchant links to one the auth data no longer has', async () => {
      linkTo('GM-100106', 'GA-5001');
      linkTo('GM-100103', 'GA-5002');
      await prepareVietnam();

      const res = await goLive('APP-2026-0007');
      expect(res.body.status).toBe('operational');
      expect(db().merchants.find((m) => m.id === 'GM-100106')!.linkedAccountId).toBe('GA-5003');
      expect(res.body.history.map((h) => h.action)).toContain('Vietnam activated on Global Account GA-5003 (account created)');
      linksAreUnique();
      // A retry still finds the same account.
      expect((await goLive('APP-2026-0007')).body.status).toBe('operational');
      expect(authDb().accounts.filter((a) => a.merchantId === 'GM-100106').map((a) => a.id)).toEqual(['GA-5003']);
    });
  });

  it('reuses the linked Global Account for a further country', async () => {
    const id = await prepareFurther();
    const accounts = authDb().accounts.length;
    expect((await goLive(id)).body.status).toBe('operational');
    expect(authDb().accounts).toHaveLength(accounts);
    expect(authDb().accounts.find((a) => a.id === 'GA-1005')!.countries).toContainEqual({ code: 'VN', status: 'active' });
    const mids = (await call<MerchantDetail>('GET', '/api/merchants/GM-109001')).body.mids;
    expect(mids.map((m) => m.country).sort()).toEqual(['ID', 'MY', 'VN']);
    expect(new Set(mids.map((m) => m.mid)).size).toBe(3);
  });

  it('refuses a second MID for the same entity and region, before touching the Global Account', async () => {
    await prepareVietnam();
    const d = db();
    const entityId = d.applications.find((a) => a.id === 'APP-2026-0007')!.entityId!;
    d.mids!.push({ mid: 'MID-000000099', entityId, gmid: 'GM-100106', regionCode: 'VN', country: 'VN', environment: 'live', source: 'go_live', issuedAt: 1, issuedBy: 'x', applicationId: null, demo: false });
    storage.setItem(KEY, JSON.stringify(d));
    const authBefore = storage.getItem(AUTH_KEY);

    expect(await goLive('APP-2026-0007')).toMatchObject({ status: 409, body: { code: 'MID_CONFLICT' } });
    expect(db().goLiveIntents ?? []).toEqual([]);
    expect(storage.getItem(AUTH_KEY)).toBe(authBefore);
  });

  it('blocks go-live for a suspended merchant without writing anything', async () => {
    const id = await prepareFurther();
    await call<GlobalMerchant>('POST', '/api/merchants/GM-109001/lifecycle', { action: 'suspend', reason: 'Chargeback ratio above threshold' }, 'risk');
    const before = storage.getItem(KEY);
    const authBefore = storage.getItem(AUTH_KEY);
    expect(await goLive(id)).toMatchObject({ status: 409, body: { code: 'MERCHANT_SUSPENDED' } });
    expect(storage.getItem(KEY)).toBe(before);
    expect(JSON.parse(storage.getItem(AUTH_KEY)!).accounts).toEqual(JSON.parse(authBefore!).accounts);
  });

  describe('sub-merchant gate (fixture data; creating sub-merchants is not part of Phase 1)', () => {
    /** Adds a sub-merchant of GM-100106 with its own Vietnam application in go-live verification. */
    const addChild = (over: Partial<MerchantEntity> = {}) => {
      const d = db();
      const parent = d.entities!.find((e) => e.gmid === 'GM-100106' && e.kind === 'parent')!;
      const child: MerchantEntity = { id: 'ME-000090', gmid: 'GM-100106', kind: 'sub', parentEntityId: parent.id, legalEntity: null, displayName: 'Hanoi Learning Hub – Cau Giay', lifecycleStatus: 'active', createdAt: now, createdBy: 'Hafiz Ismail', ...over };
      const source = structuredClone(d.applications.find((a) => a.id === 'APP-2026-0007')!);
      const app: CountryApplication = { ...source, id: 'APP-2026-0090', entityId: child.id, status: 'go_live_verification', history: source.history.filter((h) => h.toStatus !== 'operational') };
      d.entities!.push(child);
      d.applications.push(app);
      storage.setItem(KEY, JSON.stringify(d));
    };

    it('needs the parent operational in the country, then gives the child its own MID in the same region', async () => {
      await prepareVietnam();
      addChild();
      expect(await goLive('APP-2026-0090')).toMatchObject({ status: 409, body: { code: 'PARENT_NOT_OPERATIONAL' } });

      await goLive('APP-2026-0007');
      const accounts = authDb().accounts.length;
      expect((await goLive('APP-2026-0090')).body.status).toBe('operational');
      const vn = db().mids!.filter((m) => m.regionCode === 'VN' && m.gmid === 'GM-100106');
      expect(vn).toHaveLength(2);
      expect(new Set(vn.map((m) => m.entityId)).size).toBe(2);
      expect(new Set(vn.map((m) => m.mid)).size).toBe(2);
      expect(authDb().accounts).toHaveLength(accounts); // the child shares the parent's Global Account
    });

    it('is blocked while the child or the parent is suspended, and parent suspension does not suspend the child', async () => {
      await prepareVietnam();
      await goLive('APP-2026-0007');
      addChild({ lifecycleStatus: 'suspended' });
      expect(await goLive('APP-2026-0090')).toMatchObject({ status: 409, body: { code: 'MERCHANT_SUSPENDED' } });

      const d = db();
      d.entities!.find((e) => e.id === 'ME-000090')!.lifecycleStatus = 'active';
      storage.setItem(KEY, JSON.stringify(d));
      await call('POST', '/api/merchants/GM-100106/lifecycle', { action: 'suspend', reason: 'Card scheme investigation' }, 'risk');
      expect(await goLive('APP-2026-0090')).toMatchObject({ status: 409, body: { code: 'MERCHANT_SUSPENDED' } });
      expect(db().entities!.find((e) => e.id === 'ME-000090')!.lifecycleStatus).toBe('active');
    });
  });
});
