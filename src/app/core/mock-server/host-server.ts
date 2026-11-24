import {
  AuthMethod,
  AVAILABILITY_LABEL,
  AvailabilityStatus,
  completionOf,
  enableBlockers,
  HEALTH_STATUS_LABEL,
  Host,
  HOST_ADAPTERS,
  HOST_CODE_RE,
  HOST_TYPES,
  HostActivity,
  HostAuthConfig,
  HostCapability,
  HostCapabilityView,
  HostDetailResponse,
  HostEnvironment,
  HostFieldError,
  HostHealthCheck,
  HostHealthRow,
  HostIntegration,
  HostIntegrationView,
  HostListResponse,
  HostType,
  HostView,
  hostCountries,
  hostMethods,
  integrationFingerprint,
  integrationMissing,
  integrationStatusOf,
  maskReference,
  methodName,
  operationalStatusOf,
  Partner,
  PAYMENT_FLOW_LABEL,
  registrationCountries,
  VALIDATION_RESULT_LABEL,
  validateIntegration,
} from '../hosts/hosts';
import { countryName } from '../merchants/onboarding-config';

/**
 * Host Management (Batch 5A), simulated backend. Hosts, capabilities, integrations, health checks
 * and activity are stored apart (own localStorage key), linked by host ID. Every internal team can
 * view; only Tech Ops (or the prototype admin acting as Tech Ops) can change anything. Enable,
 * disable, maintenance and credential replacement need a current authenticator code.
 *
 * No secrets are ever received or stored: integrations keep an opaque credential reference that
 * this server generates. Validation and health checks are simulated and never contact a provider.
 */

const KEY = 'mobi.gp.hostdb';
const DB_VERSION = 1;

interface HostDb {
  version: number;
  seq: { host: Record<string, number>; any: number };
  partners: Partner[];
  hosts: Host[];
  capabilities: HostCapability[];
  integrations: HostIntegration[];
  health: HostHealthCheck[];
  activity: HostActivity[];
}

export interface HostCaller {
  userId: string;
  name: string;
  team?: string | null;
  readOnly?: boolean;
  merchantId?: string | null;
}

interface Reply {
  status: number;
  body: unknown;
}

export interface HostServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  auth: {
    authenticate(token: string | null, portal?: 'internal' | 'merchant'): Promise<{ ok: true; caller: HostCaller } | { ok: false; response: Reply }>;
    stepUp?(token: string | null, code: unknown): Promise<void>;
  };
  now?: () => number;
}

class HostError {
  constructor(
    readonly status: number,
    readonly body: { code: string; message?: string; errors?: HostFieldError[] },
  ) {}
}
const fail = (status: number, code: string, message?: string, errors?: HostFieldError[]): never => {
  throw new HostError(status, { code, ...(message ? { message } : {}), ...(errors ? { errors } : {}) });
};

interface Who {
  name: string;
  manage: boolean;
  label: string;
}

const AUTH_KEYS: (keyof HostAuthConfig)[] = ['keyHeader', 'signature', 'tokenUrl', 'clientId', 'scope', 'description'];

export class HostServer {
  private readonly now: () => number;

  constructor(private readonly opts: HostServerOptions) {
    this.now = opts.now ?? Date.now;
  }

  static handles(path: string) {
    return /^\/api\/hosts(\/|\?|$)/.test(path);
  }

  async handle(method: string, path: string, body: any, token: string | null, roleHeader: string | null): Promise<Reply> {
    const auth = await this.opts.auth.authenticate(token, 'internal');
    if (!auth.ok) return auth.response;
    try {
      const who = this.who(auth.caller, roleHeader);
      const [rawPath, rawQuery] = path.split('?');
      const q = new URLSearchParams(rawQuery ?? '');
      const [, , id, sub, subId] = rawPath.split('/').filter(Boolean);
      const m = method.toUpperCase();
      if (m === 'GET' && !id) return ok(this.list(who));
      if (m === 'GET' && id === 'health' && !sub) return ok(this.healthRows());
      if (m === 'GET' && id === 'activity' && !sub) return ok(this.allActivity(q));
      if (m === 'POST' && !id) return ok(this.save(who, null, body), 201);
      if (m === 'GET' && id && !sub) return ok(this.detail(who, id));
      if (m === 'PUT' && id && !sub) return ok(this.save(who, id, body));
      if (m === 'POST' && id && sub === 'capabilities' && !subId) return ok(this.addCapability(who, id, body), 201);
      if (m === 'PUT' && id && sub === 'capabilities' && subId) return ok(this.updateCapability(who, id, subId, body));
      if (m === 'POST' && id && sub === 'validate') return ok(this.validate(who, id));
      if (m === 'POST' && id && sub === 'health-check') return ok(this.healthCheck(who, id));
      if (m === 'POST' && id && sub === 'credentials') {
        this.requireManage(who);
        const denied = await this.stepUp(token, body?.code);
        if (denied) return denied;
        return ok(this.replaceCredential(who, id));
      }
      if (m === 'POST' && id && sub === 'status') {
        this.requireManage(who);
        this.checkStatusChange(id, body);
        const denied = await this.stepUp(token, body?.code);
        if (denied) return denied;
        return ok(this.changeStatus(who, id, body));
      }
      return fail(404, 'NOT_FOUND');
    } catch (e) {
      if (e instanceof HostError) return { status: e.status, body: e.body };
      throw e;
    }
  }

