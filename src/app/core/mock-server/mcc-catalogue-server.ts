import { EMPTY_MCC_CATALOGUE, MccCatalogue, MccCatalogueSource, readMccCatalogueEntries } from '../merchants/mcc';
import { AuthBridge, ServerReply } from './merchant-server';
import { MCC_TEST_FIXTURE, MCC_TEST_FIXTURE_NAME, MCC_TEST_FIXTURE_VERSION } from './mcc-test-fixture';

// Simulated MCC catalogue (Phase 2). Stored under its own key. Until a catalogue is loaded on
// purpose the default applies (the app uses the standard ISO 18245 shortlist; tests use none): an approved one when it is supplied, or the labelled test fixture. Signed-in
// users can read it; nobody can edit entries through the portal, because the content must come
// from the approved source.

const DB_VERSION = 1;

interface CatalogueDb {
  version: number;
  catalogue: MccCatalogue;
}

export interface MccCatalogueServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey?: string;
  now?: () => number;
  auth: Pick<AuthBridge, 'authenticate'>;
  /** Used while no catalogue has been loaded. Default: none (MCC is then optional). */
  defaultCatalogue?: MccCatalogue;
}

export class MccCatalogueServer {
  private readonly storageKey: string;
  private readonly now: () => number;

  constructor(private readonly opts: MccCatalogueServerOptions) {
    this.storageKey = opts.storageKey ?? 'mobi.gp.mcccatalogue';
    this.now = opts.now ?? Date.now;
  }

  static handles(path: string) {
    return /^\/api\/config\/mcc(\/|\?|$)/.test(path);
  }

  async handle(method: string, path: string, _body: unknown, token: string | null): Promise<ServerReply> {
    const auth = await this.opts.auth.authenticate(token);
    if (!auth.ok) return auth.response;
    if (method.toUpperCase() === 'GET' && path.split('?')[0] === '/api/config/mcc') return { status: 200, body: this.catalogue() };
    return { status: 404, body: { code: 'NOT_FOUND' } };
  }

  /** The current catalogue; empty when none has been loaded. Reads storage on every call. */
  catalogue(): MccCatalogue {
    const fallback = () => structuredClone(this.opts.defaultCatalogue ?? EMPTY_MCC_CATALOGUE);
    const raw = this.opts.storage.getItem(this.storageKey);
    if (!raw) return fallback();
    try {
      const db = JSON.parse(raw) as CatalogueDb;
      return db.version === DB_VERSION ? db.catalogue : fallback();
    } catch {
      return fallback();
    }
  }

  /** Prototype/QA: loads a catalogue from a supplied list, replacing the current one. Validated first; nothing changes on error. */
  load(entries: unknown, source: { kind: MccCatalogueSource['kind']; name: string; version: string }): string {
    const { entries: valid, errors } = readMccCatalogueEntries(entries);
    if (errors.length) return `Not loaded. ${errors.join(' ')}`;
    if (!source.name.trim() || !source.version.trim()) return 'Not loaded. Give the catalogue source a name and version.';
    const catalogue: MccCatalogue = { source: { ...source, loadedAt: this.now() }, entries: valid };
    this.opts.storage.setItem(this.storageKey, JSON.stringify({ version: DB_VERSION, catalogue } satisfies CatalogueDb));
    return `Loaded ${valid.length} MCC entries from "${source.name}" (${source.version}). Reload the page to see them.`;
  }

  /** Prototype/QA: loads the labelled test fixture. Never loaded automatically. */
  loadTestFixture(): string {
    return this.load(MCC_TEST_FIXTURE, { kind: 'test_fixture', name: MCC_TEST_FIXTURE_NAME, version: MCC_TEST_FIXTURE_VERSION });
  }

  /** Prototype/QA, run by hand only: removes the loaded catalogue. Assigned merchant MCCs are kept. */
  clear(): string {
    this.opts.storage.removeItem(this.storageKey);
    return 'MCC catalogue removed. Merchants keep the MCCs already assigned.';
  }
}
