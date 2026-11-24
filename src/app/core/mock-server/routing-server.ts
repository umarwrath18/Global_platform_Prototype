import { HostCapability, HostStatus, methodName } from '../hosts/hosts';
import { countryName } from '../merchants/onboarding-config';
import {
  decide,
  DEFAULT_SMART,
  effectiveShares,
  HostOption,
  HostPerformance,
  MerchantOption,
  MerchantOverride,
  OverrideView,
  Route,
  RouteDecision,
  RouteHost,
  RouteMode,
  RouteView,
  RoutingActivity,
  RoutingResponse,
  routeState,
  smartRanking,
} from '../routing/routing';

/**
 * Routing (Batch 5B + 5C), simulated backend. Routes, merchant overrides and the activity log are
 * stored apart (`mobi.gp.routingdb`). Hosts and their payment methods are read live from Host
 * Management, and live merchants from the merchant service, so eligibility is always current.
 * Every internal team can view; only Tech Ops (or the prototype admin acting as Tech Ops) can
 * change anything, each change with an authenticator code. Smart routing's performance figures are
 * generated (simulated) and change every 15 minutes; nothing is sent to a provider.
 */

const KEY = 'mobi.gp.routingdb';
const DB_VERSION = 1;
const PERF_BUCKET_MS = 15 * 60_000;

interface RoutingDb {
  version: number;
  seq: number;
  routes: Route[];
  overrides: MerchantOverride[];
  activity: RoutingActivity[];
}

interface Reply {
  status: number;
  body: unknown;
}

export interface RoutingCaller {
  userId: string;
  name: string;
  team?: string | null;
  readOnly?: boolean;
  merchantId?: string | null;
}

export interface RoutingHostSnapshot {
  hosts: { id: string; name: string; hostCode: string; status: HostStatus }[];
  capabilities: Pick<HostCapability, 'hostId' | 'countryCode' | 'paymentMethodCode' | 'paymentFlow' | 'availabilityStatus'>[];
}

/** A live merchant (or sub-merchant) in one country, with the payment methods switched on for it. */
export interface RoutingMerchantSource {
  gmid: string;
  merchantName: string;
  country: string;
  products: { methodCode: string; methodName: string; flow: 'payin' | 'payout' }[];
  subMerchants: { id: string; name: string }[];
}

export interface RoutingServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  auth: {
    authenticate(token: string | null, portal?: 'internal' | 'merchant'): Promise<{ ok: true; caller: RoutingCaller } | { ok: false; response: Reply }>;
    stepUp?(token: string | null, code: unknown): Promise<void>;
  };
  hosts: () => RoutingHostSnapshot;
  merchants: () => RoutingMerchantSource[];
  now?: () => number;
}

class RoutingError {
  constructor(
    readonly status: number,
    readonly body: { code: string; message?: string; errors?: { field: string; message: string }[] },
  ) {}
}
const fail = (status: number, code: string, message?: string, errors?: { field: string; message: string }[]): never => {
  throw new RoutingError(status, { code, ...(message ? { message } : {}), ...(errors ? { errors } : {}) });
};

interface Who {
  manage: boolean;
  label: string;
}

const MODES: RouteMode[] = ['priority', 'split', 'smart'];

export class RoutingServer {
  private readonly now: () => number;

  constructor(private readonly opts: RoutingServerOptions) {
    this.now = opts.now ?? Date.now;
  }

  static handles(path: string) {
    return /^\/api\/routing(\/|\?|$)/.test(path);
  }

