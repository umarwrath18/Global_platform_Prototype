import { pricingSummary, techniqueLabel } from '../merchants/products';
import {
  CurrencyAmount,
  DetailField,
  DetailSection,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  IpnAttempt,
  MerchantTxnDetail,
  MerchantTxnListResponse,
  MerchantTxnRow,
  PathStep,
  PathStepKey,
  PAYMENT_TYPE_LABEL,
  PAYMENT_TYPE_ORDER,
  PaymentType,
  paymentTypeOf,
  TimelineEntry,
  TXN_FLAG_LABEL,
  TXN_FLOWS,
  TXN_PAGE_SIZES,
  TXN_STATUS_LABEL,
  TXN_STATUSES,
  TxnAuditEntry,
  TxnDetail,
  TxnExport,
  TxnFlag,
  TxnFlow,
  TxnListResponse,
  TxnListRow,
  TxnNote,
  TxnRange,
  TxnStatus,
  TxnSummary,
  TYPE_COLUMNS,
} from '../transactions/transactions';
import type { TxnSource } from './merchant-server';
import { generateTables, hash, statusAt, TxnDetailRecord, TxnRecord, TxnTables, updatedAt } from './transaction-data';

// Simulated Transaction Management API, phase 1 (docs/transaction-management-phase-1.md):
// lists per flow, details, export, notes and investigation flags, for internal staff; and the
// merchant's own view for the Merchant Portal. Like the other simulated services it enforces every
// rule itself: team permissions, country scope, masking and validation are never left to the UI.

const OPS_KEY = 'mobi.gp.txnops';
const OPS_VERSION = 1;
const MAX_EXPORT_ROWS = 50_000;
const MAX_CUSTOM_DAYS = 93;

/** Teams that can use Transactions (Security Admin can't; merchants use the Merchant Portal). */
type TxnTeam = 'sales' | 'risk' | 'cs' | 'finops' | 'support';
const VIEW_TEAMS: TxnTeam[] = ['sales', 'risk', 'cs', 'finops', 'support'];
/** Proposed §4 matrix (decision: as proposed). */
const FEE_TEAMS: TxnTeam[] = ['sales', 'cs', 'finops'];
const DEVICE_TEAMS: TxnTeam[] = ['risk', 'support'];
const EXPORT_TEAMS: TxnTeam[] = ['sales', 'risk', 'cs', 'finops'];
const TEAM_LABEL: Record<TxnTeam, string> = { sales: 'Sales / Ops', risk: 'Risk', cs: 'CS', finops: 'FinOps', support: 'Mobi Support' };

export interface TxnCaller {
  userId: string;
  name: string;
  team?: string | null;
  /** Countries the login's account can access (codes). */
  countries?: string[];
  /** Viewer logins can look but not add notes or flags. */
  readOnly?: boolean;
  merchantId?: string | null;
}

export interface TransactionServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  auth: { authenticate(token: string | null, portal?: 'internal' | 'merchant'): Promise<{ ok: true; caller: TxnCaller } | { ok: false; response: Reply }> };
  /** Live MIDs (merchant data). */
  sources: () => TxnSource[];
  /** When true, a login works only as its own team (only `admin` may switch). Default true. */
  fixedTeams?: boolean;
  now?: () => number;
}

interface Reply {
  status: number;
  body: unknown;
}

class TxnError {
  constructor(
    readonly status: number,
    readonly body: { code: string; message?: string },
  ) {}
}
const fail = (status: number, code: string, message?: string): never => {
  throw new TxnError(status, message ? { code, message } : { code });
};

interface FlagRec {
  transactionId: string;
  flag: 'investigation';
  reason: string;
  ticket: string | null;
  raisedBy: string;
  raisedAt: number;
  clearedBy: string | null;
  clearedAt: number | null;
  resolution: string | null;
}

interface OpsDb {
  version: number;
  seq: number;
  notes: (TxnNote & { transactionId: string })[];
  flags: FlagRec[];
  audit: TxnAuditEntry[];
}

interface Who {
  caller: TxnCaller;
  team: TxnTeam;
  countries: Set<string>;
}

interface Filters {
  flow: TxnFlow;
  type: PaymentType | null;
  country: string | null;
  currency: string | null;
  gmid: string | null;
  sub: string | null;
  method: string | null;
  provider: string | null;
  status: TxnStatus | null;
  flag: TxnFlag | null;
  amountMin: number | null;
  amountMax: number | null;
  from: number;
  to: number;
  q: string;
  sort: 'created' | 'amount' | 'updated';
  dir: 'asc' | 'desc';
}

export class TransactionServer {
  private readonly now: () => number;
  private cache: { key: string; tables: TxnTables } | null = null;

  constructor(private readonly opts: TransactionServerOptions) {
    this.now = opts.now ?? Date.now;
  }

  static handles(path: string) {
    return /^\/api\/transactions(\/|\?|$)/.test(path);
  }

  async handle(method: string, path: string, body: any, token: string | null, roleHeader: string | null): Promise<Reply> {
    const auth = await this.opts.auth.authenticate(token, 'internal');
    if (!auth.ok) return auth.response;
    try {
      const who = this.who(auth.caller, roleHeader);
      const [rawPath, rawQuery] = path.split('?');
      const q = new URLSearchParams(rawQuery ?? '');
      const [, , flowSeg, id, sub, action] = rawPath.split('/').filter(Boolean);
      const m = method.toUpperCase();
      const flow = TXN_FLOWS.includes(flowSeg as TxnFlow) ? (flowSeg as TxnFlow) : fail(404, 'NOT_FOUND');
      if (m === 'GET' && !id) return ok(this.list(who, flow, q));
      if (m === 'GET' && id === 'export' && !sub) return ok(this.export(who, flow, q));
      if (m === 'GET' && id && !sub) return ok(this.detail(who, flow, id));
      if (m === 'POST' && id && sub === 'notes' && !action) return ok(this.addNote(who, flow, id, body), 201);
      if (m === 'POST' && id && sub === 'flag' && !action) return ok(this.raiseFlag(who, flow, id, body), 201);
      if (m === 'POST' && id && sub === 'flag' && action === 'clear') return ok(this.clearFlag(who, flow, id, body));
      return fail(404, 'NOT_FOUND');
    } catch (e) {
      if (e instanceof TxnError) return { status: e.status, body: e.body };
      throw e;
    }
  }

  /** Prototype/QA: restores the demo state (notes, flags and the audit log). */
  resetAll() {
    this.opts.storage.removeItem(OPS_KEY);
    this.cache = null;
  }

  /** Prototype/QA: the transaction audit log, newest first. */
  auditLog(): TxnAuditEntry[] {
    return [...this.ops().audit].reverse();
  }

  // ------------------------------------------------------------- caller

  private who(caller: TxnCaller, roleHeader: string | null): Who {
    const fixed = this.opts.fixedTeams ?? true;
    const own = caller.team ?? 'sales';
    const switchable = !fixed || own === 'admin';
    const raw = switchable ? roleHeader || 'sales' : own;
    if (raw === 'security') fail(403, 'ROLE_NOT_PERMITTED', 'Security Admin has no access to transactions.');
    if (!VIEW_TEAMS.includes(raw as TxnTeam)) fail(403, 'ROLE_NOT_PERMITTED', 'Your team has no access to transactions.');
    return { caller, team: raw as TxnTeam, countries: new Set(caller.countries ?? ['MY', 'ID', 'VN']) };
  }

  // ------------------------------------------------------------- data