  /** Prototype/QA: restores the sample hosts. */
  resetAll() {
    this.opts.storage.removeItem(KEY);
  }

  // ------------------------------------------------------------- access

  private who(caller: HostCaller, roleHeader: string | null): Who {
    if (caller.merchantId) fail(403, 'ROLE_NOT_PERMITTED', 'Merchant users have no access to Host Management.');
    const team = caller.team ?? null;
    const techOps = team === 'techops' || (team === 'admin' && roleHeader === 'techops');
    return { name: caller.name, manage: techOps && !caller.readOnly, label: `${caller.name} (${techOps ? 'Tech Ops' : TEAM_LABEL[team ?? ''] ?? 'Mobi'})` };
  }

  private requireManage(who: Who) {
    if (!who.manage) fail(403, 'ROLE_NOT_PERMITTED', 'Only Tech Ops can change hosts.');
  }

  private async stepUp(token: string | null, code: unknown): Promise<Reply | null> {
    if (!this.opts.auth.stepUp) return fail(503, 'SERVICE_UNAVAILABLE', 'Re-authentication is not available.');
    try {
      await this.opts.auth.stepUp(token, code);
      return null;
    } catch (e: any) {
      if (e && typeof e.status === 'number' && e.body) return { status: e.status, body: e.body };
      throw e;
    }
  }

  // ------------------------------------------------------------- reads

  private list(who: Who): HostListResponse {
    const db = this.load();
    const hosts = db.hosts.map((h) => this.view(db, h)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      hosts,
      partners: db.partners,
      summary: {
        total: hosts.length,
        active: hosts.filter((h) => h.operationalStatus === 'active').length,
        inactive: hosts.filter((h) => h.operationalStatus === 'disabled' || h.operationalStatus === 'maintenance').length,
        attention: hosts.filter((h) => h.operationalStatus === 'attention').length,
      },
      can: { manage: who.manage },
      sampleData: true,
    };
  }

