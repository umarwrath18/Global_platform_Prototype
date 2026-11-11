import { beforeEach, describe, expect, it } from 'vitest';
import { MerchantSettingsView } from '../merchants/merchant-portal';
import { StaffRole } from '../merchants/merchant-models';
import { AuthServer } from './auth-server';
import { MerchantPortalServer } from './merchant-portal-server';
import { MerchantDb, MerchantServer } from './merchant-server';
import { FlakyStorage } from './testing/merchant-test-data';
import { signIn } from './testing/sign-in';

const KEY = 'mobi.gp.merchantdb';

// The browser build runs with fixed teams: each demo login works only as its own team, and only
// MOBI-ADMIN may switch with "View as". Seed: APP-2026-9001 (Nusantara, Malaysia) is operational.

describe('Fixed teams, IPN after go-live and the Merchant Portal settings', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: MerchantServer;
  const tokens = new Map<string, string>();

  const as = async (loginId: string) => {
    if (!tokens.has(loginId)) {
      now += 31_000;
      tokens.set(loginId, await signIn(auth, loginId));
    }
    return tokens.get(loginId)!;
  };
  const call = async <T = any>(loginId: string, method: string, path: string, body: unknown = null, role: StaffRole | string = 'sales') =>
    server.handle(method, path, body, await as(loginId), role) as Promise<{ status: number; body: T }>;
  const session = async (loginId: string) => (await auth.handle('GET', '/api/auth/session', null, await as(loginId))).body as any;
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const app = (id: string) => db().applications.find((a) => a.id === id)!;

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 10, 9);
    tokens.clear();
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {}, fixedTeams: true });
    server = new MerchantServer({ storage, now: () => now, auth, fixedTeams: true });
    await call('123', 'GET', '/api/merchants');
  });

  it('gives every demo login its team, and login 123 only MY, ID and VN', async () => {
    const teams: [string, string][] = [];
    for (const id of ['123', 'MOBI-RISK', 'MOBI-CS', 'TANJUNG-ADMIN', 'MOBI-SUPPORT', 'MOBI-SECURITY', 'MOBI-ADMIN']) teams.push([id, (await session(id)).team]);
    expect(teams).toEqual([['123', 'sales'], ['MOBI-RISK', 'risk'], ['MOBI-CS', 'cs'], ['TANJUNG-ADMIN', 'finops'], ['MOBI-SUPPORT', 'support'], ['MOBI-SECURITY', 'security'], ['MOBI-ADMIN', 'admin']]);
    expect((await session('123')).countries.map((c: any) => c.code)).toEqual(['MY', 'ID', 'VN']);
    expect((await session('NUSANTARA-MERCHANT')).team).toBeNull();
  });

  it('acts as the login’s own team whatever "View as" sends; only the admin can switch', async () => {
    // Sales can't approve pricing by claiming to be FinOps: the request is treated as Sales.
    const pricing = (await call('123', 'GET', '/api/pricing/merchants?country=MY', null, 'finops')).body;
    expect(pricing.canConfigure).toBe(true);
    expect((await call('TANJUNG-ADMIN', 'GET', '/api/pricing/merchants?country=MY', null, 'sales')).body.canConfigure).toBe(false);
    expect((await call('MOBI-ADMIN', 'GET', '/api/pricing/merchants?country=MY', null, 'finops')).body.canConfigure).toBe(false);
    expect((await call('MOBI-ADMIN', 'GET', '/api/pricing/merchants?country=MY', null, 'sales')).body.canConfigure).toBe(true);
  });

  it('lets Mobi Support and Security Admin read merchants but never change them', async () => {
    for (const id of ['MOBI-SUPPORT', 'MOBI-SECURITY']) {
      expect((await call(id, 'GET', '/api/merchants')).status).toBe(200);
      expect(await call(id, 'PUT', '/api/applications/APP-2026-9001/ipn', { url: 'https://nusantarahome.example/ipn/v2' }, 'cs')).toMatchObject({ status: 403, body: { code: 'ROLE_NOT_PERMITTED' } });
    }
  });

  it('keeps User security to its own team; the admin may view as either', async () => {
    const overview = async (id: string, role: string) => (await auth.handle('GET', '/api/security/overview', null, await as(id), role)).status;
    expect(await overview('MOBI-SUPPORT', 'security')).toBe(200); // acts as Support
    expect(await overview('MOBI-SECURITY', 'support')).toBe(200); // acts as Security Admin
    expect(await overview('123', 'support')).toBe(403);
    expect(await overview('TANJUNG-ADMIN', 'security')).toBe(403);
    expect(await overview('MOBI-ADMIN', 'support')).toBe(200);
    expect(await overview('MOBI-ADMIN', '')).toBe(403);
  });

  it('lets CS or Sales change the IPN callback URL after go-live, with history and no Risk request', async () => {
    const before = app('APP-2026-9001').data.transaction.ipnCallbackUrl;
    const res = await call('MOBI-CS', 'PUT', '/api/applications/APP-2026-9001/ipn', { url: 'https://nusantarahome.example/ipn/v2' });
    expect(res.status).toBe(200);
    expect(app('APP-2026-9001')).toMatchObject({ status: 'operational', data: { transaction: { ipnCallbackUrl: 'https://nusantarahome.example/ipn/v2' } } });
    expect(app('APP-2026-9001').history.at(-1)).toMatchObject({ action: 'IPN callback URL changed', by: 'Mei Ling Wong', role: 'cs', comment: `${before} → https://nusantarahome.example/ipn/v2` });
    expect((await call('123', 'PUT', '/api/applications/APP-2026-9001/ipn', { url: 'https://nusantarahome.example/ipn/v3' })).status).toBe(200);
    expect((await call('MOBI-RISK', 'PUT', '/api/applications/APP-2026-9001/ipn', { url: 'https://nusantarahome.example/ipn/v4' })).status).toBe(403);
    expect((await call('MOBI-CS', 'PUT', '/api/applications/APP-2026-9001/ipn', { url: 'http://insecure.example/ipn' })).status).toBe(422);
    // A transaction change request through Risk never carries an IPN change.
    const t = app('APP-2026-9001').data.transaction;
    const cr = await call('123', 'POST', '/api/applications/APP-2026-9001/changes', { section: 'transaction', value: { ...t, ipnCallbackUrl: 'https://elsewhere.example/ipn', sendReceipts: !t.sendReceipts }, reason: 'Merchant asked for receipts' });
    expect(cr.status).toBe(201);
    expect(cr.body.changes.map((c: any) => c.label)).toEqual(['Send payment receipts to customers']);
  });

  it('shows the merchant its pricing, settlement and IPN read-only in the Merchant Portal', async () => {
    const portal = new MerchantPortalServer({ storage, auth, profile: (id) => server.portalProfile(id), now: () => now });
    const res = await portal.handle('GET', '/api/merchant-portal/settings', await as('NUSANTARA-MERCHANT'));
    expect(res.status).toBe(200);
    const view = res.body as MerchantSettingsView;
    expect(view.merchant.name).toBe('Nusantara Home Retail Sdn Bhd');
    const my = view.countries.find((c) => c.country === 'MY')!;
    expect(my.mid).toBeTruthy();
    expect(my.ipnCallbackUrl).toBe(app('APP-2026-9001').data.transaction.ipnCallbackUrl);
    expect(my.products.find((p) => p.name === 'Cards')).toMatchObject({ flow: 'payin', pricing: 'Percentage: 2.2%' });
    // Staff logins have no Merchant Portal.
    expect((await portal.handle('GET', '/api/merchant-portal/settings', await as('123'))).status).toBe(403);
  });
});
