import { describe, expect, it } from 'vitest';
import { AuthServer } from './auth-server';
import { MerchantDb, MerchantServer } from './merchant-server';
import { signIn } from './testing/sign-in';

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

const KEY = 'mobi.gp.merchantdb';

describe('demo merchants added after the original seed', () => {
  async function setup() {
    const now = Date.UTC(2026, 10, 6);
    const storage = new MemoryStorage();
    const auth = new AuthServer({ storage, now: () => now, pbkdf2Iterations: 1000, sendEmail: () => {} });
    const server = new MerchantServer({ storage, now: () => now, auth });
    const token = await signIn(auth, '123');
    const list = async () => ((await server.handle('GET', '/api/merchants', null, token, 'sales')).body as { id: string }[]).map((m) => m.id);
    const db = () => JSON.parse(storage.getItem(KEY)!) as MerchantDb;
    return { storage, list, db };
  }

  it('adds Nusantara Home Retail once to data that was seeded before it existed, keeping everything else', async () => {
    const { storage, list, db } = await setup();
    await list();
    // Simulate data from the previous build: no addition, plus a merchant the user created.
    const old = db();
    old.merchants = old.merchants.filter((m) => m.id !== 'GM-109001');
    old.applications = old.applications.filter((a) => a.merchantId !== 'GM-109001');
    old.mids = old.mids!.filter((m) => m.gmid !== 'GM-109001');
    old.entities = old.entities!.filter((e) => e.gmid !== 'GM-109001');
    delete old.seedAdditions;
    old.merchants.push({ ...structuredClone(old.merchants[0]), id: 'GM-100109', legalName: 'User Created Sdn Bhd', registrationNumber: '202501000001' });
    storage.setItem(KEY, JSON.stringify(old));

    const ids = await list();
    expect(ids.filter((id) => id === 'GM-109001')).toHaveLength(1);
    expect(ids).toContain('GM-100109');
    expect(db().applications.filter((a) => a.merchantId === 'GM-109001').map((a) => a.status)).toEqual(['operational', 'operational']);
    expect(db().mids!.filter((m) => m.gmid === 'GM-109001')).toHaveLength(2);

    // Never added twice.
    await list();
    expect((await list()).filter((id) => id === 'GM-109001')).toHaveLength(1);
    expect(db().seedAdditions).toEqual(['GM-109001']);
  });
});
