import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CountryConfigDetail, CountryConfigView, toConfigInput } from '../merchants/country-config';
import { CountryApplication, GlobalMerchant, StaffRole } from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES, resetCountryConfigs } from '../merchants/onboarding-config';
import { AuthServer } from './auth-server';
import { CountryConfigServer } from './country-config-server';
import { MerchantServer } from './merchant-server';
import { signIn } from './testing/sign-in';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

describe('CountryConfigServer', () => {
  let now: number;
  let storage: MemoryStorage;
  let auth: AuthServer;
  let config: CountryConfigServer;
  let token: string;
  let merchants: MerchantServer;

  const login = async (loginId: string) => signIn(auth, loginId);
  const get = <T = any>(path: string, server = config, role: StaffRole | null = 'sales') => server.handle('GET', path, null, token, role) as Promise<{ status: number; body: T }>;
  const put = <T = any>(code: string, changes: (input: any) => void, extra: Record<string, unknown> = {}, role: StaffRole | null = 'sales') => {
    const input: any = { ...toConfigInput(ONBOARDING_COUNTRIES[code]), version: extra['version'] ?? 1, reason: 'Approved by Risk policy update' };
    changes(input);
    return config.handle('PUT', `/api/config/countries/${code}`, { ...input, ...extra }, token, role) as Promise<{ status: number; body: T }>;
  };
  const call = <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') =>
    merchants.handle(method, path, body, token, role) as Promise<{ status: number; body: T }>;

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 28);
    storage = new MemoryStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    config = new CountryConfigServer({ storage, now: () => now, auth });
    merchants = new MerchantServer({ storage, now: () => now, auth, countryConfig: config });
    token = await login('123');
  });

  afterEach(() => resetCountryConfigs());

  it('lets any signed-in user read the configuration of every onboarding country', async () => {
    expect((await config.handle('GET', '/api/config/countries', null, null)).status).toBe(401);
    const list = (await get<CountryConfigView[]>('/api/config/countries')).body;
    expect(list.map((c) => c.config.code)).toEqual(['MY', 'ID', 'VN']);
    expect(list.every((c) => c.onboardingEnabled && c.version === 1 && c.updatedBy === null)).toBe(true);
    expect((await get('/api/config/countries/SG')).status).toBe(404);
  });

  it('only Sales / Operations can change configuration; other teams are view only', async () => {
    for (const role of ['risk', 'cs', null] as const) {
      expect((await get<CountryConfigDetail>('/api/config/countries/MY', config, role)).body.canEdit).toBe(false);
      const res = await put('MY', (i) => (i.onboardingEnabled = false), {}, role);
      expect(res).toMatchObject({ status: 403, body: { code: 'PERMISSION_REQUIRED', message: 'Only Sales / Operations can change country configuration.' } });
    }
    expect((await get<CountryConfigView>('/api/config/countries/MY')).body).toMatchObject({ onboardingEnabled: true, version: 1 });
    expect((await get<CountryConfigDetail>('/api/config/countries/MY')).body.canEdit).toBe(true);
    // No login role or user is involved: any signed-in user acting as Sales / Operations can edit.
    token = await login('TANJUNG-VIEWER');
    expect((await put('MY', (i) => (i.onboardingEnabled = false))).body).toMatchObject({ onboardingEnabled: false, version: 2 });
  });

  it('pausing a country blocks new applications only, until it is resumed', async () => {
    const m = (await call<GlobalMerchant>('POST', '/api/merchants', { legalName: 'Kopi Nusantara Sdn Bhd', registrationCountry: 'MY', registrationNumber: '202401000077', primaryContact: { name: 'Ana', email: 'ana@kopi.test', phone: '+60 12 000 0000' } })).body;
    expect((await put('ID', (i) => (i.onboardingEnabled = false))).body).toMatchObject({ onboardingEnabled: false, version: 2 });

    const blocked = await call('POST', `/api/merchants/${m.id}/applications`, { country: 'ID' });
    expect(blocked).toMatchObject({ status: 422, body: { code: 'COUNTRY_NOT_SUPPORTED', message: expect.stringMatching(/paused/) } });
    expect((await call('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' })).status).toBe(201);
    // Existing Indonesia applications keep working.
    expect((await call('GET', '/api/applications/APP-2026-0002')).status).toBe(200);

    await put('ID', (i) => (i.onboardingEnabled = true), { version: 2 });
    expect((await call('POST', `/api/merchants/${m.id}/applications`, { country: 'ID' })).status).toBe(201);
  });

  it('applies a newly required document to drafts', async () => {
    const m = (await call<GlobalMerchant>('POST', '/api/merchants', { legalName: 'Kopi Nusantara Sdn Bhd', registrationCountry: 'MY', registrationNumber: '202401000077', primaryContact: { name: 'Ana', email: 'ana@kopi.test', phone: '+60 12 000 0000' } })).body;
    const draft = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' })).body;

    await put('MY', (i) => (i.documents.find((d: any) => d.type === 'sst_certificate').required = true));
    const res = await call('POST', `/api/applications/${draft.id}/submit`, {});
    expect(res.body.code).toBe('APPLICATION_INCOMPLETE');
    expect(res.body.errors.map((e: any) => e.field)).toContain('documents.sst_certificate');
  });

  it('records a snapshot of the rules at submission', async () => {
    const m = (await call<GlobalMerchant>('POST', '/api/merchants', { legalName: 'Kopi Nusantara Sdn Bhd', registrationCountry: 'MY', registrationNumber: '202401000077', primaryContact: { name: 'Ana', email: 'ana@kopi.test', phone: '+60 12 000 0000' } })).body;
    const guided = new MerchantServer({ storage, now: () => now, auth, countryConfig: config, strictValidation: () => false });
    const id = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'MY' })).body.id;
    const submitted = (await guided.handle('POST', `/api/applications/${id}/submit`, {}, token, 'sales')).body as CountryApplication;
    expect(submitted.rulesSnapshot?.documents.find((d) => d.type === 'ssm_profile')?.label).toBe('SSM company profile (Section 14 / e-Info)');

    await put('MY', (i) => (i.documents.find((d: any) => d.type === 'ssm_profile').label = 'SSM e-Info company profile'));
    const later = (await call<any>('GET', `/api/applications/${id}`)).body.application as CountryApplication;
    expect(later.rulesSnapshot?.documents.find((d) => d.type === 'ssm_profile')?.label).toBe('SSM company profile (Section 14 / e-Info)');
    expect(ONBOARDING_COUNTRIES['MY'].documents.find((d) => d.type === 'ssm_profile')?.label).toBe('SSM e-Info company profile');
  });

  it('rejects invalid configuration with field-level errors', async () => {
    const fields = async (change: (i: any) => void, extra: Record<string, unknown> = {}) => ((await put('MY', change, extra)).body.errors ?? []).map((e: any) => e.field);
    expect(await fields((i) => (i.localRegistration.pattern = '^(\\d+'))).toContain('localRegistration.pattern');
    expect(await fields((i) => (i.businessTypes = []))).toContain('businessTypes');
    expect(await fields((i) => i.businessTypes.push(i.businessTypes[0]))).toContain('businessTypes');
    expect(await fields((i) => i.documents.push({ type: 'ssm_profile', label: 'Duplicate', required: false }))).toContain('documents');
    expect(await fields((i) => i.documents.push({ type: 'Bad Type!', label: 'X', required: false }))).toContain('documents.4.type');
    expect(await fields((i) => (i.bankFields = i.bankFields.filter((f: any) => f.key !== 'swiftCode')))).toContain('bankFields');
    expect(await fields((i) => (i.directors.minCount = 0))).toContain('directors.minCount');
    expect(await fields((i) => (i.directors.minCount = 25))).toContain('directors.minCount');
    expect(await fields((i) => (i.onboardingEnabled = false), { reason: 'no' })).toEqual(['reason']);
    expect((await put('MY', () => {})).body).toMatchObject({ code: 'VALIDATION_FAILED', message: 'There are no changes to save.' });
    // Nothing above was saved.
    expect((await get<CountryConfigView>('/api/config/countries/MY')).body.version).toBe(1);
  });

  it('records who changed what and why, and rejects edits based on an old version', async () => {
    now += 60_000;
    await put('ID', (i) => {
      i.bankFields.push({ key: 'branchCode', label: 'Branch code', required: false });
      i.directors.minCount = 2;
    });
    const stale = await put('ID', (i) => (i.onboardingEnabled = false));
    expect(stale).toMatchObject({ status: 409, body: { code: 'CONFIG_CONFLICT' } });

    const detail = (await get<CountryConfigDetail>('/api/config/countries/ID')).body;
    expect(detail).toMatchObject({ version: 2, updatedBy: 'Sarah Lim', updatedAt: now });
    expect(detail.history).toEqual([
      { at: now, country: 'ID', by: 'Sarah Lim', role: 'sales', reason: 'Approved by Risk policy update', version: 2, changes: ['Bank field added: Branch code', 'Director rules updated'] },
    ]);
    // A new bank field becomes part of the application data shape.
    const m = (await call<GlobalMerchant>('POST', '/api/merchants', { legalName: 'PT Teh Nusantara', registrationCountry: 'ID', registrationNumber: '9120001234999', primaryContact: { name: 'Nok', email: 'nok@teh.test', phone: '+62 21 000 0000' } })).body;
    const app = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'ID' })).body;
    expect(app.data.bank).toHaveProperty('branchCode', '');
  });

  it('keeps changes in storage, so they survive a reload', async () => {
    await put('VN', (i) => (i.onboardingEnabled = false));
    resetCountryConfigs(); // Simulates a fresh page: live rules back to the shipped defaults.
    expect(ONBOARDING_COUNTRIES['VN'].onboardingEnabled).not.toBe(false);
    const reloaded = new CountryConfigServer({ storage, now: () => now, auth });
    expect((await get<CountryConfigView>('/api/config/countries/VN', reloaded)).body.onboardingEnabled).toBe(false);
    reloaded.sync();
    expect(ONBOARDING_COUNTRIES['VN'].onboardingEnabled).toBe(false);
  });
});
