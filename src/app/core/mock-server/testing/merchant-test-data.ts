import { CountryApplication } from '../../merchants/merchant-models';
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
