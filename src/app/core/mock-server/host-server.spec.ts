import { beforeEach, describe, expect, it } from 'vitest';
import { HostDetailResponse, HostDraftInput, HostHealthRow, HostListResponse } from '../hosts/hosts';
import { AuthServer } from './auth-server';
import { HostServer } from './host-server';
import { FlakyStorage } from './testing/merchant-test-data';
import { currentCode, signIn } from './testing/sign-in';

// Host Management (Batch 5A). Seed: six sample hosts (HARSYA, WINPAY, LINKQU, Public Bank,
// Saigon PayLink, CIMB Collect) and four sample partners. MOBI-TECHOPS manages; others view.

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

  const input = (over: Partial<HostDraftInput> = {}): HostDraftInput => ({
    draft: false,
    basic: { name: 'Mekong Pay', hostCode: 'MEKONG', description: 'Sample', hostType: 'payment_gateway', associatedPartnerId: 'PTN-004', registrationCountry: 'VN', ownerTeam: 'Tech Ops – Vietnam', notes: '' },
    capabilities: [
      { countryCode: 'VN', paymentMethodCode: 'vietqr', availabilityStatus: 'available' },
      { countryCode: 'VN', paymentMethodCode: 'bank_transfer_payout', availabilityStatus: 'available' },
    ],
    integration: { integrationName: 'Mekong API', adapterType: 'mobi_rest_v1', apiBaseUrl: 'https://api.mekongpay.example/v1', apiVersion: 'v1', environment: 'production', authenticationType: 'api_key', authConfig: { keyHeader: 'X-Api-Key' }, timeoutSeconds: 30, connectionConfig: '', notes: '' },
    ...over,
  });

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 24, 9);
    tokens.clear();
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new HostServer({ storage, auth, now: () => now });
  });

  it('lists the sample hosts with summary cards worked out from the data', async () => {
    const l = await list();
    expect(l.hosts.map((h) => h.hostCode).sort()).toEqual(['CIMBCOLLECT', 'HARSYA', 'LINKQU', 'PBB', 'SAIGONPAY', 'WINPAY']);
    expect(l.hosts.every((h) => h.sample)).toBe(true);
    const count = (s: string) => l.hosts.filter((h) => h.operationalStatus === s).length;
    expect(l.summary).toEqual({ total: 6, active: count('active'), inactive: count('disabled') + count('maintenance'), attention: count('attention') });
    // WINPAY is active but its last check was Unreachable; Saigon PayLink's integration is incomplete.
    expect((await byCode('WINPAY')).operationalStatus).toBe('attention');
    expect((await byCode('SAIGONPAY')).integrationStatus).toBe('incomplete');
    expect((await byCode('LINKQU')).integrationStatus).toBe('testing');
    expect((await byCode('HARSYA')).integrationStatus).toBe('verified');
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
    expect(bad.body.errors.find((e: any) => e.field === 'basic.hostCode').message).toBe('HARSYA is already used by another host. Choose a unique code.');

    const r = await call<HostDetailResponse>('POST', '/api/hosts', input());
    expect(r.status).toBe(201);
    expect(r.body.host).toMatchObject({ id: 'HST-VN-002', hostCode: 'MEKONG', draft: false, operationalStatus: 'disabled', integrationStatus: 'configured', partnerName: 'Mekong Commerce Partners' });
    expect(r.body.capabilities.map((c) => [c.paymentMethodName, c.paymentFlow, c.supportedCurrencies])).toEqual([['VietQR', 'payin', ['VND']], ['Bank Transfer', 'payout', ['VND']]]);
    // A credential reference is assigned and only ever shown masked.
    expect(r.body.integration!.credentialReferenceMasked).toMatch(/^cred_••••\w{4}$/);
    expect(r.body.integration).not.toHaveProperty('credentialReference');
    expect(r.body.activity.map((a) => a.action)).toEqual(expect.arrayContaining(['Host created', 'Payment methods added', 'Integration configuration updated']));
    // Payment methods must come from the country catalogue.
    const unknown = await call('POST', '/api/hosts', input({ basic: { ...input().basic, hostCode: 'X2' }, capabilities: [{ countryCode: 'VN', paymentMethodCode: 'fpx', availabilityStatus: 'available' }] }));
    expect(unknown.body.errors[0].message).toBe('Choose a payment method configured for Vietnam.');
  });

  it('saves a draft with only a name and code, and completes it later', async () => {
    const d = await call<HostDetailResponse>('POST', '/api/hosts', { draft: true, basic: { name: 'Draft Host', hostCode: 'DRAFT1' }, capabilities: [], integration: null });
    expect(d.status).toBe(201);
    expect(d.body.host).toMatchObject({ draft: true, operationalStatus: 'disabled', integrationStatus: 'not_configured' });
    expect(d.body.enableBlockers[0]).toContain('draft');
    const done = await call<HostDetailResponse>('PUT', `/api/hosts/${d.body.host.id}`, input({ basic: { ...input().basic, name: 'Draft Host', hostCode: 'DRAFT1' } }));
    expect(done.body.host.draft).toBe(false);
    expect(done.body.activity).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'Host created', details: 'Draft completed and saved.' })]));
  });

  it('never stores secrets: anything that looks like a secret is refused', async () => {
    const r = await call('POST', '/api/hosts', input({ integration: { ...input().integration!, ...({ secret: 'sk_live_123' } as object) } }));
    expect(r.status).toBe(422);
    expect(storage.getItem('mobi.gp.hostdb') ?? '').not.toContain('sk_live_123');
  });

  it('manages capabilities one by one: disabling a method never disables the host', async () => {
    const h = await byCode('HARSYA');
    const before = await detail(h.id);
    const ovo = before.capabilities.find((c) => c.paymentMethodCode === 'ovo')!;
    const r = await call<HostDetailResponse>('PUT', `/api/hosts/${h.id}/capabilities/${ovo.id}`, { availabilityStatus: 'disabled' });
    expect(r.body.capabilities.find((c) => c.id === ovo.id)!.availabilityStatus).toBe('disabled');
    expect(r.body.host.operationalStatus).toBe('active');
    expect(r.body.activity[0]).toMatchObject({ action: 'Payment method disabled', details: 'OVO · PayIn · Indonesia · Disabled' });
    const add = await call<HostDetailResponse>('POST', `/api/hosts/${h.id}/capabilities`, { countryCode: 'ID', paymentMethodCode: 'dana', availabilityStatus: 'available' });
    expect(add.status).toBe(201);
    expect((await call('POST', `/api/hosts/${h.id}/capabilities`, { countryCode: 'ID', paymentMethodCode: 'dana' })).status).toBe(409);
  });

  it('validates the configuration (simulated) and tells Testing from Verified', async () => {
    const created = (await call<HostDetailResponse>('POST', '/api/hosts', input({ integration: { ...input().integration!, environment: 'sandbox', apiBaseUrl: 'https://sandbox.mekongpay.example' } }))).body;
    const v = await call<HostDetailResponse & { validation: { result: string } }>('POST', `/api/hosts/${created.host.id}/validate`);
    expect(v.body.validation.result).toBe('valid');
    expect(v.body.host.integrationStatus).toBe('testing');
    // Switching to production with a sandbox URL fails validation.
    await call('PUT', `/api/hosts/${created.host.id}`, input({ integration: { ...input().integration!, apiBaseUrl: 'https://sandbox.mekongpay.example' } }));
    expect((await detail(created.host.id)).host.integrationStatus).toBe('configured');
    const failed = await call<HostDetailResponse & { validation: { result: string; messages: string[] } }>('POST', `/api/hosts/${created.host.id}/validate`);
    expect(failed.body.validation).toMatchObject({ result: 'failed', messages: ['The production endpoint looks like a test URL (contains sandbox, staging, test or UAT).'] });
    expect(failed.body.host.integrationStatus).toBe('error');
    // Incomplete configuration.
    const saigon = await byCode('SAIGONPAY');
    const inc = await call<HostDetailResponse & { validation: { result: string; messages: string[] } }>('POST', `/api/hosts/${saigon.id}/validate`);
    expect(inc.body.validation.result).toBe('incomplete');
    expect(inc.body.validation.messages).toEqual(expect.arrayContaining(['Token URL is missing.']));
  });

  it('replaces the credential reference only with an authenticator code', async () => {
    const h = await byCode('HARSYA');
    expect((await call('POST', `/api/hosts/${h.id}/credentials`, {})).body).toMatchObject({ code: 'MFA_CODE_REQUIRED' });
    const before = (await detail(h.id)).integration!.credentialReferenceMasked;
    const r = await call<HostDetailResponse>('POST', `/api/hosts/${h.id}/credentials`, { code: await code() });
    expect(r.body.integration!.credentialReferenceMasked).not.toBe(before);
    // A new reference changes the configuration: validate again before it is Verified.
    expect(r.body.host.integrationStatus).toBe('configured');
    expect(r.body.host.operationalStatus).toBe('attention');
    expect(r.body.activity[0].action).toBe('Credential reference replaced');
  });

  it('enables only a verified host with an available capability; disable and maintenance need a reason and a code', async () => {
    const created = (await call<HostDetailResponse>('POST', '/api/hosts', input())).body;
    const id = created.host.id;
    expect((await call('POST', `/api/hosts/${id}/status`, { action: 'enable', code: await code() })).body.message).toContain('must be Verified');
    await call('POST', `/api/hosts/${id}/validate`);
    expect((await call('POST', `/api/hosts/${id}/status`, { action: 'enable' })).body).toMatchObject({ code: 'MFA_CODE_REQUIRED' });
    const on = await call<HostDetailResponse>('POST', `/api/hosts/${id}/status`, { action: 'enable', code: await code() });
    expect(on.body.host.operationalStatus).toBe('active');
    expect(on.body.activity[0]).toMatchObject({ action: 'Host enabled' });

    expect((await call('POST', `/api/hosts/${id}/status`, { action: 'maintenance', reason: 'x', code: await code() })).body.message).toBe('Enter a reason (at least 5 characters).');
    const m = await call<HostDetailResponse>('POST', `/api/hosts/${id}/status`, { action: 'maintenance', reason: 'Provider upgrade tonight', until: now + 3600_000, code: await code() });
    expect(m.body.host.operationalStatus).toBe('maintenance');
    expect(m.body.host.maintenance).toMatchObject({ reason: 'Provider upgrade tonight' });
    const back = await call<HostDetailResponse>('POST', `/api/hosts/${id}/status`, { action: 'enable', code: await code() });
    expect(back.body.activity[0].action).toBe('Host re-enabled');

    expect((await call('POST', `/api/hosts/${id}/status`, { action: 'disable', reason: 'Provider outage on VA', code: await code() })).body.message).toBe('Confirm that the host stops being eligible for routing.');
    const off = await call<HostDetailResponse>('POST', `/api/hosts/${id}/status`, { action: 'disable', reason: 'Provider outage on VA', confirm: true, code: await code() });
    expect(off.body.host).toMatchObject({ operationalStatus: 'disabled', disabledReason: 'Provider outage on VA' });
    expect(off.body.activity[0].details).toContain('No traffic is rerouted automatically.');
  });

  it('simulates health checks; an incomplete configuration is never Healthy', async () => {
    const saigon = await byCode('SAIGONPAY');
    const r = await call<HostDetailResponse>('POST', `/api/hosts/${saigon.id}/health-check`);
    expect(r.body.health[0]).toMatchObject({ status: 'unknown', simulated: true });
    const h = await byCode('PBB');
    const checks = [];
    for (let i = 0; i < 6; i++) {
      now += 1000;
      checks.push((await call<HostDetailResponse>('POST', `/api/hosts/${h.id}/health-check`)).body.health[0]);
    }
    expect(checks.every((c) => ['healthy', 'degraded', 'unreachable'].includes(c.status) && c.simulated && c.message.includes('simulated'))).toBe(true);
    const rows = (await call<HostHealthRow[]>('GET', '/api/hosts/health')).body;
    expect(rows.find((x) => x.hostCode === 'SAIGONPAY')!.status).toBe('unknown');
    expect(rows.find((x) => x.hostCode === 'WINPAY')).toMatchObject({ status: 'unreachable', recentError: 'No response within 30 s (simulated).' });
  });

  it('keeps hosts after a reload (new server, same storage) and lists all activity', async () => {
    await call('POST', '/api/hosts', input());
    server = new HostServer({ storage, auth, now: () => now });
    expect((await list()).hosts.some((h) => h.hostCode === 'MEKONG')).toBe(true);
    const activity = (await call<{ hostName: string; action: string }[]>('GET', '/api/hosts/activity')).body;
    expect(activity[0]).toMatchObject({ hostName: 'Mekong Pay' });
  });
});
