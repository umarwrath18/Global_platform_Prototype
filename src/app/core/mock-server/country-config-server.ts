import { CountryConfigChange, CountryConfigDetail, CountryConfigView, describeConfigChanges, readCountryConfigInput } from '../merchants/country-config';
import { MerchantApiError, MerchantApiErrorCode, StaffRole } from '../merchants/merchant-models';
import { applyCountryConfigs, CountryOnboardingConfig, defaultCountryConfig, ONBOARDING_COUNTRIES, resetCountryConfigs } from '../merchants/onboarding-config';
import { AuthBridge, Caller, ServerReply } from './merchant-server';

// Simulated Country Configuration backend (MVP feature 5). Stored under its own key so it never
// touches merchant or auth data. Editing is limited to the existing Sales / Operations team, taken
// from the prototype's "View as" header like every other merchant action. Each change needs a
// reason and is recorded in the change history.

/** The only team that may change country configuration. */
export const COUNTRY_CONFIG_EDITOR: StaffRole = 'sales';

// 2: directors rules carry the ID label; ownership threshold removed. Older configuration is reset to the defaults.
const DB_VERSION = 2;

interface StoredCountry {
  config: CountryOnboardingConfig;
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

interface CountryConfigDb {
  version: number;
  countries: Record<string, StoredCountry>;
  history: CountryConfigChange[];
}

export interface CountryConfigServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey?: string;
  now?: () => number;
  auth: Pick<AuthBridge, 'authenticate'>;
}

class ApiError {
  constructor(
    readonly status: number,
    readonly body: MerchantApiError,
  ) {}
}

const fail = (status: number, code: MerchantApiErrorCode, extra: Omit<MerchantApiError, 'code'> = {}): never => {
  throw new ApiError(status, { code, ...extra });
};

export class CountryConfigServer {
  private readonly storageKey: string;
  private readonly now: () => number;

  constructor(private readonly opts: CountryConfigServerOptions) {
    this.storageKey = opts.storageKey ?? 'mobi.gp.countryconfig';
    this.now = opts.now ?? Date.now;
  }

  static handles(path: string) {
    return /^\/api\/config\/countries(\/|\?|$)/.test(path);
  }

  async handle(method: string, path: string, body: any, token: string | null, roleHeader: string | null = null): Promise<ServerReply> {
    const auth = await this.opts.auth.authenticate(token);
    if (!auth.ok) return auth.response;
    const caller = auth.caller;
    const role = roleHeader as StaffRole | null;
    try {
      const code = path.split('?')[0].split('/').filter(Boolean)[3]?.toUpperCase();
      const m = method.toUpperCase();
      if (!code && m === 'GET') return ok(this.list());
      if (code && m === 'GET') return ok(this.detail(code, role));
      if (code && m === 'PUT') return ok(this.update(code, body, caller, role));
      return fail(404, 'NOT_FOUND');
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: e.body };
      throw e;
    }
  }

  /** Loads the stored configuration into the live onboarding rules. The merchant server calls this per request. */
  sync() {
    applyCountryConfigs(Object.values(this.load().countries).map((c) => c.config));
  }

  async resetAll() {
    this.opts.storage.removeItem(this.storageKey);
    resetCountryConfigs();
    this.sync();
  }

  private list(): CountryConfigView[] {
    return Object.values(this.load().countries).map((c) => this.view(c));
  }

  private detail(code: string, role: StaffRole | null): CountryConfigDetail {
    const db = this.load();
    const c = this.find(db, code);
    return { ...this.view(c), history: db.history.filter((h) => h.country === code), canEdit: role === COUNTRY_CONFIG_EDITOR };
  }

  private update(code: string, body: any, caller: Caller, role: StaffRole | null): CountryConfigView {
    if (role !== COUNTRY_CONFIG_EDITOR) {
      fail(403, 'PERMISSION_REQUIRED', { message: 'Only Sales / Operations can change country configuration.' });
    }
    const db = this.load();
    const c = this.find(db, code);
    if (body?.version !== c.version) {
      fail(409, 'CONFIG_CONFLICT', { message: `${c.config.name} was changed by ${c.updatedBy ?? 'someone else'} after you opened it. Reload to see the latest rules.` });
    }
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    const { input, errors } = readCountryConfigInput(c.config, body);
    if (reason.length < 5) errors.push({ section: 'business', field: 'reason', message: 'Enter a reason with at least 5 characters.' });
    if (errors.length) fail(422, 'VALIDATION_FAILED', { errors, message: `${errors.length} item${errors.length === 1 ? '' : 's'} must be fixed before saving.` });
    const changes = describeConfigChanges(c.config, input);
    if (!changes.length) fail(422, 'VALIDATION_FAILED', { message: 'There are no changes to save.' });

    const at = this.now();
    c.config = { ...c.config, ...input };
    c.version += 1;
    c.updatedAt = at;
    c.updatedBy = caller.name;
    db.history.unshift({ at, country: code, by: caller.name, role: COUNTRY_CONFIG_EDITOR, reason, changes, version: c.version });
    db.history = db.history.slice(0, 500);
    this.save(db);
    this.sync();
    return this.view(c);
  }

  private view(c: StoredCountry): CountryConfigView {
    return { config: c.config, onboardingEnabled: c.config.onboardingEnabled !== false, version: c.version, updatedAt: c.updatedAt, updatedBy: c.updatedBy };
  }

  private find(db: CountryConfigDb, code: string): StoredCountry {
    return db.countries[code] ?? fail(404, 'NOT_FOUND', { message: `No configuration for country ${code}.` });
  }

  // Re-read on every request so changes made in another tab apply immediately.
  private load(): CountryConfigDb {
    const raw = this.opts.storage.getItem(this.storageKey);
    let db: CountryConfigDb | null = raw ? JSON.parse(raw) : null;
    if (db?.version !== DB_VERSION) db = { version: DB_VERSION, countries: {}, history: [] };
    // Countries without stored changes use the shipped defaults.
    let added = false;
    for (const code of Object.keys(ONBOARDING_COUNTRIES)) {
      if (db.countries[code]) continue;
      db.countries[code] = { config: { ...defaultCountryConfig(code)!, onboardingEnabled: true }, version: 1, updatedAt: null, updatedBy: null };
      added = true;
    }
    if (added || !raw) this.save(db);
    return db;
  }

  private save(db: CountryConfigDb) {
    this.opts.storage.setItem(this.storageKey, JSON.stringify(db));
  }
}

const ok = (body: unknown, status = 200): ServerReply => ({ status, body });