  private detail(who: Who, id: string): HostDetailResponse {
    const db = this.load();
    const host = this.find(db, id);
    const view = this.view(db, host);
    const caps = db.capabilities.filter((c) => c.hostId === host.id);
    const integration = db.integrations.find((i) => i.hostId === host.id) ?? null;
    return {
      host: view,
      capabilities: caps.map(capView),
      integration: integration ? integrationView(integration) : null,
      health: db.health.filter((x) => x.hostId === host.id).sort((a, b) => b.checkedAt - a.checkedAt).slice(0, 20),
      activity: db.activity.filter((a) => a.hostId === host.id).sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id)),
      partner: db.partners.find((p) => p.id === host.associatedPartnerId) ?? null,
      enableBlockers: enableBlockers(host, view.integrationStatus, caps),
      can: { manage: who.manage },
      sampleData: true,
    };
  }

  private healthRows(): HostHealthRow[] {
    const db = this.load();
    return db.hosts
      .map((h) => {
        const v = this.view(db, h);
        const last = v.lastHealth;
        const lastProblem = db.health.filter((x) => x.hostId === h.id && x.status !== 'healthy' && x.status !== 'unknown').sort((a, b) => b.checkedAt - a.checkedAt)[0];
        return {
          hostId: h.id,
          hostName: h.name,
          hostCode: h.hostCode,
          countries: v.markets,
          paymentMethods: v.paymentMethods,
          status: last?.status ?? 'unknown',
          checkedAt: last?.checkedAt ?? null,
          responseTimeMs: last?.responseTimeMs ?? null,
          recentError: last && last.status !== 'healthy' ? last.message : (lastProblem?.message ?? null),
        };
      })
      .sort((a, b) => a.hostName.localeCompare(b.hostName));
  }

  private allActivity(q: URLSearchParams): HostActivity[] {
    const host = q.get('host');
    return this.load()
      .activity.filter((a) => !host || a.hostId === host)
      .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))
      .slice(0, 500);
  }

  private view(db: HostDb, h: Host): HostView {
    const caps = db.capabilities.filter((c) => c.hostId === h.id);
    const integration = db.integrations.find((i) => i.hostId === h.id) ?? null;
    const integrationStatus = integrationStatusOf(integration);
    const lastHealth = db.health.filter((x) => x.hostId === h.id).sort((a, b) => b.checkedAt - a.checkedAt)[0] ?? null;
    const active = caps.filter((c) => c.availabilityStatus !== 'disabled');
    return {
      ...h,
      integrationStatus,
      operationalStatus: operationalStatusOf(h, integrationStatus, lastHealth),
      partnerName: db.partners.find((p) => p.id === h.associatedPartnerId)?.name ?? null,
      markets: [...new Set(caps.map((c) => countryName(c.countryCode)))],
      paymentMethods: [...new Set(active.map((c) => methodName(c.countryCode, c.paymentMethodCode) + (c.paymentFlow === 'payout' ? ' (Payout)' : '')))],
      lastHealth,
      completion: completionOf(h, caps, integrationStatus),
    };
  }

  // ------------------------------------------------------------- create / edit (the four steps)

  private save(who: Who, id: string | null, body: any): HostDetailResponse {
    this.requireManage(who);
    const db = this.load();
    const existing = id ? this.find(db, id) : null;
    const draft = body?.draft === true;
    const errors: HostFieldError[] = [];
    const basic = this.readBasic(db, body?.basic ?? {}, existing, draft, errors);
    const caps = this.readCapabilities(body?.capabilities, draft, errors);
    const integ = this.readIntegration(body?.integration, errors);
    if (errors.length) fail(422, 'VALIDATION_FAILED', `${errors.length} item${errors.length === 1 ? '' : 's'} must be fixed.`, errors);
    const now = this.now();

    let host: Host;
    if (!existing) {
      const country = basic.registrationCountry || 'XX';
      db.seq.host[country] = (db.seq.host[country] ?? 0) + 1;
      host = {
        id: `HST-${country}-${String(db.seq.host[country]).padStart(3, '0')}`,
        ...basic,
        draft,
        // A new host is never operational: Tech Ops enables it once it is verified.
        operationalState: 'disabled',
        maintenance: null,
        disabledReason: null,
        createdAt: now,
        updatedAt: now,
        createdBy: who.label,
        updatedBy: who.label,
        sample: false,
      };
      db.hosts.push(host);
      this.log(db, host, who, draft ? 'Host saved as draft' : 'Host created', `${host.name} (${host.hostCode}) · ${hostTypeName(host.hostType)}`);
    } else {
      host = existing;
      const changed = (Object.keys(basic) as (keyof typeof basic)[]).filter((k) => (host[k] ?? '') !== (basic[k] ?? ''));
      Object.assign(host, basic, { updatedAt: now, updatedBy: who.label });
      if (host.draft && !draft) {
        host.draft = false;
        this.log(db, host, who, 'Host created', 'Draft completed and saved.');
      } else if (changed.length) {
        this.log(db, host, who, 'Host details updated', changed.map((k) => FIELD_LABEL[k] ?? k).join(', '));
      }
    }

    // Capabilities: same country + method keeps its record; new ones are added; removed ones go.
    const current = db.capabilities.filter((c) => c.hostId === host.id);
    for (const c of caps) {
      const same = current.find((x) => x.countryCode === c.countryCode && x.paymentMethodCode === c.paymentMethodCode);
      if (same) {
        if (same.availabilityStatus !== c.availabilityStatus) {
          same.availabilityStatus = c.availabilityStatus;
          same.updatedAt = now;
          this.log(db, host, who, c.availabilityStatus === 'disabled' ? 'Payment method disabled' : 'Payment method updated', `${capLabel(same)} · ${AVAILABILITY_LABEL[c.availabilityStatus]}`);
        }
      } else {
        const rec = this.newCapability(db, host.id, c, now);
        db.capabilities.push(rec);
        if (existing) this.log(db, host, who, 'Payment method added', `${capLabel(rec)} · ${AVAILABILITY_LABEL[rec.availabilityStatus]}`);
      }
    }
    for (const old of current) {
      if (!caps.some((c) => c.countryCode === old.countryCode && c.paymentMethodCode === old.paymentMethodCode)) {
        db.capabilities = db.capabilities.filter((x) => x.id !== old.id);
        this.log(db, host, who, 'Payment method removed', capLabel(old));
      }
    }
    if (!existing && caps.length) this.log(db, host, who, 'Payment methods added', caps.map((c) => `${methodName(c.countryCode, c.paymentMethodCode)} (${countryName(c.countryCode)})`).join(', '));

    // Integration: a credential reference is assigned (simulated) once an auth method is chosen.
    if (integ) {
      let rec = db.integrations.find((i) => i.hostId === host.id);
      const before = rec ? integrationFingerprint(rec) : null;
      if (!rec) {
        rec = { id: this.nextId(db, 'INT'), hostId: host.id, lastValidation: null, credentialReference: null, credentialUpdatedAt: null, credentialUpdatedBy: null, ...integ, updatedAt: now };
        db.integrations.push(rec);
      } else {
        Object.assign(rec, integ, { updatedAt: now });
      }
      if (rec.authenticationType && !rec.credentialReference) {
        rec.credentialReference = this.newReference(db);
        rec.credentialUpdatedAt = now;
        rec.credentialUpdatedBy = who.label;
      }
      if (!rec.authenticationType) rec.credentialReference = null;
      if (before !== integrationFingerprint(rec) || !before) this.log(db, host, who, 'Integration configuration updated', `${rec.integrationName || 'Integration'} · ${rec.environment === 'production' ? 'Production' : 'Sandbox'} · ${integrationMissing(rec).length ? 'incomplete' : 'complete'}`);
    }

    this.saveDb(db);
    return this.detail(who, host.id);
  }

  private readBasic(db: HostDb, b: any, existing: Host | null, draft: boolean, errors: HostFieldError[]) {
    const s = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    const name = s(b.name, 80);
    const hostCode = s(b.hostCode, 20).toUpperCase();
    const hostType = (HOST_TYPES.some((t) => t.id === b.hostType) ? b.hostType : '') as HostType;
    const registrationCountry = registrationCountries().some((c) => c.code === b.registrationCountry) ? String(b.registrationCountry) : '';
    const ownerTeam = s(b.ownerTeam, 80);
    const partnerId = b.associatedPartnerId ? String(b.associatedPartnerId) : null;
    if (!name) errors.push({ field: 'basic.name', message: 'Enter the host name.' });
    if (!hostCode) errors.push({ field: 'basic.hostCode', message: 'Enter a host code.' });
    else if (!HOST_CODE_RE.test(hostCode)) errors.push({ field: 'basic.hostCode', message: 'Use 2–20 letters, numbers, dashes or underscores, starting with a letter or number.' });
    else if (db.hosts.some((h) => h.hostCode === hostCode && h.id !== existing?.id)) errors.push({ field: 'basic.hostCode', message: `${hostCode} is already used by another host. Choose a unique code.` });
    if (partnerId && !db.partners.some((p) => p.id === partnerId)) errors.push({ field: 'basic.associatedPartnerId', message: 'Choose a partner from the list.' });
    if (!draft) {
      if (!hostType) errors.push({ field: 'basic.hostType', message: 'Choose the host type.' });
      if (!registrationCountry) errors.push({ field: 'basic.registrationCountry', message: 'Choose the country of registration.' });
      if (!ownerTeam) errors.push({ field: 'basic.ownerTeam', message: 'Enter the responsible team.' });
    }
    return { name, hostCode, description: s(b.description, 300), hostType: hostType || 'other', associatedPartnerId: partnerId, registrationCountry, ownerTeam, notes: s(b.notes, 1000) };
  }

  private readCapabilities(raw: unknown, draft: boolean, errors: HostFieldError[]) {
    const list = Array.isArray(raw) ? raw.slice(0, 100) : [];
    const out: Pick<HostCapability, 'countryCode' | 'paymentMethodCode' | 'availabilityStatus'>[] = [];
    list.forEach((c: any, i: number) => {
      const country = String(c?.countryCode ?? '');
      const method = String(c?.paymentMethodCode ?? '');
      if (!hostCountries().some((x) => x.code === country)) return void errors.push({ field: `capabilities.${i}`, message: 'Choose a supported country.' });
      if (!hostMethods(country).some((m) => m.code === method)) return void errors.push({ field: `capabilities.${i}`, message: `Choose a payment method configured for ${countryName(country)}.` });
      if (out.some((x) => x.countryCode === country && x.paymentMethodCode === method)) return void errors.push({ field: `capabilities.${i}`, message: `${methodName(country, method)} in ${countryName(country)} is listed twice.` });
      const availability = (['available', 'unavailable', 'disabled'].includes(c?.availabilityStatus) ? c.availabilityStatus : 'available') as AvailabilityStatus;
      out.push({ countryCode: country, paymentMethodCode: method, availabilityStatus: availability });
    });
    if (!draft && !out.length) errors.push({ field: 'capabilities', message: 'Add at least one country and payment method.' });
    return out;
  }

  private readIntegration(raw: any, errors: HostFieldError[]) {
    if (!raw || typeof raw !== 'object') return null;
    const s = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    const adapter = HOST_ADAPTERS.some((a) => a.id === raw.adapterType) ? String(raw.adapterType) : '';
    const environment: HostEnvironment = raw.environment === 'production' ? 'production' : 'sandbox';
    const auth = (['api_key', 'api_key_secret', 'oauth2', 'mtls', 'other'].includes(raw.authenticationType) ? raw.authenticationType : null) as AuthMethod | null;
    const authConfig: HostAuthConfig = {};
    for (const k of AUTH_KEYS) {
      const v = s(raw.authConfig?.[k], 200);
      if (v) authConfig[k] = v;
    }
    let timeout: number | null = null;
    if (raw.timeoutSeconds !== null && raw.timeoutSeconds !== undefined && raw.timeoutSeconds !== '') {
      timeout = Number(raw.timeoutSeconds);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
        errors.push({ field: 'integration.timeoutSeconds', message: 'Enter a whole number of seconds (1–600).' });
        timeout = null;
      }
    }
    // Secrets are never accepted: anything that looks like one is refused, not stored.
    if (raw.secret || raw.apiKey || raw.password || raw.privateKey) errors.push({ field: 'integration', message: 'Secrets are not entered here. Mobi assigns a credential reference.' });
    return {
      integrationName: s(raw.integrationName, 80),
      adapterType: adapter,
      apiBaseUrl: s(raw.apiBaseUrl, 300),
      apiVersion: s(raw.apiVersion, 20),
      environment,
      authenticationType: auth,
      authConfig,
      timeoutSeconds: timeout,
      connectionConfig: s(raw.connectionConfig, 500),
      notes: s(raw.notes, 1000),
    };
  }

  // ------------------------------------------------------------- capabilities

  private addCapability(who: Who, id: string, body: any): HostDetailResponse {
    this.requireManage(who);
    const db = this.load();
    const host = this.find(db, id);
    const errors: HostFieldError[] = [];
    const [c] = this.readCapabilities([body], true, errors);
    if (errors.length) fail(422, 'VALIDATION_FAILED', errors[0].message, errors);
    if (db.capabilities.some((x) => x.hostId === host.id && x.countryCode === c.countryCode && x.paymentMethodCode === c.paymentMethodCode)) {
      fail(409, 'VALIDATION_FAILED', `${methodName(c.countryCode, c.paymentMethodCode)} in ${countryName(c.countryCode)} is already listed.`);
    }
    const rec = this.newCapability(db, host.id, c, this.now());
    db.capabilities.push(rec);
    this.touch(host, who);
    this.log(db, host, who, 'Payment method added', `${capLabel(rec)} · ${AVAILABILITY_LABEL[rec.availabilityStatus]}`);
    this.saveDb(db);
    return this.detail(who, id);
  }

  /** Change one capability's availability. Disabling a method never disables the host. */
  private updateCapability(who: Who, id: string, capId: string, body: any): HostDetailResponse {
    this.requireManage(who);
    const db = this.load();
    const host = this.find(db, id);
    const cap = db.capabilities.find((c) => c.id === capId && c.hostId === host.id) ?? fail(404, 'NOT_FOUND', 'Capability not found.');
    const next = body?.availabilityStatus as AvailabilityStatus;
    if (!['available', 'unavailable', 'disabled'].includes(next)) fail(400, 'VALIDATION_FAILED', 'Choose Available, Unavailable or Disabled.');
    if (cap.availabilityStatus !== next) {
      cap.availabilityStatus = next;
      cap.updatedAt = this.now();
      this.touch(host, who);
      this.log(db, host, who, next === 'disabled' ? 'Payment method disabled' : 'Payment method updated', `${capLabel(cap)} · ${AVAILABILITY_LABEL[next]}`);
      this.saveDb(db);
    }
    return this.detail(who, id);
  }

  // ------------------------------------------------------------- integration actions

  private validate(who: Who, id: string): HostDetailResponse & { validation: { result: string; label: string; messages: string[] } } {
    this.requireManage(who);
    const db = this.load();
    const host = this.find(db, id);
    const integ = db.integrations.find((i) => i.hostId === host.id) ?? fail(409, 'INVALID_TRANSITION', 'Add the integration configuration first.');
    const r = validateIntegration(integ);
    integ.lastValidation = { result: r.result, at: this.now(), by: who.label, messages: r.messages, fingerprint: integrationFingerprint(integ) };
    this.log(db, host, who, 'Configuration validated', `${VALIDATION_RESULT_LABEL[r.result]} (simulated)${r.result === 'valid' ? '' : ': ' + r.messages.join(' ')}`);
    this.saveDb(db);
    return { ...this.detail(who, id), validation: { result: r.result, label: VALIDATION_RESULT_LABEL[r.result], messages: r.messages } };
  }

  /** Simulated: a new opaque reference replaces the old one. No secret is entered or stored. */
  private replaceCredential(who: Who, id: string): HostDetailResponse {
    const db = this.load();
    const host = this.find(db, id);
    const integ = db.integrations.find((i) => i.hostId === host.id) ?? fail(409, 'INVALID_TRANSITION', 'Add the integration configuration first.');
    if (!integ.authenticationType) fail(409, 'INVALID_TRANSITION', 'Choose an authentication method first.');
    const old = maskReference(integ.credentialReference);
    integ.credentialReference = this.newReference(db);
    integ.credentialUpdatedAt = this.now();
    integ.credentialUpdatedBy = who.label;
    integ.updatedAt = this.now();
    this.touch(host, who);
    this.log(db, host, who, 'Credential reference replaced', `${old ?? 'None'} → ${maskReference(integ.credentialReference)} (simulated). Validate the configuration again.`);
    this.saveDb(db);
    return this.detail(who, id);
  }

  /** Simulated connection check. A host whose configuration is incomplete is not checked (Unknown). */
  private healthCheck(who: Who, id: string): HostDetailResponse {
    this.requireManage(who);
    const db = this.load();
    const host = this.find(db, id);
    const integ = db.integrations.find((i) => i.hostId === host.id) ?? null;
    const status = integrationStatusOf(integ);
    const count = db.health.filter((x) => x.hostId === host.id).length;
    let check: Omit<HostHealthCheck, 'id' | 'hostId' | 'checkedAt' | 'by' | 'simulated'>;
    if (status === 'not_configured' || status === 'incomplete') {
      check = { status: 'unknown', responseTimeMs: null, message: 'Not checked: the integration configuration is incomplete.' };
    } else {
      const roll = hash(`${host.id}:${count}`) % 10;
      const timeout = (integ?.timeoutSeconds ?? 30) * 1000;
      check =
        roll === 0
          ? { status: 'unreachable', responseTimeMs: null, message: `No response within ${timeout / 1000} s (simulated).` }
          : roll <= 2
            ? { status: 'degraded', responseTimeMs: 1500 + (hash(`${host.id}:${count}:t`) % 1100), message: 'Slow response, above 1,500 ms (simulated).' }
            : { status: 'healthy', responseTimeMs: 150 + (hash(`${host.id}:${count}:t`) % 300), message: 'OK (simulated).' };
    }
    db.health.push({ id: this.nextId(db, 'HC'), hostId: host.id, checkedAt: this.now(), by: who.label, simulated: true, ...check });
    this.log(db, host, who, 'Health check performed', `${HEALTH_STATUS_LABEL[check.status]}${check.responseTimeMs ? ` · ${check.responseTimeMs} ms` : ''} · simulated, not a live connection test`);
    this.saveDb(db);
    return this.detail(who, id);
  }

  // ------------------------------------------------------------- operational controls

  /** All checks before the authenticator code is asked for. */
  private checkStatusChange(id: string, body: any) {
    const db = this.load();
    const host = this.find(db, id);
    const action = body?.action;
    const reason = String(body?.reason ?? '').trim();
    const view = this.view(db, host);
    const caps = db.capabilities.filter((c) => c.hostId === host.id);
    if (action === 'enable') {
      if (host.operationalState === 'active') fail(409, 'INVALID_TRANSITION', 'The host is already enabled.');
      const blockers = enableBlockers(host, view.integrationStatus, caps);
      if (blockers.length) fail(409, 'INVALID_TRANSITION', blockers.join(' '));
    } else if (action === 'disable') {
      if (host.operationalState === 'disabled') fail(409, 'INVALID_TRANSITION', 'The host is already disabled.');
      if (reason.length < 5) fail(422, 'VALIDATION_FAILED', 'Enter a reason (at least 5 characters).');
      if (body?.confirm !== true) fail(422, 'VALIDATION_FAILED', 'Confirm that the host stops being eligible for routing.');
    } else if (action === 'maintenance') {
      if (host.operationalState !== 'active') fail(409, 'INVALID_TRANSITION', 'Only an active host can be put under maintenance.');
      if (reason.length < 5) fail(422, 'VALIDATION_FAILED', 'Enter a reason (at least 5 characters).');
      if (body?.until !== null && body?.until !== undefined && body?.until !== '') {
        const until = Number(body.until);
        if (!Number.isFinite(until) || until <= this.now()) fail(422, 'VALIDATION_FAILED', 'The expected end must be in the future.');
      }
    } else {
      fail(400, 'VALIDATION_FAILED', 'Choose enable, disable or maintenance.');
    }
  }

  private changeStatus(who: Who, id: string, body: any): HostDetailResponse {
    const db = this.load();
    const host = this.find(db, id);
    const reason = String(body?.reason ?? '').trim().slice(0, 500);
    const now = this.now();
    if (body.action === 'enable') {
      const from = host.operationalState;
      host.operationalState = 'active';
      host.maintenance = null;
      host.disabledReason = null;
      this.log(db, host, who, from === 'maintenance' ? 'Host re-enabled' : 'Host enabled', `${from === 'maintenance' ? 'Maintenance ended. ' : ''}Eligible for routing once Routing Management exists; no routing rules were created.`);
    } else if (body.action === 'disable') {
      host.operationalState = 'disabled';
      host.maintenance = null;
      host.disabledReason = reason;
      this.log(db, host, who, 'Host disabled', `Reason: ${reason}. No traffic is rerouted automatically.`);
    } else {
      const until = body.until ? Number(body.until) : null;
      host.operationalState = 'maintenance';
      host.maintenance = { reason, until, since: now, by: who.label };
      this.log(db, host, who, 'Maintenance started', `Reason: ${reason}${until ? ` · expected end ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`);
    }
    this.touch(host, who);
    this.saveDb(db);
    return this.detail(who, id);
  }

  // ------------------------------------------------------------- helpers

  private find(db: HostDb, id: string): Host {
    return db.hosts.find((h) => h.id === id) ?? fail(404, 'NOT_FOUND', 'Host not found.');
  }

  private touch(host: Host, who: Who) {
    host.updatedAt = this.now();
    host.updatedBy = who.label;
  }

  private newCapability(db: HostDb, hostId: string, c: Pick<HostCapability, 'countryCode' | 'paymentMethodCode' | 'availabilityStatus'>, now: number): HostCapability {
    const method = hostMethods(c.countryCode).find((m) => m.code === c.paymentMethodCode)!;
    const currency = hostCountries().find((x) => x.code === c.countryCode)!.currency;
    return { id: this.nextId(db, 'CAP'), hostId, countryCode: c.countryCode, paymentMethodCode: c.paymentMethodCode, paymentFlow: method.flow, supportedCurrencies: [currency], availabilityStatus: c.availabilityStatus, createdAt: now, updatedAt: now };
  }

  private newReference(db: HostDb): string {
    db.seq.any += 1;
    const tail = hash(`${db.seq.any}:${this.now()}`).toString(36).toUpperCase().padStart(4, '0').slice(-4);
    return `cred_ref_${tail}`;
  }

  private nextId(db: HostDb, prefix: string) {
    db.seq.any += 1;
    return `${prefix}-${String(db.seq.any).padStart(5, '0')}`;
  }

  private log(db: HostDb, host: Host, who: Who | string, action: string, details: string) {
    db.activity.push({ id: this.nextId(db, 'ACT'), hostId: host.id, hostName: host.name, action, performedBy: typeof who === 'string' ? who : who.label, timestamp: this.now(), details });
  }

  private load(): HostDb {
    const raw = this.opts.storage.getItem(KEY);
    if (raw) {
      try {
        const db = JSON.parse(raw) as HostDb;
        if (db.version === DB_VERSION) return db;
      } catch {
        // fall through to a fresh seed
      }
    }
    const db = seed(this.now());
    this.saveDb(db);
    return db;
  }

  private saveDb(db: HostDb) {
    this.opts.storage.setItem(KEY, JSON.stringify(db));
  }
}

// ------------------------------------------------------------------ views

function capView(c: HostCapability): HostCapabilityView {
  return { ...c, countryName: countryName(c.countryCode), paymentMethodName: methodName(c.countryCode, c.paymentMethodCode) };
}

function integrationView(i: HostIntegration): HostIntegrationView {
  const { credentialReference, ...rest } = i;
  return { ...rest, credentialReferenceMasked: maskReference(credentialReference), configurationStatus: integrationStatusOf(i), missing: integrationMissing(i) };
}

function capLabel(c: HostCapability) {
  return `${methodName(c.countryCode, c.paymentMethodCode)} · ${PAYMENT_FLOW_LABEL[c.paymentFlow]} · ${countryName(c.countryCode)}`;
}

const hostTypeName = (t: HostType) => HOST_TYPES.find((x) => x.id === t)?.label ?? t;

const FIELD_LABEL: Record<string, string> = {
  name: 'Host Name',
  hostCode: 'Host Code',
  description: 'Description',
  hostType: 'Host Type',
  associatedPartnerId: 'Associated Partner',
  registrationCountry: 'Country of Registration',
  ownerTeam: 'Internal Owner',
  notes: 'Notes',
};

const TEAM_LABEL: Record<string, string> = { sales: 'Sales / Operations', risk: 'Risk', cs: 'Customer Success', finops: 'FinOps', support: 'Mobi Support', security: 'Security Admin', admin: 'Prototype admin' };

function ok(body: unknown, status = 200): Reply {
  return { status, body };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ------------------------------------------------------------------ sample data (clearly labelled)

const DAY = 86_400_000;
const TECH = 'Wei Ling Tan (Tech Ops)';
const SYSTEM = 'System (simulated)';

/** Sample hosts and partners. Names identify demo records only; none is a live integration. */
function seed(now: number): HostDb {
  const db: HostDb = { version: DB_VERSION, seq: { host: {}, any: 0 }, partners: [], hosts: [], capabilities: [], integrations: [], health: [], activity: [] };
  const id = (p: string) => `${p}-${String(++db.seq.any).padStart(5, '0')}`;
  db.partners = [
    { id: 'PTN-001', name: 'Nusa Payments Partnership', country: 'ID', sample: true },
    { id: 'PTN-002', name: 'Public Bank Berhad', country: 'MY', sample: true },
    { id: 'PTN-003', name: 'Saigon PayLink JSC', country: 'VN', sample: true },
    { id: 'PTN-004', name: 'Mekong Commerce Partners', country: 'VN', sample: true },
  ];
  type SeedHost = {
    code: string;
    name: string;
    type: HostType;
    partner: string | null;
    country: string;
    state: Host['operationalState'];
    desc: string;
    caps: [string, string, AvailabilityStatus][];
    integ: Partial<HostIntegration> | null;
    validated: boolean;
    health: [number, HostHealthCheck['status'], number | null, string][];
    maintenance?: string;
    disabledReason?: string;
  };
  const rest = (url: string, env: HostEnvironment, auth: AuthMethod, cfg: HostAuthConfig, name: string): Partial<HostIntegration> => ({ integrationName: name, adapterType: 'mobi_rest_v1', apiBaseUrl: url, apiVersion: 'v1', environment: env, authenticationType: auth, authConfig: cfg, timeoutSeconds: 30, connectionConfig: 'Callback URL: https://pay.mobi.example/hooks · IP allowlist: 2 addresses', notes: '' });
  const hosts: SeedHost[] = [
    {
      code: 'HARSYA', name: 'HARSYA', type: 'payment_aggregator', partner: 'PTN-001', country: 'ID', state: 'active', desc: 'Indonesian aggregator for virtual accounts, QRIS and e-wallets.',
      caps: [['ID', 'va', 'available'], ['ID', 'qris', 'available'], ['ID', 'ovo', 'available']],
      integ: rest('https://api.harsya.example/v1', 'production', 'oauth2', { tokenUrl: 'https://api.harsya.example/oauth/token', clientId: 'mobi-collections', scope: 'payments' }, 'HARSYA Collections API'), validated: true,
      health: [[3, 'healthy', 284, 'OK (simulated).'], [2, 'healthy', 301, 'OK (simulated).'], [1, 'healthy', 312, 'OK (simulated).']],
    },
    {
      code: 'WINPAY', name: 'WINPAY', type: 'payment_aggregator', partner: 'PTN-001', country: 'ID', state: 'active', desc: 'Virtual accounts and bank payouts in Indonesia.',
      caps: [['ID', 'va', 'available'], ['ID', 'bank_transfer_payout', 'available']],
      integ: rest('https://api.winpay.example/v2', 'production', 'api_key_secret', { keyHeader: 'X-Api-Key', signature: 'HMAC-SHA256' }, 'WINPAY Gateway API'), validated: true,
      health: [[3, 'healthy', 284, 'OK (simulated).'], [2, 'degraded', 2140, 'Slow response, above 1,500 ms (simulated).'], [1, 'unreachable', null, 'No response within 30 s (simulated).']],
    },
    {
      code: 'LINKQU', name: 'LINKQU', type: 'payment_aggregator', partner: null, country: 'ID', state: 'disabled', desc: 'Payout and e-wallet aggregator; sandbox testing in progress.',
      caps: [['ID', 'bank_transfer_payout', 'available'], ['ID', 'dana', 'available'], ['ID', 'va', 'unavailable']],
      integ: rest('https://sandbox.linkqu.example/api', 'sandbox', 'api_key_secret', { keyHeader: 'X-Linkqu-Key', signature: 'HMAC-SHA256' }, 'LINKQU Payout API'), validated: true,
      health: [[1, 'degraded', 1840, 'Slow response, above 1,500 ms (simulated).']], disabledReason: 'Sandbox testing; not ready for production.',
    },
    {
      code: 'PBB', name: 'Public Bank', type: 'bank', partner: 'PTN-002', country: 'MY', state: 'active', desc: 'FPX, card acquiring and bank payouts in Malaysia.',
      caps: [['MY', 'fpx', 'available'], ['MY', 'cards', 'available'], ['MY', 'bank_transfer_payout', 'available']],
      integ: { ...rest('https://h2h.publicbank.example/gateway', 'production', 'mtls', {}, 'Public Bank Host-to-Host'), adapterType: 'mobi_iso8583' }, validated: true,
      health: [[2, 'healthy', 198, 'OK (simulated).'], [1, 'healthy', 205, 'OK (simulated).']],
    },
    {
      code: 'SAIGONPAY', name: 'Saigon PayLink', type: 'payment_gateway', partner: 'PTN-003', country: 'VN', state: 'disabled', desc: 'Vietnam provider for VietQR and MoMo (sample).',
      caps: [['VN', 'vietqr', 'available'], ['VN', 'momo', 'available']],
      integ: { ...rest('https://api.saigonpaylink.example', 'sandbox', 'oauth2', { clientId: 'mobi-vn' }, 'Saigon PayLink API') }, validated: false,
      health: [], disabledReason: 'Integration not finished.',
    },
    {
      code: 'CIMBCOLLECT', name: 'CIMB Collect', type: 'bank', partner: null, country: 'MY', state: 'maintenance', desc: 'DuitNow QR collections in Malaysia.',
      caps: [['MY', 'duitnow_qr', 'available']],
      integ: rest('https://collect.cimb.example/api', 'production', 'api_key', { keyHeader: 'X-Api-Key' }, 'CIMB Collect API'), validated: true,
      health: [[1, 'healthy', 290, 'OK (simulated).']], maintenance: 'Provider certificate rotation announced for tonight.',
    },
  ];
  let i = 0;
  for (const s of hosts) {
    i += 1;
    db.seq.host[s.country] = (db.seq.host[s.country] ?? 0) + 1;
    const hostId = `HST-${s.country}-${String(db.seq.host[s.country]).padStart(3, '0')}`;
    const created = now - (40 - i * 3) * DAY;
    const host: Host = {
      id: hostId, hostCode: s.code, name: s.name, description: s.desc, hostType: s.type, associatedPartnerId: s.partner, registrationCountry: s.country,
      ownerTeam: `Tech Ops – ${countryName(s.country)}`, notes: 'Sample record for the prototype; not a live integration.', draft: false,
      operationalState: s.state, maintenance: s.maintenance ? { reason: s.maintenance, until: now + 0.5 * DAY, since: now - 2 * 3600_000, by: TECH } : null,
      disabledReason: s.disabledReason ?? null, createdAt: created, updatedAt: now - i * 3600_000, createdBy: TECH, updatedBy: TECH, sample: true,
    };
    db.hosts.push(host);
    const act = (at: number, action: string, details: string, by = TECH) => db.activity.push({ id: id('ACT'), hostId, hostName: s.name, action, performedBy: by, timestamp: at, details });
    act(created, 'Host created', `${s.name} (${s.code}) · ${hostTypeName(s.type)}`);
    for (const [country, method, availability] of s.caps) {
      const m = hostMethods(country).find((x) => x.code === method)!;
      db.capabilities.push({ id: id('CAP'), hostId, countryCode: country, paymentMethodCode: method, paymentFlow: m.flow, supportedCurrencies: [hostCountries().find((x) => x.code === country)!.currency], availabilityStatus: availability, createdAt: created, updatedAt: created });
    }
    act(created + 60_000, 'Payment methods added', s.caps.map(([c, m]) => `${methodName(c, m)} (${countryName(c)})`).join(', '));
    if (s.integ) {
      const integ: HostIntegration = {
        id: id('INT'), hostId, integrationName: '', adapterType: 'mobi_rest_v1', apiBaseUrl: '', apiVersion: '', environment: 'sandbox', authenticationType: null, authConfig: {},
        credentialReference: null, credentialUpdatedAt: null, credentialUpdatedBy: null, timeoutSeconds: 30, connectionConfig: '', notes: '', lastValidation: null, updatedAt: created + 2 * DAY, ...s.integ,
      };
      if (s.validated) {
        integ.credentialReference = `cred_ref_${s.code.slice(0, 4)}`;
        integ.credentialUpdatedAt = created + 2 * DAY;
        integ.credentialUpdatedBy = TECH;
        const r = validateIntegration(integ);
        integ.lastValidation = { result: r.result, at: created + 3 * DAY, by: TECH, messages: r.messages, fingerprint: integrationFingerprint(integ) };
      }
      db.integrations.push(integ);
      act(created + 2 * DAY, 'Integration configuration updated', `${integ.integrationName} · ${integ.environment === 'production' ? 'Production' : 'Sandbox'}`);
      if (integ.lastValidation) act(created + 3 * DAY, 'Configuration validated', `${VALIDATION_RESULT_LABEL[integ.lastValidation.result]} (simulated)`);
    }
    if (s.state === 'active' || s.state === 'maintenance') act(created + 4 * DAY, 'Host enabled', 'Eligible for routing once Routing Management exists; no routing rules were created.');
    if (s.state === 'maintenance') act(now - 2 * 3600_000, 'Maintenance started', `Reason: ${s.maintenance}`);
    if (s.state === 'disabled' && s.disabledReason) act(created + 4 * DAY, 'Host disabled', `Reason: ${s.disabledReason}`);
    for (const [hoursAgo, status, ms, message] of s.health) {
      const at = now - hoursAgo * 3600_000;
      db.health.push({ id: id('HC'), hostId, status, responseTimeMs: ms, checkedAt: at, message, by: SYSTEM, simulated: true });
      act(at, 'Health check performed', `${HEALTH_STATUS_LABEL[status]}${ms ? ` · ${ms} ms` : ''} · simulated`, SYSTEM);
    }
  }
  return db;
}
