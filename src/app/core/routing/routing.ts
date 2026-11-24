/**
 * Routing (Batch 5B + 5C): which host each payment goes to.
 *
 * One default route per country + payment method, in one of three modes:
 * - Priority: an ordered list; the first eligible host is used.
 * - Percentage split: shares adding up to 100; a payment is assigned by share.
 * - Smart (5C): hosts ranked by SIMULATED success rate and response time.
 * A merchant (or sub-merchant) override pins one country + method to a host and comes first.
 *
 * Eligible host = Active in Host Management and that payment method Available. Fallback (per
 * route) skips ineligible hosts: Priority uses the next host, Split re-divides the shares, Smart
 * uses the next in the ranking. Fallback off: the payment fails instead.
 *
 * Nothing here is sent to a provider; Smart's performance figures are generated for the prototype.
 */

export type RouteMode = 'priority' | 'split' | 'smart';
export const ROUTE_MODE_LABEL: Record<RouteMode, string> = { priority: 'Priority', split: 'Split', smart: 'Smart' };

export interface RouteHost {
  hostId: string;
  /** Split only: whole-number percentage. */
  share?: number;
}

export interface SmartSettings {
  /** 0–100: how much success rate counts against speed (the rest). */
  successWeight: number;
  /** Hosts below this simulated success rate (%) are skipped. */
  minSuccessRate: number;
}

export interface Route {
  id: string;
  country: string;
  methodCode: string;
  mode: RouteMode;
  hosts: RouteHost[];
  fallback: boolean;
  smart: SmartSettings;
  updatedAt: number;
  updatedBy: string;
}

export interface MerchantOverride {
  id: string;
  merchantId: string;
  subMerchantId: string | null;
  merchantName: string;
  country: string;
  methodCode: string;
  hostId: string;
  /** If the pinned host is not eligible: true = use the default route, false = the payment fails. */
  fallbackToRoute: boolean;
  reason: string;
  updatedAt: number;
  updatedBy: string;
}

export interface RoutingActivity {
  id: string;
  at: number;
  action: string;
  subject: string;
  details: string;
  by: string;
}

/** A host as routing sees it, for one country + method. */
export interface HostOption {
  hostId: string;
  name: string;
  hostCode: string;
  hostStatus: string;
  availability: 'available' | 'unavailable' | 'disabled';
  eligible: boolean;
  /** Why it isn't eligible (empty when it is). */
  reason: string;
}

/** Simulated performance per host + method (5C). */
export interface HostPerformance {
  hostId: string;
  hostName: string;
  country: string;
  methodCode: string;
  methodName: string;
  successRate: number | null;
  avgResponseMs: number | null;
  attempts: number;
  simulated: true;
}

export type RouteState = 'routing' | 'fallback' | 'at_risk' | 'none' | 'not_set';
export const ROUTE_STATE_LABEL: Record<RouteState, string> = {
  routing: 'Routing',
  fallback: 'Fallback in use',
  at_risk: 'Some payments fail',
  none: 'No eligible host',
  not_set: 'Not set',
};

export interface RouteView {
  key: string;
  country: string;
  countryName: string;
  methodCode: string;
  methodName: string;
  flow: 'payin' | 'payout';
  route: Route | null;
  options: HostOption[];
  state: RouteState;
  stateNote: string;
  /** Split: shares after skipping ineligible hosts (fallback on). Smart: the ranking now. */
  effective: { hostId: string; name: string; share?: number; score?: number; successRate?: number | null; avgResponseMs?: number | null }[];
  eligibleCount: number;
  overrideCount: number;
}

export interface OverrideView extends MerchantOverride {
  hostName: string;
  methodName: string;
  countryName: string;
  hostEligible: boolean;
  hostReason: string;
}

export interface MerchantOption {
  merchantId: string;
  subMerchantId: string | null;
  name: string;
  country: string;
  methods: { code: string; name: string }[];
}

export interface RoutingResponse {
  routes: RouteView[];
  overrides: OverrideView[];
  merchants: MerchantOption[];
  summary: { routes: number; routing: number; fallback: number; none: number };
  can: { manage: boolean };
  sampleData: true;
}

export interface DecisionStep {
  kind: 'ok' | 'skip' | 'info' | 'fail';
  title: string;
  detail: string;
}

export interface RouteDecision {
  hostId: string | null;
  hostName: string | null;
  via: 'override' | 'priority' | 'split' | 'smart' | 'none';
  usedFallback: boolean;
  steps: DecisionStep[];
}

export interface RouteInput {
  mode: RouteMode;
  hosts: RouteHost[];
  fallback: boolean;
  smart: SmartSettings;
}

export interface OverrideInput {
  merchantId: string;
  subMerchantId: string | null;
  country: string;
  methodCode: string;
  hostId: string;
  fallbackToRoute: boolean;
  reason: string;
}

export const DEFAULT_SMART: SmartSettings = { successWeight: 70, minSuccessRate: 90 };

// ------------------------------------------------------------------ the engine (pure)

