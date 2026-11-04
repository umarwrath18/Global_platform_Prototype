import { emptyApplicationData } from '../../merchants/application-rules';
import { ApplicationData, CountryApplication, StaffRole } from '../../merchants/merchant-models';
import { ProductPricingView } from '../../merchants/products';
import { ONBOARDING_COUNTRIES } from '../../merchants/onboarding-config';
import { buildMerchantSeed } from '../merchant-seed';
import type { MerchantDb, MerchantRecord } from '../merchant-server';

// Test-only helpers for the merchant data upgrade and go-live retries.

/** In-memory Storage that can be told to fail chosen writes, to simulate quota errors or a crash mid-request. */
export class FlakyStorage {
  readonly data = new Map<string, string>();
  private failures: { key: string; skip: number }[] = [];
  writes: string[] = [];

  getItem = (k: string) => this.data.get(k) ?? null;
  removeItem = (k: string) => void this.data.delete(k);
  setItem = (k: string, v: string) => {
    const i = this.failures.findIndex((f) => f.key === k);
    if (i >= 0) {
      if (this.failures[i].skip === 0) {
        this.failures.splice(i, 1);
        throw new Error(`Simulated storage failure writing ${k}`);
      }
      this.failures[i].skip--;
    }
    this.writes.push(k);
    this.data.set(k, v);
  };

  /** The next write to `key` after `skip` successful ones throws once. */
  failWrite(key: string, skip = 0) {
    this.failures.push({ key, skip });
  }
}

export const FIXTURE_NOW = Date.UTC(2026, 8, 1);
const DAY = 24 * 60 * 60_000;

/**
 * Merchant data as the Phase 0 build stores it (version 2, no schemaRevision), built from the
 * demo seed plus the kinds of records a real browser can hold:
 * - GM-100109: created in the portal, live in MY with a Global Account created at go-live (GA-5001)
 * - GM-100101 suspended, with its lifecycle event
 * - APP-2026-0016: operational but with no go-live event in its history (edited or partial data)
 * - APP-2026-0017: an application for a country that has no region (SG)
 * - APP-2026-0018: a second operational application for GM-100101 in Malaysia
 */
export function v2Fixture(): MerchantDb {
  const db = buildMerchantSeed(FIXTURE_NOW, 2);
  const ago = (d: number) => FIXTURE_NOW - d * DAY;
  const template = db.applications.find((a) => a.id === 'APP-2026-0001')!;
  const clone = (id: string, merchantId: string, country: string, history: CountryApplication['history']): CountryApplication => ({
    ...structuredClone(template),
    id,
    merchantId,
    country,
    demo: false,
    history,
    createdAt: history[0]?.at ?? ago(30),
    updatedAt: history[history.length - 1]?.at ?? ago(30),
  });

  const portal: MerchantRecord = {
    id: 'GM-100109',
    legalName: 'Kedai Runcit Maju Sdn Bhd',
    registrationCountry: 'MY',
    registrationNumber: '202201033333',
    primaryContact: { name: 'Aiman', email: 'aiman@kedai.test', phone: '+60 12 000 1111' },
    linkedAccountId: 'GA-5001',
    createdAt: ago(40),
    updatedAt: ago(10),
    createdBy: 'Hafiz Ismail',
    demo: false,
  };
  db.merchants.push(portal);
  db.applications.push(
    clone('APP-2026-0016', 'GM-100109', 'MY', [
      { at: ago(39), action: 'Application created', by: 'Hafiz Ismail', role: 'sales', fromStatus: null, toStatus: 'draft' },
      { at: ago(12), action: 'Go-live verification started', by: 'Mei Ling Wong', role: 'cs', fromStatus: 'integration', toStatus: 'go_live_verification' },
    ]),
    clone('APP-2026-0017', 'GM-100105', 'SG', [{ at: ago(20), action: 'Application created', by: 'Hafiz Ismail', role: 'sales', fromStatus: null, toStatus: 'draft' }]),
    clone('APP-2026-0018', 'GM-100101', 'MY', [
      { at: ago(50), action: 'Application created', by: 'Hafiz Ismail', role: 'sales', fromStatus: null, toStatus: 'draft' },
      { at: ago(5), action: 'Go-live verified; country is operational', by: 'Mei Ling Wong', role: 'cs', fromStatus: 'go_live_verification', toStatus: 'operational' },
    ]),
  );
  db.applications.find((a) => a.id === 'APP-2026-0016')!.status = 'operational';
  db.applications.find((a) => a.id === 'APP-2026-0017')!.status = 'draft';
  db.applications.find((a) => a.id === 'APP-2026-0018')!.status = 'operational';
  db.seq = { merchant: 100110, application: 19, notification: db.seq.notification };

  const trading = db.merchants.find((m) => m.id === 'GM-100101')!;
  Object.assign(trading, { lifecycleStatus: 'suspended', lifecycleReason: 'Chargeback ratio above threshold', lifecycleUpdatedAt: ago(2), lifecycleUpdatedBy: 'Daniel Tan' });
  db.lifecycleEvents = [{ at: ago(2), action: 'suspended', by: 'Daniel Tan', role: 'risk', reason: 'Chargeback ratio above threshold', fromStatus: 'active', toStatus: 'suspended', merchantId: 'GM-100101' }];
  return db;
}

