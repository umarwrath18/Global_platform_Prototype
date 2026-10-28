import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalsView, ChangeRequest } from '../merchants/change-requests';
import { ApplicationDetail, MerchantDetail, StaffRole } from '../merchants/merchant-models';
import { AuthServer } from './auth-server';
import { MerchantDb, MerchantServer } from './merchant-server';
import { DEMO_PASSWORD } from './seed';
import { FlakyStorage } from './testing/merchant-test-data';

const KEY = 'mobi.gp.merchantdb';

// Seed: GM-100101 is approved (APP-2026-0001 Malaysia is live; account 514012345678). GM-100104 has
// only a draft. APP-2026-0009 (Thailand, GM-100105) is past Risk approval. APP-2026-0011 is returned.

describe('Changes after Risk approval', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: MerchantServer;
  let token: string;

  const login = async (loginId: string) => ((await auth.handle('POST', '/api/auth/login', { loginId, password: DEMO_PASSWORD }, null)).body as any).token as string;
  const call = <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales', t = token) => server.handle(method, path, body, t, role) as Promise<{ status: number; body: T }>;
  const merchant = async (id: string) => (await call<MerchantDetail>('GET', `/api/merchants/${id}`)).body;
  const application = async (id: string) => (await call<ApplicationDetail>('GET', `/api/applications/${id}`)).body;
  const requestCountry = (id: string, section: string, value: unknown, reason = 'Merchant moved banks this quarter', role: StaffRole = 'sales', t = token) =>
    call<any>('POST', `/api/applications/${id}/changes`, { section, value, reason }, role, t);
  const requestIdentity = (id: string, value: unknown, reason = 'Company renamed after restructuring') => call<any>('POST', `/api/merchants/${id}/changes`, { section: 'identity', value, reason });
  const decide = (id: string, decision: string, comment = '', role: StaffRole = 'risk') => call<any>('POST', `/api/changes/${id}/decision`, { decision, comment }, role);
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const app = (id: string) => db().applications.find((a) => a.id === id)!;
  const identity = { legalName: 'Tanjung Global Trading Sdn Bhd', registrationCountry: 'MY', registrationNumber: '201901012345' };

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 28, 9);
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new MerchantServer({ storage, now: () => now, auth });
    token = await login('123');
    await call('GET', '/api/merchants');
  });

  describe('direct profile edits', () => {
    it('records every edit; the legal identity changes directly only before Risk approval', async () => {
      const before = await merchant('GM-100104');
      expect((await call('PATCH', '/api/merchants/GM-100104', { legalName: 'Saigon Journeys Joint Stock Company' })).status).toBe(200);
      expect((await merchant('GM-100104')).profileEvents[0]).toMatchObject({
        action: 'identity_updated', by: 'Sarah Lim', role: 'sales',
        changes: [{ field: 'legalName', label: 'Legal name', from: before.merchant.legalName, to: 'Saigon Journeys Joint Stock Company' }],
      });

      const blocked = await call('PATCH', '/api/merchants/GM-100101', { legalName: 'Tanjung Renamed Bhd' });
      expect(blocked).toMatchObject({ status: 409, body: { code: 'CHANGE_REQUEST_REQUIRED' } });
      expect((await merchant('GM-100101')).merchant.legalName).toBe('Tanjung Global Trading Sdn Bhd');

      expect((await call('PATCH', '/api/merchants/GM-100101', { primaryContact: { name: 'Farah Ismail', email: 'farah.ismail@tanjungtrading.example', phone: '+60 12 999 0000' } })).status).toBe(200);
      const events = (await merchant('GM-100101')).profileEvents;
      expect(events).toEqual([expect.objectContaining({ action: 'contact_updated', changes: [{ field: 'primaryContact.phone', label: 'Phone', from: '+60 12 345 6789', to: '+60 12 999 0000' }] })]);
      // Saving without changes records nothing.
      await call('PATCH', '/api/merchants/GM-100101', {});
      expect((await merchant('GM-100101')).profileEvents).toHaveLength(1);
    });
  });

  describe('legal identity requests', () => {
    it('validates, waits for Risk, and applies only when Risk approves', async () => {
      expect((await requestIdentity('GM-100101', { ...identity, registrationNumber: '12' })).body.errors).toEqual([expect.objectContaining({ field: 'identity.registrationNumber' })]);
      expect((await requestIdentity('GM-100101', { ...identity, registrationNumber: '202301045678' })).body.code).toBe('DUPLICATE_MERCHANT'); // GM-100102's number
      expect((await requestIdentity('GM-100101', identity)).body.message).toBe('There are no changes to request.');
      expect((await requestIdentity('GM-100101', { ...identity, legalName: 'Tanjung Berhad' }, 'short')).status).toBe(422);
      expect((await requestIdentity('GM-100104', { ...identity, legalName: 'X Sdn Bhd' })).body.code).toBe('INVALID_TRANSITION');

      const req = (await requestIdentity('GM-100101', { ...identity, legalName: 'Tanjung Global Trading Berhad' })).body as ChangeRequest;
      expect(req).toMatchObject({ id: 'CR-0001', status: 'pending', scope: 'merchant_profile', changes: [{ label: 'Legal name', from: 'Tanjung Global Trading Sdn Bhd', to: 'Tanjung Global Trading Berhad' }] });
      expect(req).not.toHaveProperty('proposed');
      expect((await requestIdentity('GM-100101', { ...identity, legalName: 'Another Name Berhad' })).body.code).toBe('CHANGE_PENDING');
      expect((await merchant('GM-100101')).merchant.legalName).toBe('Tanjung Global Trading Sdn Bhd');
      expect((await merchant('GM-100101')).pendingChanges.map((c) => c.id)).toEqual(['CR-0001']);
      expect(db().notifications[0]).toMatchObject({ event: 'change_requested', audience: ['risk'], applicationId: '', email: { to: ['risk-review@mobi.xyz'], status: 'simulated' } });

      for (const role of ['sales', 'cs', 'finops'] as StaffRole[]) expect((await decide('CR-0001', 'approve', '', role)).status).toBe(403);
      const submittedBefore = app('APP-2026-0001').submittedProfile;
      const midsBefore = JSON.stringify(db().mids);
      expect((await decide('CR-0001', 'approve', 'Matches the new company register extract')).body.status).toBe('approved');
      const m = await merchant('GM-100101');
      expect(m.merchant.legalName).toBe('Tanjung Global Trading Berhad');
      expect(m.profileEvents[0]).toMatchObject({ action: 'change_approved', requestId: 'CR-0001', role: 'risk', comment: 'Matches the new company register extract' });
      expect(app('APP-2026-0001').submittedProfile).toEqual(submittedBefore); // what Risk reviewed is kept
      expect(JSON.stringify(db().mids)).toBe(midsBefore);
      expect(db().notifications[0]).toMatchObject({ event: 'change_decided', audience: ['sales'] });
    });
  });

  describe('country details', () => {
    it('masks bank account numbers, leaves data unchanged on rejection and applies on approval', async () => {
      const bank = app('APP-2026-0001').data.bank;
      const res = await requestCountry('APP-2026-0001', 'bank', { ...bank, accountNumber: '998877665544' });
      expect(res.status).toBe(201);
      expect(res.body.changes).toEqual([{ field: 'bank.accountNumber', label: 'Account number', from: '•••• 5678', to: '•••• 5544' }]);
      // Everything Phase 4 adds: the request, merchant pending changes and history, the application's
      // change list, approvals, notifications and application history. (Application data itself is
      // returned to staff screens as before and shown masked there.)
      const m = await merchant('GM-100101');
      const exposed = JSON.stringify([res.body, m.pendingChanges, m.profileEvents, (await application('APP-2026-0001')).changes, (await call('GET', '/api/approvals', null, 'risk')).body, db().notifications.slice(0, 2), app('APP-2026-0001').history]);
      expect(exposed).not.toContain('998877665544');
      expect(exposed).not.toContain('514012345678');

      expect((await decide(res.body.id, 'reject', 'short')).status).toBe(422);
      expect((await decide(res.body.id, 'reject', 'Bank letter is not on company letterhead')).body.status).toBe('rejected');
      expect(app('APP-2026-0001').data.bank).toEqual(bank);
      expect(app('APP-2026-0001').history.map((h) => h.action)).toContain(`Change rejected by Risk – Bank / settlement account (${res.body.id})`);

      // A blank account number keeps the current one.
      const rename = await requestCountry('APP-2026-0001', 'bank', { ...bank, bankName: 'CIMB Bank', accountNumber: '' });
      expect(rename.body.changes).toEqual([{ field: 'bank.bankName', label: 'Bank name', from: 'Maybank', to: 'CIMB Bank' }]);
      const snapshot = app('APP-2026-0001').rulesSnapshot;
      expect((await decide(rename.body.id, 'approve')).body.status).toBe('approved');
      expect(app('APP-2026-0001').data.bank).toEqual({ ...bank, bankName: 'CIMB Bank' });
      expect(app('APP-2026-0001').rulesSnapshot).toEqual(snapshot);
      expect(app('APP-2026-0001').history.map((h) => h.action)).toContain(`Bank / settlement account changed – ${rename.body.id} approved by Risk`);
    });

    it('validates each section with the onboarding rules', async () => {
      const bank = app('APP-2026-0001').data.bank;
      expect((await requestCountry('APP-2026-0001', 'bank', { ...bank, accountNumber: '12' })).body.errors).toEqual([expect.objectContaining({ field: 'bank.accountNumber' })]);
      expect((await requestCountry('APP-2026-0009', 'directors', [])).body.errors).toEqual([expect.objectContaining({ field: 'directors' })]);
      const docs = app('APP-2026-0009').data.documents;
      expect((await requestCountry('APP-2026-0009', 'documents', docs.slice(1))).body.errors?.[0].field).toMatch(/^documents\./);
      expect((await requestCountry('APP-2026-0009', 'business', app('APP-2026-0009').data.business)).body.message).toBe('There are no changes to request.');
      expect((await requestCountry('APP-2026-0009', 'pricing', [])).status).toBe(422);
    });

    it('applies approved director, business and document changes', async () => {
      const directors = app('APP-2026-0009').data.directors;
      const d = await requestCountry('APP-2026-0009', 'directors', [{ ...directors[0], ownershipPct: 80 }, { id: 'new', name: 'Anong Chai', nationality: 'Thai', idNumber: '3100500999999', role: 'beneficial_owner', ownershipPct: 20 }]);
      expect(d.body.changes[0].to).toBe('Somchai Prasert (Director & owner, 80%); Anong Chai (Beneficial owner, 20%)');
      await decide(d.body.id, 'approve');
      expect(app('APP-2026-0009').data.directors.map((p) => [p.name, p.ownershipPct])).toEqual([['Somchai Prasert', 80], ['Anong Chai', 20]]);

      const b = await requestCountry('APP-2026-0009', 'business', { ...app('APP-2026-0009').data.business, address: '99 Sukhumvit Road, Bangkok 10110' });
      await decide(b.body.id, 'approve');
      expect(app('APP-2026-0009').data.business.address).toBe('99 Sukhumvit Road, Bangkok 10110');

      const docs = app('APP-2026-0009').data.documents;
      const added = [...docs, { id: 'x1', type: docs[0].type, fileName: 'renewed-affidavit.pdf', sizeKb: 120, uploadedAt: now, sample: false }];
      const doc = await requestCountry('APP-2026-0009', 'documents', added);
      await decide(doc.body.id, 'approve');
      expect(app('APP-2026-0009').data.documents.map((x) => x.fileName)).toContain('renewed-affidavit.pdf');
    });

    it('is available only after Risk approval, only to Sales / Operations', async () => {
      expect((await requestCountry('APP-2026-0011', 'business', {})).body).toMatchObject({ code: 'INVALID_TRANSITION', message: 'This application is still editable; change it directly.' });
      expect((await requestCountry('APP-2026-0013', 'business', {})).body.message).toBe('Changes can be requested once Risk has approved this country.');
      for (const role of ['risk', 'cs', 'finops'] as StaffRole[]) expect((await requestCountry('APP-2026-0001', 'bank', {}, undefined, role)).status).toBe(403);
    });

    it('lets only the requester withdraw, and nothing changes', async () => {
      const bank = app('APP-2026-0001').data.bank;
      const r = (await requestCountry('APP-2026-0001', 'bank', { ...bank, bankName: 'RHB Bank' })).body;
      const other = await login('TANJUNG-ADMIN');
      expect((await call('POST', `/api/changes/${r.id}/withdraw`, {}, 'sales', other)).body.message).toBe('Only the person who made the request can withdraw it.');
      expect((await call('POST', `/api/changes/${r.id}/withdraw`, {})).body.status).toBe('withdrawn');
      expect(app('APP-2026-0001').data.bank).toEqual(bank);
      expect((await decide(r.id, 'approve')).body.code).toBe('INVALID_TRANSITION');
    });

    it('still works for a suspended merchant', async () => {
      await call('POST', '/api/merchants/GM-100101/lifecycle', { action: 'suspend', reason: 'Chargeback ratio above threshold' }, 'risk');
      const r = (await requestCountry('APP-2026-0001', 'bank', { ...app('APP-2026-0001').data.bank, bankName: 'RHB Bank' })).body;
      expect((await decide(r.id, 'approve')).body.status).toBe('approved');
    });

    it('leaves MIDs, entities, MCC, products and pricing untouched', async () => {
      await call('PUT', '/api/applications/APP-2026-0009/products', { products: [{ methodCode: 'TH_PROMPTPAY', enabled: true }, { methodCode: 'TH_CARDS', enabled: true }, { methodCode: 'TH_TRUEMONEY', enabled: true }], settlement: { TH_CARDS: 'T+1' }, revision: 0 }, 'sales');
      const keep = () => JSON.stringify({ mids: db().mids, entities: db().entities, mcc: db().merchants.map((m) => m.mcc ?? null), products: db().productConfigs, pricing: db().pricingVersions });
      const before = keep();
      const r = (await requestCountry('APP-2026-0009', 'business', { ...app('APP-2026-0009').data.business, website: 'https://bangkokbites.example/th' })).body;
      await decide(r.id, 'approve');
      expect(keep()).toBe(before);
    });
  });

  describe('Approvals page', () => {
    it('shows each team what waits for it, and recent decisions', async () => {
      const bank = (await requestCountry('APP-2026-0001', 'bank', { ...app('APP-2026-0001').data.bank, bankName: 'RHB Bank' })).body;
      const pricing = (await call<any>('POST', '/api/applications/APP-2026-0009/pricing', { methodCode: 'TH_CARDS', mdrPct: 2.4 }, 'sales')).body.version;
      const d = db();
      d.mccRequests = [{ id: 'MCR-0001', merchantId: 'GM-100105', previous: null, proposed: { code: '5814', description: 'TEST – Fast food restaurants' }, reason: 'Menu change', restrictedIn: [], requestedBy: 'Sarah Lim', requestedRole: 'sales', requestedAt: now, status: 'pending', decidedBy: null, decidedRole: null, decidedAt: null, decisionComment: null }];
      storage.setItem(KEY, JSON.stringify(d));

      const view = async (role: StaffRole) => (await call<ApprovalsView>('GET', '/api/approvals', null, role)).body;
      const risk = await view('risk');
      expect(risk).toMatchObject({ heading: 'Waiting for Risk', canDecide: true });
      expect(risk.pending.map((i) => `${i.kind}:${i.id}`)).toEqual([`change:${bank.id}`, 'mcc:MCR-0001']);
      expect(risk.pending[0]).toMatchObject({ link: ['/applications', 'APP-2026-0001'], summary: 'Bank name: Maybank → RHB Bank' });
      const finops = await view('finops');
      expect(finops.pending.map((i) => `${i.kind}:${i.id}`)).toEqual([`pricing:${pricing.id}`]);
      expect(finops.pending[0].link).toEqual(['/applications', 'APP-2026-0009', 'products']);
      expect((await view('sales')).pending).toHaveLength(3);
      expect((await view('sales')).canDecide).toBe(false);
      expect((await view('cs')).pending).toHaveLength(3);

      await decide(bank.id, 'reject', 'Bank letter is not on company letterhead');
      const after = await view('risk');
      expect(after.pending.map((i) => i.id)).toEqual(['MCR-0001']);
      expect(after.recent[0]).toMatchObject({ id: bank.id, status: 'rejected' });
    });
  });
});

