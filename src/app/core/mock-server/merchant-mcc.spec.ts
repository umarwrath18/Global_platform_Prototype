import { beforeEach, describe, expect, it } from 'vitest';
import { catalogueCovers, MccCatalogue, MccChangeRequest, mccOptionsFor } from '../merchants/mcc';
import { CountryApplication, GlobalMerchant, MerchantDetail, PortalNotification, StaffRole } from '../merchants/merchant-models';
import { AuthServer } from './auth-server';
import { MccCatalogueServer } from './mcc-catalogue-server';
import { MCC_TEST_FIXTURE } from './mcc-test-fixture';
import { entityProblems, MerchantEntity, mccOfEntity } from './merchant-identity';
import { MerchantDb, MerchantServer } from './merchant-server';
import { completeApplicationData, FlakyStorage, v2Fixture } from './testing/merchant-test-data';
import { signIn } from './testing/sign-in';

const KEY = 'mobi.gp.merchantdb';
const MCC_KEY = 'mobi.gp.mcccatalogue';
const MINUTE = 60_000;

describe('MCC management', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let mcc: MccCatalogueServer;
  let server: MerchantServer;
  let token: string;

  const call = <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') => server.handle(method, path, body, token, role) as Promise<{ status: number; body: T }>;
  const detail = async (id: string) => (await call<MerchantDetail>('GET', `/api/merchants/${id}`)).body;
  const setMcc = (id: string, code: string, role: StaffRole = 'sales') => call<GlobalMerchant>('PUT', `/api/merchants/${id}/mcc`, { code }, role);
  const request = (id: string, code: string, reason = 'Business now mainly sells groceries online', role: StaffRole = 'sales') =>
    call<MccChangeRequest>('POST', `/api/merchants/${id}/mcc-requests`, { code, reason }, role);
  const decide = (id: string, rid: string, decision: string, comment = '', role: StaffRole = 'risk') =>
    call<MccChangeRequest>('POST', `/api/merchants/${id}/mcc-requests/${rid}/decision`, { decision, comment }, role);
  const newMerchant = async (legalName: string, registrationNumber: string) =>
    (await call<GlobalMerchant>('POST', '/api/merchants', { legalName, registrationCountry: 'MY', registrationNumber, primaryContact: { name: 'Ana', email: 'ana@shop.test', phone: '+60 12 000 0000' } })).body;
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 28);
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    mcc = new MccCatalogueServer({ storage, now: () => now, auth });
    server = new MerchantServer({ storage, now: () => now, auth, mcc });
    token = await signIn(auth, '123');
  });

  describe('catalogue', () => {
    it('is empty until loaded on purpose, and MCC is then optional everywhere', async () => {
      expect((await mcc.handle('GET', '/api/config/mcc', null, null)).status).toBe(401);
      expect((await mcc.handle('GET', '/api/config/mcc', null, token)).body).toEqual({ source: null, entries: [] });
      expect(storage.getItem(MCC_KEY)).toBeNull();

      expect(await setMcc('GM-100104', '5411')).toMatchObject({ status: 422, body: { code: 'MCC_NOT_AVAILABLE', message: expect.stringMatching(/No MCC catalogue/) } });
      const m = await newMerchant('Kedai Buku Sdn Bhd', '202401000101');
      const app = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' })).body;
      expect((await call<CountryApplication>('POST', `/api/applications/${app.id}/submit`, { data: completeApplicationData('MY', m.legalName) })).body.status).toBe('pending_risk_review');
      expect(storage.getItem(MCC_KEY)).toBeNull();
    });

    it('loads only a valid catalogue, and labels the test fixture', () => {
      expect(mcc.load([{ code: '54', description: 'x', countries: { MY: 'available' } }], { kind: 'approved', name: 'Spec', version: '1' })).toMatch(/^Not loaded/);
      expect(mcc.load([{ code: '5411', description: 'x', countries: { MY: 'banned' } }], { kind: 'approved', name: 'Spec', version: '1' })).toMatch(/must be "available" or "restricted"/);
      expect(mcc.load([{ code: '5411', description: 'x', countries: {} }, { code: '5411', description: 'y', countries: {} }], { kind: 'approved', name: 'Spec', version: '1' })).toMatch(/more than once/);
      expect(storage.getItem(MCC_KEY)).toBeNull();

      mcc.loadTestFixture();
      const cat = mcc.catalogue();
      expect(cat.source).toMatchObject({ kind: 'test_fixture', name: expect.stringMatching(/^TEST FIXTURE/), loadedAt: now });
      expect(cat.entries.every((e) => e.description.startsWith('TEST –'))).toBe(true);
      expect(cat.entries).toHaveLength(MCC_TEST_FIXTURE.length);
    });

    it('lists only the MCCs available in a country, with restricted ones marked', () => {
      mcc.loadTestFixture();
      const cat: MccCatalogue = mcc.catalogue();
      expect(mccOptionsFor(cat, 'VN').map((o) => o.code)).toEqual(['5411', '8299']);
      expect(mccOptionsFor(cat, 'TH').find((o) => o.code === '5814')?.availability).toBe('restricted');
      expect(mccOptionsFor(cat, 'MY').find((o) => o.code === '7995')?.availability).toBe('restricted');
      expect(catalogueCovers(cat, 'SG')).toBe(false);
    });
  });

  describe('before Risk approval', () => {
    beforeEach(() => mcc.loadTestFixture());

    it('lets only Sales / Operations set it directly, only to a code available in its countries, and records each change', async () => {
      // GM-100104 has one draft application, in Vietnam.
      expect((await setMcc('GM-100104', '5411', 'risk')).status).toBe(403);
      expect((await setMcc('GM-100104', '5411', 'cs')).status).toBe(403);
      expect(await setMcc('GM-100104', '5732')).toMatchObject({ status: 422, body: { code: 'MCC_NOT_AVAILABLE', message: 'MCC 5732 is not available in Vietnam.' } });
      expect(await setMcc('GM-100104', '0000')).toMatchObject({ status: 422, body: { code: 'MCC_NOT_AVAILABLE' } });

      expect((await setMcc('GM-100104', '5411')).body.mcc).toMatchObject({ code: '5411', description: 'TEST – Grocery stores', catalogueKind: 'test_fixture', catalogueVersion: 'test-1', setBy: 'Sarah Lim', setAt: now });
      now += MINUTE;
      await setMcc('GM-100104', '8299');
      const events = (await detail('GM-100104')).mccEvents;
      expect(events.map((e) => [e.outcome, e.previous?.code ?? null, e.next?.code])).toEqual([
        ['set_before_approval', '5411', '8299'],
        ['set_before_approval', null, '5411'],
      ]);
      expect(events[0]).toMatchObject({ requestedBy: 'Sarah Lim', requestedRole: 'sales', requestedAt: now, decidedBy: null, merchantId: 'GM-100104' });
    });

    it('requires an MCC at submission only in countries the catalogue covers', async () => {
      mcc.load([{ code: '5411', description: 'Spec data – grocery', countries: { MY: 'available' } }], { kind: 'approved', name: 'Spec catalogue (test data)', version: '1' });
      const m = await newMerchant('Kedai Buku Sdn Bhd', '202401000101');
      const ph = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'PH' })).body;
      expect((await call<CountryApplication>('POST', `/api/applications/${ph.id}/submit`, { data: completeApplicationData('PH', m.legalName) })).body.status).toBe('pending_risk_review');

      const my = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' })).body;
      const blocked = await call('POST', `/api/applications/${my.id}/submit`, { data: completeApplicationData('MY', m.legalName) });
      expect(blocked.body.code).toBe('APPLICATION_INCOMPLETE');
      expect(blocked.body.errors.map((e: any) => e.field)).toEqual(['business.mcc']);

      await setMcc(m.id, '5411');
      const submitted = (await call<CountryApplication>('POST', `/api/applications/${my.id}/submit`, {})).body;
      expect(submitted.status).toBe('pending_risk_review');
      expect(submitted.submittedProfile?.mcc).toEqual({ code: '5411', description: 'Spec data – grocery' });
    });

    it('refuses a new country where the merchant’s MCC is not available', async () => {
      const m = await newMerchant('Gadget Hub Sdn Bhd', '202401000102');
      await setMcc(m.id, '5732'); // available in Malaysia and Thailand only
      expect(await call('POST', `/api/merchants/${m.id}/applications`, { country: 'VN' })).toMatchObject({ status: 422, body: { code: 'MCC_NOT_AVAILABLE' } });
      expect((await call('POST', `/api/merchants/${m.id}/applications`, { country: 'TH' })).status).toBe(201);
    });

    it('allows a restricted MCC but records that it is restricted', async () => {
      // GM-100107 has one application, in Malaysia, not yet approved.
      await setMcc('GM-100107', '7995');
      expect((await detail('GM-100107')).mccEvents[0]).toMatchObject({ next: { code: '7995' }, restrictedIn: ['MY'] });
    });
  });

  describe('after Risk approval', () => {
    beforeEach(() => mcc.loadTestFixture());

    it('changes the MCC only when Risk approves, recording a complete audit trail', async () => {
      // GM-100101 is approved, with applications in MY, ID, VN and TH.
      expect(await setMcc('GM-100101', '5411')).toMatchObject({ status: 409, body: { code: 'MCC_CHANGE_REQUIRED' } });
      expect((await request('GM-100101', '5411', 'too short')).status).toBe(422);
      expect((await request('GM-100101', '5411', undefined, 'risk')).status).toBe(403);
      expect((await request('GM-100101', '5814')).body).toMatchObject({ code: 'MCC_NOT_AVAILABLE', message: 'MCC 5814 is not available in Vietnam.' });

      const req = (await request('GM-100101', '5411')).body;
      expect(req).toMatchObject({ id: 'MCR-0001', status: 'pending', previous: null, proposed: { code: '5411' }, requestedBy: 'Sarah Lim', requestedRole: 'sales', requestedAt: now });
      expect((await detail('GM-100101')).merchant.mcc ?? null).toBeNull();
      expect((await detail('GM-100101')).mccRequest?.id).toBe('MCR-0001');
      expect(await request('GM-100101', '8299')).toMatchObject({ status: 409, body: { code: 'MCC_CHANGE_PENDING' } });
      expect((await decide('GM-100101', req.id, 'approve', '', 'sales')).status).toBe(403);
      expect((await decide('GM-100101', req.id, 'approve', '', 'cs')).status).toBe(403);
      const toRisk = db().notifications.find((n) => n.event === 'mcc_change_requested') as PortalNotification;
      expect(toRisk).toMatchObject({ audience: ['risk'], applicationId: '', merchantId: 'GM-100101' });

      const requestedAt = now;
      now += 5 * MINUTE;
      const approved = (await decide('GM-100101', req.id, 'approve', 'Matches the website and volumes')).body;
      expect(approved).toMatchObject({ status: 'approved', decidedBy: 'Sarah Lim', decidedRole: 'risk', decidedAt: now, decisionComment: 'Matches the website and volumes' });
      const d = await detail('GM-100101');
      expect(d.merchant.mcc).toMatchObject({ code: '5411', setAt: now });
      expect(d.mccRequest).toBeNull();
      expect(d.mccEvents[0]).toEqual({
        at: now, merchantId: 'GM-100101', outcome: 'change_approved', previous: null, next: { code: '5411', description: 'TEST – Grocery stores' },
        reason: 'Business now mainly sells groceries online', requestId: 'MCR-0001', requestedBy: 'Sarah Lim', requestedRole: 'sales', requestedAt,
        decidedBy: 'Sarah Lim', decidedRole: 'risk', decidedAt: now, comment: 'Matches the website and volumes', restrictedIn: [],
      });
      expect(d.mccEvents[1]).toMatchObject({ outcome: 'change_requested', decidedBy: null });
      expect(db().notifications.find((n) => n.event === 'mcc_change_decided')).toMatchObject({ audience: ['sales'], applicationId: '' });
      expect(await decide('GM-100101', req.id, 'reject', 'Second decision attempt')).toMatchObject({ status: 409, body: { code: 'INVALID_TRANSITION' } });
    });

    it('leaves the MCC unchanged when Risk rejects, and requires a reason', async () => {
      await request('GM-100101', '5411');
      await decide('GM-100101', 'MCR-0001', 'approve');
      const req = (await request('GM-100101', '8299', 'Now mainly runs training courses')).body;
      expect((await decide('GM-100101', req.id, 'reject', 'no')).status).toBe(422);
      const rejected = (await decide('GM-100101', req.id, 'reject', 'Website still shows a grocery business')).body;
      expect(rejected.status).toBe('rejected');
      const d = await detail('GM-100101');
      expect(d.merchant.mcc?.code).toBe('5411');
      expect(d.mccEvents[0]).toMatchObject({ outcome: 'change_rejected', previous: { code: '5411' }, next: { code: '8299' }, reason: 'Now mainly runs training courses', comment: 'Website still shows a grocery business', decidedRole: 'risk' });
    });

    it('flags a restricted MCC to Risk without blocking it', async () => {
      // GM-100105 is approved, with one application in Thailand, where 5814 is restricted.
      const req = (await request('GM-100105', '5814')).body;
      expect(req.restrictedIn).toEqual(['TH']);
      expect((await decide('GM-100105', req.id, 'approve')).body.status).toBe('approved');
      expect((await detail('GM-100105')).mccEvents[0]).toMatchObject({ outcome: 'change_approved', restrictedIn: ['TH'] });
    });

    it('re-checks availability when Risk decides', async () => {
      const req = (await request('GM-100105', '5732')).body; // TH available today
      mcc.load(MCC_TEST_FIXTURE.map((e) => (e.code === '5732' ? { ...e, countries: { MY: 'available' as const } } : e)), { kind: 'test_fixture', name: 'TEST FIXTURE – changed', version: 'test-2' });
      expect(await decide('GM-100105', req.id, 'approve')).toMatchObject({ status: 422, body: { code: 'MCC_NOT_AVAILABLE' } });
      expect((await detail('GM-100105')).mccRequest?.status).toBe('pending');
      expect((await decide('GM-100105', req.id, 'reject', 'No longer available in Thailand')).body.status).toBe('rejected');
    });

    it('allows MCC requests and decisions while suspended, but still blocks new countries', async () => {
      await call('POST', '/api/merchants/GM-100101/lifecycle', { action: 'suspend', reason: 'Chargeback ratio above threshold' }, 'risk');
      const req = (await request('GM-100101', '8299')).body;
      expect((await decide('GM-100101', req.id, 'approve')).body.status).toBe('approved');
      expect(await call('POST', '/api/merchants/GM-100101/applications', { country: 'PH' })).toMatchObject({ status: 409, body: { code: 'MERCHANT_SUSPENDED' } });
    });
  });

  describe('parent merchant only', () => {
    beforeEach(() => mcc.loadTestFixture());

    it('keeps the MCC on the GMID record; sub-merchants use the parent’s and cannot hold their own', async () => {
      await call('GET', '/api/merchants');
      const d = db();
      const parent = d.entities!.find((e) => e.gmid === 'GM-100104' && e.kind === 'parent')!;
      const child: MerchantEntity = { id: 'ME-000090', gmid: 'GM-100104', kind: 'sub', parentEntityId: parent.id, legalEntity: null, displayName: 'Saigon Journeys – Hanoi', lifecycleStatus: 'active', createdAt: now, createdBy: 'x' };
      d.entities!.push(child);
      storage.setItem(KEY, JSON.stringify(d));

      expect(await setMcc(child.id, '5411')).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
      await setMcc('GM-100104', '5411');
      const after = db();
      expect(mccOfEntity(after.merchants, after.entities!, child.id)?.code).toBe('5411');
      expect(mccOfEntity(after.merchants, after.entities!, parent.id)?.code).toBe('5411');
      expect(after.entities!.some((e) => 'mcc' in e)).toBe(false);
      expect(entityProblems({ ...child, mcc: { code: '5814' } } as MerchantEntity, [parent, child])).toContain("A sub-merchant uses its parent's MCC and cannot have its own.");
    });
  });

  describe('existing data', () => {
    it('reads merchants without an MCC as "not captured" and writes nothing when reading', async () => {
      await call('GET', '/api/merchants');
      const before = storage.getItem(KEY);
      for (const m of db().merchants) {
        const d = await detail(m.id);
        expect(d.merchant.mcc ?? null).toBeNull();
        expect(d.mccEvents).toEqual([]);
        expect(d.mccRequest).toBeNull();
      }
      mcc.loadTestFixture();
      await call('GET', '/api/applications');
      await detail('GM-100101');
      expect(storage.getItem(KEY)).toBe(before);
      expect(db().mids).toHaveLength(3); // Phase 1 MIDs untouched
    });

    it('upgrades older (version 2) data exactly as before, without adding MCC fields', async () => {
      const original = v2Fixture();
      const fresh = new FlakyStorage();
      fresh.setItem(KEY, JSON.stringify(original));
      const s = new MerchantServer({ storage: fresh, now: () => now, auth, mcc: new MccCatalogueServer({ storage: fresh, now: () => now, auth }) });
      expect((await s.handle('GET', '/api/merchants', null, token, 'sales')).status).toBe(200);
      const upgraded = JSON.parse(fresh.getItem(KEY)!) as MerchantDb;
      expect(upgraded.merchants).toEqual(original.merchants);
      expect(upgraded.mccEvents).toBeUndefined();
      expect(upgraded.mccRequests).toBeUndefined();
      expect(fresh.getItem(MCC_KEY)).toBeNull();
    });
  });
});