/** Application data that passes validation for the country (test only). */
export function completeApplicationData(country: string, legalName: string): ApplicationData {
  const cfg = ONBOARDING_COUNTRIES[country];
  const d = emptyApplicationData(country);
  const reg: Record<string, [string, string]> = { MY: ['', ''], ID: ['9120001234567', '012345678901000'], VN: ['0312345678', '0312345678'], TH: ['0105561234567', '0105561234567'], PH: ['CS201912345', '123456789'] };
  d.business = { tradingName: legalName, businessType: cfg.businessTypes[0], merchantCategory: 'merchant', industry: 'Education', website: 'https://example.test', address: '1 Demo Street', localRegistrationNumber: reg[country][0], taxId: reg[country][1], expectedMonthlyVolume: 1000 };
  d.contact = { name: 'Test Person', email: 'test@example.test', phone: '+60 12 345 6789', supportEmail: '' };
  d.bank = Object.fromEntries(cfg.bankFields.map((f) => [f.key, f.key === 'accountNumber' ? '1234567890' : f.key === 'accountName' ? legalName : f.key === 'swiftCode' ? '' : 'Demo']));
  d.directors = [{ id: 'x', name: 'Test Person', nationality: 'Malaysian', idNumber: 'A1', role: 'director_and_owner', ownershipPct: 100 }];
  d.documents = cfg.documents.filter((x) => x.required).map((x, i) => ({ id: `d${i}`, type: x.type, fileName: 'a.pdf', sizeKb: 10, uploadedAt: 0, sample: true }));
  d.pricing = cfg.paymentMethods.map((m, i) => ({ code: m.code, enabled: i === 0, mdr: m.defaultMdr }));
  return d;
}

type Call = (method: string, path: string, body?: unknown, role?: StaffRole) => Promise<{ status: number; body: any }>;

/**
 * Completes Product & Payment Config as Customer Success (test only): keeps the switched-on
 * products (or switches on the first one), gives each PayIn product a T+1 settlement cycle and
 * prices any unpriced product at the method's lowest allowed MDR.
 */
export async function completeProductConfig(call: Call, applicationId: string) {
  const view = (await call('GET', `/api/applications/${applicationId}/products`, null, 'cs')).body as ProductPricingView;
  const anyOn = view.config.products.some((p) => p.enabled);
  const products = view.config.products.map((p, i) => ({ methodCode: p.methodCode, enabled: anyOn ? p.enabled : i === 0 }));
  const settlement = Object.fromEntries(products.filter((p) => p.enabled).map((p) => [p.methodCode, view.config.settlement[p.methodCode] ?? 'T+1']));
  const saved = await call('PUT', `/api/applications/${applicationId}/products`, { products, settlement, revision: view.config.revision }, 'cs');
  if (saved.status !== 200 && saved.body?.message !== 'There are no changes to save.') throw new Error(`Saving products failed: ${JSON.stringify(saved.body)}`);
  const after = (await call('GET', `/api/applications/${applicationId}/products`, null, 'cs')).body as ProductPricingView;
  for (const gap of after.gaps.filter((g) => g.issue === 'pricing')) {
    const method = after.methods.find((m) => m.code === gap.methodCode)!;
    const priced = await call('POST', `/api/applications/${applicationId}/pricing`, { methodCode: method.code, mdrPct: method.minMdr }, 'cs');
    if (priced.status !== 201) throw new Error(`Pricing failed: ${JSON.stringify(priced.body)}`);
  }
}