  async handle(method: string, path: string, body: any, token: string | null, roleHeader: string | null): Promise<Reply> {
    const auth = await this.opts.auth.authenticate(token, 'internal');
    if (!auth.ok) return auth.response;
    try {
      const who = this.who(auth.caller, roleHeader);
      const [, , a, b, c] = path.split('?')[0].split('/').filter(Boolean);
      const m = method.toUpperCase();
      if (m === 'GET' && !a) return ok(this.overview(who));
      if (m === 'GET' && a === 'performance') return ok(this.performance());
      if (m === 'GET' && a === 'activity') return ok(this.load().activity.slice().sort((x, y) => y.at - x.at || y.id.localeCompare(x.id)).slice(0, 500));
      if (m === 'POST' && a === 'check') return ok(this.check(body));
      // Changes: every check runs before the authenticator code is asked for.
      if (m === 'PUT' && a === 'routes' && b && c) return await this.guarded(who, token, body, () => this.readRoute(b, c, body), (input) => this.saveRoute(who, b, c, input));
      if (m === 'POST' && a === 'overrides' && !b) return await this.guarded(who, token, body, () => this.readOverride(null, body), (input) => this.saveOverride(who, null, input), 201);
      if (m === 'PUT' && a === 'overrides' && b) return await this.guarded(who, token, body, () => this.readOverride(b, body), (input) => this.saveOverride(who, b, input));
      if (m === 'POST' && a === 'overrides' && b && c === 'remove') return await this.guarded(who, token, body, () => this.findOverride(b), () => this.removeOverride(who, b));
      return fail(404, 'NOT_FOUND');
    } catch (e) {
      if (e instanceof RoutingError) return { status: e.status, body: e.body };
      throw e;
    }
  }

  /** Prototype/QA: restores the sample routes. */
  resetAll() {
    this.opts.storage.removeItem(KEY);
  }

  // ------------------------------------------------------------- access

  private who(caller: RoutingCaller, roleHeader: string | null): Who {
    if (caller.merchantId) fail(403, 'ROLE_NOT_PERMITTED', 'Merchant users have no access to Routing.');
    const team = caller.team ?? null;
    const techOps = team === 'techops' || (team === 'admin' && roleHeader === 'techops');
    return { manage: techOps && !caller.readOnly, label: `${caller.name} (${techOps ? 'Tech Ops' : TEAM_LABEL[team ?? ''] ?? 'Mobi'})` };
  }

  private async guarded<T>(who: Who, token: string | null, body: any, check: () => T, run: (input: T) => unknown, status = 200): Promise<Reply> {
    if (!who.manage) fail(403, 'ROLE_NOT_PERMITTED', 'Only Tech Ops can change routing.');
    const input = check();
    if (!this.opts.auth.stepUp) fail(503, 'SERVICE_UNAVAILABLE', 'Re-authentication is not available.');
    try {
      await this.opts.auth.stepUp!(token, body?.code);
    } catch (e: any) {
      if (e && typeof e.status === 'number' && e.body) return { status: e.status, body: e.body };
      throw e;
    }
    return ok(run(input), status);
  }

  // ------------------------------------------------------------- reads

  private overview(who: Who): RoutingResponse {
    const db = this.load();
    const snap = this.opts.hosts();
    const merchants = this.merchantOptions();
    const combos = new Map<string, { country: string; methodCode: string; flow: 'payin' | 'payout' }>();
    for (const cap of snap.capabilities) combos.set(key(cap.countryCode, cap.paymentMethodCode), { country: cap.countryCode, methodCode: cap.paymentMethodCode, flow: cap.paymentFlow });
    for (const r of db.routes) if (!combos.has(key(r.country, r.methodCode))) combos.set(key(r.country, r.methodCode), { country: r.country, methodCode: r.methodCode, flow: 'payin' });
    const routes: RouteView[] = [...combos.values()]
      .map((cm) => this.routeView(db, snap, cm.country, cm.methodCode, cm.flow))
      .sort((x, y) => x.countryName.localeCompare(y.countryName) || stateOrder(x.state) - stateOrder(y.state) || x.methodName.localeCompare(y.methodName));
    const set = routes.filter((r) => r.state !== 'not_set');
    return {
      routes,
      overrides: db.overrides.map((o) => this.overrideView(snap, o)).sort((x, y) => x.merchantName.localeCompare(y.merchantName)),
      merchants,
      summary: { routes: set.length, routing: set.filter((r) => r.state === 'routing').length, fallback: set.filter((r) => r.state === 'fallback' || r.state === 'at_risk').length, none: set.filter((r) => r.state === 'none').length },
      can: { manage: who.manage },
      sampleData: true,
    };
  }

