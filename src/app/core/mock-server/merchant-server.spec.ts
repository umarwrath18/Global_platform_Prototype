import { beforeEach, describe, expect, it } from 'vitest';
import { emptyApplicationData } from '../merchants/application-rules';
import { ApplicationData, CountryApplication, GlobalMerchant, MerchantDetail, MerchantSummary, StaffRole } from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES } from '../merchants/onboarding-config';
import { AuthServer } from './auth-server';
import { MerchantServer } from './merchant-server';
import { DEMO_PASSWORD } from './seed';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

function completeData(country: string, legalName: string): ApplicationData {
  const cfg = ONBOARDING_COUNTRIES[country];
  const d = emptyApplicationData(country);
  d.business = { tradingName: legalName, businessType: cfg.businessTypes[0], industry: 'Education', website: 'https://example.test', address: '1 Demo Street', localRegistrationNumber: '', taxId: '', expectedMonthlyVolume: 1000 };
  if (country === 'TH') {
    d.business.localRegistrationNumber = '0105561234567';
    d.business.taxId = '0105561234567';
  }
  d.contact = { name: 'Test Person', email: 'test@example.test', phone: '+60 12 345 6789', supportEmail: '' };
  d.bank = { bankName: 'Demo Bank', accountName: legalName, accountNumber: '1234567890', branch: 'Main' };
  if (!cfg.bankFields.some((f) => f.key === 'branch')) delete d.bank['branch'];
  d.directors = [{ id: 'x', name: 'Test Person', nationality: 'Malaysian', idNumber: 'A1', role: 'director_and_owner', ownershipPct: 100 }];
  d.documents = cfg.documents.filter((x) => x.required).map((x, i) => ({ id: `d${i}`, type: x.type, fileName: 'a.pdf', sizeKb: 10, uploadedAt: 0, sample: true }));
  d.pricing = cfg.paymentMethods.map((m, i) => ({ code: m.code, enabled: i === 0, mdr: m.defaultMdr }));
  return d;
}