/** Smart score 0–1: success rate and speed (1 at 0 ms, 0 at 3,000 ms or slower), weighted. */
export function smartScore(successRate: number, avgResponseMs: number, s: SmartSettings): number {
  const w = Math.min(100, Math.max(0, s.successWeight)) / 100;
  const speed = Math.min(1, Math.max(0, 1 - avgResponseMs / 3000));
  return Math.round((w * (successRate / 100) + (1 - w) * speed) * 100) / 100;
}

/** Split shares after removing ineligible hosts (re-divided in proportion, whole numbers adding to 100). */
export function effectiveShares(hosts: RouteHost[], eligible: (id: string) => boolean): { hostId: string; share: number }[] {
  const keep = hosts.filter((h) => eligible(h.hostId) && (h.share ?? 0) > 0);
  const total = keep.reduce((n, h) => n + (h.share ?? 0), 0);
  if (!total) return [];
  const raw = keep.map((h) => ({ hostId: h.hostId, exact: ((h.share ?? 0) * 100) / total }));
  const out = raw.map((r) => ({ hostId: r.hostId, share: Math.floor(r.exact) }));
  let left = 100 - out.reduce((n, r) => n + r.share, 0);
  [...raw].sort((a, b) => (b.exact % 1) - (a.exact % 1)).forEach((r) => {
    if (left-- > 0) out.find((o) => o.hostId === r.hostId)!.share += 1;
  });
  return out;
}

/** Smart ranking of eligible hosts with performance data, best first. */
export function smartRanking(route: Pick<Route, 'hosts' | 'smart'>, eligible: (id: string) => boolean, perf: (id: string) => { successRate: number | null; avgResponseMs: number | null }) {
  return route.hosts
    .filter((h) => eligible(h.hostId))
    .map((h) => ({ hostId: h.hostId, ...perf(h.hostId) }))
    .filter((p) => p.successRate !== null && p.avgResponseMs !== null)
    .map((p) => ({ ...p, score: smartScore(p.successRate!, p.avgResponseMs!, route.smart), meets: p.successRate! >= route.smart.minSuccessRate }))
    .sort((a, b) => b.score - a.score || a.hostId.localeCompare(b.hostId));
}

export interface EngineContext {
  name: (hostId: string) => string;
  option: (hostId: string) => { eligible: boolean; reason: string };
  perf: (hostId: string) => { successRate: number | null; avgResponseMs: number | null };
  /** 0 ≤ roll < 1, picks the split bucket. */
  roll: number;
}

/** Runs the default route only (no override). */
export function decideRoute(route: Route | null, ctx: EngineContext): RouteDecision {
  const steps: DecisionStep[] = [];
  const done = (hostId: string | null, via: RouteDecision['via'], usedFallback: boolean): RouteDecision => ({ hostId, hostName: hostId ? ctx.name(hostId) : null, via, usedFallback, steps });
  if (!route || !route.hosts.length) {
    steps.push({ kind: 'fail', title: 'No route set', detail: 'This country and payment method has no default route, so the payment fails.' });
    return done(null, 'none', false);
  }
  const elig = (id: string) => ctx.option(id).eligible;
  if (route.mode === 'priority') {
    for (const [i, h] of route.hosts.entries()) {
      const o = ctx.option(h.hostId);
      if (o.eligible) {
        steps.push({ kind: 'ok', title: `${ctx.name(h.hostId)} is eligible`, detail: `Priority #${i + 1}${i ? ' (fallback)' : ''}` });
        return done(h.hostId, 'priority', i > 0);
      }
      steps.push({ kind: 'skip', title: `Skipped ${ctx.name(h.hostId)}`, detail: `Priority #${i + 1}: ${o.reason}` });
      if (!route.fallback) {
        steps.push({ kind: 'fail', title: 'Fallback is off', detail: 'The payment fails.' });
        return done(null, 'none', false);
      }
    }
    steps.push({ kind: 'fail', title: 'No eligible host', detail: 'Every host in the list was skipped, so the payment fails.' });
    return done(null, 'none', false);
  }
  if (route.mode === 'split') {
    const blocked = route.hosts.filter((h) => !elig(h.hostId));
    for (const h of blocked) steps.push({ kind: 'skip', title: `Skipped ${ctx.name(h.hostId)}`, detail: `${h.share ?? 0} % share: ${ctx.option(h.hostId).reason}` });
    // Without fallback, a payment drawn for a blocked host fails.
    const pool = route.fallback ? effectiveShares(route.hosts, elig) : route.hosts.map((h) => ({ hostId: h.hostId, share: h.share ?? 0 }));
    let acc = 0;
    const pick = pool.find((p) => (acc += p.share) > ctx.roll * 100) ?? pool.at(-1);
    if (!pick || !elig(pick.hostId)) {
      steps.push({ kind: 'fail', title: pick ? `Drawn for ${ctx.name(pick.hostId)}, which isn't eligible` : 'No eligible host', detail: route.fallback ? 'The payment fails.' : 'Fallback is off, so the payment fails.' });
      return done(null, 'none', false);
    }
    steps.push({ kind: 'ok', title: `${ctx.name(pick.hostId)} drawn`, detail: `Split: ${pool.map((p) => `${ctx.name(p.hostId)} ${p.share} %`).join(' · ')}${blocked.length && route.fallback ? ' (shares re-divided)' : ''}` });
    return done(pick.hostId, 'split', blocked.length > 0 && route.fallback);
  }
  // Smart
  for (const h of route.hosts) if (!elig(h.hostId)) steps.push({ kind: 'skip', title: `Skipped ${ctx.name(h.hostId)}`, detail: ctx.option(h.hostId).reason });
  const ranked = smartRanking(route, elig, ctx.perf);
  const best = ranked.find((r) => r.meets);
  for (const r of ranked.filter((x) => !x.meets)) steps.push({ kind: 'skip', title: `Below ${route.smart.minSuccessRate} %: ${ctx.name(r.hostId)}`, detail: `${r.successRate} % success (simulated)` });
  if (best) {
    steps.push({ kind: 'ok', title: `${ctx.name(best.hostId)} ranked first`, detail: `Score ${best.score.toFixed(2)} · ${best.successRate} % success · ${best.avgResponseMs} ms (simulated)` });
    return done(best.hostId, 'smart', false);
  }
  if (route.fallback && ranked.length) {
    steps.push({ kind: 'ok', title: `${ctx.name(ranked[0].hostId)}: best available`, detail: 'No host meets the minimum success rate; fallback uses the best ranked.' });
    return done(ranked[0].hostId, 'smart', true);
  }
  steps.push({ kind: 'fail', title: 'No eligible host', detail: route.fallback ? 'No host can take the payment.' : 'No host meets the minimum and fallback is off.' });
  return done(null, 'none', false);
}