  private routeView(db: RoutingDb, snap: RoutingHostSnapshot, country: string, methodCode: string, flow: 'payin' | 'payout'): RouteView {
    const route = db.routes.find((r) => r.country === country && r.methodCode === methodCode) ?? null;
    const options = this.options(snap, country, methodCode, route);
    const perf = (id: string) => this.perfOf(snap, id, country, methodCode);
    const { state, note } = routeState(route, options, perf);
    const name = (id: string) => options.find((o) => o.hostId === id)?.name ?? 'Removed host';
    const elig = (id: string) => !!options.find((o) => o.hostId === id)?.eligible;
    let effective: RouteView['effective'] = [];
    if (route?.mode === 'split') effective = (route.fallback ? effectiveShares(route.hosts, elig) : route.hosts.filter((h) => elig(h.hostId)).map((h) => ({ hostId: h.hostId, share: h.share ?? 0 }))).map((e) => ({ ...e, name: name(e.hostId) }));
    if (route?.mode === 'smart') effective = smartRanking(route, elig, perf).map((r) => ({ hostId: r.hostId, name: name(r.hostId), score: r.score, successRate: r.successRate, avgResponseMs: r.avgResponseMs }));
    return {
      key: key(country, methodCode),
      country,
      countryName: countryName(country),
      methodCode,
      methodName: methodName(country, methodCode),
      flow,
      route,
      options,
      state,
      stateNote: note,
      effective,
      eligibleCount: options.filter((o) => o.eligible && (!route || route.hosts.some((h) => h.hostId === o.hostId))).length,
      overrideCount: db.overrides.filter((o) => o.country === country && o.methodCode === methodCode).length,
    };
  }

  /** Hosts registered for a country + method, plus any host a route still names. */
  private options(snap: RoutingHostSnapshot, country: string, methodCode: string, route: Route | null): HostOption[] {
    const caps = snap.capabilities.filter((c) => c.countryCode === country && c.paymentMethodCode === methodCode);
    const ids = [...new Set([...caps.map((c) => c.hostId), ...(route?.hosts.map((h) => h.hostId) ?? [])])];
    return ids.map((id) => {
      const host = snap.hosts.find((h) => h.id === id);
      const cap = caps.find((c) => c.hostId === id);
      const reason = !host ? 'Removed from Host Management' : !cap ? 'Method not registered' : host.status !== 'active' ? STATUS_REASON[host.status] : cap.availabilityStatus !== 'available' ? `${methodName(country, methodCode)} ${cap.availabilityStatus === 'disabled' ? 'switched off' : 'unavailable'}` : '';
      return { hostId: id, name: host?.name ?? id, hostCode: host?.hostCode ?? '', hostStatus: host?.status ?? 'removed', availability: cap?.availabilityStatus ?? 'disabled', eligible: !reason, reason };
    });
  }

  private overrideView(snap: RoutingHostSnapshot, o: MerchantOverride): OverrideView {
    const opt = this.options(snap, o.country, o.methodCode, null).find((x) => x.hostId === o.hostId);
    return { ...o, hostName: snap.hosts.find((h) => h.id === o.hostId)?.name ?? 'Removed host', methodName: methodName(o.country, o.methodCode), countryName: countryName(o.country), hostEligible: !!opt?.eligible, hostReason: opt?.reason ?? 'Method not registered' };
  }

  private merchantOptions(): MerchantOption[] {
    const out: MerchantOption[] = [];
    for (const s of this.opts.merchants()) {
      const methods = s.products.map((p) => ({ code: p.methodCode, name: p.methodName }));
      out.push({ merchantId: s.gmid, subMerchantId: null, name: s.merchantName, country: s.country, methods });
      for (const sub of s.subMerchants) out.push({ merchantId: s.gmid, subMerchantId: sub.id, name: `${s.merchantName} · ${sub.name}`, country: s.country, methods });
    }
    return out.sort((x, y) => x.name.localeCompare(y.name) || x.country.localeCompare(y.country));
  }