  private tables(): TxnTables {
    const sources = this.opts.sources();
    const day = new Date(this.now());
    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}|${hash(JSON.stringify(sources))}`;
    if (this.cache?.key !== key) this.cache = { key, tables: generateTables(sources, this.now()) };
    return this.cache.tables;
  }

  /** Rows of one flow visible at this moment (created before now). */
  private rows(flow: TxnFlow): TxnRecord[] {
    const now = this.now();
    return this.tables()[flow].filter((t) => t.createdAt <= now);
  }

  private find(flow: TxnFlow, id: string, countries: Set<string> | null, merchantId: string | null = null): TxnRecord {
    const t = this.tables().byId.get(String(id).toUpperCase());
    // Not found, another flow, a country outside the caller's access or another merchant: all look the same.
    if (!t || t.flow !== flow || t.createdAt > this.now() || (countries && !countries.has(t.country)) || (merchantId && t.gmid !== merchantId)) fail(404, 'NOT_FOUND', 'Transaction not found.');
    return t!;
  }

  private detailRec(t: TxnRecord): TxnDetailRecord | undefined {
    return this.tables().details[t.paymentType].get(t.id);
  }

  private ops(): OpsDb {
    try {
      const db = JSON.parse(this.opts.storage.getItem(OPS_KEY) ?? 'null') as OpsDb | null;
      if (db?.version === OPS_VERSION) return db;
    } catch {
      // Unreadable: start empty (sample data holds nothing else).
    }
    return { version: OPS_VERSION, seq: 0, notes: [], flags: [], audit: [] };
  }

  private saveOps(db: OpsDb) {
    this.opts.storage.setItem(OPS_KEY, JSON.stringify(db));
  }

  private audit(db: OpsDb, who: Who, transactionId: string | null, action: string, detail: string) {
    db.seq++;
    db.audit.push({ id: `TA-${db.seq}`, at: this.now(), actor: who.caller.name, team: TEAM_LABEL[who.team], transactionId, action, detail });
  }

  private openFlag(db: OpsDb, id: string) {
    return db.flags.find((f) => f.transactionId === id && !f.clearedAt) ?? null;
  }

  private flagsOf(t: TxnRecord, db: OpsDb): TxnFlag[] {
    const out: TxnFlag[] = [];
    if (this.openFlag(db, t.id)) out.push('investigation');
    if (t.lateSuccessAt !== null && t.lateSuccessAt <= this.now()) out.push('status_conflict');
    if (t.reasonCode === 'MOBI-SUSPENDED') out.push('merchant_suspended');
    return out;
  }

  // ------------------------------------------------------------- filters

  private filters(q: URLSearchParams, flow: TxnFlow, allowed: Set<string>, internal: boolean): Filters {
    const now = this.now();
    const range = (q.get('range') || '24h') as TxnRange;
    let from: number;
    let to = now;
    const startOfDay = (t: number) => {
      const d = new Date(t);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    switch (range) {
      case '1h':
        from = now - 3_600_000;
        break;
      case '24h':
        from = now - 86_400_000;
        break;
      case 'today':
        from = startOfDay(now);
        break;
      case '7d':
        from = startOfDay(now) - 6 * 86_400_000;
        break;
      case '30d':
        from = startOfDay(now) - 29 * 86_400_000;
        break;
      case 'custom': {
        const f = Date.parse(q.get('from') ?? '');
        const t = Date.parse(q.get('to') ?? '');
        if (!Number.isFinite(f) || !Number.isFinite(t) || f > t) fail(400, 'VALIDATION_FAILED', 'Choose a valid date range.');
        if (t - f > MAX_CUSTOM_DAYS * 86_400_000) fail(400, 'VALIDATION_FAILED', `Choose a range of ${MAX_CUSTOM_DAYS} days or less.`);
        from = f;
        to = t;
        break;
      }
      default:
        return fail(400, 'VALIDATION_FAILED', 'Unknown date range.');
    }
    const type = (q.get('type') || null) as PaymentType | null;
    if (type && !PAYMENT_TYPE_LABEL[flow][type]) fail(400, 'VALIDATION_FAILED', 'Unknown payment type.');
    const country = q.get('country')?.toUpperCase() || null;
    if (country && !allowed.has(country)) fail(400, 'VALIDATION_FAILED', 'Choose a country you can access.');
    const status = (q.get('status') || null) as TxnStatus | null;
    if (status && !TXN_STATUSES.includes(status)) fail(400, 'VALIDATION_FAILED', 'Unknown status.');
    const flag = internal ? ((q.get('flag') || null) as TxnFlag | null) : null;
    if (flag && !TXN_FLAG_LABEL[flag]) fail(400, 'VALIDATION_FAILED', 'Unknown flag.');
    const amt = (k: string) => {
      const v = q.get(k);
      if (v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) fail(400, 'VALIDATION_FAILED', 'Enter a valid amount.');
      return n;
    };
    const amountMin = amt('amountMin');
    const amountMax = amt('amountMax');
    const currency = q.get('currency')?.toUpperCase() || null;
    if ((amountMin !== null || amountMax !== null) && !currency && !country) fail(400, 'VALIDATION_FAILED', 'Choose one country or currency to filter by amount.');
    const search = (q.get('q') ?? '').trim().toUpperCase();
    if (search.length > 64 || /[^A-Z0-9-]/.test(search)) fail(400, 'VALIDATION_FAILED', 'IDs contain only letters, numbers and dashes.');
    const sort = (['created', 'amount', 'updated'].includes(q.get('sort') ?? '') ? q.get('sort') : 'created') as Filters['sort'];
    return {
      flow,
      type,
      country,
      currency,
      gmid: q.get('merchant') || null,
      sub: q.get('subMerchant') || null,
      method: q.get('method') || null,
      provider: internal ? q.get('provider') || null : null,
      status,
      flag,
      amountMin,
      amountMax,
      from,
      to,
      q: search,
      sort,
      dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
    };
  }

  /**
   * Applies the filters. An ID search (exact Transaction ID or Invoice ID) ignores every other
   * filter and the date range, so an ID always finds its record (SF-1); the caller's country scope
   * still applies.
   */
  private apply(rows: TxnRecord[], f: Filters, db: OpsDb | null, partialId = false): TxnRecord[] {
    const now = this.now();
    // The Merchant Portal keeps its partial Transaction ID match (My Transactions, Batch 4).
    if (f.q) return rows.filter((t) => (partialId ? t.id.includes(f.q) : t.id === f.q) || t.invoiceId.toUpperCase() === f.q).sort((a, b) => b.createdAt - a.createdAt);
    const out = rows.filter(
      (t) =>
        t.createdAt >= f.from &&
        t.createdAt <= f.to &&
        (!f.type || t.paymentType === f.type) &&
        (!f.country || t.country === f.country) &&
        (!f.currency || t.currency === f.currency) &&
        (!f.gmid || t.gmid === f.gmid) &&
        (!f.sub || (f.sub === 'master' ? t.subMerchantId === null : t.subMerchantId === f.sub)) &&
        (!f.method || t.methodCode === f.method) &&
        (!f.provider || t.providerId === f.provider) &&
        (!f.status || statusAt(t, now) === f.status) &&
        (f.amountMin === null || t.amount >= f.amountMin) &&
        (f.amountMax === null || t.amount <= f.amountMax) &&
        (!f.flag || (db !== null && this.flagsOf(t, db).includes(f.flag))),
    );
    const key = (t: TxnRecord) => (f.sort === 'amount' ? t.amount : f.sort === 'updated' ? updatedAt(t, now) : t.createdAt);
    const dir = f.dir === 'asc' ? 1 : -1;
    return out.sort((a, b) => (key(a) - key(b)) * dir || (b.createdAt - a.createdAt));
  }

  private page<T>(rows: T[], q: URLSearchParams) {
    const pageSize = Number(q.get('pageSize') ?? 25);
    const page = Number(q.get('page') ?? 1);
    if (!TXN_PAGE_SIZES.includes(pageSize) || !Number.isInteger(page) || page < 1) fail(400, 'VALIDATION_FAILED', 'Invalid page.');
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize };
  }

  // ------------------------------------------------------------- internal list

  private list(who: Who, flow: TxnFlow, q: URLSearchParams): TxnListResponse {
    const f = this.filters(q, flow, who.countries, true);
    const db = this.ops();
    const scoped = this.rows(flow).filter((t) => who.countries.has(t.country));
    const rows = this.apply(scoped, f, db);
    let otherFlowMatch: TxnFlow | null = null;
    if (f.q && !rows.length) {
      const other: TxnFlow = flow === 'payin' ? 'payout' : 'payin';
      if (this.apply(this.rows(other).filter((t) => who.countries.has(t.country)), f, null).length) otherFlowMatch = other;
    }
    const { items, page, pageSize } = this.page(rows, q);
    const seeFees = FEE_TEAMS.includes(who.team);
    const columns = f.type ? (TYPE_COLUMNS[flow][f.type] ?? []) : [];
    const now = this.now();
    return {
      items: items.map((t) => this.listRow(t, db, seeFees, columns.length ? f.type : null, now)),
      total: rows.length,
      page,
      pageSize,
      summary: summarise(rows, now),
      typeColumns: columns,
      options: this.options(scoped, f.country, flow),
      otherFlowMatch,
      can: { export: EXPORT_TEAMS.includes(who.team), seeFees },
      sampleData: true,
    };
  }

  private listRow(t: TxnRecord, db: OpsDb, seeFees: boolean, type: PaymentType | null, now: number): TxnListRow {
    const status = statusAt(t, now);
    const row: TxnListRow = {
      transactionId: t.id,
      invoiceId: t.invoiceId,
      flow: t.flow,
      createdAt: t.createdAt,
      updatedAt: updatedAt(t, now),
      completedAt: status === 'successful' || status === 'failed' || status === 'expired' ? t.finalAt : null,
      merchantName: t.merchantName,
      gmid: t.gmid,
      subMerchantName: t.subMerchantName,
      mid: t.subMerchantMid ?? t.masterMid,
      country: t.country,
      countryName: t.countryName,
      methodCode: t.methodCode,
      methodName: t.methodName,
      paymentType: t.paymentType,
      providerName: t.providerName,
      amount: t.amount,
      currency: t.currency,
      status,
      flags: this.flagsOf(t, db),
      ...(status === 'successful' && t.settlementHeld ? { settlementHeld: true } : {}),
    };
    if (seeFees) {
      row.fee = status === 'successful' ? t.fee : null;
      row.net = status === 'successful' && t.fee !== null ? netOf(t) : null;
    }
    if (type) row.typeValues = typeValues(this.detailRec(t));
    return row;
  }

  private options(rows: TxnRecord[], country: string | null, flow: TxnFlow) {
    const sources = this.opts.sources();
    const countries = new Map<string, { code: string; name: string; currency: string }>();
    const merchants = new Map<string, string>();
    const subs = new Map<string, { id: string; name: string; gmid: string }>();
    const methods = new Map<string, { code: string; name: string; type: PaymentType; country: string }>();
    const providers = new Map<string, string>();
    const types = new Set<PaymentType>();
    const allowed = new Set(rows.map((r) => r.country));
    for (const s of sources) {
      if (!allowed.has(s.country) && rows.length) continue;
      countries.set(s.country, { code: s.country, name: s.countryName, currency: s.currency });
      if (country && s.country !== country) continue;
      merchants.set(s.gmid, s.merchantName);
      if (flow === 'payin') for (const sm of s.subMerchants) subs.set(sm.id, { id: sm.id, name: sm.name, gmid: s.gmid });
      for (const p of s.products.filter((x) => x.flow === flow)) {
        const type = paymentTypeOf(p.methodCode, flow);
        methods.set(`${s.country}:${p.methodCode}`, { code: p.methodCode, name: p.methodName, type, country: s.country });
        types.add(type);
      }
    }
    for (const r of rows) if (!country || r.country === country) providers.set(r.providerId, r.providerName);
    return {
      countries: [...countries.values()].sort((a, b) => a.name.localeCompare(b.name)),
      merchants: [...merchants].map(([gmid, name]) => ({ gmid, name })).sort((a, b) => a.name.localeCompare(b.name)),
      subMerchants: [...subs.values()].sort((a, b) => a.name.localeCompare(b.name)),
      methods: dedupeMethods([...methods.values()]),
      providers: [...providers].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      paymentTypes: PAYMENT_TYPE_ORDER[flow].filter((t) => types.has(t)),
    };
  }

  // ------------------------------------------------------------- export

  private export(who: Who, flow: TxnFlow, q: URLSearchParams): TxnExport {
    if (!EXPORT_TEAMS.includes(who.team)) fail(403, 'ROLE_NOT_PERMITTED', 'Your team cannot export transactions.');
    const f = this.filters(q, flow, who.countries, true);
    const db = this.ops();
    const rows = this.apply(this.rows(flow).filter((t) => who.countries.has(t.country)), f, db);
    if (rows.length > MAX_EXPORT_ROWS) fail(413, 'EXPORT_TOO_LARGE', `Exports are limited to ${MAX_EXPORT_ROWS.toLocaleString('en-US')} rows. Narrow the filters and try again.`);
    const seeFees = FEE_TEAMS.includes(who.team);
    const now = this.now();
    const header = ['Created', 'Transaction ID', 'Invoice ID', 'Flow', 'Merchant', 'GMID', 'Sub-merchant', 'MID', 'Country', 'Payment type', 'Payment method', 'Provider', 'Amount', 'Currency', 'Status', 'Status reason', 'Completed', 'Last updated', 'Flags', 'Provider reference', 'Mobi request ID'];
    if (seeFees) header.push('Fee', flow === 'payin' ? 'Net amount' : 'Total debited', 'Pricing version', 'Technique');
    const iso = (t: number | null) => (t === null ? '' : new Date(t).toISOString());
    const lines = rows.map((t) => {
      const status = statusAt(t, now);
      const final = status === 'successful' || status === 'failed' || status === 'expired';
      const cells = [
        iso(t.createdAt),
        t.id,
        t.invoiceId,
        flow === 'payin' ? 'PayIn' : 'Payout',
        t.merchantName,
        t.gmid,
        t.subMerchantName ?? '',
        t.subMerchantMid ?? t.masterMid,
        t.countryName,
        PAYMENT_TYPE_LABEL[flow][t.paymentType] ?? '',
        t.methodName,
        t.providerName,
        t.amount.toFixed(dec(t.currency)),
        t.currency,
        TXN_STATUS_LABEL[status],
        final ? (t.reasonText ?? '') : '',
        iso(final ? t.finalAt : null),
        iso(updatedAt(t, now)),
        this.flagsOf(t, db).map((x) => TXN_FLAG_LABEL[x]).join('; '),
        t.sentAt !== null && t.sentAt <= now ? (t.providerReference ?? '') : '',
        t.mobiRequestId,
      ];
      if (seeFees) {
        const fee = status === 'successful' ? t.fee : null;
        cells.push(fee === null ? '' : fee.toFixed(dec(t.currency)), fee === null ? '' : netOf(t).toFixed(dec(t.currency)), t.pricing ? `v${t.pricing.version}` : '', t.pricing ? techniqueLabel(t.pricing.technique) : '');
      }
      return cells;
    });
    const csv = [header, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const d = new Date(now);
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    const scope = f.country ? f.country.toLowerCase() : 'global';
    this.audit(db, who, null, 'Exported transactions', `${flow === 'payin' ? 'PayIn' : 'Payout'} · ${rows.length} rows · ${describeFilters(f)}`);
    this.saveOps(db);
    return { filename: `mobi-transactions-${flow}-${scope}-${stamp}.csv`, csv, rows: rows.length };
  }

  // ------------------------------------------------------------- details

  private detail(who: Who, flow: TxnFlow, id: string): TxnDetail {
    const t = this.find(flow, id, who.countries);
    const db = this.ops();
    this.audit(db, who, t.id, 'Viewed details', 'Opened the transaction details, including references.');
    this.saveOps(db);
    const now = this.now();
    const status = statusAt(t, now);
    const d = this.detailRec(t);
    const seeFees = FEE_TEAMS.includes(who.team);
    const seeDevice = DEVICE_TEAMS.includes(who.team);
    const sections: DetailSection[] = [];
    const final = status === 'successful' || status === 'failed' || status === 'expired';

    if (flow === 'payin') {
      const c = t.customer;
      const fields: DetailField[] = [];
      if (c.name) fields.push({ label: 'Customer name', value: c.name });
      if (c.reference) fields.push({ label: 'Customer reference', value: c.reference });
      if (c.email) fields.push({ label: 'Customer email', value: maskEmail(c.email) });
      if (c.phone) fields.push({ label: 'Customer phone', value: maskPhone(c.phone) });
      fields.push({ label: 'Payment details', value: paymentDetails(t, d) });
      if (seeDevice && c.ip) fields.push({ label: 'IP address', value: c.ip, restricted: 'Risk · Mobi Support' });
      if (seeDevice && c.device) fields.push({ label: 'Device', value: c.device, restricted: 'Risk · Mobi Support' });
      sections.push({ key: 'customer', title: 'Customer', fields });
    }

    const ipnStatus = ipnState(t, now);
    sections.push({
      key: 'merchant',
      title: 'Merchant',
      fields: compact([
        { label: 'Merchant', value: t.merchantName, link: { kind: 'merchant', id: t.gmid } },
        { label: 'GMID', value: t.gmid },
        t.subMerchantName ? { label: 'Sub-merchant', value: t.subMerchantName } : null,
        { label: 'MID', value: t.subMerchantMid ?? t.masterMid },
        t.subMerchantMid ? { label: 'Master MID', value: t.masterMid } : null,
        { label: 'Country', value: t.countryName },
        { label: 'Channel', value: t.channel },
        { label: 'Invoice ID', value: t.invoiceId },
        t.description ? { label: 'Description', value: t.description } : null,
        { label: 'IPN status', value: ipnStatus.text, tone: ipnStatus.tone },
        { label: 'IPN callback URL', value: this.ipnUrl(t) || '—' },
      ]),
    });

    const mobi: (DetailField | null)[] = [{ label: 'Amount', value: fmtMoney(t.amount, t.currency) }];
    if (seeFees) {
      const fee = status === 'successful' ? t.fee : null;
      mobi.push({ label: 'Fee', value: fee === null ? '—' : fmtMoney(fee, t.currency) });
      mobi.push({ label: flow === 'payin' ? 'Net amount' : 'Total debited', value: fee === null ? '—' : fmtMoney(netOf(t), t.currency) });
      if (t.pricing) {
        const v = t.pricing.summary;
        mobi.push({ label: 'Pricing version', value: `v${t.pricing.version} · ${t.pricing.level === 'sub_merchant' ? t.subMerchantName : 'Master Merchant'}`, link: { kind: 'pricing', id: t.applicationId } });
        mobi.push({ label: 'Technique', value: techniqueLabel(t.pricing.technique) });
        mobi.push({ label: 'Rate', value: pricingSummary(v).replace(/^[^:]*:\s*/, '') });
        if (v.usd) {
          mobi.push({ label: 'USD fee', value: `USD ${v.usd.fixedFeeUsd}` });
          mobi.push({ label: 'FX rate', value: `${v.usd.usdExchangeRate} ${t.currency}/USD` });
          mobi.push({ label: 'Rate date', value: v.approvedAt ? fmtDate(v.approvedAt) : fmtDate(v.createdAt) });
          mobi.push({ label: 'Rate source', value: 'Prototype static rate' });
        }
      } else {
        mobi.push({ label: 'Pricing version', value: 'No pricing in effect' });
      }
    }
    if (flow === 'payin') {
      const settle = settlementOf(t, status);
      mobi.push({ label: 'Settlement cycle', value: t.settlementCycle ?? '—' }, { label: 'Expected settlement date', value: settle.expected }, { label: 'Settlement status', value: settle.status }, { label: 'Settlement reference', value: '—' });
    }
    if (final && t.reasonText) mobi.push({ label: 'Status reason', value: t.reasonCode ? `${t.reasonCode} · ${t.reasonText}` : t.reasonText, tone: status === 'expired' ? 'warning' : 'danger' });
    if (t.expiresAt) mobi.push({ label: 'Expires', value: fmtDateTime(t.expiresAt) });
    mobi.push({ label: 'Mobi request ID', value: t.mobiRequestId }, { label: 'Last updated', value: fmtDateTime(updatedAt(t, now)) });
    sections.push({ key: 'mobi', title: 'Mobi', fields: compact(mobi) });

    const sent = t.sentAt !== null && t.sentAt <= now;
    sections.push({
      key: 'provider',
      title: 'Provider',
      fields: compact([
        { label: 'Provider', value: t.providerName },
        { label: 'Provider reference', value: sent ? (t.providerReference ?? '—') : 'Not sent' },
        { label: 'Provider response code', value: final && t.providerResponse ? t.providerResponse.code : '—' },
        { label: 'Provider response message', value: final && t.providerResponse ? t.providerResponse.message : '—' },
        { label: 'Sent to provider at', value: sent ? fmtDateTime(t.sentAt!, true) : '—' },
      ]),
    });

    const bank = bankFields(t, d, status, true);
    sections.push({ key: 'bank', title: 'Bank', fields: bank });
    if (flow === 'payout') sections.splice(0, 0, { key: 'beneficiary', title: 'Beneficiary', fields: beneficiaryFields(d) });
    const methodFields = methodDetailFields(d);
    if (methodFields.length) sections.push({ key: 'method', title: `${PAYMENT_TYPE_LABEL[flow][t.paymentType]} details`, fields: methodFields });

    const open = this.openFlag(db, t.id);
    const flags = [];
    if (open) flags.push({ flag: 'investigation' as TxnFlag, label: TXN_FLAG_LABEL.investigation, reason: open.reason, ticket: open.ticket, raisedBy: open.raisedBy, raisedAt: open.raisedAt });
    if (t.lateSuccessAt !== null && t.lateSuccessAt <= now) flags.push({ flag: 'status_conflict' as TxnFlag, label: TXN_FLAG_LABEL.status_conflict, reason: 'The provider reported Successful after the transaction expired. Not applied: check with the provider.', ticket: null, raisedBy: 'System', raisedAt: t.lateSuccessAt });

    const writable = !who.caller.readOnly;
    return {
      transactionId: t.id,
      invoiceId: t.invoiceId,
      flow,
      status,
      statusReason: final ? t.reasonText : null,
      amount: t.amount,
      currency: t.currency,
      methodName: t.methodName,
      paymentTypeLabel: PAYMENT_TYPE_LABEL[flow][t.paymentType] ?? '',
      countryName: t.countryName,
      createdAt: t.createdAt,
      completedAt: final ? t.finalAt : null,
      path: internalPath(t, d, now),
      sections,
      timeline: internalTimeline(t, now),
      ipn: { status: ipnStatus.text, url: this.ipnUrl(t), attempts: ipnAttempts(t, now) },
      notes: db.notes.filter((n) => n.transactionId === t.id).map(({ transactionId, ...n }) => n).reverse(),
      flags,
      audit: db.audit.filter((a) => a.transactionId === t.id).reverse(),
      can: { addNote: writable, flag: writable },
      sampleData: true,
    };
  }

  private ipnUrl(t: TxnRecord) {
    return this.opts.sources().find((s) => s.applicationId === t.applicationId)?.ipnCallbackUrl ?? '';
  }

  // ------------------------------------------------------------- notes and flags

  private writable(who: Who) {
    if (who.caller.readOnly) fail(403, 'ROLE_NOT_PERMITTED', 'Viewers can’t add notes or flags.');
  }

  private addNote(who: Who, flow: TxnFlow, id: string, body: any) {
    this.writable(who);
    const t = this.find(flow, id, who.countries);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) fail(422, 'VALIDATION_FAILED', 'Enter a note.');
    if (text.length > 1000) fail(422, 'VALIDATION_FAILED', 'Keep the note to 1,000 characters.');
    const db = this.ops();
    db.seq++;
    const note = { id: `TN-${db.seq}`, transactionId: t.id, at: this.now(), by: who.caller.name, team: TEAM_LABEL[who.team], text };
    db.notes.push(note);
    this.audit(db, who, t.id, 'Added a note', text.length > 120 ? `${text.slice(0, 117)}…` : text);
    this.saveOps(db);
    const { transactionId, ...view } = note;
    return view;
  }

  private raiseFlag(who: Who, flow: TxnFlow, id: string, body: any) {
    this.writable(who);
    const t = this.find(flow, id, who.countries);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const ticket = typeof body?.ticket === 'string' ? body.ticket.trim().slice(0, 60) : '';
    if (!reason) fail(422, 'VALIDATION_FAILED', 'Enter a reason for the investigation.');
    if (reason.length > 500) fail(422, 'VALIDATION_FAILED', 'Keep the reason to 500 characters.');
    const db = this.ops();
    if (this.openFlag(db, t.id)) fail(409, 'ALREADY_FLAGGED', 'This transaction is already under investigation.');
    db.flags.push({ transactionId: t.id, flag: 'investigation', reason, ticket: ticket || null, raisedBy: who.caller.name, raisedAt: this.now(), clearedBy: null, clearedAt: null, resolution: null });
    this.audit(db, who, t.id, 'Flagged for investigation', `${reason}${ticket ? ` · Ticket ${ticket}` : ''}`);
    this.saveOps(db);
    return { ok: true };
  }

  private clearFlag(who: Who, flow: TxnFlow, id: string, body: any) {
    this.writable(who);
    const t = this.find(flow, id, who.countries);
    const resolution = typeof body?.resolution === 'string' ? body.resolution.trim() : '';
    if (!resolution) fail(422, 'VALIDATION_FAILED', 'Enter a resolution note.');
    if (resolution.length > 500) fail(422, 'VALIDATION_FAILED', 'Keep the resolution to 500 characters.');
    const db = this.ops();
    const open = this.openFlag(db, t.id);
    if (!open) fail(409, 'NOT_FLAGGED', 'This transaction is not under investigation.');
    open!.clearedAt = this.now();
    open!.clearedBy = who.caller.name;
    open!.resolution = resolution;
    this.audit(db, who, t.id, 'Cleared the investigation flag', resolution);
    this.saveOps(db);
    return { ok: true };
  }

  // ------------------------------------------------------------- merchant portal

  /** The merchant's own transactions (newest first), for the Dashboard. */
  merchantRows(merchantId: string, flow: TxnFlow): { createdAt: number; status: TxnStatus; amount: number; net: number | null; currency: string }[] {
    const now = this.now();
    return this.rows(flow)
      .filter((t) => t.gmid === merchantId)
      .map((t) => {
        const status = statusAt(t, now);
        return { createdAt: t.createdAt, status, amount: t.amount, net: status === 'successful' && t.fee !== null ? netOf(t) : null, currency: t.currency };
      });
  }

  merchantList(merchantId: string, flow: TxnFlow, q: URLSearchParams): MerchantTxnListResponse {
    const mine = this.rows(flow).filter((t) => t.gmid === merchantId);
    const countries = new Set(mine.map((t) => t.country));
    const f = this.filters(q, flow, countries.size ? countries : new Set(['MY', 'ID', 'VN']), false);
    f.gmid = null;
    const rows = this.apply(mine, f, null, true);
    const { items, page, pageSize } = this.page(rows, q);
    const now = this.now();
    const sources = this.opts.sources().filter((s) => s.gmid === merchantId);
    const methods = new Map<string, { code: string; name: string; type: PaymentType; country: string }>();
    const types = new Set<PaymentType>();
    for (const s of sources) {
      if (f.country && s.country !== f.country) continue;
      for (const p of s.products.filter((x) => x.flow === flow)) {
        const type = paymentTypeOf(p.methodCode, flow);
        methods.set(`${s.country}:${p.methodCode}`, { code: p.methodCode, name: p.methodName, type, country: s.country });
        types.add(type);
      }
    }
    const ok = rows.filter((t) => statusAt(t, now) === 'successful');
    return {
      items: items.map((t) => merchantRow(t, now)),
      total: rows.length,
      page,
      pageSize,
      summary: {
        total: rows.length,
        successful: ok.length,
        gross: sumBy(ok, (t) => t.amount),
        fees: sumBy(ok, (t) => t.fee ?? 0),
        net: sumBy(ok, (t) => (t.fee === null ? t.amount : netOf(t))),
      },
      options: {
        countries: sources.map((s) => ({ code: s.country, name: s.countryName, currency: s.currency })),
        subMerchants: flow === 'payin' ? sources.filter((s) => !f.country || s.country === f.country).flatMap((s) => s.subMerchants.map((sm) => ({ id: sm.id, name: sm.name }))) : [],
        methods: dedupeMethods([...methods.values()]),
        paymentTypes: PAYMENT_TYPE_ORDER[flow].filter((t) => types.has(t)),
      },
      sampleData: true,
    };
  }

  merchantExport(merchantId: string, merchantName: string, flow: TxnFlow, q: URLSearchParams): TxnExport {
    const mine = this.rows(flow).filter((t) => t.gmid === merchantId);
    const f = this.filters(q, flow, new Set(mine.map((t) => t.country)), false);
    const rows = this.apply(mine, f, null, true);
    if (rows.length > MAX_EXPORT_ROWS) fail(413, 'EXPORT_TOO_LARGE', `Exports are limited to ${MAX_EXPORT_ROWS.toLocaleString('en-US')} rows. Narrow the filters and try again.`);
    const now = this.now();
    const header = ['Date & Time', 'Invoice ID', 'Transaction ID', 'Flow', 'Sub-merchant', 'Payment Method', 'Amount', 'Fee', flow === 'payin' ? 'Net Amount' : 'Total Debited', 'Currency', 'Status'];
    const lines = rows.map((t) => {
      const r = merchantRow(t, now);
      return [localDateTime(t.createdAt), t.invoiceId, t.id, flow === 'payin' ? 'PayIn' : 'Payout', t.subMerchantName ?? '', t.methodName, t.amount.toFixed(dec(t.currency)), r.fee === null ? '' : r.fee.toFixed(dec(t.currency)), r.net === null ? '' : r.net.toFixed(dec(t.currency)), t.currency, TXN_STATUS_LABEL[r.status]];
    });
    const csv = [header, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const d = new Date(now);
    return { filename: `${slug(merchantName)}-${flow}-transactions-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.csv`, csv, rows: rows.length };
  }

  merchantDetail(merchantId: string, flow: TxnFlow, id: string): MerchantTxnDetail {
    const t = this.find(flow, id, null, merchantId);
    const now = this.now();
    const status = statusAt(t, now);
    const d = this.detailRec(t);
    const final = status === 'successful' || status === 'failed' || status === 'expired';
    const fee = status === 'successful' ? t.fee : null;
    const sections: DetailSection[] = [
      {
        key: 'payment',
        title: flow === 'payin' ? 'Payment' : 'Payout',
        fields: compact([
          { label: 'Transaction ID', value: t.id },
          { label: 'Invoice ID', value: t.invoiceId },
          { label: 'Status', value: TXN_STATUS_LABEL[status] },
          final && t.merchantReason && status !== 'successful' ? { label: 'Reason', value: t.merchantReason, tone: status === 'expired' ? 'warning' : 'danger' } : null,
          { label: 'Payment method', value: t.methodName },
          { label: 'Created', value: fmtDateTime(t.createdAt) },
          { label: 'Completed', value: final ? fmtDateTime(t.finalAt) : '—' },
          t.subMerchantName ? { label: 'Sub-merchant', value: t.subMerchantName } : null,
          { label: 'MID', value: t.subMerchantMid ?? t.masterMid },
          { label: 'Channel', value: t.channel },
          t.description ? { label: 'Description', value: t.description } : null,
        ]),
      },
      {
        key: 'fees',
        title: 'Amount and fees',
        fields: [
          { label: 'Amount', value: fmtMoney(t.amount, t.currency) },
          { label: 'Fee', value: fee === null ? '—' : `${flow === 'payin' ? '− ' : '+ '}${fmtMoney(fee, t.currency)}` },
          { label: flow === 'payin' ? 'Net amount' : 'Total debited', value: fee === null ? '—' : fmtMoney(netOf(t), t.currency) },
        ],
      },
    ];
    if (flow === 'payin') {
      const c = t.customer;
      // The merchant sent these details, so it sees them in full.
      const fields = compact([
        c.name ? { label: 'Customer name', value: c.name } : null,
        c.reference ? { label: 'Customer reference', value: c.reference } : null,
        c.email ? { label: 'Customer email', value: c.email } : null,
        c.phone ? { label: 'Customer phone', value: c.phone } : null,
        { label: 'Payment details', value: paymentDetails(t, d) },
      ]);
      sections.push({ key: 'customer', title: 'Customer', fields });
    } else {
      sections.push({ key: 'beneficiary', title: 'Beneficiary', fields: beneficiaryFields(d) });
    }
    sections.push({ key: 'bank', title: 'Bank', fields: bankFields(t, d, status, false) });
    if (flow === 'payin') {
      const settle = settlementOf(t, status, true);
      sections.push({ key: 'settlement', title: 'Settlement', fields: [{ label: 'Settlement cycle', value: t.settlementCycle ?? '—' }, { label: 'Expected settlement date', value: settle.expected }, { label: 'Settlement status', value: settle.status }, { label: 'Settlement reference', value: '—' }] });
    }
    return {
      transactionId: t.id,
      invoiceId: t.invoiceId,
      flow,
      status,
      statusReason: final && status !== 'successful' ? t.merchantReason : null,
      amount: t.amount,
      currency: t.currency,
      methodName: t.methodName,
      countryName: t.countryName,
      createdAt: t.createdAt,
      completedAt: final ? t.finalAt : null,
      sections,
      timeline: merchantTimeline(t, now),
      ipn: { status: ipnState(t, now).text, attempts: ipnAttempts(t, now) },
      sampleData: true,
    };
  }
}

// ------------------------------------------------------------------ views

function ok(body: unknown, status = 200): Reply {
  return { status, body };
}

function compact(fields: (DetailField | null)[]): DetailField[] {
  return fields.filter((f): f is DetailField => !!f);
}

const dec = (cur: string) => (cur === 'IDR' || cur === 'VND' ? 0 : 2);
const p2 = (n: number) => String(n).padStart(2, '0');
const hm = (t: number) => {
  const d = new Date(t);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** Pay-in: amount minus fee (net to the merchant). Payout: amount plus fee (total debited). */
function netOf(t: TxnRecord) {
  const fee = t.fee ?? 0;
  const raw = t.flow === 'payin' ? t.amount - fee : t.amount + fee;
  return Math.round(raw * 10 ** dec(t.currency)) / 10 ** dec(t.currency);
}

function dedupeMethods(list: { code: string; name: string; type: PaymentType; country: string }[]) {
  const seen = new Map<string, { code: string; name: string; type: PaymentType; country: string }>();
  for (const m of list) if (!seen.has(m.code)) seen.set(m.code, m);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function sumBy(rows: TxnRecord[], fn: (t: TxnRecord) => number): CurrencyAmount[] {
  const m = new Map<string, number>();
  for (const t of rows) m.set(t.currency, (m.get(t.currency) ?? 0) + fn(t));
  return [...m].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 10 ** dec(currency)) / 10 ** dec(currency) }));
}

function summarise(rows: TxnRecord[], now: number): TxnSummary {
  const byStatus = Object.fromEntries(TXN_STATUSES.map((s) => [s, { count: 0, amounts: [] as CurrencyAmount[] }])) as TxnSummary['byStatus'];
  const groups = new Map<TxnStatus, TxnRecord[]>();
  for (const t of rows) {
    const s = statusAt(t, now);
    groups.set(s, [...(groups.get(s) ?? []), t]);
  }
  for (const [s, list] of groups) byStatus[s] = { count: list.length, amounts: sumBy(list, (t) => t.amount) };
  return { total: rows.length, totalAmounts: sumBy(rows, (t) => t.amount), byStatus };
}

function merchantRow(t: TxnRecord, now: number): MerchantTxnRow {
  const status = statusAt(t, now);
  const fee = status === 'successful' ? t.fee : null;
  return {
    transactionId: t.id,
    invoiceId: t.invoiceId,
    flow: t.flow,
    createdAt: t.createdAt,
    subMerchantName: t.subMerchantName,
    methodCode: t.methodCode,
    methodName: t.methodName,
    paymentType: t.paymentType,
    amount: t.amount,
    fee,
    net: fee === null ? null : netOf(t),
    currency: t.currency,
    status,
    note: t.reasonCode === 'MOBI-SUSPENDED' && status === 'failed' ? 'Payments are paused' : status === 'successful' && t.settlementHeld ? 'Settlement paused' : null,
  };
}

function maskEmail(e: string) {
  const [user, domain] = e.split('@');
  return `${user[0]}•••••@${domain}`;
}

function maskPhone(p: string) {
  const parts = p.split(' ');
  const last = parts.pop() ?? '';
  return `${parts[0] ?? ''} ••• ••• ${last}`.trim();
}

function paymentDetails(t: TxnRecord, d: TxnDetailRecord | undefined): string {
  if (!d) return t.methodName;
  switch (d.type) {
    case 'cards':
      return `${d.brand} •••• ${d.last4}`;
    case 'ewallet':
      return `${d.wallet} ${d.walletAccount}`;
    case 'online_banking':
      return `${t.methodName} · ${d.bank}`;
    case 'qr':
      return `${d.qrType} · ${d.payerApp}`;
    case 'virtual_account':
      return `VA ${d.vaBank} ${d.vaNumber}`;
    case 'otc':
      return `${t.methodName} · ${d.outlet}`;
    case 'bank_transfer':
      return `${t.methodName} · ${d.bank}`;
  }
}

function typeValues(d: TxnDetailRecord | undefined): Record<string, string> {
  if (!d) return {};
  switch (d.type) {
    case 'online_banking':
      return { bank: d.bank, fpxTransactionId: d.fpxTransactionId };
    case 'ewallet':
      return { wallet: d.wallet, walletAccount: d.walletAccount };
    case 'qr':
      return { payerApp: d.payerApp };
    case 'cards':
      return { card: `${d.brand} •••• ${d.last4}`, approvalCode: d.approvalCode ?? '—' };
    case 'virtual_account':
      return { vaBank: d.vaBank, vaNumber: d.vaNumber };
    case 'otc':
      return { paymentCode: d.paymentCode };
    case 'bank_transfer':
      return { bank: d.bank, beneficiaryBank: d.bank, beneficiaryAccount: d.beneficiaryAccount ?? '—' };
  }
}

function beneficiaryFields(d: TxnDetailRecord | undefined): DetailField[] {
  if (d?.type === 'bank_transfer') return compact([d.beneficiaryName ? { label: 'Beneficiary name', value: d.beneficiaryName } : null, { label: 'Beneficiary bank', value: d.bank }, { label: 'Beneficiary account', value: d.beneficiaryAccount ?? '—' }]);
  if (d?.type === 'ewallet') return compact([d.beneficiaryName ? { label: 'Beneficiary name', value: d.beneficiaryName } : null, { label: 'Wallet', value: d.wallet }, { label: 'Wallet account', value: d.walletAccount }]);
  return [];
}

/** Bank section: the bank (or wallet issuer) on the customer's or beneficiary's side. */
function bankFields(t: TxnRecord, d: TxnDetailRecord | undefined, status: TxnStatus, internal: boolean): DetailField[] {
  let bank = '—';
  let ref: string | null = null;
  let approval: string | null = null;
  if (d) {
    switch (d.type) {
      case 'cards':
        bank = `${d.issuer} (card issuer)`;
        ref = d.rrn;
        approval = d.approvalCode;
        break;
      case 'online_banking':
        bank = d.bank;
        ref = d.fpxTransactionId;
        break;
      case 'ewallet':
        bank = `${d.wallet} (wallet issuer)`;
        ref = d.walletTransactionId;
        break;
      case 'qr':
        bank = d.payerApp;
        ref = d.qrReference;
        break;
      case 'virtual_account':
        bank = d.vaBank;
        ref = d.vaNumber;
        break;
      case 'otc':
        bank = d.outlet;
        ref = d.paymentCode;
        break;
      case 'bank_transfer':
        bank = d.bank;
        ref = d.transferReference;
        break;
    }
  }
  const reached = status === 'successful' || (status === 'failed' && t.failStage === 'bank');
  return compact([
    { label: 'Bank', value: bank },
    { label: 'Payment reference', value: reached || d?.type === 'virtual_account' || d?.type === 'otc' ? (ref ?? '—') : '—' },
    d?.type === 'cards' ? { label: 'Approval code', value: approval ?? '—' } : null,
    internal ? { label: 'Bank response code', value: reached && t.bankResponse ? `${t.bankResponse.code} · ${t.bankResponse.message}` : '—' } : null,
  ]);
}

function methodDetailFields(d: TxnDetailRecord | undefined): DetailField[] {
  if (!d) return [];
  switch (d.type) {
    case 'cards':
      return [
        { label: 'Card brand', value: d.brand },
        { label: 'Last 4 digits', value: d.last4 },
        { label: 'Card type', value: d.cardType },
        { label: 'Issuer', value: d.issuer },
        { label: 'Issuer country', value: d.issuerCountry },
        { label: '3-D Secure', value: d.threeDs },
        { label: 'Approval code', value: d.approvalCode ?? '—' },
        { label: 'RRN', value: d.rrn },
      ];
    case 'online_banking':
      return [
        { label: 'Buyer bank', value: d.bank },
        { label: 'FPX transaction ID', value: d.fpxTransactionId },
      ];
    case 'ewallet':
      return [
        { label: 'Wallet', value: d.wallet },
        { label: 'Wallet account', value: d.walletAccount },
        { label: 'Wallet transaction ID', value: d.walletTransactionId },
      ];
    case 'qr':
      return [
        { label: 'QR type', value: d.qrType },
        { label: 'Payer app / bank', value: d.payerApp },
        { label: 'QR reference', value: d.qrReference },
      ];
    case 'virtual_account':
      return [
        { label: 'VA bank', value: d.vaBank },
        { label: 'VA number', value: d.vaNumber },
      ];
    case 'otc':
      return [
        { label: 'Outlet', value: d.outlet },
        { label: 'Payment code', value: d.paymentCode },
      ];
    case 'bank_transfer':
      return [
        { label: 'Bank', value: d.bank },
        { label: 'Bank transfer reference', value: d.transferReference },
      ];
  }
}

function settlementOf(t: TxnRecord, status: TxnStatus, merchant = false): { expected: string; status: string } {
  if (status === 'successful' && t.settlementHeld) return { expected: '—', status: merchant ? 'Settlement paused' : 'On hold (merchant suspended)' };
  if (status !== 'successful' || !t.settlementCycle) return { expected: '—', status: status === 'successful' ? 'Not settled yet' : 'Not applicable' };
  const days = Number(t.settlementCycle.replace('T+', '')) || 0;
  const d = new Date(t.finalAt);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return { expected: fmtDate(d.getTime()), status: 'Not settled yet' };
}

function ipnAttempts(t: TxnRecord, now: number): IpnAttempt[] {
  if (now < t.finalAt) return [];
  const gaps = [2_000, 60_000, 300_000];
  return t.ipn
    .map((code, i) => ({ attempt: i + 1, at: t.finalAt + gaps[i], httpStatus: code, ok: code !== null && code < 300, result: code === null ? 'Timed out' : code < 300 ? `${code} · Delivered` : `${code} · Failed` }))
    .filter((a) => a.at <= now);
}

function ipnState(t: TxnRecord, now: number): { text: string; tone?: 'success' | 'danger' | 'warning' } {
  const attempts = ipnAttempts(t, now);
  if (!attempts.length) return { text: now < t.finalAt ? 'No notification yet (not final)' : 'Sending' };
  const last = attempts[attempts.length - 1];
  if (last.ok) return { text: `Delivered · attempt ${last.attempt} of ${t.ipn.length}`, tone: 'success' };
  if (attempts.length === t.ipn.length) return { text: `Failed after ${attempts.length} attempts`, tone: 'danger' };
  return { text: `Retrying · attempt ${last.attempt} failed`, tone: 'warning' };
}

function internalPath(t: TxnRecord, d: TxnDetailRecord | undefined, now: number): PathStep[] {
  const status = statusAt(t, now);
  const ipn = ipnState(t, now);
  const s = (key: PathStepKey, state: PathStep['state'], caption: string): PathStep => ({ key, state, caption });
  const reason = `${t.reasonCode && !t.reasonCode.startsWith('MOBI') && t.reasonCode !== 'CANCELLED' ? `${t.reasonCode} · ` : ''}${t.reasonText ?? ''}`;
  if (t.flow === 'payout') {
    const merchant = s('merchant', 'done', 'Request received');
    const done = status === 'successful';
    const mobi = s('mobi', status === 'pending' ? 'current' : 'done', status === 'pending' ? 'Sending' : `Sent ${hm(t.sentAt!)}`);
    const provider = s('provider', status === 'processing' ? 'current' : status === 'failed' && t.failStage === 'provider' ? 'failed' : status === 'pending' ? 'off' : 'done', status === 'processing' ? 'Awaiting result' : status === 'failed' && t.failStage === 'provider' ? reason : status === 'pending' ? '—' : 'Forwarded');
    const bank = s('bank', done ? 'done' : status === 'failed' && t.failStage === 'bank' ? 'failed' : 'off', done ? 'Credited' : status === 'failed' && t.failStage === 'bank' ? reason : '—');
    const ben = s('customer', done ? 'done' : 'off', done ? `Paid ${hm(t.finalAt)}` : '—');
    return [merchant, mobi, provider, bank, ben];
  }
  const merchant = s('merchant', 'done', status === 'successful' || status === 'failed' ? (ipn.tone === 'danger' ? 'IPN failed' : ipn.tone === 'success' ? 'IPN delivered' : 'Request received') : 'Request received');
  switch (status) {
    case 'pending':
      return [s('customer', 'current', t.expiresAt ? `Waiting · expires ${hm(t.expiresAt)}` : 'Waiting for payment'), merchant, s('mobi', 'done', 'Created'), s('provider', 'off', '—'), s('bank', 'off', '—')];
    case 'processing':
      return [s('customer', 'done', 'Paid'), merchant, s('mobi', 'done', `Sent ${hm(t.sentAt!)}`), s('provider', 'current', 'Awaiting result'), s('bank', 'off', '—')];
    case 'successful':
      return [s('customer', 'done', `Paid ${hm(t.sentAt!)}`), merchant, s('mobi', 'done', hm(t.sentAt!)), s('provider', 'done', `Approved ${hm(t.finalAt)}`), s('bank', 'done', 'Confirmed')];
    case 'expired':
      return [s('customer', 'expired', `Not paid by ${hm(t.finalAt)}`), merchant, s('mobi', 'done', `Expired ${hm(t.finalAt)}`), s('provider', 'off', '—'), s('bank', 'off', '—')];
    case 'failed':
      if (t.failStage === 'mobi') return [s('customer', 'done', 'Checkout'), merchant, s('mobi', 'failed', reason), s('provider', 'off', 'Not sent'), s('bank', 'off', '—')];
      if (t.failStage === 'customer') return [s('customer', 'failed', 'Cancelled'), merchant, s('mobi', 'done', 'Created'), s('provider', 'done', 'Forwarded'), s('bank', 'off', '—')];
      if (t.failStage === 'provider') return [s('customer', 'done', 'Paid'), merchant, s('mobi', 'done', `Sent ${hm(t.sentAt!)}`), s('provider', 'failed', reason), s('bank', 'off', '—')];
      return [s('customer', 'done', d?.type === 'cards' ? 'Card entered' : 'Paid'), merchant, s('mobi', 'done', `Sent ${hm(t.sentAt!)}`), s('provider', 'done', 'Forwarded'), s('bank', 'failed', reason)];
  }
}

function internalTimeline(t: TxnRecord, now: number): TimelineEntry[] {
  const out: TimelineEntry[] = [{ at: t.createdAt, title: 'Created', from: null, to: 'pending', source: 'Merchant request', detail: `Received through ${t.channel}.` }];
  if (t.failStage === 'mobi') {
    if (now >= t.finalAt) out.push({ at: t.finalAt, title: 'Stopped by Mobi', from: 'pending', to: 'failed', source: 'Mobi check', detail: t.reasonText ?? '' });
  } else if (t.outcome === 'expired') {
    if (now >= t.finalAt) out.push({ at: t.finalAt, title: 'Expired', from: 'pending', to: 'expired', source: 'Expiry job', detail: 'No payment within the validity window.' });
    if (t.lateSuccessAt !== null && now >= t.lateSuccessAt) out.push({ at: t.lateSuccessAt, title: 'Late success not applied', source: 'Provider callback', detail: 'The provider reported Successful after the transaction expired. Flagged as a status conflict for review.' });
  } else {
    if (t.sentAt !== null && now >= t.sentAt) {
      out.push(t.flow === 'payin' ? { at: t.sentAt, title: t.failStage === 'customer' ? 'Customer redirected to pay' : 'Customer paid', from: 'pending', to: 'processing', source: 'Customer', detail: `Sent to ${t.providerName}.` } : { at: t.sentAt, title: 'Sent to provider', from: 'pending', to: 'processing', source: 'Mobi', detail: t.providerName });
    }
    if (now >= t.finalAt) {
      const from: TxnStatus = 'processing';
      if (t.outcome === 'successful') out.push({ at: t.finalAt, title: 'Confirmed', from, to: 'successful', source: 'Provider callback', detail: t.providerResponse ? `${t.providerResponse.code} · ${t.providerResponse.message}` : '' });
      else out.push({ at: t.finalAt, title: t.failStage === 'customer' ? 'Cancelled by customer' : 'Declined', from, to: 'failed', source: 'Provider callback', detail: `${t.reasonCode ?? ''} · ${t.reasonText ?? ''}` });
    }
  }
  return out.reverse();
}

function merchantTimeline(t: TxnRecord, now: number): TimelineEntry[] {
  const status = statusAt(t, now);
  const out: TimelineEntry[] = [{ at: t.createdAt, title: 'Created', source: '' }];
  if (status === 'successful') {
    out.push({ at: t.finalAt, title: t.flow === 'payin' ? 'Paid' : 'Paid out', source: '' });
    if (t.flow === 'payin') {
      const s = settlementOf(t, status, true);
      out.push({ at: Number.MAX_SAFE_INTEGER, title: 'Settled', source: '', detail: t.settlementHeld ? 'Settlement paused' : s.expected === '—' ? 'Not settled yet' : `Expected ${s.expected}` });
    }
  } else if (status === 'failed') out.push({ at: t.finalAt, title: 'Failed', source: '', detail: t.merchantReason ?? '' });
  else if (status === 'expired') out.push({ at: t.finalAt, title: 'Expired', source: '', detail: t.merchantReason ?? '' });
  else out.push({ at: Number.MAX_SAFE_INTEGER, title: t.flow === 'payin' ? 'Paid' : 'Paid out', source: '', detail: 'Waiting' });
  return out;
}

function describeFilters(f: Filters): string {
  if (f.q) return `search ${f.q}`;
  const parts = [`${fmtDateTime(f.from)} – ${fmtDateTime(f.to)}`];
  if (f.type) parts.push(PAYMENT_TYPE_LABEL[f.flow][f.type] ?? f.type);
  if (f.country) parts.push(f.country);
  if (f.gmid) parts.push(f.gmid);
  if (f.method) parts.push(f.method);
  if (f.provider) parts.push(f.provider);
  if (f.status) parts.push(TXN_STATUS_LABEL[f.status]);
  if (f.flag) parts.push(TXN_FLAG_LABEL[f.flag]);
  return parts.join(' · ');
}

function localDateTime(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** Quotes a CSV cell and neutralises spreadsheet formulas (CSV injection). */
function csvCell(v: string) {
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'merchant'
  );
}