/** Override first, then the default route. */
export function decide(override: MerchantOverride | null, route: Route | null, ctx: EngineContext): RouteDecision {
  if (override) {
    const o = ctx.option(override.hostId);
    const head: DecisionStep = { kind: 'info', title: 'Merchant override', detail: `${override.merchantName} pinned to ${ctx.name(override.hostId)}` };
    if (o.eligible) return { hostId: override.hostId, hostName: ctx.name(override.hostId), via: 'override', usedFallback: false, steps: [head, { kind: 'ok', title: `${ctx.name(override.hostId)} is eligible`, detail: 'Default route not needed.' }] };
    if (!override.fallbackToRoute) return { hostId: null, hostName: null, via: 'none', usedFallback: false, steps: [head, { kind: 'fail', title: `${ctx.name(override.hostId)} is not eligible`, detail: `${o.reason}. The override doesn't fall back, so the payment fails.` }] };
    const r = decideRoute(route, ctx);
    return { ...r, usedFallback: r.hostId !== null || r.usedFallback, steps: [head, { kind: 'skip', title: `Skipped ${ctx.name(override.hostId)}`, detail: `${o.reason}. Using the default route.` }, ...r.steps] };
  }
  const r = decideRoute(route, ctx);
  return { ...r, steps: [{ kind: 'info', title: 'No merchant override', detail: 'Using the default route.' }, ...r.steps] };
}

/** The state shown on the Routes list. */
export function routeState(route: Route | null, options: HostOption[], perf: (id: string) => { successRate: number | null; avgResponseMs: number | null }): { state: RouteState; note: string } {
  if (!route || !route.hosts.length) return { state: 'not_set', note: options.length ? 'No route yet' : 'No host registered' };
  const opt = (id: string) => options.find((o) => o.hostId === id);
  const elig = (id: string) => !!opt(id)?.eligible;
  const name = (id: string) => opt(id)?.name ?? id;
  const blocked = route.hosts.filter((h) => !elig(h.hostId));
  const why = (id: string) => `${name(id)} ${(opt(id)?.reason ?? 'not registered').toLowerCase()}`;
  if (blocked.length === route.hosts.length) return { state: 'none', note: blocked.map((h) => why(h.hostId)).join('; ') };
  if (route.mode === 'priority') {
    if (elig(route.hosts[0].hostId)) return { state: 'routing', note: '' };
    return route.fallback ? { state: 'fallback', note: `${why(route.hosts[0].hostId)}: using ${name(route.hosts.find((h) => elig(h.hostId))!.hostId)}` } : { state: 'none', note: `${why(route.hosts[0].hostId)}; fallback is off` };
  }
  if (route.mode === 'split') {
    if (!blocked.length) return { state: 'routing', note: '' };
    if (!route.fallback) return { state: 'at_risk', note: `${blocked.map((h) => `${name(h.hostId)}'s ${h.share} %`).join(', ')} fail${blocked.length === 1 ? 's' : ''}` };
    const eff = effectiveShares(route.hosts, elig);
    return { state: 'fallback', note: `${blocked.map((h) => name(h.hostId)).join(', ')} skipped: ${eff.map((e) => `${e.share} % to ${name(e.hostId)}`).join(', ')}` };
  }
  const ranked = smartRanking(route, elig, perf);
  if (ranked.some((r) => r.meets)) return { state: 'routing', note: '' };
  return route.fallback && ranked.length ? { state: 'fallback', note: `No host meets ${route.smart.minSuccessRate} %: using the best ranked` } : { state: 'none', note: `No host meets ${route.smart.minSuccessRate} %` };
}
