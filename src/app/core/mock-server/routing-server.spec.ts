import { beforeEach, describe, expect, it } from 'vitest';
import { HostDetailResponse, HostListResponse } from '../hosts/hosts';
import { decide, effectiveShares, Route, RoutingResponse, smartScore } from '../routing/routing';
import { AuthServer } from './auth-server';
import { HostServer } from './host-server';
import { RoutingMerchantSource, RoutingServer } from './routing-server';
import { FlakyStorage } from './testing/merchant-test-data';
import { currentCode, signIn } from './testing/sign-in';

// Routing (Batch 5B + 5C). Seed routes on the sample hosts: ID VA priority HARSYA → WINPAY →
// LINKQU (disabled); ID QRIS smart HARSYA; ID payout split WINPAY 70 / LINKQU 30; MY FPX and
// cards on Public Bank; MY DuitNow QR on CIMB Collect (maintenance). One override: the first live
// ID merchant with VA pinned to WINPAY.

const MERCHANTS: RoutingMerchantSource[] = [
  { gmid: 'GM-1', merchantName: 'Nusantara Home Retail', country: 'ID', products: [{ methodCode: 'va', methodName: 'Virtual Account', flow: 'payin' }, { methodCode: 'qris', methodName: 'QRIS', flow: 'payin' }], subMerchants: [{ id: 'SUB-1', name: 'Online store' }] },
  { gmid: 'GM-2', merchantName: 'Tanjung Global Trading', country: 'ID', products: [{ methodCode: 'va', methodName: 'Virtual Account', flow: 'payin' }], subMerchants: [] },
  { gmid: 'GM-2', merchantName: 'Tanjung Global Trading', country: 'MY', products: [{ methodCode: 'fpx', methodName: 'FPX', flow: 'payin' }], subMerchants: [] },
];

