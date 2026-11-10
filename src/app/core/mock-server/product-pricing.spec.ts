import { beforeEach, describe, expect, it } from 'vitest';
import { CountryApplication, StaffRole } from '../merchants/merchant-models';
import { addDays, PricingApprovalsView, PricingAuditEvent, PricingDraft, PricingVersion, ProductPricingView, todayIso } from '../merchants/products';
import { AuthServer } from './auth-server';
import { MerchantDb, MerchantServer } from './merchant-server';
import { completeProductConfig, FlakyStorage, percentageDraft } from './testing/merchant-test-data';
import { signIn } from './testing/sign-in';

const KEY = 'mobi.gp.merchantdb';
const DAY = 24 * 60 * 60_000;

// Seed:
// - APP-2026-0010 (Malaysia, GM-100105) is in Product & Payment Config (onboarding mode): Cards,
//   DuitNow QR and Touch 'n Go are switched on and priced (Percentage v1), with no settlement yet.
// - APP-2026-0009 (Indonesia: VA, QRIS, DANA) and APP-2026-0007 (Vietnam) are past "Confirm
//   onboarding" (change mode), with their products priced and settled T+1.
// - APP-2026-0001 (Tanjung, Malaysia, operational) has a pending Cards change (v2) from Sales.
// - APP-2026-0012 (Lumi, Malaysia) is still with Risk (read only).

type Result = { version: PricingVersion; view: ProductPricingView };