describe('MerchantServer', () => {
  let now: number;
  let auth: AuthServer;
  let server: MerchantServer;
  let token: string;

  const call = <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') =>
    server.handle(method, path, body, token, role) as Promise<{ status: number; body: T }>;

  const newMerchant = async (legalName = 'Acme Learning Sdn Bhd', registrationNumber = '202401000001') =>
    (await call<GlobalMerchant>('POST', '/api/merchants', { legalName, registrationCountry: 'MY', registrationNumber, primaryContact: { name: 'Ana', email: 'ana@acme.test', phone: '+60 12 000 0000' } })).body;

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 25);
    const storage = new MemoryStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new MerchantServer({ storage, now: () => now, auth });
    token = ((await auth.handle('POST', '/api/auth/login', { loginId: '123', password: DEMO_PASSWORD }, null)).body as any).token;
  });

  it('requires a valid session', async () => {
    expect((await server.handle('GET', '/api/merchants', null, null, 'sales')).status).toBe(401);
  });

  it('seeds demo merchants consistent with the Batch 1 Global Accounts', async () => {
    const list = (await call<MerchantSummary[]>('GET', '/api/merchants')).body;
    expect(list).toHaveLength(8);
    const trading = list.find((m) => m.id === 'GM-100101')!;
    expect(trading.linkedAccountId).toBe('GA-1001');
    expect(trading.globalStatus).toBe('active');
    expect(Object.fromEntries(trading.applications.map((a) => [a.country, a.status]))).toEqual({
      MY: 'operational', ID: 'operational', VN: 'operational', PH: 'rejected', TH: 'cs_configuration',
    });
    expect(list.find((m) => m.id === 'GM-100108')!.applications).toHaveLength(0);
  });

  it('creates a Global Merchant ID before any approval and blocks duplicates', async () => {
    const m = await newMerchant();
    expect(m.id).toBe('GM-100109');
    expect(m.globalStatus).toBe('onboarding');

    const dupReg = await call('POST', '/api/merchants', { legalName: 'Other name', registrationCountry: 'MY', registrationNumber: '202401000001', primaryContact: { name: 'B', email: 'b@b.test', phone: '+60 12 000 0001' } });
    expect(dupReg.status).toBe(409);
    expect(dupReg.body).toMatchObject({ code: 'DUPLICATE_MERCHANT', existingMerchantId: 'GM-100109' });

    const similar = { legalName: 'ACME Learning', registrationCountry: 'MY', registrationNumber: '202401000002', primaryContact: { name: 'B', email: 'b@b.test', phone: '+60 12 000 0001' } };
    expect((await call('POST', '/api/merchants', similar)).body).toMatchObject({ code: 'POSSIBLE_DUPLICATE' });
    expect((await call('POST', '/api/merchants', { ...similar, confirmNotDuplicate: true })).status).toBe(201);
  });

  it('validates the Global Merchant fields', async () => {
    const res = await call('POST', '/api/merchants', { legalName: '', registrationCountry: 'MY', registrationNumber: '123', primaryContact: { name: '', email: 'x', phone: '1' } });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: any) => e.field)).toEqual(['legalName', 'registrationNumber', 'primaryContact.name', 'primaryContact.email', 'primaryContact.phone']);
  });

  it('only lets Sales/Ops create merchants and applications', async () => {
    expect((await call('POST', '/api/merchants', {}, 'risk')).body).toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
    expect((await call('POST', '/api/merchants/GM-100108/applications', { country: 'MY' }, 'cs')).status).toBe(403);
  });

  it('prefills shared information and keeps one open application per country', async () => {
    const m = await newMerchant();
    const app = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' })).body;
    expect(app.id).toMatch(/^APP-2026-\d{4}$/);
    expect(app.status).toBe('draft');
    expect(app.data.contact.email).toBe('ana@acme.test');
    expect(app.data.business.localRegistrationNumber).toBe('202401000001');
    expect(app.prefill.map((p) => p.field)).toContain('business.localRegistrationNumber');

    const again = await call('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' });
    expect(again.body).toMatchObject({ code: 'APPLICATION_EXISTS', existingApplicationId: app.id });

    // Country expansion: same merchant, new application, no new Global Merchant.
    const th = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'TH' })).body;
    expect(th.merchantId).toBe(m.id);
    expect(th.data.business.localRegistrationNumber).toBe('');
    expect(th.data.bank).toEqual({ bankName: '', branch: '', accountName: '', accountNumber: '' });
    const detail = (await call<MerchantDetail>('GET', `/api/merchants/${m.id}`)).body;
    expect(detail.applications.map((a) => a.country)).toEqual(['MY', 'TH']);
    expect((await call<MerchantSummary[]>('GET', '/api/merchants')).body).toHaveLength(9);
  });

  it('copies directors from an existing application when expanding', async () => {
    const res = await call<CountryApplication>('POST', '/api/merchants/GM-100105/applications', { country: 'MY' });
    expect(res.body.data.directors.map((d) => d.name)).toEqual(['Somchai Prasert']);
    expect(res.body.data.bank['accountNumber']).toBe('');
    expect(res.body.data.documents).toEqual([]);
  });

  it('blocks incomplete submissions, including missing required documents', async () => {
    const m = await newMerchant();
    const app = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' })).body;
    const res = await call('POST', `/api/applications/${app.id}/submit`, {});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('APPLICATION_INCOMPLETE');
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['documents.ssm_profile', 'bank.accountNumber', 'pricing']));

    const data = completeData('MY', m.legalName);
    data.pricing[0].mdr = 9;
    const bad = await call('POST', `/api/applications/${app.id}/submit`, { data });
    expect(bad.body.errors).toEqual([expect.objectContaining({ field: 'pricing.MY_CARDS' })]);
  });

  it('runs the full journey: return, resubmit with the same ID, approve, CS readiness, go-live', async () => {
    const m = await newMerchant();
    const id = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' })).body.id;
    await call('PUT', `/api/applications/${id}`, { data: completeData('MY', m.legalName) });
    expect((await call<CountryApplication>('POST', `/api/applications/${id}/submit`, {})).body.status).toBe('pending_risk_review');

    // Risk must explain a return and pick sections.
    expect((await call('POST', `/api/applications/${id}/review`, { decision: 'return', comment: '', evidenceReviewed: true }, 'risk')).status).toBe(422);
    expect((await call('POST', `/api/applications/${id}/review`, { decision: 'approve' }, 'sales')).status).toBe(403);
    const returned = (await call<CountryApplication>('POST', `/api/applications/${id}/review`, { decision: 'return', comment: 'Upload a clearer SSM profile.', sections: ['documents'], evidenceReviewed: true }, 'risk')).body;
    expect(returned.status).toBe('returned');
    expect(returned.corrections).toEqual({ reason: 'Upload a clearer SSM profile.', sections: ['documents'] });

    const resubmitted = (await call<CountryApplication>('POST', `/api/applications/${id}/submit`, { comment: 'Replaced the SSM profile.' })).body;
    expect(resubmitted.id).toBe(id);
    expect(resubmitted.submissionCount).toBe(2);
    expect(resubmitted.history.map((h) => h.action)).toEqual(expect.arrayContaining(['Submitted for Risk review', 'Returned for correction', 'Resubmitted after correction']));

    const approved = (await call<CountryApplication>('POST', `/api/applications/${id}/review`, { decision: 'approve', comment: '', evidenceReviewed: true }, 'risk')).body;
    expect(approved.status).toBe('risk_approved');
    expect((await call<GlobalMerchant>('GET', `/api/merchants/${m.id}`)).body).toMatchObject({ merchant: { globalStatus: 'onboarding', linkedAccountId: null } });

    // CS steps must happen in order.
    expect((await call('POST', `/api/applications/${id}/readiness`, { action: 'generate_keys' }, 'cs')).status).toBe(409);
    await call('POST', `/api/applications/${id}/readiness`, { action: 'start_configuration' }, 'cs');
    expect((await call('POST', `/api/applications/${id}/readiness`, { action: 'generate_keys' }, 'cs')).body.code).toBe('CHECKLIST_INCOMPLETE');
    for (const key of ['settlement_account', 'payment_methods', 'pricing_loaded', 'merchant_portal']) {
      await call('POST', `/api/applications/${id}/readiness`, { action: 'set_item', stage: 'configuration', key, done: true }, 'cs');
    }
    const keyed = (await call<CountryApplication>('POST', `/api/applications/${id}/readiness`, { action: 'generate_keys' }, 'cs')).body;
    expect(keyed.status).toBe('keys_generated');
    expect(keyed.readiness.keySet).toMatchObject({ reference: expect.stringMatching(/^KS-[0-9A-F]{6}$/), simulated: true });

    await call('POST', `/api/applications/${id}/readiness`, { action: 'start_integration' }, 'cs');
    for (const key of ['docs_shared', 'sandbox_tests', 'webhook_verified']) await call('POST', `/api/applications/${id}/readiness`, { action: 'set_item', stage: 'integration', key, done: true }, 'cs');
    await call('POST', `/api/applications/${id}/readiness`, { action: 'request_go_live' }, 'cs');
    for (const key of ['live_transaction', 'settlement_test', 'merchant_signoff']) await call('POST', `/api/applications/${id}/readiness`, { action: 'set_item', stage: 'go_live', key, done: true }, 'cs');
    const live = (await call<CountryApplication>('POST', `/api/applications/${id}/readiness`, { action: 'confirm_go_live' }, 'cs')).body;
    expect(live.status).toBe('operational');

    const detail = (await call<MerchantDetail>('GET', `/api/merchants/${m.id}`)).body;
    expect(detail.merchant.globalStatus).toBe('active');
    expect(detail.merchant.linkedAccountId).toMatch(/^GA-\d+$/);

    const notes = (await call<any[]>('GET', '/api/notifications')).body.filter((n) => n.applicationId === id).map((n) => n.event);
    expect(notes).toEqual(['go_live', 'configuration_ready', 'approved', 'resubmitted', 'returned', 'submitted']);
  });

  it('activates the country on the linked Global Account at go-live only', async () => {
    const countries = async () => ((await auth.handle('GET', '/api/auth/session', null, token)).body as any).countries.map((c: any) => `${c.code}:${c.status}`);
    expect(await countries()).toContain('TH:pending');
    const id = 'APP-2026-0010';
    for (const key of ['pricing_loaded', 'merchant_portal']) await call('POST', `/api/applications/${id}/readiness`, { action: 'set_item', stage: 'configuration', key, done: true }, 'cs');
    await call('POST', `/api/applications/${id}/readiness`, { action: 'generate_keys' }, 'cs');
    await call('POST', `/api/applications/${id}/readiness`, { action: 'start_integration' }, 'cs');
    expect(await countries()).toContain('TH:pending');
    for (const key of ['docs_shared', 'sandbox_tests', 'webhook_verified']) await call('POST', `/api/applications/${id}/readiness`, { action: 'set_item', stage: 'integration', key, done: true }, 'cs');
    await call('POST', `/api/applications/${id}/readiness`, { action: 'request_go_live' }, 'cs');
    for (const key of ['live_transaction', 'settlement_test', 'merchant_signoff']) await call('POST', `/api/applications/${id}/readiness`, { action: 'set_item', stage: 'go_live', key, done: true }, 'cs');
    await call('POST', `/api/applications/${id}/readiness`, { action: 'confirm_go_live' }, 'cs');
    expect(await countries()).toContain('TH:active');
    // Other countries are untouched.
    expect(await countries()).toContain('PH:failed');
  });

  it('keeps rejected applications and starts a new one on retry', async () => {
    const res = await call<CountryApplication>('POST', '/api/merchants/GM-100101/applications', { country: 'PH' });
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe('APP-2026-0006');
    expect(res.body.previousApplicationId).toBe('APP-2026-0006');
    const old = (await call<any>('GET', '/api/applications/APP-2026-0006')).body.application as CountryApplication;
    expect(old.status).toBe('rejected');

    // A rejected application is final.
    expect((await call('POST', '/api/applications/APP-2026-0006/submit', {})).status).toBe(409);
    expect((await call('PUT', '/api/applications/APP-2026-0006', { data: old.data })).status).toBe(409);
  });

  it('rejects and approves independently per country', async () => {
    await call('POST', '/api/applications/APP-2026-0012/review', { decision: 'reject', comment: 'Not within risk appetite.', evidenceReviewed: true }, 'risk');
    const detail = (await call<MerchantDetail>('GET', '/api/merchants/GM-100102')).body;
    expect(detail.applications.map((a) => a.status)).toEqual(['rejected', 'rejected']);
    expect(detail.merchant.globalStatus).toBe('no_active_applications');
    const trading = (await call<MerchantDetail>('GET', '/api/merchants/GM-100101')).body;
    expect(trading.applications.filter((a) => a.status === 'operational')).toHaveLength(3);
  });

  it('flags screening matches as evidence without deciding', async () => {
    const app = (await call<any>('GET', '/api/applications/APP-2026-0013')).body.application as CountryApplication;
    expect(app.status).toBe('pending_risk_review');
    expect(app.verification?.checks.find((c) => c.name.startsWith('Sanctions'))?.result).toBe('review');
  });

  it('guided mode records gaps but never blocks a step', async () => {
    const guided = new MerchantServer({ storage: new MemoryStorage(), now: () => now, auth, strictValidation: () => false });
    const g = <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') =>
      guided.handle(method, path, body, token, role) as Promise<{ status: number; body: T }>;

    const m = (await g<GlobalMerchant>('POST', '/api/merchants', {})).body;
    expect(m.legalName).toBe('Untitled merchant');
    const id = (await g<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' })).body.id;

    const submitted = (await g<CountryApplication>('POST', `/api/applications/${id}/submit`, {})).body;
    expect(submitted.status).toBe('pending_risk_review');
    expect(submitted.history.find((h) => h.action === 'Submitted for Risk review')?.comment).toMatch(/incomplete item/);

    // A decision is still required; everything else gets a sensible default.
    expect((await g('POST', `/api/applications/${id}/review`, {}, 'risk')).status).toBe(422);
    const returned = (await g<CountryApplication>('POST', `/api/applications/${id}/review`, { decision: 'return' }, 'risk')).body;
    expect(returned.corrections?.reason).toMatch(/resubmit/);
    expect(returned.corrections?.sections.length).toBeGreaterThan(0);

    await g('POST', `/api/applications/${id}/submit`, {});
    await g('POST', `/api/applications/${id}/review`, { decision: 'approve' }, 'risk');
    await g('POST', `/api/applications/${id}/readiness`, { action: 'start_configuration' }, 'cs');
    const keyed = (await g<CountryApplication>('POST', `/api/applications/${id}/readiness`, { action: 'generate_keys' }, 'cs')).body;
    expect(keyed.status).toBe('keys_generated');
    expect(keyed.readiness.configuration.every((i) => i.done)).toBe(true);

    // Order is still enforced.
    expect((await g('POST', `/api/applications/${id}/readiness`, { action: 'confirm_go_live' }, 'cs')).status).toBe(409);
  });

  it('marks notifications as read per role', async () => {
    const before = (await call<any[]>('GET', '/api/notifications')).body.filter((n) => n.audience.includes('risk') && !n.readBy.includes('risk'));
    expect(before.length).toBeGreaterThan(0);
    await call('POST', '/api/notifications/read', {}, 'risk');
    const after = (await call<any[]>('GET', '/api/notifications')).body;
    expect(after.filter((n) => n.audience.includes('risk') && !n.readBy.includes('risk'))).toHaveLength(0);
    expect(after.some((n) => n.audience.includes('sales') && !n.readBy.includes('sales'))).toBe(true);
  });
});