  /** Simulated performance (5C): stable within a 15-minute window, per host + country + method. */
  private perfOf(snap: RoutingHostSnapshot, hostId: string, country: string, methodCode: string): { successRate: number | null; avgResponseMs: number | null; attempts: number } {
    const host = snap.hosts.find((h) => h.id === hostId);
    const cap = snap.capabilities.find((c) => c.hostId === hostId && c.countryCode === country && c.paymentMethodCode === methodCode);
    if (!host || !cap || host.status !== 'active' || cap.availabilityStatus === 'disabled') return { successRate: null, avgResponseMs: null, attempts: 0 };
    const bucket = Math.floor(this.now() / PERF_BUCKET_MS);
    const seed = `${host.hostCode}:${country}:${methodCode}`;
    const base = hash(seed);
    const wobble = (hash(`${seed}:${bucket}`) % 100) / 100;
    return {
      successRate: Math.round((90.5 + (base % 70) / 10 + wobble * 1.2) * 10) / 10,
      avgResponseMs: 200 + (base % 1100) + Math.round(wobble * 120),
      attempts: 800 + (hash(`${seed}:n:${bucket}`) % 7000),
    };
  }

  private performance(): HostPerformance[] {
    const snap = this.opts.hosts();
    return snap.capabilities
      .map((c) => {
        const p = this.perfOf(snap, c.hostId, c.countryCode, c.paymentMethodCode);
        return { hostId: c.hostId, hostName: snap.hosts.find((h) => h.id === c.hostId)?.name ?? c.hostId, country: c.countryCode, methodCode: c.paymentMethodCode, methodName: methodName(c.countryCode, c.paymentMethodCode), ...p, simulated: true as const };
      })
      .sort((a, b) => a.country.localeCompare(b.country) || a.hostName.localeCompare(b.hostName) || a.methodName.localeCompare(b.methodName));
  }

  // ------------------------------------------------------------- route checker

  private check(body: any): RouteDecision & { route: string; simulated: boolean } {
    const country = String(body?.country ?? '');
    const methodCode = String(body?.methodCode ?? '');
    if (!country || !methodCode) fail(422, 'VALIDATION_FAILED', 'Choose a country and payment method.');
    const db = this.load();
    const snap = this.opts.hosts();
    const merchantId = body?.merchantId ? String(body.merchantId) : null;
    const subId = body?.subMerchantId ? String(body.subMerchantId) : null;
    // A sub-merchant's own override comes first, then the parent's.
    const override = merchantId ? (db.overrides.find((o) => o.merchantId === merchantId && o.subMerchantId === subId && o.country === country && o.methodCode === methodCode) ?? (subId ? db.overrides.find((o) => o.merchantId === merchantId && !o.subMerchantId && o.country === country && o.methodCode === methodCode) : undefined)) ?? null : null;
    const route = db.routes.find((r) => r.country === country && r.methodCode === methodCode) ?? null;
    const options = this.options(snap, country, methodCode, route);
    const opt = (id: string) => options.find((o) => o.hostId === id) ?? this.options(snap, country, methodCode, null).find((o) => o.hostId === id);
    const name = (id: string) => snap.hosts.find((h) => h.id === id)?.name ?? 'Removed host';
    const roll = (hash(`${merchantId ?? ''}:${subId ?? ''}:${body?.amount ?? ''}:${this.now()}`) % 10_000) / 10_000;
    const d = decide(override, route, {
      name,
      option: (id) => ({ eligible: !!opt(id)?.eligible, reason: opt(id)?.reason ?? 'Method not registered' }),
      perf: (id) => this.perfOf(snap, id, country, methodCode),
      roll,
    });
    return { ...d, route: `${countryName(country)} · ${methodName(country, methodCode)}`, simulated: route?.mode === 'smart' && d.via === 'smart' };
  }

  // ------------------------------------------------------------- routes