describe('Product & Payment Config', () => {
  let now: number;
  let storage: FlakyStorage;
  let auth: AuthServer;
  let server: MerchantServer;
  let guided: MerchantServer;
  let maker: string; // 123 · Sarah Lim
  let checker: string; // TANJUNG-ADMIN · Aisyah Rahman

  const callOn = (s: MerchantServer, token = () => maker) => <T = any>(method: string, path: string, body: unknown = null, role: StaffRole = 'sales') => s.handle(method, path, body, token(), role) as Promise<{ status: number; body: T }>;
  let call: ReturnType<typeof callOn>;
  let asChecker: ReturnType<typeof callOn>;
  const view = async (id: string, role: StaffRole = 'cs') => (await call<ProductPricingView>('GET', `/api/applications/${id}/products`, null, role)).body;
  const save = async (id: string, role: StaffRole, change: { on?: string[]; off?: string[]; settlement?: Record<string, string>; confirm?: boolean; revision?: number }) => {
    const v = await view(id, role);
    const products = v.config.products.map((p) => ({ methodCode: p.methodCode, enabled: change.on?.includes(p.methodCode) ? true : change.off?.includes(p.methodCode) ? false : p.enabled }));
    return call<any>('PUT', `/api/applications/${id}/products`, { products, settlement: { ...v.config.settlement, ...change.settlement }, revision: change.revision ?? v.config.revision, confirmCancelPricing: change.confirm }, role);
  };
  const price = (id: string, role: StaffRole, draft: PricingDraft, editOf: string | null = null) => call<Result & { message?: string; code?: string; errors?: any[] }>('POST', `/api/applications/${id}/pricing`, { draft, editOf }, role);
  const today = () => todayIso(now);
  const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
  const app = (id: string) => db().applications.find((a) => a.id === id)!;
  const actions = (id: string) => app(id).history.map((h) => h.action);
  const versions = (id: string, code?: string) => (db().pricingVersions ?? []).filter((v) => v.applicationId === id && (!code || v.methodCode === code));
  /** A fresh code from the checker's authenticator (moves past the code used at sign-in). */
  const code = async (token = checker) => {
    now += 31_000;
    return (await auth.demoAuthenticator('session', token))!.code;
  };
  const decide = async (id: string, vid: string, decision: 'approve' | 'reject', reason = '', c?: string) =>
    asChecker<any>('POST', `/api/applications/${id}/pricing/${vid}/decision`, { decision, reason, code: c ?? (await code()) }, 'finops');

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 10, 9);
    storage = new FlakyStorage();
    auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    server = new MerchantServer({ storage, now: () => now, auth });
    guided = new MerchantServer({ storage, now: () => now, auth, strictValidation: () => false });
    maker = await signIn(auth, '123');
    now += 31_000;
    checker = await signIn(auth, 'TANJUNG-ADMIN');
    call = callOn(server);
    asChecker = callOn(server, () => checker);
    await call('GET', '/api/merchants');
  });

  it('routes the pricing queue and audit log to the merchant server', () => {
    expect(MerchantServer.handles('/api/pricing/approvals')).toBe(true);
    expect(MerchantServer.handles('/api/pricing/audit')).toBe(true);
  });

  describe('catalog and modes', () => {
    it('offers the corridor catalog, PayIn and PayOut (§3.3)', async () => {
      const names = async (id: string) => (await view(id)).methods.map((m) => `${m.flow}:${m.name}`);
      expect(await names('APP-2026-0010')).toEqual(['payin:FPX', 'payin:DuitNow QR', "payin:Touch 'n Go", 'payin:GrabPay', 'payin:Cards', 'payout:Bank Transfer']);
      expect(await names('APP-2026-0009')).toEqual(['payin:Virtual Account', 'payin:QRIS', 'payin:DANA', 'payin:OVO', 'payout:Bank Transfer']);
      expect(await names('APP-2026-0007')).toEqual(['payin:VietQR', 'payin:MoMo', 'payin:ZaloPay', 'payin:Bank Transfer', 'payout:Bank Transfer']);
    });

    it('derives the mode and notice from the MID state and the acting team (§8.1)', async () => {
      expect(await view('APP-2026-0010', 'cs')).toMatchObject({ mode: 'onboarding', notice: 'Switch on the products this MID will offer, then set pricing for each one. During onboarding, pricing applies as soon as it is saved – no FinOps approval.', can: { editProducts: true, editPricing: true, decidePricing: false } });
      expect((await view('APP-2026-0010', 'sales')).notice).toBe('CS sets pricing while reviewing this MID.');
      expect(await view('APP-2026-0009', 'sales')).toMatchObject({ mode: 'change', notice: 'Onboarding is confirmed. Pricing changes create a new version that needs FinOps approval; the current pricing stays in effect until then.', can: { editPricing: true } });
      expect(await view('APP-2026-0009', 'finops')).toMatchObject({ notice: 'Onboarding is confirmed. Ops changes pricing from Merchant List → Merchant Pricing, with FinOps approval.', can: { editPricing: false, decidePricing: true } });
      expect(await view('APP-2026-0012', 'cs')).toMatchObject({ mode: 'read_only', notice: 'Pricing is set by CS once the MID is submitted for CS review.' });
      await call('POST', '/api/merchants/GM-100101/lifecycle', { action: 'suspend', reason: 'Chargeback ratio above threshold' }, 'risk');
      expect(await view('APP-2026-0001', 'sales')).toMatchObject({ mode: 'read_only', notice: 'This MID is suspended. Pricing cannot change until it is reactivated.' });
      expect((await price('APP-2026-0001', 'sales', percentageDraft('fpx', 1.1, addDays(today(), 1)))).body.message).toBe('This MID is suspended. Pricing cannot change until it is reactivated.');
    });

    it('enforces who may change what, server-side (MP-2, MP-3, §8.2, §8.3)', async () => {
      expect((await price('APP-2026-0010', 'sales', percentageDraft('fpx', 1, today()))).body.message).toBe('Only CS can set pricing during onboarding.');
      expect((await price('APP-2026-0009', 'cs', percentageDraft('qris', 0.8, addDays(today(), 1)))).body.message).toBe('Only Ops can change pricing after onboarding.');
      expect((await price('APP-2026-0012', 'cs', percentageDraft('fpx', 1, today()))).body.message).toBe('Pricing can be set once the MID is under CS review, and changed after CS confirms it.');
      expect((await save('APP-2026-0010', 'sales', { on: ['fpx'] })).body.message).toBe('Only CS can set products during onboarding.');
      expect((await save('APP-2026-0009', 'cs', { settlement: { qris: 'T+2' } })).body.message).toBe('Only Ops can change settlement after onboarding.');
      expect((await save('APP-2026-0012', 'cs', { on: ['fpx'] })).body.message).toBe('Products can be set once the MID is under CS review.');
    });
  });

  describe('products and settlement', () => {
    it('needs at least one product, and treats products as drafts until saved', async () => {
      expect((await save('APP-2026-0010', 'cs', { off: ['cards', 'duitnow_qr', 'tng'], confirm: true })).body.message).toBe('Switch on at least one product.');
      const res = await save('APP-2026-0010', 'cs', { on: ['fpx', 'bank_transfer_payout'] });
      expect(res.body.message).toBe('Products saved – 5 product(s) switched on.');
      expect(actions('APP-2026-0010')).toContain("Updated products – PayIn: FPX, DuitNow QR, Touch 'n Go, Cards; Payout: Bank Transfer");
    });

    it('during onboarding, switching off cancels active, scheduled and pending pricing after confirmation', async () => {
      const blocked = await save('APP-2026-0010', 'cs', { off: ['tng'] });
      expect(blocked).toMatchObject({ status: 409, body: { code: 'PRICING_WILL_BE_CANCELLED', message: "Switching off Touch 'n Go will cancel its pricing. Continue?" } });
      expect((await save('APP-2026-0010', 'cs', { off: ['tng'], confirm: true })).status).toBe(200);
      expect(versions('APP-2026-0010', 'tng').map((v) => v.status)).toEqual(['cancelled']);
      expect(actions('APP-2026-0010')).toContain('Cancelled pricing v1');
    });

    it('in change mode, refuses to switch off a product with active pricing and cancels scheduled and pending versions', async () => {
      expect((await save('APP-2026-0009', 'sales', { off: ['qris'] })).body).toMatchObject({ code: 'PRODUCT_HAS_ACTIVE_PRICING', message: 'QRIS has active pricing and cannot be switched off after onboarding.' });
      await save('APP-2026-0009', 'sales', { on: ['ovo'] });
      const pending = (await price('APP-2026-0009', 'sales', percentageDraft('ovo', 1.5, addDays(today(), 3)))).body.version;
      expect((await save('APP-2026-0009', 'sales', { off: ['ovo'], confirm: true })).status).toBe(200);
      expect(versions('APP-2026-0009', 'ovo').find((v) => v.id === pending.id)?.status).toBe('cancelled');
    });

    it('saves settlement without creating a pricing version, drops cycles for products switched off, and refuses stale saves', async () => {
      const before = versions('APP-2026-0010').length;
      const res = await save('APP-2026-0010', 'cs', { settlement: { cards: 'T+2' } });
      expect(res.body.message).toBe('Settlement saved – Cards: not set → T+2');
      expect(versions('APP-2026-0010')).toHaveLength(before);
      expect(actions('APP-2026-0010')).toContain('Changed settlement cycle – Cards: not set → T+2');
      expect((await save('APP-2026-0010', 'cs', { on: ['fpx'], settlement: { fpx: 'T+1' } })).body.message).toBe('Switch on and save the product first.');
      expect((await save('APP-2026-0010', 'cs', { settlement: { tng: 'T+1' }, revision: 0 })).body).toMatchObject({ code: 'CONFIG_CONFLICT', message: 'Pricing changed – reload' });
      await save('APP-2026-0010', 'cs', { off: ['cards'], confirm: true });
      expect((await view('APP-2026-0010')).config.settlement).toEqual({});
    });
  });

  describe('onboarding pricing (CS)', () => {
    it('applies at once, versions per scope, and records the audit trail (MP-4, MP-5)', async () => {
      await save('APP-2026-0010', 'cs', { on: ['fpx'] });
      const res = await price('APP-2026-0010', 'cs', percentageDraft('fpx', 1.2, today(), 'payin', { minimumFee: 0.5 }));
      expect(res.status).toBe(201);
      expect(res.body.version).toMatchObject({ status: 'active', version: 1, source: 'onboarding', createdRole: 'cs' });
      expect(actions('APP-2026-0010')).toContain('Set merchant pricing v1 – FPX (PayIn) – Percentage: 1.2% (min MYR 0.5)');
      const audit = (await call<PricingAuditEvent[]>('GET', '/api/pricing/audit')).body[0];
      expect(audit).toMatchObject({ role: 'CS', user: 'Sarah Lim', previous: 'No pricing configured', next: 'Percentage: 1.2% (min MYR 0.5)', status: 'active', methodName: 'FPX' });
    });

    it('supersedes open-ended pricing from a later date, and blocks a hard overlap', async () => {
      const v1 = versions('APP-2026-0010', 'cards')[0];
      const from = addDays(today(), 5);
      const v2 = (await price('APP-2026-0010', 'cs', percentageDraft('cards', 2.4, from))).body.version;
      expect(v2).toMatchObject({ version: 2, status: 'scheduled' });
      expect(versions('APP-2026-0010', 'cards').find((v) => v.id === v1.id)).toMatchObject({ status: 'active', endDate: addDays(from, -1) });
      const overlap = await price('APP-2026-0010', 'cs', percentageDraft('cards', 2.5, addDays(today(), 2), 'payin', { endDate: addDays(today(), 10) }));
      expect(overlap.status).toBe(409);
      expect(overlap.body.message).toMatch(/^Pricing period overlaps with an existing configuration\. Percentage pricing is already configured for PT Rasa Bali Kuliner → Cards from .* Please select a non-overlapping effective period\.$/);
    });

    it('stores every primary method and secondary charge, validated server-side', async () => {
      await save('APP-2026-0010', 'cs', { on: ['fpx', 'grabpay', 'bank_transfer_payout'] });
      const tiers = [{ minVolume: 0, maxVolume: 1_000_000, mdrPct: 1.5, fixedFee: 0 }, { minVolume: 1_000_000, maxVolume: null, mdrPct: 1.0, fixedFee: 0 }];
      const vb = await price('APP-2026-0010', 'cs', percentageDraft('fpx', 0, today(), 'payin', { technique: 'volume_based', mdrPct: null, volumePeriod: 'quarterly', tiers }));
      expect(vb.body.version).toMatchObject({ technique: 'volume_based', volumePeriod: 'quarterly', tiers });
      const usd = await price('APP-2026-0010', 'cs', percentageDraft('bank_transfer_payout', 0, today(), 'payout', { technique: 'fixed_fee', currency: 'USD', fixedFee: 0.25, mdrPct: null }));
      expect(usd.body.version).toMatchObject({ currency: 'USD', usd: { fixedFeeUsd: 0.25, usdExchangeRate: 4.2, localEquivalent: 1.05, localEquivalentCurrency: 'MYR' }, settlementSnapshot: null });
      const subOnly = await price('APP-2026-0010', 'cs', percentageDraft('grabpay', 0, today(), 'payin', { technique: null, mdrPct: null }));
      expect(subOnly.body.message).toBe('If the Primary Pricing Method is not configured, Subscription Fees must be configured.');
      const sub = await price('APP-2026-0010', 'cs', percentageDraft('grabpay', 0, today(), 'payin', { technique: null, mdrPct: null, subscription: { monthlyFee: 99, currency: 'MYR' } }));
      expect(sub.body.version).toMatchObject({ technique: null, subscription: { monthlyFee: 99, currency: 'MYR' } });
      const tooHigh = await price('APP-2026-0010', 'cs', percentageDraft('cards', 12, addDays(today(), 3)));
      expect(tooHigh.body.errors!.map((e: any) => e.message)).toEqual(['MDR % cannot be more than 10%']);
    });

    it('applies the VA bank overlap rule for Indonesia Virtual Account', async () => {
      // APP-2026-0009 is in change mode; use a new Indonesian MID in onboarding.
      const m = (await call<any>('POST', '/api/merchants', { legalName: 'PT Va Test', registrationCountry: 'ID', registrationNumber: '9120001234111', primaryContact: { name: 'A', email: 'a@va.test', phone: '+62 21 000 0001' } })).body;
      const id = (await call<CountryApplication>('POST', `/api/merchants/${m.id}/applications`, { country: 'ID' })).body.id;
      const d = db();
      Object.assign(d.applications.find((a) => a.id === id)!, { status: 'cs_configuration' });
      storage.setItem(KEY, JSON.stringify(d));
      await save(id, 'cs', { on: ['va'] });
      expect((await price(id, 'cs', percentageDraft('va', 0.9, today(), 'payin', { vaBanks: ['va_bca'] }))).status).toBe(201);
      expect((await price(id, 'cs', percentageDraft('va', 1.0, today(), 'payin', { vaBanks: ['va_bni'] }))).status).toBe(201);
      expect((await price(id, 'cs', percentageDraft('va', 1.1, today(), 'payin', { vaBanks: [] }))).status).toBe(409);
    });

    it('lets CS cancel active, scheduled or pending pricing during onboarding (MP-9)', async () => {
      const v1 = versions('APP-2026-0010', 'tng')[0];
      const res = await call<Result>('POST', `/api/applications/APP-2026-0010/pricing/${v1.id}/cancel`, {}, 'cs');
      expect(res.body.version.status).toBe('cancelled');
      expect((await call('POST', `/api/applications/APP-2026-0010/pricing/${v1.id}/cancel`, {}, 'cs')).body.message).toBe('Only active, scheduled or pending pricing can be cancelled.');
    });
  });

  describe('change mode (Ops, FinOps approval)', () => {
    it('submits a new version for FinOps, keeping the current pricing in effect (MP-6)', async () => {
      const res = await price('APP-2026-0009', 'sales', percentageDraft('qris', 0.8, addDays(today(), 1)));
      expect(res.body.version).toMatchObject({ status: 'pending_approval', version: 2, source: 'change', settlementSnapshot: 'T+1' });
      expect(versions('APP-2026-0009', 'qris')[0].status).toBe('active');
      expect(actions('APP-2026-0009')).toContain('Submitted pricing change v2 for FinOps approval');
      expect(db().notifications[0]).toMatchObject({ event: 'pricing_approval_requested', audience: ['finops'] });
      // Edit and another submission are blocked while a version is pending.
      expect((await price('APP-2026-0009', 'sales', percentageDraft('qris', 0.9, addDays(today(), 2)))).body.code).toBe('PRICING_PENDING');
      expect((await price('APP-2026-0009', 'sales', percentageDraft('qris', 0.9, addDays(today(), 2)), versions('APP-2026-0009', 'qris')[0].id)).body.message).toBe('This pricing has a change waiting for FinOps approval.');
    });

    it('edits keep the technique and scope, default to tomorrow and make v+1', async () => {
      const active = versions('APP-2026-0009', 'qris')[0];
      const wrong = await price('APP-2026-0009', 'sales', percentageDraft('qris', 0, addDays(today(), 1), 'payin', { technique: 'fixed_fee', fixedFee: 1, mdrPct: null }), active.id);
      expect(wrong.body.message).toBe('The pricing method (Percentage) cannot be changed.');
      const ok = await price('APP-2026-0009', 'sales', percentageDraft('qris', 0.75, addDays(today(), 1)), active.id);
      expect(ok.body.version).toMatchObject({ version: 2, editOf: active.id, technique: 'variable_rate' });
    });

    it('needs a different person, FinOps and a current authenticator code to approve (maker ≠ checker)', async () => {
      const v = (await price('APP-2026-0009', 'sales', percentageDraft('qris', 0.8, today()))).body.version;
      // The maker can't approve their own change, even as FinOps.
      const own = await call<any>('POST', `/api/applications/APP-2026-0009/pricing/${v.id}/decision`, { decision: 'approve', code: await code(maker) }, 'finops');
      expect(own.body.message).toBe('You submitted this pricing change, so someone else must approve or reject it.');
      expect((await asChecker('POST', `/api/applications/APP-2026-0009/pricing/${v.id}/decision`, { decision: 'approve', code: await code() }, 'sales')).body.message).toBe('Only FinOps can approve pricing changes.');
      expect((await decide('APP-2026-0009', v.id, 'approve', '', '000000')).body.code).toMatch(/MFA_CODE_INVALID|MFA_CODE_REUSED/);
      expect(versions('APP-2026-0009', 'qris').find((x) => x.id === v.id)?.status).toBe('pending_approval');

      const approved = await decide('APP-2026-0009', v.id, 'approve');
      expect(approved.body.version).toMatchObject({ status: 'active', approvedBy: 'Aisyah Rahman' });
      expect(versions('APP-2026-0009', 'qris').find((x) => x.version === 1)?.status).toBe('expired');
      expect(actions('APP-2026-0009')).toContain('FinOps approved pricing change v2');
      expect((await decide('APP-2026-0009', v.id, 'approve')).body.message).toBe('This pricing change is not awaiting approval.');
      const audit = (await call<PricingAuditEvent[]>('GET', '/api/pricing/audit')).body[0];
      expect(audit).toMatchObject({ role: 'Finance', user: 'Aisyah Rahman', previous: 'Pending Approval', next: 'Percentage: 0.8%', status: 'active' });
    });

    it('schedules an approval with a future start, and the daily job activates it', async () => {
      const from = addDays(today(), 2);
      const res = await price('APP-2026-0009', 'sales', percentageDraft('dana', 1.2, from));
      const v = res.body.version;
      expect((await decide('APP-2026-0009', v.id, 'approve')).body.version.status).toBe('scheduled');
      expect(versions('APP-2026-0009', 'dana').find((x) => x.version === 1)).toMatchObject({ status: 'active', endDate: addDays(from, -1) });
      now += 3 * DAY;
      maker = await signIn(auth, '123');
      await call('GET', '/api/merchants');
      const after = (await view('APP-2026-0009', 'sales')).versions.filter((x) => x.methodCode === 'dana').map((x) => [x.version, x.status]);
      expect(after).toEqual([[2, 'active'], [1, 'expired']]);
    });

    it('rejects only with a reason and keeps the current pricing (MP-8)', async () => {
      const v = (await price('APP-2026-0009', 'sales', percentageDraft('va', 1.4, addDays(today(), 1)))).body.version;
      expect((await decide('APP-2026-0009', v.id, 'reject', '')).body.message).toBe('A rejection reason is required.');
      const rejected = await decide('APP-2026-0009', v.id, 'reject', 'Below our floor for VA');
      expect(rejected.body.version).toMatchObject({ status: 'rejected', rejectionReason: 'Below our floor for VA' });
      expect(versions('APP-2026-0009', 'va').find((x) => x.version === 1)?.status).toBe('active');
      expect(actions('APP-2026-0009')).toContain('FinOps rejected pricing change v2');
      expect((await call<PricingAuditEvent[]>('GET', '/api/pricing/audit')).body[0]).toMatchObject({ next: 'Rejected', reason: 'Below our floor for VA' });
    });

    it('lets Ops cancel scheduled or pending pricing only, never active (MP-9)', async () => {
      const active = versions('APP-2026-0009', 'qris')[0];
      expect((await call('POST', `/api/applications/APP-2026-0009/pricing/${active.id}/cancel`, {}, 'sales')).body.message).toBe('You cannot cancel this pricing at this stage.');
      const pending = (await price('APP-2026-0009', 'sales', percentageDraft('qris', 0.8, addDays(today(), 1)))).body.version;
      expect((await call<Result>('POST', `/api/applications/APP-2026-0009/pricing/${pending.id}/cancel`, {}, 'sales')).body.version.status).toBe('cancelled');
    });

    it('lists pending and decided changes for FinOps, with current vs proposed (§8.7)', async () => {
      const q = (await asChecker<PricingApprovalsView>('GET', '/api/pricing/approvals', null, 'finops')).body;
      expect(q.canDecide).toBe(true);
      expect(q.pending.map((i) => [i.merchantName, i.methodName, i.current, i.proposed, i.ownSubmission])).toEqual([['Tanjung Global Trading Sdn Bhd', 'Cards', 'Percentage: 2.2% (v1)', 'Higher of Percentage or Fixed Fee: 2% + Min: MYR 0.5', false]]);
      await decide('APP-2026-0001', q.pending[0].version.id, 'approve');
      const after = (await asChecker<PricingApprovalsView>('GET', '/api/pricing/approvals', null, 'finops')).body;
      expect([after.pending.length, after.decided.length]).toEqual([0, 1]);
      expect((await call<PricingApprovalsView>('GET', '/api/pricing/approvals', null, 'sales')).body.canDecide).toBe(false);
    });
  });

  describe('Confirm onboarding gate (§8.8)', () => {
    const confirm = (s = call) => s<any>('POST', '/api/applications/APP-2026-0010/readiness', { action: 'confirm_onboarding' }, 'cs');

    it('names each blocking item in strict and guided mode, then confirms and issues the keys', async () => {
      for (const s of [call, callOn(guided)]) {
        const res = await confirm(s);
        expect(res).toMatchObject({ status: 409, body: { code: 'PRODUCT_CONFIG_INCOMPLETE', message: "Set a settlement cycle for every PayIn product before confirming: DuitNow QR, Touch 'n Go, Cards." } });
      }
      expect((await call<any>('GET', '/api/applications/APP-2026-0010')).body.productGaps.map((g: any) => g.message)).toEqual(["Set a settlement cycle for every PayIn product before confirming: DuitNow QR, Touch 'n Go, Cards."]);
      await save('APP-2026-0010', 'cs', { on: ['fpx'] });
      expect((await confirm()).body.message).toBe("Set pricing for every product before confirming: FPX. Set a settlement cycle for every PayIn product before confirming: FPX, DuitNow QR, Touch 'n Go, Cards.");
      await save('APP-2026-0010', 'cs', { off: ['fpx', 'cards', 'duitnow_qr', 'tng'], confirm: true }).catch(() => null);
      await completeProductConfig(call, 'APP-2026-0010');
      for (const key of ['settlement_account', 'merchant_portal']) await call('POST', '/api/applications/APP-2026-0010/readiness', { action: 'set_item', stage: 'configuration', key, done: true }, 'cs');
      const ok = await confirm();
      expect(ok.body.status).toBe('keys_generated');
      expect(ok.body.readiness.keySet).not.toBeNull();
      expect(actions('APP-2026-0010')).toContain('Onboarding confirmed; production keys generated');
      // Now in change mode: CS can no longer set pricing.
      expect((await view('APP-2026-0010', 'cs')).mode).toBe('change');
    });

    it('reports "Switch on at least one product before confirming." when nothing is on', async () => {
      await call('POST', '/api/applications/APP-2026-0012/review', { decision: 'approve', evidenceReviewed: true }, 'risk');
      await call('POST', '/api/applications/APP-2026-0012/readiness', { action: 'start_configuration' }, 'cs');
      expect((await call<any>('POST', '/api/applications/APP-2026-0012/readiness', { action: 'confirm_onboarding' }, 'cs')).body.message).toBe('Switch on at least one product before confirming.');
      expect((await view('APP-2026-0012')).gapCount).toBe(1);
    });
  });
});
