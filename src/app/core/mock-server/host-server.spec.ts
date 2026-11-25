import { beforeEach, describe, expect, it } from 'vitest';
import { HostDetailResponse, HostDraftInput, HostListResponse } from '../hosts/hosts';
import { AuthServer } from './auth-server';
import { HostServer } from './host-server';
import { FlakyStorage } from './testing/merchant-test-data';
import { currentCode, signIn } from './testing/sign-in';

// Host Management. Seed: six sample hosts (HARSYA, WINPAY, LINKQU, Public Bank, Saigon PayLink,
// CIMB Collect). One status per host (Draft · Active · Disabled · Maintenance) plus a setup
// checklist. MOBI-TECHOPS manages; others view.

describe('Host Management', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: HostServer;
  const tokens = new Map<string, string>();

  const as = async (login: string) => {
    if (!tokens.has(login)) {
      now += 31_000;
      tokens.set(login, await signIn(auth, login));
    }
    return tokens.get(login)!;
  };
  const code = async (login = 'MOBI-TECHOPS') => {
    const token = await as(login);
    now += 61_000;
    return currentCode(auth, token);
  };
  const call = async <T = any>(method: string, path: string, body: unknown = null, login = 'MOBI-TECHOPS', role: string | null = null) =>
    server.handle(method, path, body, await as(login), role) as Promise<{ status: number; body: T }>;
  const list = async () => (await call<HostListResponse>('GET', '/api/hosts')).body;
  const byCode = async (c: string) => (await list()).hosts.find((h) => h.hostCode === c)!;
  const detail = async (id: string) => (await call<HostDetailResponse>('GET', `/api/hosts/${id}`)).body;

  const today = () => new Date(now).toISOString().slice(0, 10);
  const draftFor = (methodCode: string, flow: 'payin' | 'payout', over: object = {}) => ({
    flow, methodCode, subMerchantId: null, vaBanks: [], technique: 'variable_rate', currency: 'VND', mdrPct: 0.6, fixedFee: null, minimumFee: null,
    volumePeriod: null, tiers: null, historical: null, subscription: null, promotion: null, startDate: today(), endDate: null, ...over,
  });
  /** Tech Ops submits cost pricing for both sample methods; FinOps (TANJUNG-ADMIN's team) approves. */
  const priceAll = async (id: string) => {
    for (const [m, flow] of [['vietqr', 'payin'], ['bank_transfer_payout', 'payout']] as const) {
      const v = (await call<any>('POST', `/api/hosts/${id}/cost-pricing`, { country: 'VN', draft: draftFor(m, flow, flow === 'payout' ? { technique: 'fixed_fee', mdrPct: null, fixedFee: 5000 } : {}), editOf: null })).body;
      expect(v.status).toBe('pending_approval');
      expect((await call<any>('POST', `/api/hosts/${id}/cost-pricing/${v.id}/decision`, { decision: 'approve' }, 'TANJUNG-ADMIN')).body.status).toBe('active');
    }
  };
  const input = (over: Partial<HostDraftInput> = {}): HostDraftInput => ({
    draft: false,
    basic: { name: 'Mekong Pay', hostCode: 'MEKONG', description: 'Sample', hostType: 'payment_gateway', registrationCountry: 'VN', ownerTeam: 'Tech Ops – Vietnam', notes: '', contactEmail: 'ops@mekongpay.example', contactPhone: '+84 24 3974 8888', escalationContact: '' },
    capabilities: [
      { countryCode: 'VN', paymentMethodCode: 'vietqr', availabilityStatus: 'available' },
      { countryCode: 'VN', paymentMethodCode: 'bank_transfer_payout', availabilityStatus: 'available' },
    ],
    integration: { integrationName: 'Mekong API', adapterType: 'mobi_rest_v1', apiBaseUrl: 'https://api.mekongpay.example/v1', apiVersion: 'v1', environment: 'production', authenticationType: 'api_key', authConfig: { keyHeader: 'X-Api-Key' }, timeoutSeconds: 30, connectionConfig: '', notes: '', portalUsername: '' },
    ...over,
  });

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 24, 9);
    tokens.clear();
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new HostServer({ storage, auth, now: () => now });
  });

  it('lists the sample hosts with one status each and a setup checklist', async () => {
    const l = await list();
    expect(l.hosts.map((h) => h.hostCode).sort()).toEqual(['CIMBCOLLECT', 'HARSYA', 'LINKQU', 'PBB', 'SAIGONPAY', 'WINPAY']);
    expect(l.hosts.every((h) => h.sample)).toBe(true);
    expect(l.summary).toEqual({ total: 6, active: 3, disabled: 2, maintenance: 1, draft: 0, costMissing: 2, costPending: 1 });
    expect(Object.fromEntries(l.hosts.map((h) => [h.hostCode, h.status]))).toEqual({ CIMBCOLLECT: 'maintenance', HARSYA: 'active', LINKQU: 'disabled', PBB: 'active', SAIGONPAY: 'disabled', WINPAY: 'active' });
    const open = (c: string) => l.hosts.find((h) => h.hostCode === c)!.checklist.filter((x) => !x.done).map((x) => x.id);
    expect(open('HARSYA')).toEqual([]);
    expect(open('LINKQU')).toEqual(['production', 'pricing']);
    expect(open('SAIGONPAY')).toEqual(['integration', 'production', 'pricing']);
    expect(l.hosts.find((h) => h.hostCode === 'WINPAY')!.cost).toEqual({ priced: 2, total: 2, pending: 1 });
    expect(l.hosts.find((h) => h.hostCode === 'HARSYA')!.categories).toEqual([{ category: 'QR', count: 1 }, { category: 'Online banking', count: 1 }, { category: 'E-wallets', count: 1 }]);
    // Nothing removed in this release comes back in the API.
    const raw = JSON.stringify(l);
    for (const gone of ['associatedPartner', 'credentialReference', 'health', 'integrationStatus', 'attention', 'lastValidation']) expect(raw).not.toContain(gone);
    expect(l.can.manage).toBe(true);
  });

  it('other teams can view but not change anything; merchant users have no access', async () => {
    const risk = await call<HostListResponse>('GET', '/api/hosts', null, 'MOBI-RISK');
    expect(risk.status).toBe(200);
    expect(risk.body.can.manage).toBe(false);
    expect((await call('POST', '/api/hosts', input(), 'MOBI-RISK')).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
    // The prototype admin manages only while viewing as Tech Ops.
    expect((await call<HostListResponse>('GET', '/api/hosts', null, 'MOBI-ADMIN', 'sales')).body.can.manage).toBe(false);
    expect((await call<HostListResponse>('GET', '/api/hosts', null, 'MOBI-ADMIN', 'techops')).body.can.manage).toBe(true);
    expect((await call('GET', '/api/hosts', null, 'NUSANTARA-MERCHANT')).status).toBe(403);
  });

  it('adds a host: required fields, unique host code, and it starts Disabled', async () => {
    const bad = await call('POST', '/api/hosts', input({ basic: { ...input().basic, name: '', hostCode: 'harsya', hostType: '' as never }, capabilities: [] }));
    expect(bad.status).toBe(422);
    const fields = (bad.body.errors as { field: string; message: string }[]).map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['basic.name', 'basic.hostCode', 'basic.hostType', 'capabilities']));
    expect(bad.body.errors.find((e: any) => e.field === 'basic.hostCode').message).toBe('HARSYA is already used by another partner. Choose a unique code.');

    const r = await call<HostDetailResponse>('POST', '/api/hosts', input());
    expect(r.status).toBe(201);
    expect(r.body.host).toMatchObject({ id: 'PTR-VN-002', hostCode: 'MEKONG', draft: false, status: 'disabled' });
    expect(r.body.host.checklist.filter((c) => !c.done).map((c) => c.id)).toEqual(['pricing']);
    expect(r.body.enableBlockers).toEqual(['Get cost pricing approved by FinOps for every Available payment method.']);
    expect(r.body.capabilities.map((c) => [c.paymentMethodName, c.paymentFlow, c.supportedCurrencies])).toEqual([['VietQR', 'payin', ['VND']], ['Bank Transfer', 'payout', ['VND']]]);
    expect(r.body.integration!.missing).toEqual([]);
    expect(r.body.activity.map((a) => a.action)).toEqual(expect.arrayContaining(['Partner created', 'Payment methods added', 'Integration details updated']));
    // Payment methods must come from the country catalogue.
    const unknown = await call('POST', '/api/hosts', input({ basic: { ...input().basic, hostCode: 'X2' }, capabilities: [{ countryCode: 'VN', paymentMethodCode: 'fpx', availabilityStatus: 'available' }] }));
    expect(unknown.body.errors[0].message).toBe('Choose a payment method configured for Vietnam.');
  });

  it('saves a draft with only a name and code, and completes it later', async () => {
    const d = await call<HostDetailResponse>('POST', '/api/hosts', { draft: true, basic: { name: 'Draft Host', hostCode: 'DRAFT1' }, capabilities: [], integration: null });
    expect(d.status).toBe(201);
    expect(d.body.host).toMatchObject({ draft: true, status: 'draft' });
    expect(d.body.enableBlockers[0]).toContain('draft');
    expect(d.body.host.checklist.filter((c) => c.done)).toEqual([]);
    const done = await call<HostDetailResponse>('PUT', `/api/hosts/${d.body.host.id}`, input({ basic: { ...input().basic, name: 'Draft Host', hostCode: 'DRAFT1' } }));
    expect(done.body.host.draft).toBe(false);
    expect(done.body.activity).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'Partner set up', details: 'Draft completed and saved.' })]));
  });

  it('never stores credentials: anything that looks like a secret is refused', async () => {
    for (const extra of [{ secret: 'sk_live_123' }, { credentialReference: 'cred_ref_ABCD' }]) {
      const r = await call('POST', '/api/hosts', input({ integration: { ...input().integration!, ...(extra as object) } }));
      expect(r.status).toBe(422);
    }
    expect(storage.getItem('mobi.gp.hostdb') ?? '').not.toContain('sk_live_123');
  });

  it('checks the endpoint on save: valid URL; Production needs https and not a test URL', async () => {
    const at = async (apiBaseUrl: string, environment: 'sandbox' | 'production') =>
      (await call('POST', '/api/hosts', input({ integration: { ...input().integration!, apiBaseUrl, environment } }))).body.errors?.[0]?.message;
    expect(await at('not a url', 'sandbox')).toBe('Enter a valid URL, starting with https://.');
    expect(await at('http://api.mekongpay.example', 'production')).toBe('Production endpoints must use https.');
    expect(await at('https://sandbox.mekongpay.example', 'production')).toContain('looks like a test URL');
    const sandbox = (await call<HostDetailResponse>('POST', '/api/hosts', input({ integration: { ...input().integration!, apiBaseUrl: 'https://sandbox.mekongpay.example', environment: 'sandbox' } }))).body;
    expect(sandbox.enableBlockers).toEqual(['Set the Production endpoint: a Sandbox endpoint cannot take live payments.', 'Get cost pricing approved by FinOps for every Available payment method.']);
  });

  it('manages capabilities one by one: disabling a method never disables the host', async () => {
    const h = await byCode('HARSYA');
    const before = await detail(h.id);
    const ovo = before.capabilities.find((c) => c.paymentMethodCode === 'ovo')!;
    const r = await call<HostDetailResponse>('PUT', `/api/hosts/${h.id}/capabilities/${ovo.id}`, { availabilityStatus: 'disabled' });
    expect(r.body.capabilities.find((c) => c.id === ovo.id)!.availabilityStatus).toBe('disabled');
    expect(r.body.host.status).toBe('active');
    expect(r.body.activity[0]).toMatchObject({ action: 'Payment method disabled', details: 'OVO · PayIn · Indonesia · Disabled' });
    const back = await call<HostDetailResponse>('PUT', `/api/hosts/${h.id}/capabilities/${ovo.id}`, { availabilityStatus: 'available' });
    expect(back.body.activity[0]).toMatchObject({ action: 'Payment method updated', details: 'OVO · PayIn · Indonesia · Available' });
    const add = await call<HostDetailResponse>('POST', `/api/hosts/${h.id}/capabilities`, { countryCode: 'ID', paymentMethodCode: 'dana', availabilityStatus: 'available' });
    expect(add.status).toBe(201);
    expect((await call('POST', `/api/hosts/${h.id}/capabilities`, { countryCode: 'ID', paymentMethodCode: 'dana' })).status).toBe(409);
  });

  it('enables only a host whose setup checklist is complete; disable and maintenance need a reason and a code', async () => {
    const saigon = await byCode('SAIGONPAY');
    expect((await call('POST', `/api/hosts/${saigon.id}/status`, { action: 'enable', code: await code() })).body.message).toContain('Complete the integration details.');
    const draft = (await call<HostDetailResponse>('POST', '/api/hosts', { draft: true, basic: { name: 'Draft Host', hostCode: 'DRAFT2' }, capabilities: [], integration: null })).body;
    expect((await call('POST', `/api/hosts/${draft.host.id}/status`, { action: 'disable', reason: 'Not needed now', confirm: true })).body.message).toContain('draft');

    const created = (await call<HostDetailResponse>('POST', '/api/hosts', input())).body;
    const id = created.host.id;
    expect((await call('POST', `/api/hosts/${id}/status`, { action: 'enable' })).body.message).toBe('Get cost pricing approved by FinOps for every Available payment method.');
    await priceAll(id);
    expect((await call('POST', `/api/hosts/${id}/status`, { action: 'enable' })).body).toMatchObject({ code: 'MFA_CODE_REQUIRED' });
    const on = await call<HostDetailResponse>('POST', `/api/hosts/${id}/status`, { action: 'enable', code: await code() });
    expect(on.body.host.status).toBe('active');
    expect(on.body.activity[0]).toMatchObject({ action: 'Partner enabled' });

    expect((await call('POST', `/api/hosts/${id}/status`, { action: 'maintenance', reason: 'x', code: await code() })).body.message).toBe('Enter a reason (at least 5 characters).');
    const m = await call<HostDetailResponse>('POST', `/api/hosts/${id}/status`, { action: 'maintenance', reason: 'Provider upgrade tonight', until: now + 3600_000, code: await code() });
    expect(m.body.host.status).toBe('maintenance');
    expect(m.body.host.maintenance).toMatchObject({ reason: 'Provider upgrade tonight' });
    const back = await call<HostDetailResponse>('POST', `/api/hosts/${id}/status`, { action: 'enable', code: await code() });
    expect(back.body.activity[0].action).toBe('Partner re-enabled');

    expect((await call('POST', `/api/hosts/${id}/status`, { action: 'disable', reason: 'Provider outage on VA', code: await code() })).body.message).toBe('Confirm that the host stops being eligible for routing.');
    const off = await call<HostDetailResponse>('POST', `/api/hosts/${id}/status`, { action: 'disable', reason: 'Provider outage on VA', confirm: true, code: await code() });
    expect(off.body.host).toMatchObject({ status: 'disabled', disabledReason: 'Provider outage on VA' });
    expect(off.body.activity[0].details).toContain('No traffic is rerouted automatically.');
  });

  it('an active host stays ready: edits that would break its setup are refused until it is disabled', async () => {
    const h = await byCode('HARSYA');
    const d = await detail(h.id);
    const same = (over: Partial<HostDraftInput>): HostDraftInput => ({
      draft: false,
      basic: { name: h.name, hostCode: h.hostCode, description: h.description, hostType: h.hostType, registrationCountry: h.registrationCountry, ownerTeam: h.ownerTeam, notes: h.notes, contactEmail: h.contactEmail, contactPhone: h.contactPhone, escalationContact: h.escalationContact },
      capabilities: d.capabilities.map((c) => ({ countryCode: c.countryCode, paymentMethodCode: c.paymentMethodCode, availabilityStatus: c.availabilityStatus })),
      integration: { ...d.integration!, apiBaseUrl: d.integration!.apiBaseUrl },
      ...over,
    });
    const toSandbox = await call('PUT', `/api/hosts/${h.id}`, same({ integration: { ...d.integration!, environment: 'sandbox', apiBaseUrl: 'https://sandbox.harsya.example' } }));
    expect(toSandbox).toMatchObject({ status: 409, body: { code: 'INVALID_TRANSITION' } });
    expect(toSandbox.body.message).toContain('Disable it first');
    expect((await call('PUT', `/api/hosts/${h.id}`, same({ basic: { ...same({}).basic, description: 'Updated description' } }))).status).toBe(200);
  });

  it('cost pricing: Tech Ops submits with the merchant pricing rules, FinOps decides, versions never overlap', async () => {
    const id = (await call<HostDetailResponse>('POST', '/api/hosts', input())).body.host.id;
    const set = (draft: object, editOf: string | null = null, login = 'MOBI-TECHOPS') => call<any>('POST', `/api/hosts/${id}/cost-pricing`, { country: 'VN', draft, editOf }, login);
    expect((await set(draftFor('vietqr', 'payin'), null, 'MOBI-RISK')).body.code).toBe('ROLE_NOT_PERMITTED');
    expect((await set(draftFor('momo', 'payin'))).body.message).toContain("isn't registered");
    expect((await set(draftFor('vietqr', 'payin', { startDate: '2020-01-01' }))).body.message).toContain("can't be in the past");
    const tiers = [{ minVolume: 0, maxVolume: 500_000_000, mdrPct: 0.6, fixedFee: 0 }, { minVolume: 500_000_000, maxVolume: null, mdrPct: 0.45, fixedFee: 0 }];
    const v1 = (await set(draftFor('vietqr', 'payin', { technique: 'volume_based', mdrPct: null, volumePeriod: 'monthly', tiers }))).body;
    expect(v1).toMatchObject({ version: 1, status: 'pending_approval', hostId: id, country: 'VN', technique: 'volume_based' });
    expect((await set(draftFor('vietqr', 'payin'))).body.code).toBe('PRICING_PENDING');
    // Only FinOps decides, and a rejection needs a reason.
    expect((await call<any>('POST', `/api/hosts/${id}/cost-pricing/${v1.id}/decision`, { decision: 'approve' })).body.code).toBe('ROLE_NOT_PERMITTED');
    expect((await call<any>('POST', `/api/hosts/${id}/cost-pricing/${v1.id}/decision`, { decision: 'reject' }, 'TANJUNG-ADMIN')).status).toBe(422);
    expect((await call<any>('POST', `/api/hosts/${id}/cost-pricing/${v1.id}/decision`, { decision: 'approve' }, 'TANJUNG-ADMIN')).body.status).toBe('active');
    let d = await detail(id);
    expect(d.methodCosts.find((c) => c.methodCode === 'vietqr')!.current!.id).toBe(v1.id);
    expect(d.host.cost).toEqual({ priced: 1, total: 2, pending: 0 });
    // A change keeps the model; it starts later and the version in effect ends the day before.
    expect((await set(draftFor('vietqr', 'payin'), v1.id)).body.message).toContain('cannot be changed');
    const later = new Date(now + 10 * 86_400_000).toISOString().slice(0, 10);
    const v2 = (await set(draftFor('vietqr', 'payin', { technique: 'volume_based', mdrPct: null, volumePeriod: 'monthly', tiers, startDate: later }), v1.id)).body;
    expect((await call<any>('POST', `/api/hosts/${id}/cost-pricing/${v2.id}/decision`, { decision: 'approve' }, 'TANJUNG-ADMIN')).body.status).toBe('scheduled');
    d = await detail(id);
    expect(d.methodCosts.find((c) => c.methodCode === 'vietqr')).toMatchObject({ current: { id: v1.id }, scheduled: { id: v2.id } });
    // Withdraw a pending one.
    const v3 = (await set(draftFor('bank_transfer_payout', 'payout', { technique: 'fixed_fee', mdrPct: null, fixedFee: 5000 }))).body;
    expect((await call<any>('POST', `/api/hosts/${id}/cost-pricing/${v3.id}/cancel`)).body.status).toBe('cancelled');
    // Shown in the Approvals inbox while pending.
    const v4 = (await set(draftFor('bank_transfer_payout', 'payout', { technique: 'fixed_fee', mdrPct: null, fixedFee: 4800 }))).body;
    expect(server.costApprovals().find((a) => a.id === v4.id)).toMatchObject({ status: 'pending', hostName: 'Mekong Pay', country: 'VN' });
  });

  it('secrets are write-only: only the last 4 characters are kept, and setting one needs a code', async () => {
    const h = await byCode('HARSYA');
    expect((await call('POST', `/api/hosts/${h.id}/secrets`, { kind: 'apiKey', value: 'short' })).status).toBe(422);
    expect((await call('POST', `/api/hosts/${h.id}/secrets`, { kind: 'apiKey', value: 'sk_live_9f8e7d6c5b4a' })).body).toMatchObject({ code: 'MFA_CODE_REQUIRED' });
    const r = await call<HostDetailResponse>('POST', `/api/hosts/${h.id}/secrets`, { kind: 'apiKey', value: 'sk_live_9f8e7d6c5b4a', code: await code() });
    expect(r.body.host.secrets.apiKey).toMatchObject({ last4: '5b4a', setBy: 'Wei Ling Tan (Tech Ops)' });
    expect(r.body.activity[0]).toMatchObject({ action: 'API key set', details: 'Ends in 5b4a. The value is never shown again.' });
    expect(JSON.stringify(r.body)).not.toContain('sk_live_9f8e7d6c5b4a');
    expect(storage.getItem('mobi.gp.hostdb') ?? '').not.toContain('sk_live_9f8e7d6c5b4a');
    expect((await call('POST', `/api/hosts/${h.id}/secrets`, { kind: 'apiKey', value: 'sk_live_other_value' }, 'MOBI-RISK')).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
  });

  it('keeps hosts after a reload (new server, same storage) and lists all activity', async () => {
    await call('POST', '/api/hosts', input());
    server = new HostServer({ storage, auth, now: () => now });
    expect((await list()).hosts.some((h) => h.hostCode === 'MEKONG')).toBe(true);
    const activity = (await call<{ hostName: string; action: string }[]>('GET', '/api/hosts/activity')).body;
    expect(activity[0]).toMatchObject({ hostName: 'Mekong Pay' });
  });
});