  private readRoute(country: string, methodCode: string, body: any) {
    const snap = this.opts.hosts();
    if (!snap.capabilities.some((c) => c.countryCode === country && c.paymentMethodCode === methodCode)) fail(404, 'NOT_FOUND', 'No host is registered for this country and payment method.');
    const errors: { field: string; message: string }[] = [];
    const mode = MODES.includes(body?.mode) ? (body.mode as RouteMode) : fail(422, 'VALIDATION_FAILED', 'Choose Priority, Percentage split or Smart.');
    const raw: any[] = Array.isArray(body?.hosts) ? body.hosts.slice(0, 20) : [];
    const hosts: RouteHost[] = [];
    for (const h of raw) {
      const id = String(h?.hostId ?? '');
      if (!snap.capabilities.some((c) => c.hostId === id && c.countryCode === country && c.paymentMethodCode === methodCode)) errors.push({ field: 'hosts', message: `${snap.hosts.find((x) => x.id === id)?.name ?? id} isn't registered for ${methodName(country, methodCode)} in ${countryName(country)}.` });
      else if (hosts.some((x) => x.hostId === id)) errors.push({ field: 'hosts', message: `${snap.hosts.find((x) => x.id === id)!.name} is listed twice.` });
      else hosts.push(mode === 'split' ? { hostId: id, share: Number(h?.share) } : { hostId: id });
    }
    if (!hosts.length) errors.push({ field: 'hosts', message: 'Add at least one host.' });
    if (mode === 'split') {
      if (hosts.length < 2) errors.push({ field: 'hosts', message: 'A split needs at least two hosts.' });
      if (hosts.some((h) => !Number.isInteger(h.share) || h.share! < 1 || h.share! > 99)) errors.push({ field: 'shares', message: 'Each share must be a whole number from 1 to 99.' });
      else if (hosts.reduce((n, h) => n + h.share!, 0) !== 100) errors.push({ field: 'shares', message: `Shares add up to ${hosts.reduce((n, h) => n + h.share!, 0)} %; they must add up to 100 %.` });
    }
    const smart = { successWeight: Number(body?.smart?.successWeight ?? DEFAULT_SMART.successWeight), minSuccessRate: Number(body?.smart?.minSuccessRate ?? DEFAULT_SMART.minSuccessRate) };
    if (mode === 'smart') {
      if (!Number.isInteger(smart.successWeight) || smart.successWeight < 0 || smart.successWeight > 100) errors.push({ field: 'smart.successWeight', message: 'Choose a weighting from 0 to 100.' });
      if (!Number.isFinite(smart.minSuccessRate) || smart.minSuccessRate < 50 || smart.minSuccessRate > 100) errors.push({ field: 'smart.minSuccessRate', message: 'Enter a minimum success rate from 50 to 100 %.' });
    }
    if (errors.length) fail(422, 'VALIDATION_FAILED', errors[0].message, errors);
    return { mode, hosts, fallback: body?.fallback !== false, smart: mode === 'smart' ? smart : DEFAULT_SMART };
  }

  private saveRoute(who: Who, country: string, methodCode: string, input: Pick<Route, 'mode' | 'hosts' | 'fallback' | 'smart'>): RouteView {
    const db = this.load();
    const snap = this.opts.hosts();
    let route = db.routes.find((r) => r.country === country && r.methodCode === methodCode);
    const before = route ? describe(route, snap) : null;
    if (!route) {
      route = { id: `RT-${String(++db.seq).padStart(4, '0')}`, country, methodCode, ...input, updatedAt: this.now(), updatedBy: who.label };
      db.routes.push(route);
    } else Object.assign(route, input, { updatedAt: this.now(), updatedBy: who.label });
    const after = describe(route, snap);
    if (before !== after) this.log(db, who, before ? 'Route changed' : 'Route created', `${countryName(country)} · ${methodName(country, methodCode)}`, before ? `${before} → ${after}` : after);
    this.save(db);
    return this.routeView(db, snap, country, methodCode, snap.capabilities.find((c) => c.countryCode === country && c.paymentMethodCode === methodCode)?.paymentFlow ?? 'payin');
  }

  // ------------------------------------------------------------- overrides

  private findOverride(id: string): MerchantOverride {
    return this.load().overrides.find((o) => o.id === id) ?? fail(404, 'NOT_FOUND', 'Override not found.');
  }