describe('Routing', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let hosts: HostServer;
  let routing: RoutingServer;
  const tokens = new Map<string, string>();

  const as = async (login: string) => {
    if (!tokens.has(login)) {
      now += 31_000;
      tokens.set(login, await signIn(auth, login));
    }
    return tokens.get(login)!;
  };
  const code = async () => {
    const token = await as('MOBI-TECHOPS');
    now += 61_000;
    return currentCode(auth, token);
  };
  const call = async <T = any>(method: string, path: string, body: unknown = null, login = 'MOBI-TECHOPS') =>
    routing.handle(method, path, body, await as(login), null) as Promise<{ status: number; body: T }>;
  const hostCall = async <T = any>(method: string, path: string, body: unknown = null) => hosts.handle(method, path, body, await as('MOBI-TECHOPS'), null) as Promise<{ status: number; body: T }>;
  const overview = async () => (await call<RoutingResponse>('GET', '/api/routing')).body;
  const routeOf = async (key: string) => (await overview()).routes.find((r) => r.key === key)!;
  const hostId = async (codeName: string) => (await hostCall<HostListResponse>('GET', '/api/hosts')).body.hosts.find((h) => h.hostCode === codeName)!.id;

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 24, 9);
    tokens.clear();
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    hosts = new HostServer({ storage, auth, now: () => now });
    routing = new RoutingServer({ storage, auth, now: () => now, hosts: () => hosts.snapshot(), merchants: () => MERCHANTS });
  });

  it('lists a route per country + method with its state worked out from Host Management', async () => {
    const o = await overview();
    const state = Object.fromEntries(o.routes.map((r) => [r.key, r.state]));
    expect(state).toMatchObject({ 'ID:va': 'routing', 'ID:qris': 'routing', 'ID:bank_transfer_payout': 'fallback', 'MY:fpx': 'routing', 'MY:duitnow_qr': 'none', 'VN:vietqr': 'not_set' });
    expect(o.routes.find((r) => r.key === 'ID:bank_transfer_payout')!.effective).toEqual([{ hostId: await hostId('WINPAY'), name: 'WINPAY', share: 100 }]);
    expect(o.routes.find((r) => r.key === 'MY:duitnow_qr')!.stateNote).toBe('CIMB Collect host under maintenance');
    expect(o.summary).toEqual({ routes: 6, routing: 4, fallback: 1, none: 1 });
    expect(o.overrides).toHaveLength(1);
    expect(o.overrides[0]).toMatchObject({ merchantId: 'GM-1', hostName: 'WINPAY', hostEligible: true });
    expect(o.can.manage).toBe(true);
  });

  it('follows Host Management live: disabling the first host moves Priority to the next one', async () => {
    const harsya = await hostId('HARSYA');
    await hostCall('POST', `/api/hosts/${harsya}/status`, { action: 'disable', reason: 'Provider outage', confirm: true, code: await code() });
    const va = await routeOf('ID:va');
    expect(va).toMatchObject({ state: 'fallback', stateNote: 'HARSYA host disabled: using WINPAY' });
    const check = (await call('POST', '/api/routing/check', { merchantId: 'GM-2', country: 'ID', methodCode: 'va' })).body;
    expect(check).toMatchObject({ hostName: 'WINPAY', via: 'priority', usedFallback: true });
    expect((await routeOf('ID:qris')).state).toBe('none');
  });

  it('only Tech Ops changes routing, always with an authenticator code', async () => {
    const body = { mode: 'priority', hosts: [{ hostId: await hostId('WINPAY') }, { hostId: await hostId('HARSYA') }], fallback: true };
    expect((await call('PUT', '/api/routing/routes/ID/va', body, 'MOBI-RISK')).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
    expect((await call<RoutingResponse>('GET', '/api/routing', null, 'MOBI-RISK')).body.can.manage).toBe(false);
    expect((await call('PUT', '/api/routing/routes/ID/va', body)).body).toMatchObject({ code: 'MFA_CODE_REQUIRED' });
    const saved = await call('PUT', '/api/routing/routes/ID/va', { ...body, code: await code() });
    expect(saved.status).toBe(200);
    expect(saved.body.route.hosts.map((h: any) => h.hostId)).toEqual([await hostId('WINPAY'), await hostId('HARSYA')]);
    const log = (await call<any[]>('GET', '/api/routing/activity')).body;
    expect(log[0]).toMatchObject({ action: 'Route changed', subject: 'Indonesia · Virtual Account', details: 'Priority: HARSYA → WINPAY → LINKQU · fallback on → Priority: WINPAY → HARSYA · fallback on' });
  });

  it('checks routes before asking for a code: registered hosts, no duplicates, shares add to 100', async () => {
    const winpay = await hostId('WINPAY');
    const linkqu = await hostId('LINKQU');
    const pbb = await hostId('PBB');
    const put = (body: object) => call('PUT', '/api/routing/routes/ID/bank_transfer_payout', body);
    expect((await put({ mode: 'split', hosts: [{ hostId: winpay, share: 60 }, { hostId: linkqu, share: 30 }] })).body.message).toBe('Shares add up to 90 %; they must add up to 100 %.');
    expect((await put({ mode: 'split', hosts: [{ hostId: winpay, share: 100 }] })).body.message).toBe('A split needs at least two hosts.');
    expect((await put({ mode: 'priority', hosts: [{ hostId: pbb }] })).body.message).toBe("Public Bank isn't registered for Bank Transfer in Indonesia.");
    expect((await put({ mode: 'priority', hosts: [{ hostId: winpay }, { hostId: winpay }] })).body.message).toBe('WINPAY is listed twice.');
    expect((await put({ mode: 'smart', hosts: [{ hostId: winpay }], smart: { successWeight: 70, minSuccessRate: 20 } })).body.message).toBe('Enter a minimum success rate from 50 to 100 %.');
    // A new route for a combination with registered hosts.
    const saigon = (await hostCall<HostListResponse>('GET', '/api/hosts')).body.hosts.find((h) => h.hostCode === 'SAIGONPAY')!.id;
    const vn = await call('PUT', '/api/routing/routes/VN/vietqr', { mode: 'priority', hosts: [{ hostId: saigon }], fallback: false, code: await code() });
    expect(vn.body).toMatchObject({ state: 'none' });
    expect(vn.body.stateNote).toContain('Saigon PayLink host disabled');
  });

  it('split with fallback off: the blocked share fails; with fallback on it is re-divided', async () => {
    const winpay = await hostId('WINPAY');
    const linkqu = await hostId('LINKQU');
    await call('PUT', '/api/routing/routes/ID/bank_transfer_payout', { mode: 'split', hosts: [{ hostId: winpay, share: 70 }, { hostId: linkqu, share: 30 }], fallback: false, code: await code() });
    expect(await routeOf('ID:bank_transfer_payout')).toMatchObject({ state: 'at_risk', stateNote: "LINKQU's 30 % fails" });
    expect(effectiveShares([{ hostId: 'a', share: 50 }, { hostId: 'b', share: 25 }, { hostId: 'c', share: 25 }], (id) => id !== 'c')).toEqual([{ hostId: 'a', share: 67 }, { hostId: 'b', share: 33 }]);
  });

  it('merchant overrides come first, fall back to the default route when asked, and are validated', async () => {
    const winpay = await hostId('WINPAY');
    const pinned = await call('POST', '/api/routing/check', { merchantId: 'GM-1', country: 'ID', methodCode: 'va' });
    expect(pinned.body).toMatchObject({ hostName: 'WINPAY', via: 'override' });
    // The sub-merchant has no override of its own: the parent's applies.
    expect((await call('POST', '/api/routing/check', { merchantId: 'GM-1', subMerchantId: 'SUB-1', country: 'ID', methodCode: 'va' })).body.via).toBe('override');
    expect((await call('POST', '/api/routing/check', { merchantId: 'GM-2', country: 'ID', methodCode: 'va' })).body).toMatchObject({ hostName: 'HARSYA', via: 'priority' });

    const bad = await call('POST', '/api/routing/overrides', { merchantId: 'GM-2', country: 'MY', methodCode: 'va', hostId: winpay, reason: 'x' });
    expect(bad.body.errors.map((e: any) => e.field)).toEqual(['methodCode', 'hostId', 'reason']);
    expect((await call('POST', '/api/routing/overrides', { merchantId: 'GM-1', country: 'ID', methodCode: 'va', hostId: winpay, reason: 'Another pin' })).body.message).toContain('already has an override');

    // WINPAY disabled: the override falls back to the default route (HARSYA); with fallback off it fails.
    await hostCall('POST', `/api/hosts/${winpay}/status`, { action: 'disable', reason: 'Bank incident', confirm: true, code: await code() });
    expect((await call('POST', '/api/routing/check', { merchantId: 'GM-1', country: 'ID', methodCode: 'va' })).body).toMatchObject({ hostName: 'HARSYA', usedFallback: true });
    const ovr = (await overview()).overrides[0];
    expect(ovr).toMatchObject({ hostEligible: false, hostReason: 'Host disabled' });
    await call('PUT', `/api/routing/overrides/${ovr.id}`, { merchantId: 'GM-1', subMerchantId: null, country: 'ID', methodCode: 'va', hostId: winpay, fallbackToRoute: false, reason: 'Pilot: no fallback agreed', code: await code() });
    expect((await call('POST', '/api/routing/check', { merchantId: 'GM-1', country: 'ID', methodCode: 'va' })).body).toMatchObject({ hostId: null, via: 'none' });

    now += 6 * 60_000; // past the 5-minute re-authentication window
    expect((await call('POST', `/api/routing/overrides/${ovr.id}/remove`, {})).body).toMatchObject({ code: 'MFA_CODE_REQUIRED' });
    await call('POST', `/api/routing/overrides/${ovr.id}/remove`, { code: await code() });
    expect((await overview()).overrides).toEqual([]);
    expect((await call<any[]>('GET', '/api/routing/activity')).body[0].action).toBe('Override removed');
  });

  it('Smart (5C) ranks eligible hosts on simulated success rate and speed, with a minimum', async () => {
    const harsya = await hostId('HARSYA');
    const winpay = await hostId('WINPAY');
    await call('PUT', '/api/routing/routes/ID/va', { mode: 'smart', hosts: [{ hostId: harsya }, { hostId: winpay }], fallback: true, smart: { successWeight: 70, minSuccessRate: 90 }, code: await code() });
    const va = await routeOf('ID:va');
    expect(va.route!.mode).toBe('smart');
    expect(va.effective).toHaveLength(2);
    expect(va.effective[0].score).toBeGreaterThanOrEqual(va.effective[1].score!);
    const perf = (await call<any[]>('GET', '/api/routing/performance')).body;
    expect(perf.every((p) => p.simulated)).toBe(true);
    // Disabled hosts have no figures.
    expect(perf.find((p) => p.hostName === 'LINKQU')).toMatchObject({ successRate: null, attempts: 0 });
    // Figures are stable within 15 minutes.
    const again = (await call<any[]>('GET', '/api/routing/performance')).body;
    expect(again).toEqual(perf);
    // Nobody meets 100 %: with fallback, the best ranked is used.
    await call('PUT', '/api/routing/routes/ID/va', { mode: 'smart', hosts: [{ hostId: harsya }, { hostId: winpay }], fallback: true, smart: { successWeight: 70, minSuccessRate: 100 }, code: await code() });
    expect(await routeOf('ID:va')).toMatchObject({ state: 'fallback' });
    expect(smartScore(94.1, 310, { successWeight: 70, minSuccessRate: 90 })).toBe(0.93);
  });

  it('the engine: priority without fallback fails at the first ineligible host', () => {
    const route: Route = { id: 'R', country: 'ID', methodCode: 'va', mode: 'priority', hosts: [{ hostId: 'a' }, { hostId: 'b' }], fallback: false, smart: { successWeight: 70, minSuccessRate: 90 }, updatedAt: 0, updatedBy: '' };
    const d = decide(null, route, { name: (id) => id.toUpperCase(), option: (id) => ({ eligible: id === 'b', reason: 'Host disabled' }), perf: () => ({ successRate: null, avgResponseMs: null }), roll: 0 });
    expect(d).toMatchObject({ hostId: null, via: 'none' });
    expect(d.steps.map((s) => s.title)).toEqual(['No merchant override', 'Skipped A', 'Fallback is off']);
  });

  it('a host removed from a route still shows, as not eligible', async () => {
    const created = (await hostCall<HostDetailResponse>('POST', '/api/hosts', { draft: true, basic: { name: 'Tmp', hostCode: 'TMP1' }, capabilities: [{ countryCode: 'ID', paymentMethodCode: 'va', availabilityStatus: 'available' }], integration: null })).body;
    const va = await routeOf('ID:va');
    expect(va.options.find((o) => o.hostId === created.host.id)).toMatchObject({ eligible: false, reason: 'Host is a draft' });
  });
});
