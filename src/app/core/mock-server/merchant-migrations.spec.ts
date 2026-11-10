import { beforeEach, describe, expect, it } from 'vitest';
import { ApplicationDetail, CountryApplication, MerchantDetail } from '../merchants/merchant-models';
import { MID_PATTERN } from './merchant-identity';
import { migrationFlags, normaliseMerchantDb, SCHEMA_REVISION, UPGRADE_ACTOR } from './merchant-migrations';
import { AuthBridge, MerchantDb, MerchantServer } from './merchant-server';
import { FIXTURE_NOW, FlakyStorage, v2Fixture } from './testing/merchant-test-data';

const KEY = 'mobi.gp.merchantdb';
const BACKUP = 'mobi.gp.merchantdb.backup.r2';
const AUTH_KEY = 'mobi.gp.mockdb';

// The upgrade never reaches the auth server: a stub stands in, and the auth data is checked byte for byte.
const auth: AuthBridge = {
  authenticate: async () => ({ ok: true, caller: { userId: 'U-1', name: 'Sarah Lim' } }),
  activateCountry: async () => {
    throw new Error('The data upgrade must not touch Global Accounts');
  },
};

const without = <T extends object>(o: T, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

describe('merchant data upgrade (schema revision 3)', () => {
  let storage: FlakyStorage;
  let server: MerchantServer;
  let original: MerchantDb;
  let raw: string;
  const upgradeAt = FIXTURE_NOW + 60_000;

  const get = <T = any>(path: string, role = 'sales') => server.handle('GET', path, null, 'token', role) as Promise<{ status: number; body: T }>;
  const stored = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;

  beforeEach(() => {
    storage = new FlakyStorage();
    original = v2Fixture();
    raw = JSON.stringify(original);
    storage.setItem(KEY, raw);
    storage.setItem(AUTH_KEY, '{"version":4,"accounts":[{"id":"GA-1001"}],"note":"untouched"}');
    server = new MerchantServer({ storage, now: () => upgradeAt, auth });
  });

  it('keeps every existing record and only adds new fields', async () => {
    expect((await get('/api/merchants')).status).toBe(200);
    const db = stored();
    expect(db.version).toBe(5);
    expect(db.schemaRevision).toBe(SCHEMA_REVISION);
    expect(db.merchants).toEqual(original.merchants);
    expect(db.notifications).toEqual(original.notifications);
    expect(db.lifecycleEvents).toEqual(original.lifecycleEvents);
    expect(without(db.seq, 'entity', 'mid')).toEqual(original.seq);
    expect(db.applications.map((a) => without(a, 'entityId', 'regionCode'))).toEqual(original.applications);
    // Suspension and its history are kept as they were.
    expect((await get<MerchantDetail>('/api/merchants/GM-100101')).body.merchant).toMatchObject({ lifecycleStatus: 'suspended', lifecycleReason: 'Chargeback ratio above threshold' });
    expect(storage.getItem(AUTH_KEY)).toBe('{"version":4,"accounts":[{"id":"GA-1001"}],"note":"untouched"}');
  });

  it('adds one parent entity per merchant and an entity and region to each application', async () => {
    await get('/api/merchants');
    const db = stored();
    expect(db.entities).toHaveLength(db.merchants.length);
    expect(new Set(db.entities!.map((e) => e.gmid)).size).toBe(db.merchants.length);
    expect(db.entities!.every((e) => e.kind === 'parent' && e.parentEntityId === null && e.legalEntity === null && /^ME-\d{6}$/.test(e.id))).toBe(true);
    for (const app of db.applications) {
      const entity = db.entities!.find((e) => e.id === app.entityId)!;
      expect(entity.gmid).toBe(app.merchantId);
      expect(app.regionCode).toBe(app.country === 'SG' ? undefined : app.country);
    }
  });

  it('assigns MIDs only to operational applications with recorded go-live evidence, dated when assigned', async () => {
    await get('/api/merchants');
    const db = stored();
    const byApp = new Map(db.mids!.map((m) => [m.applicationId, m]));
    expect([...byApp.keys()].sort()).toEqual(['APP-2026-0001', 'APP-2026-0002', 'APP-2026-0003', 'APP-2026-9001', 'APP-2026-9002']);
    for (const id of byApp.keys()) {
      const app = original.applications.find((a) => a.id === id)!;
      const evidence = app.history.find((h) => h.toStatus === 'operational')!;
      expect(byApp.get(id)).toMatchObject({ source: 'migrated', issuedAt: upgradeAt, issuedBy: UPGRADE_ACTOR, goLiveEvidenceAt: evidence.at, regionCode: app.country, country: app.country, environment: 'live', demo: true });
      expect(byApp.get(id)!.mid).toMatch(MID_PATTERN);
    }
    expect(new Set(db.mids!.map((m) => m.mid)).size).toBe(5);
    // No MID for anything that hasn't gone live.
    expect(db.applications.filter((a) => a.status !== 'operational').every((a) => !byApp.has(a.id))).toBe(true);
  });

  it('flags records it cannot upgrade safely and leaves them as they were', async () => {
    await get('/api/merchants');
    const flags = server.dataReport().flags;
    expect(flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'GO_LIVE_RECORD_MISSING', recordId: 'APP-2026-0016' }),
        expect.objectContaining({ reason: 'NO_REGION', recordId: 'APP-2026-0017' }),
        expect.objectContaining({ reason: 'SECOND_OPERATIONAL_IN_REGION', recordId: 'APP-2026-0018' }),
      ]),
    );
    expect(flags).toHaveLength(3);
    const detail = (await get<ApplicationDetail>('/api/applications/APP-2026-0016')).body;
    expect(detail).toMatchObject({ mid: null, midIssue: expect.stringMatching(/no go-live event/) });
    expect((await get<ApplicationDetail>('/api/applications/APP-2026-0018')).body).toMatchObject({ mid: null, midIssue: expect.stringMatching(/already operational/) });
    expect((await get<ApplicationDetail>('/api/applications/APP-2026-0001')).body.mid).toMatchObject({ source: 'migrated', country: 'MY' });
  });

  it('backs up the original data once before the first upgrade and never overwrites the backup', async () => {
    await get('/api/merchants');
    expect(storage.getItem(BACKUP)).toBe(raw);
    expect(storage.writes.filter((k) => k === BACKUP)).toHaveLength(1);
    await get('/api/merchants');
    await get('/api/applications');
    expect(storage.writes.filter((k) => k === BACKUP)).toHaveLength(1);
    expect(server.dataReport()).toMatchObject({ schemaRevision: 3, backupPresent: true, upgradePending: false });
  });

  it('is idempotent: running it again changes nothing', async () => {
    await get('/api/merchants');
    const once = storage.getItem(KEY);
    const writes = storage.writes.length;
    await get('/api/merchants');
    await get('/api/merchants/GM-100101');
    expect(storage.getItem(KEY)).toBe(once);
    expect(storage.writes.length).toBe(writes);
    expect(normaliseMerchantDb(stored(), upgradeAt + 1).changed).toBe(false);
  });

  it('survives an interrupted upgrade: nothing changes until the single write succeeds, then a rerun finishes it', async () => {
    storage.failWrite(KEY);
    expect((await get('/api/merchants')).status).toBe(200); // still served, from the original data
    expect(storage.getItem(KEY)).toBe(raw);
    expect(storage.getItem(BACKUP)).toBe(raw);
    expect(server.dataReport().upgradePending).toBe(false); // the report's own load retried and succeeded

    // Same result as an upgrade that was never interrupted.
    const clean = new FlakyStorage();
    clean.setItem(KEY, raw);
    await new MerchantServer({ storage: clean, now: () => upgradeAt, auth }).handle('GET', '/api/merchants', null, 'token', 'sales');
    expect(storage.getItem(KEY)).toBe(clean.getItem(KEY));
  });

  it('leaves the data untouched and pauses go-live when the backup cannot be written', async () => {
    storage.failWrite(BACKUP);
    storage.failWrite(KEY); // not reached: the backup fails first
    expect((await get('/api/merchants')).status).toBe(200);
    expect(storage.getItem(KEY)).toBe(raw);
    expect(storage.getItem(BACKUP)).toBeNull();
    const res = await server.handle('POST', '/api/applications/APP-2026-0007/readiness', { action: 'confirm_go_live' }, 'token', 'cs');
    // The pending write to KEY above makes this request's upgrade fail as well, so go-live waits.
    expect(res).toMatchObject({ status: 503, body: { code: 'MIGRATION_PENDING' } });
    expect(storage.getItem(KEY)).toBe(raw);
  });

  it('fills in records written later by an older build', async () => {
    await get('/api/merchants');
    const db = stored();
    // An older build ignores the new fields: it adds a merchant and application without them, and
    // takes an application live without issuing an MID.
    db.merchants.push({ ...db.merchants[0], id: 'GM-100110', legalName: 'Old Build Trading', createdAt: upgradeAt + 1 });
    db.applications.push({ ...structuredClone(db.applications.find((a) => a.id === 'APP-2026-0014')!), id: 'APP-2026-0019', merchantId: 'GM-100110', entityId: undefined, regionCode: undefined });
    const pending = db.applications.find((a) => a.id === 'APP-2026-0007')!;
    pending.status = 'operational';
    pending.history.push({ at: upgradeAt + 5, action: 'Go-live verified; country is operational', by: 'Mei Ling Wong', role: 'cs', fromStatus: 'go_live_verification', toStatus: 'operational' });
    storage.setItem(KEY, JSON.stringify(db));

    await get('/api/merchants');
    const after = stored();
    const entity = after.entities!.find((e) => e.gmid === 'GM-100110')!;
    expect(after.applications.find((a) => a.id === 'APP-2026-0019')).toMatchObject({ entityId: entity.id, regionCode: 'VN' });
    expect(after.mids!.find((m) => m.applicationId === 'APP-2026-0007')).toMatchObject({ source: 'migrated', goLiveEvidenceAt: upgradeAt + 5, regionCode: 'VN' });
    expect(after.version).toBe(5);
    expect(after.schemaRevision).toBe(3);
  });

  it('keeps the data loadable by the previous build (same version, fields and types)', async () => {
    await get('/api/merchants');
    const db = stored();
    expect(db.version).toBe(5); // the previous build refuses data only when this differs
    for (const key of ['seq', 'merchants', 'applications', 'notifications', 'lifecycleEvents'] as const) expect(db[key]).toBeDefined();
    expect(Object.keys(db.seq)).toEqual(expect.arrayContaining(['merchant', 'application', 'notification']));
  });

  it('never reseeds existing data: unreadable data and other versions are left in place', async () => {
    storage.setItem(KEY, '{not json');
    expect((await get('/api/merchants')).body).toMatchObject({ code: 'DATA_UNREADABLE' });
    expect(storage.getItem(KEY)).toBe('{not json');

    const v1 = JSON.stringify({ ...original, version: 1 });
    storage.setItem(KEY, v1);
    expect((await get('/api/merchants')).body).toMatchObject({ code: 'DATA_VERSION_UNSUPPORTED' });
    expect(storage.getItem(KEY)).toBe(v1);
    expect(storage.getItem('mobi.gp.merchantdb.backup.v1')).toBe(v1);
  });

  it('replaces version 3 data (before the Pricing Engine) with the new demo data, after a backup', async () => {
    const v3 = JSON.stringify({ ...original, version: 3 });
    storage.setItem(KEY, v3);
    expect((await get('/api/merchants')).status).toBe(200);
    expect(stored().version).toBe(5);
    expect(storage.getItem('mobi.gp.merchantdb.backup.v3')).toBe(v3);
  });

  it('replaces version 2 data (the earlier registration form) with the new demo data, once, after a backup', async () => {
    const v2 = JSON.stringify({ ...original, version: 2 });
    storage.setItem(KEY, v2);
    expect((await get('/api/merchants')).status).toBe(200);
    const db = stored();
    expect(db).toMatchObject({ version: 5, schemaRevision: 3 });
    expect(db.applications.every((a) => ['MY', 'ID', 'VN'].includes(a.country))).toBe(true);
    expect(storage.getItem('mobi.gp.merchantdb.backup.v2')).toBe(v2);
    // A second load keeps the new data and the first backup.
    const after = storage.getItem(KEY);
    expect((await get('/api/merchants')).status).toBe(200);
    expect(storage.getItem(KEY)).toBe(after);
    expect(storage.getItem('mobi.gp.merchantdb.backup.v2')).toBe(v2);
  });

  it('seeds a browser with no merchant data in the upgraded shape, with nothing to back up', async () => {
    const fresh = new FlakyStorage();
    const s = new MerchantServer({ storage: fresh, now: () => upgradeAt, auth });
    expect((await s.handle('GET', '/api/merchants', null, 'token', 'sales')).status).toBe(200);
    const db = JSON.parse(fresh.getItem(KEY)!) as MerchantDb;
    expect(db).toMatchObject({ version: 5, schemaRevision: 3 });
    expect(db.mids!.map((m) => m.applicationId).sort()).toEqual(['APP-2026-0001', 'APP-2026-0002', 'APP-2026-0003', 'APP-2026-9001', 'APP-2026-9002']);
    expect(fresh.getItem(BACKUP)).toBeNull();
    expect(migrationFlags(db)).toEqual([]);
  });

  it('restores the backup only when asked, keeping a copy of the data it replaces', async () => {
    await get('/api/merchants');
    const upgraded = storage.getItem(KEY);
    expect(server.restoreBackup()).toMatch(/Restored/);
    expect(storage.getItem(KEY)).toBe(raw);
    expect(storage.getItem(`${KEY}.backup.pre-restore.${upgradeAt}`)).toBe(upgraded);
    expect(storage.getItem(BACKUP)).toBe(raw);
  });

  it('assigns MIDs to applications sorted by recorded go-live time, so reruns give the same values', () => {
    const a = normaliseMerchantDb(v2Fixture(), upgradeAt).db;
    const b = normaliseMerchantDb(v2Fixture(), upgradeAt).db;
    expect(a).toEqual(b);
    const order = a.mids!.map((m) => (a.applications.find((x) => x.id === m.applicationId) as CountryApplication).id);
    // By recorded go-live time: Tanjung MY, ID, Nusantara MY, Tanjung VN, Nusantara ID.
    expect(order).toEqual(['APP-2026-0001', 'APP-2026-0002', 'APP-2026-9001', 'APP-2026-0003', 'APP-2026-9002']);
  });
});