  private readOverride(id: string | null, body: any): Omit<MerchantOverride, 'id' | 'updatedAt' | 'updatedBy'> {
    const db = this.load();
    if (id) this.findOverride(id);
    const errors: { field: string; message: string }[] = [];
    const merchantId = String(body?.merchantId ?? '');
    const subMerchantId = body?.subMerchantId ? String(body.subMerchantId) : null;
    const country = String(body?.country ?? '');
    const methodCode = String(body?.methodCode ?? '');
    const hostId = String(body?.hostId ?? '');
    const reason = String(body?.reason ?? '').trim().slice(0, 300);
    const merchant = this.merchantOptions().find((x) => x.merchantId === merchantId && x.subMerchantId === subMerchantId && x.country === country);
    if (!merchant) errors.push({ field: 'merchantId', message: 'Choose a merchant that is live in this country.' });
    else if (!merchant.methods.some((x) => x.code === methodCode)) errors.push({ field: 'methodCode', message: `${methodName(country, methodCode)} isn't switched on for ${merchant.name}.` });
    const snap = this.opts.hosts();
    if (!snap.capabilities.some((c) => c.hostId === hostId && c.countryCode === country && c.paymentMethodCode === methodCode)) errors.push({ field: 'hostId', message: 'Choose a host registered for this country and payment method.' });
    if (reason.length < 5) errors.push({ field: 'reason', message: 'Enter a reason (at least 5 characters).' });
    const clash = db.overrides.find((o) => o.id !== id && o.merchantId === merchantId && o.subMerchantId === subMerchantId && o.country === country && o.methodCode === methodCode);
    if (clash) errors.push({ field: 'merchantId', message: `${clash.merchantName} already has an override for ${methodName(country, methodCode)} in ${countryName(country)}. Edit that one instead.` });
    if (errors.length) fail(422, 'VALIDATION_FAILED', errors[0].message, errors);
    return { merchantId, subMerchantId, merchantName: merchant!.name, country, methodCode, hostId, fallbackToRoute: body?.fallbackToRoute !== false, reason };
  }

  private saveOverride(who: Who, id: string | null, input: Omit<MerchantOverride, 'id' | 'updatedAt' | 'updatedBy'>): OverrideView {
    const db = this.load();
    const snap = this.opts.hosts();
    let o = id ? db.overrides.find((x) => x.id === id)! : null;
    const hostName = (h: string) => snap.hosts.find((x) => x.id === h)?.name ?? h;
    const subject = `${input.merchantName} · ${countryName(input.country)} · ${methodName(input.country, input.methodCode)}`;
    if (!o) {
      o = { id: `OVR-${String(++db.seq).padStart(4, '0')}`, ...input, updatedAt: this.now(), updatedBy: who.label };
      db.overrides.push(o);
      this.log(db, who, 'Override added', subject, `Pinned to ${hostName(o.hostId)} · ${o.fallbackToRoute ? 'falls back to the default route' : 'no fallback'}. Reason: ${o.reason}`);
    } else {
      const before = `${hostName(o.hostId)}, ${o.fallbackToRoute ? 'fallback on' : 'fallback off'}`;
      Object.assign(o, input, { updatedAt: this.now(), updatedBy: who.label });
      this.log(db, who, 'Override changed', subject, `${before} → ${hostName(o.hostId)}, ${o.fallbackToRoute ? 'fallback on' : 'fallback off'}. Reason: ${o.reason}`);
    }
    this.save(db);
    return this.overrideView(snap, o);
  }

  private removeOverride(who: Who, id: string): { removed: string } {
    const db = this.load();
    const o = db.overrides.find((x) => x.id === id)!;
    db.overrides = db.overrides.filter((x) => x.id !== id);
    this.log(db, who, 'Override removed', `${o.merchantName} · ${countryName(o.country)} · ${methodName(o.country, o.methodCode)}`, 'Payments use the default route again.');
    this.save(db);
    return { removed: id };
  }

  // ------------------------------------------------------------- storage

  private log(db: RoutingDb, who: Who | string, action: string, subject: string, details: string) {
    db.activity.push({ id: `RA-${String(++db.seq).padStart(5, '0')}`, at: this.now(), action, subject, details, by: typeof who === 'string' ? who : who.label });
    db.activity = db.activity.slice(-1000);
  }

  private load(): RoutingDb {
    const raw = this.opts.storage.getItem(KEY);
    if (raw) {
      try {
        const db = JSON.parse(raw) as RoutingDb;
        if (db.version === DB_VERSION) return db;
      } catch {
        // fall through to a fresh seed
      }
    }
    const db = this.seed();
    this.save(db);
    return db;
  }

  private save(db: RoutingDb) {
    this.opts.storage.setItem(KEY, JSON.stringify(db));
  }

  /** Sample routes on the sample hosts, and two sample overrides on live demo merchants. */
  private seed(): RoutingDb {
    const db: RoutingDb = { version: DB_VERSION, seq: 0, routes: [], overrides: [], activity: [] };
    const snap = this.opts.hosts();
    const by = 'Wei Ling Tan (Tech Ops)';
    const at = this.now() - 2 * 86_400_000;
    const id = (code: string) => snap.hosts.find((h) => h.hostCode === code)?.id;
    const route = (country: string, methodCode: string, mode: RouteMode, hosts: [string, number?][], smart = DEFAULT_SMART) => {
      const list = hosts.map(([code, share]) => ({ hostId: id(code), share })).filter((h): h is { hostId: string; share: number | undefined } => !!h.hostId && snap.capabilities.some((c) => c.hostId === h.hostId && c.countryCode === country && c.paymentMethodCode === methodCode));
      if (!list.length) return;
      const r: Route = { id: `RT-${String(++db.seq).padStart(4, '0')}`, country, methodCode, mode, hosts: list.map((h) => (mode === 'split' ? { hostId: h.hostId, share: h.share } : { hostId: h.hostId })), fallback: true, smart, updatedAt: at, updatedBy: by };
      db.routes.push(r);
      db.activity.push({ id: `RA-${String(++db.seq).padStart(5, '0')}`, at, action: 'Route created', subject: `${countryName(country)} · ${methodName(country, methodCode)}`, details: describe(r, snap), by });
    };
    route('ID', 'va', 'priority', [['HARSYA'], ['WINPAY'], ['LINKQU']]);
    route('ID', 'qris', 'smart', [['HARSYA']]);
    route('ID', 'bank_transfer_payout', 'split', [['WINPAY', 70], ['LINKQU', 30]]);
    route('MY', 'fpx', 'priority', [['PBB']]);
    route('MY', 'duitnow_qr', 'priority', [['CIMBCOLLECT']]);
    route('MY', 'cards', 'priority', [['PBB']]);
    const sources = safe(() => this.opts.merchants(), []);
    const pin = (country: string, methodCode: string, code: string, reason: string) => {
      const s = sources.find((x) => x.country === country && x.products.some((p) => p.methodCode === methodCode) && !db.overrides.some((o) => o.merchantId === x.gmid));
      const hostId = id(code);
      if (!s || !hostId) return;
      db.overrides.push({ id: `OVR-${String(++db.seq).padStart(4, '0')}`, merchantId: s.gmid, subMerchantId: null, merchantName: s.merchantName, country, methodCode, hostId, fallbackToRoute: true, reason, updatedAt: at, updatedBy: by });
    };
    pin('ID', 'va', 'WINPAY', 'Merchant contracted WINPAY as their virtual account bank.');
    return db;
  }
}

// ------------------------------------------------------------------ helpers

function describe(r: Route, snap: RoutingHostSnapshot): string {
  const name = (id: string) => snap.hosts.find((h) => h.id === id)?.name ?? id;
  const list = r.mode === 'split' ? r.hosts.map((h) => `${name(h.hostId)} ${h.share} %`).join(' / ') : r.hosts.map((h) => name(h.hostId)).join(' → ');
  const extra = r.mode === 'smart' ? ` · ${r.smart.successWeight} % success / ${100 - r.smart.successWeight} % speed · min ${r.smart.minSuccessRate} %` : '';
  return `${r.mode === 'priority' ? 'Priority' : r.mode === 'split' ? 'Split' : 'Smart'}: ${list}${extra} · fallback ${r.fallback ? 'on' : 'off'}`;
}

const key = (country: string, method: string) => `${country}:${method}`;
const stateOrder = (s: RouteView['state']) => ({ none: 0, at_risk: 1, fallback: 2, routing: 3, not_set: 4 })[s];
const STATUS_REASON: Record<string, string> = { draft: 'Host is a draft', disabled: 'Host disabled', maintenance: 'Host under maintenance', active: '' };
const TEAM_LABEL: Record<string, string> = { sales: 'Sales / Operations', risk: 'Risk', cs: 'Customer Success', finops: 'FinOps', support: 'Mobi Support', security: 'Security Admin', admin: 'Prototype admin' };

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

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
