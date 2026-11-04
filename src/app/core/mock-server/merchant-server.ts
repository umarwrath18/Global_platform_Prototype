import { emptyApplicationData, registeredInCountry, SECTION_ORDER, validateApplication, validateRegistrationNumber, isEmail, isPhone } from '../merchants/application-rules';
import {
  ApplicationData,
  ApplicationDetail,
  ApplicationStatus,
  ApplicationSummary,
  CountryApplication,
  CreateMerchantRequest,
  Director,
  DocumentRecord,
  FieldIssue,
  GlobalMerchant,
  GlobalMerchantStatus,
  HistoryEvent,
  MerchantDetail,
  MerchantLifecycleEvent,
  MerchantLifecycleStatus,
  MerchantSummary,
  NotificationEvent,
  PortalNotification,
  PrefillSource,
  Readiness,
  ReadinessAction,
  ReadinessStage,
  ReviewRequest,
  SectionKey,
  StaffRole,
} from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES, READINESS_CHECKLISTS, REGISTRATION_COUNTRIES } from '../merchants/onboarding-config';
import { PricingVersion, ProductConfig, productPhase } from '../merchants/products';
import { ChangeRequestRecord, describeChange, FieldChange, ProfileEvent } from '../merchants/change-requests';
import { EMPTY_MCC_CATALOGUE, MccAuditEvent, MccCatalogue, MccCatalogueEntry, MccChangeRequest, mccCountryCheck, mccIssue, MccRef } from '../merchants/mcc';
import { regionForCountry } from '../merchants/regions';
import { randomToken } from './crypto';
import { entityOfApplication, GoLiveIntent, goLiveBlocker, isRuleError, issueMid, MerchantEntity, parentEntityOf, RegionalMid, toMidView } from './merchant-identity';
import { MigrationFlag, migrationFlags, MigrationLogEntry, normaliseMerchantDb, SCHEMA_REVISION } from './merchant-migrations';
import { buildMerchantSeed } from './merchant-seed';
import { createSubMerchant, goLiveSubMerchant, reviewSubMerchant, setSubMerchantCheck, SubMerchantContext, subMerchantLifecycle, subMerchantsOf, submitSubMerchant } from './sub-merchants';
import { approvalsFor, ChangeContext, decideChange, merchantRiskApproved, profileEvent, requestCountryChange, requestProfileChange, toChangeView, withdrawChange } from './change-requests';
import { cancelPricing, decidePricing, DERIVED_CHECKLIST, onboardingGaps, ProductContext, productView, saveProducts, setPricing, syncDerivedChecklist } from './product-pricing';
import { ApiError, fail } from './server-errors';
import { simulateVerification } from './verification';

// Simulated Merchant Management & Onboarding backend (Batch 2). Like the auth server it
// runs in the browser for the prototype, but enforces every rule itself: role permissions,
// status transitions, validation and duplicate checks are never left to the UI.

const DB_VERSION = 2;

export type MerchantRecord = Omit<GlobalMerchant, 'globalStatus' | 'lifecycleStatus'> & Partial<Pick<GlobalMerchant, 'lifecycleStatus' | 'lifecycleReason' | 'lifecycleUpdatedAt' | 'lifecycleUpdatedBy'>>;

export interface MerchantDb {
  /** Stays 2: newer fields are optional, so older builds keep loading (and never reseed) this data. */
  version: number;
  /** Highest data upgrade applied (absent = before entities and MIDs). See merchant-migrations.ts. */
  schemaRevision?: number;
  seq: { merchant: number; application: number; notification: number; entity?: number; mid?: number; mccRequest?: number; pricing?: number; changeRequest?: number };
  merchants: MerchantRecord[];
  applications: CountryApplication[];
  notifications: PortalNotification[];
  lifecycleEvents?: MerchantLifecycleEvent[];
  entities?: MerchantEntity[];
  mids?: RegionalMid[];
  goLiveIntents?: GoLiveIntent[];
  migrationLog?: MigrationLogEntry[];
  mccRequests?: MccChangeRequest[];
  mccEvents?: MccAuditEvent[];
  /** Product & Payment Config per application; absent until products are first saved. */
  productConfigs?: ProductConfig[];
  pricingVersions?: PricingVersion[];
  /** Change requests after Risk approval (profile identity and country details). */
  changeRequests?: ChangeRequestRecord[];
  profileEvents?: ProfileEvent[];
}

export interface MerchantDataReport {
  schemaRevision: number | null;
  backupKey: string;
  backupPresent: boolean;
  /** True when the last upgrade attempt could not be saved; go-live waits until it succeeds. */
  upgradePending: boolean;
  log: MigrationLogEntry[];
  flags: MigrationFlag[];
}

export interface Caller {
  userId: string;
  name: string;
}

export interface ServerReply {
  status: number;
  body: unknown;
}

/** The slice of the auth server this service depends on. */
export interface AuthBridge {
  /** Validates the bearer token with the same rules as the auth APIs. */
  authenticate(token: string | null): Promise<{ ok: true; caller: Caller } | { ok: false; response: ServerReply }>;
  /**
   * Marks the country active on the merchant's Global Account, creating the account if needed, and
   * returns its ID. Safe to repeat: `merchantId` finds an account created by an earlier attempt.
   * A new account never takes an ID in `reservedIds` (IDs merchant data already refers to).
   */
  activateCountry(accountId: string | null, accountName: string, country: string, opts?: { merchantId?: string; reservedIds?: string[] }): Promise<string>;
}

export interface MerchantServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey?: string;
  now?: () => number;
  auth: AuthBridge;
  /** When false (guided mode), missing input is recorded but never blocks a step. Default: strict. */
  strictValidation?: () => boolean;
  /** Country Configuration; when present its stored rules are loaded before every request. */
  countryConfig?: { sync(): void };
  /** MCC catalogue; without one (or while it is empty) no application can be submitted. */
  mcc?: { catalogue(): MccCatalogue };
}

const STAFF_ROLES: StaffRole[] = ['sales', 'risk', 'cs', 'finops'];
const EDITABLE: ApplicationStatus[] = ['draft', 'returned'];

/** Team mailboxes that receive workflow emails. FinOps has none: its notifications are in-app only. */
export const TEAM_MAILBOX: Record<Exclude<StaffRole, 'finops'>, string> = {
  sales: 'sales-ops@mobi.xyz',
  risk: 'risk-review@mobi.xyz',
  cs: 'cs-onboarding@mobi.xyz',
};

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const normReg = (s: string) => s.replace(/[^a-z0-9]/gi, '').toUpperCase();
const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(sdn|bhd|berhad|pt|tbk|jsc|co|ltd|limited|inc|corp|corporation|llc|pte|company)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

export function deriveGlobalStatus(apps: Pick<CountryApplication, 'status'>[]): GlobalMerchantStatus {
  if (apps.some((a) => a.status === 'operational')) return 'active';
  if (apps.length && apps.every((a) => a.status === 'rejected')) return 'no_active_applications';
  return 'onboarding';
}

export function newReadiness(): Readiness {
  const list = (stage: ReadinessStage) => READINESS_CHECKLISTS[stage].map((i) => ({ ...i, done: false, doneAt: null, doneBy: null }));
  return { configuration: list('configuration'), integration: list('integration'), go_live: list('go_live'), keySet: null };
}

export class MerchantServer {
  private readonly storageKey: string;
  private readonly now: () => number;
  /** Set when the data upgrade could not be saved; cleared when it succeeds. */
  private upgradePending = false;

  constructor(private readonly opts: MerchantServerOptions) {
    this.storageKey = opts.storageKey ?? 'mobi.gp.merchantdb';
    this.now = opts.now ?? Date.now;
  }

  private get strict() {
    return this.opts.strictValidation?.() ?? true;
  }

  static handles(path: string) {
    return /^\/api\/(merchants|applications|notifications|changes|approvals|sub-merchants)(\/|\?|$)/.test(path);
  }

  async handle(method: string, path: string, body: any, token: string | null, roleHeader: string | null): Promise<ServerReply> {
    const auth = await this.opts.auth.authenticate(token);
    if (!auth.ok) return auth.response;
    const caller = auth.caller;
    const role = STAFF_ROLES.includes(roleHeader as StaffRole) ? (roleHeader as StaffRole) : 'sales';
    this.opts.countryConfig?.sync();
    try {
      this.ensureSeeded();
      const [rawPath, rawQuery] = path.split('?');
      const query = new URLSearchParams(rawQuery ?? '');
      const seg = rawPath.split('/').filter(Boolean).slice(1); // drop "api"
      const m = method.toUpperCase();
      const [resource, id, sub, subId, action] = seg;

      if (resource === 'merchants') {
        if (!id && m === 'GET') return ok(this.listMerchants());
        if (!id && m === 'POST') return ok(this.createMerchant(body, caller, role), 201);
        if (id && !sub && m === 'GET') return ok(this.merchantDetail(id));
        if (id && !sub && m === 'PATCH') return ok(this.updateMerchant(id, body, caller, role));
        if (id && sub === 'changes' && m === 'POST') return ok(this.changeAction(caller, role, (ctx) => requestProfileChange(ctx, id, body)), 201);
        if (id && sub === 'sub-merchants' && m === 'POST') return ok(this.subMerchantAction(caller, role, (ctx) => createSubMerchant(ctx, id, body)), 201);
        if (id && sub === 'lifecycle' && m === 'POST') return ok(this.updateMerchantLifecycle(id, body, caller, role));
        if (id && sub === 'applications' && m === 'POST') return ok(this.createApplication(id, body, caller, role), 201);
        if (id && sub === 'mcc' && !subId && m === 'PUT') return ok(this.setMcc(id, body, caller, role));
        if (id && sub === 'mcc-requests' && !subId && m === 'POST') return ok(this.requestMccChange(id, body, caller, role), 201);
        if (id && sub === 'mcc-requests' && subId && action === 'decision' && m === 'POST') return ok(this.decideMccChange(id, subId, body, caller, role));
      }
      if (resource === 'applications') {
        if (!id && m === 'GET') return ok(this.listApplications(query));
        if (id && !sub && m === 'GET') return ok(this.applicationDetail(id));
        if (id && !sub && m === 'PUT') return ok(this.saveDraft(id, body, caller, role));
        if (id && sub === 'submit' && m === 'POST') return ok(this.submit(id, body, caller, role));
        if (id && sub === 'review' && m === 'POST') return ok(this.review(id, body, caller, role));
        if (id && sub === 'readiness' && m === 'POST') return ok(await this.readiness(id, body, caller, role));
        if (id && sub === 'changes' && m === 'POST') return ok(this.changeAction(caller, role, (ctx) => requestCountryChange(ctx, id, body)), 201);
        if (id && sub === 'products' && m === 'GET') return ok(this.products(id, role));
        if (id && sub === 'products' && m === 'PUT') return ok(this.productAction(id, caller, role, (ctx) => ({ message: saveProducts(ctx, body) })));
        if (id && sub === 'pricing' && !subId && m === 'POST') return ok(this.productAction(id, caller, role, (ctx) => ({ version: setPricing(ctx, body) })), 201);
        if (id && sub === 'pricing' && subId && action === 'cancel' && m === 'POST') return ok(this.productAction(id, caller, role, (ctx) => ({ version: cancelPricing(ctx, subId, body) })));
        if (id && sub === 'pricing' && subId && action === 'decision' && m === 'POST') return ok(this.productAction(id, caller, role, (ctx) => ({ version: decidePricing(ctx, subId, body) })));
      }
      if (resource === 'changes' && id && sub === 'decision' && m === 'POST') return ok(this.changeAction(caller, role, (ctx) => decideChange(ctx, id, body)));
      if (resource === 'changes' && id && sub === 'withdraw' && m === 'POST') return ok(this.changeAction(caller, role, (ctx) => withdrawChange(ctx, id)));
      if (resource === 'sub-merchants' && id && m === 'POST') {
        const actions: Record<string, (ctx: SubMerchantContext) => unknown> = {
          submit: (ctx) => submitSubMerchant(ctx, id),
          review: (ctx) => reviewSubMerchant(ctx, id, body),
          checks: (ctx) => setSubMerchantCheck(ctx, id, body),
          'go-live': (ctx) => goLiveSubMerchant(ctx, id),
          lifecycle: (ctx) => subMerchantLifecycle(ctx, id, body),
        };
        if (sub && actions[sub]) return ok(this.subMerchantAction(caller, role, actions[sub]));
      }
      if (resource === 'approvals' && !id && m === 'GET') return ok(approvalsFor(this.load(), role));
      if (resource === 'notifications') {
        if (!id && m === 'GET') return ok(this.load().notifications);
        if (id === 'read' && m === 'POST') return ok(this.markRead(body, role));
      }
      return fail(404, 'NOT_FOUND');
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: e.body };
      throw e;
    }
  }

  // -------------------------------------------------------------- merchants

  private listMerchants(): MerchantSummary[] {
    const db = this.load();
    return db.merchants
      .map((m) => {
        const apps = db.applications.filter((a) => a.merchantId === m.id).map((a) => this.summary(db, a, m));
        const lastUpdatedAt = Math.max(m.updatedAt, ...apps.map((a) => a.updatedAt));
        const subMerchantCount = (db.entities ?? []).filter((e) => e.gmid === m.id && e.kind === 'sub').length;
        return { ...this.withStatus(db, m), applications: apps, lastUpdatedAt, subMerchantCount };
      })
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  }

  private merchantDetail(id: string): MerchantDetail {
    const db = this.load();
    const m = this.findMerchant(db, id);
    return {
      merchant: this.withStatus(db, m),
      applications: db.applications.filter((a) => a.merchantId === m.id).sort((a, b) => a.createdAt - b.createdAt),
      lifecycleEvents: (db.lifecycleEvents ?? []).filter((e) => e.merchantId === id).sort((a, b) => b.at - a.at),
      mids: (db.mids ?? []).filter((x) => x.gmid === m.id).map(toMidView),
      mccEvents: (db.mccEvents ?? []).filter((e) => e.merchantId === m.id).sort((a, b) => b.at - a.at),
      mccRequest: (db.mccRequests ?? []).find((r) => r.merchantId === m.id && r.status === 'pending') ?? null,
      mccChangeNeedsRisk: this.riskApproved(db, m.id),
      pendingChanges: (db.changeRequests ?? []).filter((r) => r.merchantId === m.id && r.status === 'pending').map(toChangeView),
      profileEvents: (db.profileEvents ?? []).filter((e) => e.merchantId === m.id),
      subMerchants: subMerchantsOf(db, m.id, this.now()),
    };
  }

  private createMerchant(body: any, caller: Caller, role: StaffRole): GlobalMerchant {
    this.requireRole(role, 'sales');
    const input = this.readMerchantInput(body);
    const db = this.load();

    // Hard stop: the same registration number in the same country is the same organisation.
    const sameReg = input.registrationNumber ? db.merchants.find((x) => x.registrationCountry === input.registrationCountry && normReg(x.registrationNumber) === normReg(input.registrationNumber)) : undefined;
    if (sameReg) {
      fail(409, 'DUPLICATE_MERCHANT', { existingMerchantId: sameReg.id, message: `${sameReg.legalName} (${sameReg.id}) already uses this registration number.` });
    }
    // Soft stop: a very similar name may be the same organisation; the user must confirm.
    const sameName = db.merchants.find((x) => normName(x.legalName) === normName(input.legalName));
    if (sameName && body?.confirmNotDuplicate !== true) {
      fail(409, 'POSSIBLE_DUPLICATE', { existingMerchantId: sameName.id, message: `${sameName.legalName} (${sameName.id}) has a similar name.` });
    }

    const now = this.now();
    const merchant: MerchantRecord = {
      id: `GM-${db.seq.merchant++}`,
      legalName: input.legalName,
      registrationCountry: input.registrationCountry,
      registrationNumber: input.registrationNumber,
      primaryContact: input.primaryContact,
      linkedAccountId: null,
      createdAt: now,
      updatedAt: now,
      createdBy: caller.name,
      demo: false,
    };
    db.merchants.push(merchant);
    this.save(db);
    return this.withStatus(db, merchant);
  }

  private updateMerchantLifecycle(id: string, body: any, caller: Caller, role: StaffRole): GlobalMerchant {
    const action = body?.action;
    const reason = str(body?.reason, 500).trim();
    if (action !== 'suspend' && action !== 'reactivate') fail(400, 'VALIDATION_FAILED', { message: 'Choose a valid lifecycle action.' });
    if (reason.length < 5) fail(400, 'VALIDATION_FAILED', { message: 'Enter a reason with at least 5 characters.' });
    if (action === 'suspend' && role !== 'sales' && role !== 'risk') fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only Sales / Operations or Risk can suspend a merchant.' });
    if (action === 'reactivate' && role !== 'risk') fail(403, 'ROLE_NOT_PERMITTED', { message: 'Only Risk can reactivate a suspended merchant.' });
    const db = this.load();
    const merchant = this.findMerchant(db, id);
    const current = merchant.lifecycleStatus ?? 'active';
    const globalStatus = deriveGlobalStatus(db.applications.filter((a) => a.merchantId === merchant.id));
    if (action === 'suspend') {
      if (current === 'suspended') fail(409, 'INVALID_TRANSITION', { message: 'This merchant is already suspended.' });
      if (globalStatus !== 'active') fail(409, 'INVALID_TRANSITION', { message: 'Only a merchant with at least one operational country can be suspended.' });
    } else if (current !== 'suspended') fail(409, 'INVALID_TRANSITION', { message: 'Only a suspended merchant can be reactivated.' });
    const next: MerchantLifecycleStatus = action === 'suspend' ? 'suspended' : 'active';
    const at = this.now();
    merchant.lifecycleStatus = next;
    merchant.lifecycleReason = next === 'suspended' ? reason : null;
    merchant.lifecycleUpdatedAt = at;
    merchant.lifecycleUpdatedBy = caller.name;
    db.lifecycleEvents ??= [];
    db.lifecycleEvents.unshift({ at, action: action === 'suspend' ? 'suspended' : 'reactivated', by: caller.name, role, reason, fromStatus: current, toStatus: next, merchantId: merchant.id });
    db.lifecycleEvents = db.lifecycleEvents.slice(0, 500);
    this.save(db);
    return this.withStatus(db, merchant);
  }

  /**
   * Direct profile edits by Sales / Operations, always recorded. Contact details can change at any
   * time. Once Risk has approved the merchant, the legal identity changes only through a change
   * request that Risk approves.
   */
  private updateMerchant(id: string, body: any, caller: Caller, role: StaffRole): GlobalMerchant {
    this.requireRole(role, 'sales');
    const db = this.load();
    const m = this.findMerchant(db, id);
    const input = this.readMerchantInput({ ...m, ...body });
    const before = { legalName: m.legalName, registrationCountry: m.registrationCountry, registrationNumber: m.registrationNumber };
    const after = { legalName: input.legalName, registrationCountry: input.registrationCountry, registrationNumber: input.registrationNumber };
    const identity = describeChange('identity', before, after);
    if (identity.length && this.riskApproved(db, m.id)) {
      fail(409, 'CHANGE_REQUEST_REQUIRED', { message: `${m.legalName} has been approved by Risk, so its legal identity can only change through a request that Risk approves.` });
    }
    const clash = !input.registrationNumber ? undefined : db.merchants.find((x) => x.id !== m.id && x.registrationCountry === input.registrationCountry && normReg(x.registrationNumber) === normReg(input.registrationNumber));
    if (clash) fail(409, 'DUPLICATE_MERCHANT', { existingMerchantId: clash.id, message: `${clash.legalName} (${clash.id}) already uses this registration number.` });
    const contact: FieldChange[] = (['name', 'email', 'phone'] as const)
      .filter((k) => m.primaryContact[k] !== input.primaryContact[k])
      .map((k) => ({ field: `primaryContact.${k}`, label: { name: 'Main contact', email: 'Email', phone: 'Phone' }[k], from: m.primaryContact[k] || 'Not set', to: input.primaryContact[k] || 'Not set' }));
    if (!identity.length && !contact.length) return this.withStatus(db, m);
    const now = this.now();
    Object.assign(m, { ...after, primaryContact: input.primaryContact, updatedAt: now });
    if (identity.length) profileEvent(db, { at: now, merchantId: m.id, action: 'identity_updated', changes: identity, reason: null, by: caller.name, role, requestId: null, comment: null });
    if (contact.length) profileEvent(db, { at: now, merchantId: m.id, action: 'contact_updated', changes: contact, reason: null, by: caller.name, role, requestId: null, comment: null });
    this.save(db);
    return this.withStatus(db, m);
  }

  /** Runs a sub-merchant action and saves it with its history and notifications in one write. */
  private subMerchantAction<T>(caller: Caller, role: StaffRole, run: (ctx: SubMerchantContext) => T): T {
    if (this.upgradePending) fail(503, 'MIGRATION_PENDING', { message: 'Merchant data could not be upgraded yet. Nothing has changed; try again shortly.' });
    const db = this.load();
    const result = run({
      db,
      caller,
      role,
      now: this.now(),
      strict: this.strict,
      notify: (event, merchant, audience, title, body) => {
        db.notifications.unshift({
          id: `NT-${db.seq.notification++}`, at: this.now(), event, title, body, applicationId: '', merchantId: merchant.id, audience,
          email: { to: audience.filter((a): a is Exclude<StaffRole, 'finops'> => a !== 'finops').map((a) => TEAM_MAILBOX[a]), subject: `[Mobi Global Platform] ${title}`, status: 'simulated' },
          readBy: [],
        });
        db.notifications = db.notifications.slice(0, 300);
      },
    });
    this.save(db);
    return result;
  }

  /** Runs a change-request action and saves it with its history entries and notifications in one write. */
  private changeAction<T>(caller: Caller, role: StaffRole, run: (ctx: ChangeContext) => T): T {
    const db = this.load();
    const result = run({
      db,
      caller,
      role,
      now: this.now(),
      readData: (country, raw) => this.readData(country, raw),
      recordApp: (app, text, comment) => this.event(app, caller, role, text, null, null, comment),
      notify: (event, merchant, app, audience, title, body) => {
        db.notifications.unshift({
          id: `NT-${db.seq.notification++}`, at: this.now(), event, title, body, applicationId: app?.id ?? '', merchantId: merchant.id, ...(app ? { country: app.country } : {}), audience,
          email: { to: audience.filter((a): a is Exclude<StaffRole, 'finops'> => a !== 'finops').map((a) => TEAM_MAILBOX[a]), subject: `[Mobi Global Platform] ${title}`, status: 'simulated' },
          readBy: [],
        });
        db.notifications = db.notifications.slice(0, 300);
      },
    });
    this.save(db);
    return result;
  }

  private readMerchantInput(body: any): CreateMerchantRequest {
    const errors: FieldIssue[] = [];
    const issue = (field: string, message: string) => errors.push({ section: 'business', field, message });
    const legalName = str(body?.legalName).trim();
    const registrationCountry = str(body?.registrationCountry, 2).toUpperCase();
    const registrationNumber = str(body?.registrationNumber, 40).trim();
    const c = body?.primaryContact ?? {};
    const primaryContact = { name: str(c.name, 120).trim(), email: str(c.email, 254).trim(), phone: str(c.phone, 30).trim() };

    if (!legalName) issue('legalName', 'Enter the registered legal name.');
    else if (legalName.length > 160) issue('legalName', 'Use 160 characters or fewer.');
    if (!REGISTRATION_COUNTRIES.some((x) => x.code === registrationCountry)) issue('registrationCountry', 'Select the country of registration.');
    else {
      const regError = validateRegistrationNumber(registrationCountry, registrationNumber);
      if (regError) issue('registrationNumber', regError);
    }
    if (!primaryContact.name) issue('primaryContact.name', 'Enter the primary contact name.');
    if (!isEmail(primaryContact.email)) issue('primaryContact.email', 'Enter a valid email address, e.g. name@company.com');
    if (!isPhone(primaryContact.phone)) issue('primaryContact.phone', 'Enter a valid phone number including the country code.');
    if (errors.length && this.strict) fail(422, 'VALIDATION_FAILED', { errors });
    // Guided mode: keep what was entered and fill only what a record can't exist without.
    return {
      legalName: legalName.slice(0, 160) || 'Untitled merchant',
      registrationCountry: REGISTRATION_COUNTRIES.some((x) => x.code === registrationCountry) ? registrationCountry : 'MY',
      registrationNumber,
      primaryContact,
    };
  }

  // ----------------------------------------------------------- applications

  private listApplications(query: URLSearchParams): ApplicationSummary[] {
    const db = this.load();
    const statuses = query.get('status')?.split(',').filter(Boolean) ?? [];
    return db.applications
      .filter((a) => !statuses.length || statuses.includes(a.status))
      .map((a) => this.summary(db, a, this.findMerchant(db, a.merchantId)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private applicationDetail(id: string): ApplicationDetail {
    const db = this.load();
    const application = this.findApplication(db, id);
    const mid = (db.mids ?? []).find((x) => x.applicationId === application.id);
    const issue = mid ? undefined : migrationFlags(db).find((f) => f.recordId === application.id && f.reason !== 'NO_REGION' && f.reason !== 'ORPHAN_APPLICATION');
    return {
      application,
      merchant: this.withStatus(db, this.findMerchant(db, application.merchantId)),
      mid: mid ? toMidView(mid) : null,
      midIssue: application.status === 'operational' && !mid ? (issue?.detail ?? 'No live MID has been assigned.') : null,
      mccChangeNeedsRisk: this.riskApproved(db, application.merchantId),
      productGaps: productPhase(application.status) === 'onboarding' ? onboardingGaps(db, application, this.now()) : null,
      changes: (db.changeRequests ?? []).filter((r) => r.applicationId === application.id).sort((a, b) => b.requestedAt - a.requestedAt).map(toChangeView),
    };
  }

  private createApplication(merchantId: string, body: any, caller: Caller, role: StaffRole): CountryApplication {
    this.requireRole(role, 'sales');
    const db = this.load();
    const merchant = this.findMerchant(db, merchantId);
    this.requireNotSuspended(merchant, 'start a new country application');
    const country = str(body?.country, 2).toUpperCase();
    const cfg = ONBOARDING_COUNTRIES[country];
    if (!cfg) fail(422, 'COUNTRY_NOT_SUPPORTED', { message: 'Onboarding is not available for this country.' });
    if (cfg.onboardingEnabled === false) fail(422, 'COUNTRY_NOT_SUPPORTED', { message: `New applications for ${cfg.name} are paused for this country.` });
    if (merchant.mcc && mccCountryCheck(this.catalogue(), merchant.mcc.code, [country]).unavailable.length) {
      fail(422, 'MCC_NOT_AVAILABLE', { message: `${merchant.legalName}'s MCC ${merchant.mcc.code} is not available in ${cfg.name}, so it can't apply there.` });
    }

    const existing = db.applications.filter((a) => a.merchantId === merchantId && a.country === country);
    const open = existing.find((a) => a.status !== 'rejected');
    if (open) {
      fail(409, 'APPLICATION_EXISTS', { existingApplicationId: open.id, message: `${merchant.legalName} already has application ${open.id} for ${cfg.name}.` });
    }
    const previous = existing.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

    const { data, prefill } = this.prefill(db, merchant, country);
    const now = this.now();
    const app: CountryApplication = {
      id: `APP-${new Date(now).getUTCFullYear()}-${String(db.seq.application++).padStart(4, '0')}`,
      merchantId,
      entityId: parentEntityOf(db.entities ?? [], merchantId)?.id,
      country,
      regionCode: regionForCountry(country) ?? undefined,
      currency: cfg.currency,
      status: 'draft',
      data,
      prefill,
      submittedProfile: null,
      corrections: null,
      verification: null,
      readiness: newReadiness(),
      previousApplicationId: previous?.id ?? null,
      submissionCount: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: caller.name,
      history: [],
      demo: false,
    };
    this.event(app, caller, role, previous ? `Application created (new attempt after rejected ${previous.id})` : 'Application created', null, 'draft');
    db.applications.push(app);
    merchant.updatedAt = now;
    this.save(db);
    return app;
  }

  /** Copies reusable information so it is not collected twice. Bank details and documents are always country-specific. */
  private prefill(db: MerchantDb, merchant: MerchantRecord, country: string): { data: ApplicationData; prefill: PrefillSource[] } {
    const data = emptyApplicationData(country);
    const prefill: PrefillSource[] = [];
    const fromProfile = (field: string) => prefill.push({ field, from: 'global_profile' });

    data.business.tradingName = merchant.legalName;
    fromProfile('business.tradingName');
    data.contact = { ...merchant.primaryContact, supportEmail: '' };
    ['contact.name', 'contact.email', 'contact.phone'].forEach(fromProfile);
    if (registeredInCountry(merchant, country)) {
      data.business.localRegistrationNumber = merchant.registrationNumber;
      fromProfile('business.localRegistrationNumber');
    }

    const source = db.applications
      .filter((a) => a.merchantId === merchant.id && a.status !== 'rejected')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (source) {
      const from = (field: string) => prefill.push({ field, from: 'application', applicationId: source.id, country: source.country });
      if (source.data.business.industry) (data.business.industry = source.data.business.industry), from('business.industry');
      if (source.data.business.website) (data.business.website = source.data.business.website), from('business.website');
      if (source.data.contact.supportEmail) (data.contact.supportEmail = source.data.contact.supportEmail), from('contact.supportEmail');
      if (ONBOARDING_COUNTRIES[country].directors.required && source.data.directors.length) {
        data.directors = source.data.directors.map((d) => ({ ...d, id: randomToken(6) }));
        from('directors');
      }
    }
    return { data, prefill };
  }

  private saveDraft(id: string, body: any, caller: Caller, role: StaffRole): CountryApplication {
    this.requireRole(role, 'sales');
    const db = this.load();
    const app = this.findApplication(db, id);
    if (!EDITABLE.includes(app.status)) fail(409, 'INVALID_TRANSITION', { message: 'This application can no longer be edited.' });
    app.data = this.readData(app.country, body?.data);
    app.updatedAt = this.now();
    // Collapse repeated saves into one history entry per editing session.
    const last = app.history[app.history.length - 1];
    if (last?.action === 'Draft saved' && last.by === caller.name && app.updatedAt - last.at < 30 * 60_000) last.at = app.updatedAt;
    else this.event(app, caller, role, 'Draft saved', null, null);
    this.save(db);
    return app;
  }

  private submit(id: string, body: any, caller: Caller, role: StaffRole): CountryApplication {
    this.requireRole(role, 'sales');
    const db = this.load();
    const app = this.findApplication(db, id);
    const merchant = this.findMerchant(db, app.merchantId);
    if (!EDITABLE.includes(app.status)) fail(409, 'INVALID_TRANSITION', { message: 'Only draft or returned applications can be submitted.' });
    if (body?.data) app.data = this.readData(app.country, body.data);
    const errors = validateApplication(app.country, app.data, merchant);
    const mccProblem = mccIssue(this.catalogue(), app.country, merchant.mcc);
    if (mccProblem) errors.push(mccProblem);
    // The MCC is required in guided mode too; everything else blocks only in strict mode.
    const blocking = this.strict ? errors : mccProblem ? [mccProblem] : [];
    if (blocking.length) {
      app.updatedAt = this.now();
      this.save(db);
      const message = this.strict ? `${errors.length} item${errors.length === 1 ? '' : 's'} must be completed before submission.` : mccProblem!.message;
      fail(422, 'APPLICATION_INCOMPLETE', { errors: blocking, message });
    }
    const resubmission = app.status === 'returned';
    const from = app.status;
    const now = this.now();
    app.status = 'pending_risk_review';
    app.submissionCount += 1;
    app.submittedProfile = { legalName: merchant.legalName, registrationCountry: merchant.registrationCountry, registrationNumber: merchant.registrationNumber, mcc: merchant.mcc ? { code: merchant.mcc.code, description: merchant.mcc.description } : null };
    app.verification = simulateVerification(merchant, app.data, now);
    app.rulesSnapshot = JSON.parse(JSON.stringify(ONBOARDING_COUNTRIES[app.country]));
    app.corrections = null;
    app.updatedAt = now;
    const note = [str(body?.comment, 1000).trim(), errors.length ? `Submitted with ${errors.length} incomplete item${errors.length === 1 ? '' : 's'}.` : ''].filter(Boolean).join(' ') || undefined;
    this.event(app, caller, role, resubmission ? 'Resubmitted after correction' : 'Submitted for Risk review', from, app.status, note);
    this.event(app, null, 'system', 'Verification checks completed', null, null);
    const cname = ONBOARDING_COUNTRIES[app.country].name;
    this.notify(db, resubmission ? 'resubmitted' : 'submitted', app, merchant, ['risk', 'sales'], {
      title: `${resubmission ? 'Resubmitted' : 'Submitted'}: ${merchant.legalName} · ${cname}`,
      body: `${app.id} is waiting for Risk review${resubmission ? ' after correction' : ''}.`,
      to: [TEAM_MAILBOX.risk],
    });
    this.save(db);
    return app;
  }

  private review(id: string, body: any, caller: Caller, role: StaffRole): CountryApplication {
    this.requireRole(role, 'risk');
    const db = this.load();
    const app = this.findApplication(db, id);
    const merchant = this.findMerchant(db, app.merchantId);
    if (app.status !== 'pending_risk_review') fail(409, 'INVALID_TRANSITION', { message: 'Only applications pending Risk review can be decided.' });
    const req: ReviewRequest = {
      decision: body?.decision,
      comment: str(body?.comment, 2000).trim(),
      sections: Array.isArray(body?.sections) ? body.sections.filter((s: unknown) => SECTION_ORDER.includes(s as SectionKey)) : [],
      evidenceReviewed: body?.evidenceReviewed === true,
    };
    const errors: FieldIssue[] = [];
    if (!['approve', 'return', 'reject'].includes(req.decision)) errors.push({ section: 'business', field: 'decision', message: 'Choose a decision.' });
    if (!req.evidenceReviewed) errors.push({ section: 'business', field: 'evidenceReviewed', message: 'Confirm you have reviewed the documents and verification evidence.' });
    if (req.decision !== 'approve' && req.comment.length < 10) {
      errors.push({ section: 'business', field: 'comment', message: req.decision === 'return' ? 'Explain what must be corrected (at least 10 characters).' : 'Give the reason for rejection (at least 10 characters).' });
    }
    if (req.decision === 'return' && !req.sections?.length) errors.push({ section: 'business', field: 'sections', message: 'Select at least one section to correct.' });
    if (errors.length && (this.strict || errors.some((e) => e.field === 'decision'))) fail(422, 'VALIDATION_FAILED', { errors });
    if (req.decision === 'return' && !req.sections?.length) {
      const open = [...new Set(validateApplication(app.country, app.data, merchant).map((e) => e.section))];
      req.sections = open.length ? open : ['documents'];
    }
    if (!req.comment && req.decision === 'return') req.comment = 'Please review and update the highlighted sections, then resubmit.';
    if (!req.comment && req.decision === 'reject') req.comment = 'The application does not meet our onboarding requirements.';

    const from = app.status;
    const cname = ONBOARDING_COUNTRIES[app.country].name;
    app.updatedAt = this.now();
    if (req.decision === 'approve') {
      app.status = 'risk_approved';
      this.event(app, caller, role, 'Approved by Risk', from, app.status, req.comment || undefined);
      this.notify(db, 'approved', app, merchant, ['sales', 'cs'], {
        title: `Risk approved: ${merchant.legalName} · ${cname}`,
        body: `${app.id} is approved. CS can now start country configuration. The merchant is not operational yet.`,
        to: [TEAM_MAILBOX.sales, TEAM_MAILBOX.cs],
      });
    } else if (req.decision === 'return') {
      app.status = 'returned';
      app.corrections = { reason: req.comment, sections: req.sections! };
      this.event(app, caller, role, 'Returned for correction', from, app.status, req.comment, req.sections);
      this.notify(db, 'returned', app, merchant, ['sales'], {
        title: `Returned for correction: ${merchant.legalName} · ${cname}`,
        body: `Risk asked for corrections on ${app.id}: ${req.comment}`,
        to: [TEAM_MAILBOX.sales],
      });
    } else {
      app.status = 'rejected';
      this.event(app, caller, role, 'Rejected by Risk', from, app.status, req.comment);
      this.notify(db, 'rejected', app, merchant, ['sales'], {
        title: `Rejected: ${merchant.legalName} · ${cname}`,
        body: `${app.id} was rejected. Reason: ${req.comment}`,
        to: [TEAM_MAILBOX.sales],
      });
    }
    this.save(db);
    return app;
  }

  private async readiness(id: string, body: ReadinessAction, caller: Caller, role: StaffRole): Promise<CountryApplication> {
    this.requireRole(role, 'cs');
    if (body?.action === 'confirm_go_live') return this.confirmGoLive(id, caller, role);
    const db = this.load();
    const app = this.findApplication(db, id);
    const merchant = this.findMerchant(db, app.merchantId);
    const cname = ONBOARDING_COUNTRIES[app.country].name;
    const r = app.readiness;
    const move = (from: ApplicationStatus, to: ApplicationStatus, label: string) => {
      if (app.status !== from) fail(409, 'INVALID_TRANSITION', { message: 'This step is not available at the current stage.' });
      app.status = to;
      this.event(app, caller, role, label, from, to);
    };
    const requireDone = (stage: ReadinessStage) => {
      const open = r[stage].filter((i) => !i.done);
      if (open.length && this.strict) fail(409, 'CHECKLIST_INCOMPLETE', { message: `Complete: ${open.map((i) => i.label).join('; ')}.` });
      // Guided mode: moving on completes whatever is still open, and the history says so.
      for (const item of open) {
        Object.assign(item, { done: true, doneAt: this.now(), doneBy: caller.name });
        this.event(app, caller, role, `Completed: ${item.label}`, null, null);
      }
    };
    const now = this.now();

    switch (body?.action) {
      case 'start_configuration':
        move('risk_approved', 'cs_configuration', 'Product & Payment Config started');
        break;
      case 'set_item': {
        const stageStatus: Record<ReadinessStage, ApplicationStatus> = { configuration: 'cs_configuration', integration: 'integration', go_live: 'go_live_verification' };
        if (!(body.stage in stageStatus) || app.status !== stageStatus[body.stage]) fail(409, 'INVALID_TRANSITION', { message: 'This checklist is not open at the current stage.' });
        if (body.stage === 'configuration' && DERIVED_CHECKLIST.includes(body.key)) {
          fail(409, 'INVALID_TRANSITION', { message: 'This item is set automatically from Product & Payment Config.' });
        }
        const item = r[body.stage].find((i) => i.key === body.key);
        if (!item) fail(404, 'NOT_FOUND');
        item!.done = body.done === true;
        item!.doneAt = item!.done ? now : null;
        item!.doneBy = item!.done ? caller.name : null;
        this.event(app, caller, role, `${item!.done ? 'Completed' : 'Reopened'}: ${item!.label}`, null, null);
        break;
      }
      case 'generate_keys': {
        // The onboarding handoff: products, pricing and settlement must be complete, in guided mode too.
        if (app.status === 'cs_configuration') {
          const gaps = onboardingGaps(db, app, now);
          if (gaps.length) {
            fail(409, 'PRODUCT_CONFIG_INCOMPLETE', {
              message: `Finish Product & Payment Config first: ${gaps.map((g) => g.message).join(' ')}`,
              errors: gaps.map((g) => ({ section: 'pricing', field: `products.${g.methodCode ?? 'any'}`, message: g.message })),
            });
          }
          syncDerivedChecklist(this.productContext(db, app, caller, role));
        }
        requireDone('configuration');
        move('cs_configuration', 'keys_generated', 'Production keys generated');
        r.keySet = { reference: `KS-${randomToken(3).toUpperCase()}`, generatedAt: now, environment: 'production', simulated: true };
        this.notify(db, 'configuration_ready', app, merchant, ['cs', 'sales'], {
          title: `Configuration ready: ${merchant.legalName} · ${cname}`,
          body: `Product & Payment Config is complete and production keys are generated for ${app.id}. Merchant integration can start.`,
          to: [merchant.primaryContact.email, TEAM_MAILBOX.cs],
        });
        break;
      }
      case 'start_integration':
        move('keys_generated', 'integration', 'Merchant integration started');
        break;
      case 'request_go_live':
        requireDone('integration');
        move('integration', 'go_live_verification', 'Integration complete; go-live verification started');
        break;
      default:
        fail(400, 'VALIDATION_FAILED', { message: 'Unknown readiness action.' });
    }
    app.updatedAt = now;
    this.save(db);
    return app;
  }

  /**
   * Go-live, safe to retry. All checks run before anything is written. The go-live is then recorded
   * as started, the Global Account is activated (idempotent: found again by GMID if an earlier
   * attempt created it), and one save marks the application operational, issues the live MID and
   * clears the record. If that save fails, a retry finishes the same go-live with no second account
   * or MID. Repeating a completed go-live returns the existing result and writes nothing.
   */
  private async confirmGoLive(id: string, caller: Caller, role: StaffRole): Promise<CountryApplication> {
    let db = this.load();
    let app = this.findApplication(db, id);
    if (app.status === 'operational') return app;
    if (app.status !== 'go_live_verification') fail(409, 'INVALID_TRANSITION', { message: 'Go-live can only be confirmed after verification.' });
    const merchant = this.findMerchant(db, app.merchantId);
    this.requireNotSuspended(merchant, 'go live');
    if (this.upgradePending || (db.schemaRevision ?? 0) < SCHEMA_REVISION) {
      fail(503, 'MIGRATION_PENDING', { message: 'Merchant data could not be upgraded yet, so go-live is paused. Nothing has changed; try again shortly.' });
    }
    const entityId = this.goLiveChecks(db, app).entityId;
    const open = app.readiness.go_live.filter((i) => !i.done);
    if (open.length && this.strict) fail(409, 'CHECKLIST_INCOMPLETE', { message: `Complete: ${open.map((i) => i.label).join('; ')}.` });

    const now = this.now();
    // Guided mode: going live completes whatever is still open, and the history says so.
    for (const item of open) {
      Object.assign(item, { done: true, doneAt: now, doneBy: caller.name });
      this.event(app, caller, role, `Completed: ${item.label}`, null, null);
    }
    db.goLiveIntents ??= [];
    if (!db.goLiveIntents.some((i) => i.applicationId === app.id)) db.goLiveIntents.push({ applicationId: app.id, startedAt: now, by: caller.name });
    app.updatedAt = now;
    this.save(db);

    // Every Global Account ID the merchant data refers to, so a new account can't reuse one even if
    // the auth data no longer has it (e.g. the two stores were reset separately).
    const reservedIds = db.merchants.map((x) => x.linkedAccountId).filter((x): x is string => !!x);
    const accountId = await this.opts.auth.activateCountry(merchant.linkedAccountId, merchant.legalName, app.country, { merchantId: merchant.id, reservedIds });

    // Re-read: another request may have changed or completed this go-live in the meantime.
    db = this.load();
    app = this.findApplication(db, id);
    if (app.status === 'operational') return app;
    if (app.status !== 'go_live_verification') fail(409, 'INVALID_TRANSITION', { message: 'Go-live can only be confirmed after verification.' });
    const m = this.findMerchant(db, app.merchantId);
    this.requireNotSuspended(m, 'go live');
    const regionCode = this.goLiveChecks(db, app).regionCode;
    const cname = ONBOARDING_COUNTRIES[app.country].name;
    const issued = issueMid(db, { entityId, gmid: m.id, regionCode, country: app.country, source: 'go_live', issuedAt: now, issuedBy: caller.name, applicationId: app.id, demo: app.demo });
    if (isRuleError(issued)) fail(409, issued.code, { message: issued.message });
    const mid = issued as RegionalMid;

    // A new account was created if the link changes: none before, or one the auth data no longer has.
    const created = m.linkedAccountId !== accountId;
    m.linkedAccountId = accountId;
    m.updatedAt = now;
    app.status = 'operational';
    this.event(app, caller, role, 'Go-live verified; country is operational', 'go_live_verification', 'operational');
    this.event(app, null, 'system', `${cname} activated on Global Account ${accountId}${created ? ' (account created)' : ''}`, null, null);
    this.event(app, null, 'system', `Live MID ${mid.mid} issued for ${cname}`, null, null);
    this.notify(db, 'go_live', app, m, ['sales', 'cs', 'risk'], {
      title: `Live: ${m.legalName} · ${cname}`,
      body: `${app.id} passed go-live verification. ${cname} is now operational for ${m.id} with live MID ${mid.mid}.`,
      to: [m.primaryContact.email, TEAM_MAILBOX.sales, TEAM_MAILBOX.cs],
    });
    db.goLiveIntents = (db.goLiveIntents ?? []).filter((i) => i.applicationId !== app.id);
    app.updatedAt = now;
    this.save(db);
    return app;
  }

  /** Entity, parent/suspension gate, region and one-MID-per-region checks for a go-live. Writes nothing. */
  private goLiveChecks(db: MerchantDb, app: CountryApplication): { entityId: string; regionCode: string } {
    const entities = db.entities ?? [];
    const entity = entityOfApplication(entities, app) ?? fail(409, 'INVALID_TRANSITION', { message: 'This application has no merchant entity, so it cannot go live. It has been flagged for review.' });
    const blocked = goLiveBlocker({ merchants: db.merchants, entities, applications: db.applications }, entity.id, app.country);
    if (blocked) fail(409, blocked.code, { message: blocked.message });
    const regionCode = app.regionCode ?? regionForCountry(app.country) ?? fail(422, 'COUNTRY_NOT_SUPPORTED', { message: 'No region is configured for this country, so no live MID can be issued.' });
    const held = (db.mids ?? []).find((x) => x.entityId === entity.id && x.regionCode === regionCode);
    if (held) fail(409, 'MID_CONFLICT', { message: `This merchant entity already has live MID ${held.mid} in this region.` });
    return { entityId: entity.id, regionCode };
  }

  // ------------------------------------------------------------------- MCC

  /**
   * Sets the parent merchant's MCC directly. Only before Risk has approved the merchant; after that
   * a change needs a change request that Risk approves. Every change is recorded.
   */
  private setMcc(id: string, body: any, caller: Caller, role: StaffRole): GlobalMerchant {
    this.requireRole(role, 'sales');
    const db = this.load();
    const m = this.findMerchant(db, id);
    if (this.riskApproved(db, m.id)) {
      fail(409, 'MCC_CHANGE_REQUIRED', { message: `${m.legalName} has been approved by Risk, so its MCC can only change through a change request that Risk approves.` });
    }
    const { entry, catalogue, restricted } = this.readMccChoice(db, m.id, body?.code);
    if (m.mcc?.code === entry.code) return this.withStatus(db, m);
    const now = this.now();
    const previous = mccRef(m.mcc);
    m.mcc = this.assignedMcc(entry, catalogue, now, caller.name);
    m.updatedAt = now;
    this.mccEvent(db, {
      at: now, merchantId: m.id, outcome: 'set_before_approval', previous, next: mccRef(entry), reason: str(body?.reason, 500).trim() || 'Set before Risk approval',
      requestId: null, requestedBy: caller.name, requestedRole: role, requestedAt: now, decidedBy: null, decidedRole: null, decidedAt: null, comment: null, restrictedIn: restricted,
    });
    this.save(db);
    return this.withStatus(db, m);
  }

  /** Asks Risk to change an approved merchant's MCC. The MCC stays as it is until Risk approves. */
  private requestMccChange(id: string, body: any, caller: Caller, role: StaffRole): MccChangeRequest {
    this.requireRole(role, 'sales');
    const db = this.load();
    const m = this.findMerchant(db, id);
    if (!this.riskApproved(db, m.id)) {
      fail(409, 'INVALID_TRANSITION', { message: `${m.legalName} hasn't been approved by Risk yet, so its MCC can be set directly in its application.` });
    }
    const pending = (db.mccRequests ?? []).find((r) => r.merchantId === m.id && r.status === 'pending');
    if (pending) fail(409, 'MCC_CHANGE_PENDING', { message: `MCC change ${pending.id} is waiting for a Risk decision. Wait for that decision first.` });
    const reason = str(body?.reason, 500).trim();
    if (reason.length < 10) fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'business', field: 'reason', message: 'Explain why the MCC should change (at least 10 characters).' }] });
    const { entry, restricted } = this.readMccChoice(db, m.id, body?.code);
    if (m.mcc?.code === entry.code) fail(422, 'VALIDATION_FAILED', { message: `${entry.code} is already this merchant's MCC.` });

    const now = this.now();
    db.seq.mccRequest ??= 1;
    const request: MccChangeRequest = {
      id: `MCR-${String(db.seq.mccRequest++).padStart(4, '0')}`,
      merchantId: m.id, previous: mccRef(m.mcc), proposed: mccRef(entry)!, reason, restrictedIn: restricted,
      requestedBy: caller.name, requestedRole: role, requestedAt: now,
      status: 'pending', decidedBy: null, decidedRole: null, decidedAt: null, decisionComment: null,
    };
    db.mccRequests ??= [];
    db.mccRequests.push(request);
    this.mccEvent(db, this.requestEvent(request, 'change_requested', now));
    this.notifyMerchant(db, 'mcc_change_requested', m, ['risk'], {
      title: `MCC change to review: ${m.legalName}`,
      body: `${caller.name} asked to change the MCC from ${mccText(request.previous)} to ${mccText(request.proposed)}${restricted.length ? ` (restricted in ${restricted.join(', ')})` : ''}. Reason: ${reason}`,
      to: [TEAM_MAILBOX.risk],
    });
    this.save(db);
    return request;
  }

  /** Risk approves (the MCC changes now) or rejects (nothing changes) a pending MCC change request. */
  private decideMccChange(id: string, requestId: string, body: any, caller: Caller, role: StaffRole): MccChangeRequest {
    this.requireRole(role, 'risk');
    const db = this.load();
    const m = this.findMerchant(db, id);
    const request = (db.mccRequests ?? []).find((r) => r.id === requestId && r.merchantId === m.id) ?? fail(404, 'NOT_FOUND', { message: `No MCC change request ${requestId}.` });
    if (request.status !== 'pending') fail(409, 'INVALID_TRANSITION', { message: `MCC change ${request.id} has already been ${request.status}.` });
    const decision = body?.decision;
    if (decision !== 'approve' && decision !== 'reject') fail(400, 'VALIDATION_FAILED', { message: 'Choose approve or reject.' });
    const comment = str(body?.comment, 1000).trim();
    if (decision === 'reject' && comment.length < 10) {
      fail(422, 'VALIDATION_FAILED', { errors: [{ section: 'business', field: 'comment', message: 'Give the reason for rejecting (at least 10 characters).' }] });
    }

    const now = this.now();
    if (decision === 'approve') {
      // The catalogue or the merchant's countries may have changed since the request was made.
      const { entry, catalogue, restricted } = this.readMccChoice(db, m.id, request.proposed.code);
      m.mcc = this.assignedMcc(entry, catalogue, now, caller.name);
      m.updatedAt = now;
      request.restrictedIn = restricted;
    }
    Object.assign(request, { status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: caller.name, decidedRole: role, decidedAt: now, decisionComment: comment || null });
    this.mccEvent(db, this.requestEvent(request, decision === 'approve' ? 'change_approved' : 'change_rejected', now));
    this.notifyMerchant(db, 'mcc_change_decided', m, ['sales'], {
      title: `MCC change ${decision === 'approve' ? 'approved' : 'rejected'}: ${m.legalName}`,
      body: decision === 'approve'
        ? `Risk approved the MCC change to ${mccText(request.proposed)}.${comment ? ` ${comment}` : ''}`
        : `Risk rejected the MCC change to ${mccText(request.proposed)}. The MCC stays ${mccText(request.previous)}. ${comment}`,
      to: [TEAM_MAILBOX.sales],
    });
    this.save(db);
    return request;
  }

  private catalogue(): MccCatalogue {
    return this.opts.mcc?.catalogue() ?? EMPTY_MCC_CATALOGUE;
  }

  /** Risk has approved at least one of the merchant's applications (MCC changes then need Risk). */
  private riskApproved(db: MerchantDb, merchantId: string): boolean {
    return merchantRiskApproved(db, merchantId);
  }

  /** A catalogue MCC that is available in every country the merchant has an open or live application in. */
  private readMccChoice(db: MerchantDb, merchantId: string, rawCode: unknown): { entry: MccCatalogueEntry; catalogue: MccCatalogue; restricted: string[] } {
    const catalogue = this.catalogue();
    if (!catalogue.source || !catalogue.entries.length) fail(422, 'MCC_NOT_AVAILABLE', { message: 'No MCC catalogue has been loaded yet, so an MCC cannot be assigned.' });
    const code = str(rawCode, 8).trim();
    const entry = catalogue.entries.find((e) => e.code === code) ?? fail(422, 'MCC_NOT_AVAILABLE', { message: `MCC ${code || '(blank)'} is not in the catalogue.` });
    const countries = db.applications.filter((a) => a.merchantId === merchantId && a.status !== 'rejected').map((a) => a.country);
    const { unavailable, restricted } = mccCountryCheck(catalogue, entry.code, countries);
    if (unavailable.length) {
      fail(422, 'MCC_NOT_AVAILABLE', { message: `MCC ${entry.code} is not available in ${unavailable.map((c) => ONBOARDING_COUNTRIES[c]?.name ?? c).join(', ')}.` });
    }
    return { entry, catalogue, restricted };
  }

  private assignedMcc(entry: MccCatalogueEntry, catalogue: MccCatalogue, at: number, by: string) {
    return { code: entry.code, description: entry.description, catalogueVersion: catalogue.source!.version, catalogueKind: catalogue.source!.kind, setAt: at, setBy: by };
  }

  private requestEvent(r: MccChangeRequest, outcome: MccAuditEvent['outcome'], at: number): MccAuditEvent {
    return {
      at, merchantId: r.merchantId, outcome, previous: r.previous, next: r.proposed, reason: r.reason, requestId: r.id,
      requestedBy: r.requestedBy, requestedRole: r.requestedRole, requestedAt: r.requestedAt,
      decidedBy: r.decidedBy, decidedRole: r.decidedRole, decidedAt: r.decidedAt, comment: r.decisionComment, restrictedIn: r.restrictedIn,
    };
  }

  private mccEvent(db: MerchantDb, e: MccAuditEvent) {
    db.mccEvents ??= [];
    db.mccEvents.unshift(e);
    db.mccEvents = db.mccEvents.slice(0, 1000);
  }

  // ---------------------------------------------------------- notifications

  private markRead(body: any, role: StaffRole): { updated: number } {
    const db = this.load();
    const ids: string[] | null = Array.isArray(body?.ids) ? body.ids : null;
    let updated = 0;
    for (const n of db.notifications) {
      if ((!ids || ids.includes(n.id)) && n.audience.includes(role) && !n.readBy.includes(role)) {
        n.readBy.push(role);
        updated++;
      }
    }
    this.save(db);
    return { updated };
  }

  private notify(
    db: MerchantDb,
    event: NotificationEvent,
    app: CountryApplication,
    merchant: MerchantRecord,
    audience: StaffRole[],
    msg: { title: string; body: string; to: string[] },
  ) {
    db.notifications.unshift({
      id: `NT-${db.seq.notification++}`,
      at: this.now(),
      event,
      title: msg.title,
      body: msg.body,
      applicationId: app.id,
      merchantId: merchant.id,
      country: app.country,
      audience,
      email: { to: msg.to, subject: `[Mobi Global Platform] ${msg.title}`, status: 'simulated' },
      readBy: [],
    });
    db.notifications = db.notifications.slice(0, 300);
  }

  // ------------------------------------------------- Product & Payment Config

  private products(id: string, role: StaffRole) {
    const db = this.load();
    return productView(db, this.findApplication(db, id), role, this.now());
  }

  /** Runs a product, settlement or pricing change and saves it with its history entries in one write. */
  private productAction<T extends object>(id: string, caller: Caller, role: StaffRole, run: (ctx: ProductContext) => T) {
    const db = this.load();
    const app = this.findApplication(db, id);
    const result = run(this.productContext(db, app, caller, role));
    app.updatedAt = this.now();
    this.save(db);
    return { ...result, view: productView(db, app, role, this.now()) };
  }

  private productContext(db: MerchantDb, app: CountryApplication, caller: Caller, role: StaffRole): ProductContext {
    const merchant = this.findMerchant(db, app.merchantId);
    return {
      db,
      app,
      caller,
      role,
      now: this.now(),
      record: (text, opts) => this.event(app, opts?.system ? null : caller, opts?.system ? 'system' : role, text, null, null, opts?.comment),
      notify: (event, audience, title, body) => {
        db.notifications.unshift({ id: `NT-${db.seq.notification++}`, at: this.now(), event, title, body, applicationId: app.id, merchantId: merchant.id, country: app.country, audience, readBy: [] });
        db.notifications = db.notifications.slice(0, 300);
      },
    };
  }

  /** A notification about the merchant as a whole (no application); it links to the merchant. */
  private notifyMerchant(db: MerchantDb, event: NotificationEvent, merchant: MerchantRecord, audience: StaffRole[], msg: { title: string; body: string; to: string[] }) {
    db.notifications.unshift({
      id: `NT-${db.seq.notification++}`,
      at: this.now(),
      event,
      title: msg.title,
      body: msg.body,
      applicationId: '',
      merchantId: merchant.id,
      audience,
      email: { to: msg.to, subject: `[Mobi Global Platform] ${msg.title}`, status: 'simulated' },
      readBy: [],
    });
    db.notifications = db.notifications.slice(0, 300);
  }

  // ---------------------------------------------------------------- helpers

  private requireRole(role: StaffRole, needed: StaffRole) {
    if (role !== needed) fail(403, 'ROLE_NOT_PERMITTED', { message: `Only ${needed === 'sales' ? 'Sales / Operations' : needed === 'risk' ? 'Risk' : 'Customer Success'} can do this.` });
  }

  /**
   * Suspension blocks new merchant-level activity (new country applications) and go-live until Risk
   * reactivates the merchant. Existing applications continue their controlled review: drafts can be
   * edited and submitted, Risk can approve, return or reject, and CS can work through readiness.
   */
  private requireNotSuspended(merchant: MerchantRecord, action: string) {
    if (merchant.lifecycleStatus === 'suspended') fail(409, 'MERCHANT_SUSPENDED', { message: `${merchant.legalName} is suspended, so it can't ${action}. Risk must reactivate the merchant first.` });
  }

  private findMerchant(db: MerchantDb, id: string): MerchantRecord {
    return db.merchants.find((m) => m.id === id) ?? fail(404, 'NOT_FOUND', { message: `No Global Merchant ${id}.` });
  }

  private findApplication(db: MerchantDb, id: string): CountryApplication {
    return db.applications.find((a) => a.id === id) ?? fail(404, 'NOT_FOUND', { message: `No application ${id}.` });
  }

  private withStatus(db: MerchantDb, m: MerchantRecord): GlobalMerchant {
    return { ...m, lifecycleStatus: m.lifecycleStatus ?? 'active', lifecycleReason: m.lifecycleReason ?? null, lifecycleUpdatedAt: m.lifecycleUpdatedAt ?? null, lifecycleUpdatedBy: m.lifecycleUpdatedBy ?? null, globalStatus: deriveGlobalStatus(db.applications.filter((a) => a.merchantId === m.id)) };
  }

  private summary(db: MerchantDb, a: CountryApplication, m: MerchantRecord): ApplicationSummary {
    const mid = (db.mids ?? []).find((x) => x.applicationId === a.id);
    return { id: a.id, merchantId: a.merchantId, merchantName: m.legalName, country: a.country, currency: a.currency, status: a.status, submissionCount: a.submissionCount, createdAt: a.createdAt, updatedAt: a.updatedAt, liveMid: mid ? { mid: mid.mid, source: mid.source } : null };
  }

  private event(app: CountryApplication, caller: Caller | null, role: StaffRole | 'system', action: string, from: ApplicationStatus | null, to: ApplicationStatus | null, comment?: string, sections?: SectionKey[]) {
    const e: HistoryEvent = { at: this.now(), action, by: caller?.name ?? 'System', role, fromStatus: from, toStatus: to };
    if (comment) e.comment = comment;
    if (sections?.length) e.sections = sections;
    app.history.push(e);
  }

  /** Accepts only the known shape for the country, so stray fields can't be stored. */
  private readData(country: string, raw: any): ApplicationData {
    const cfg = ONBOARDING_COUNTRIES[country];
    const base = emptyApplicationData(country);
    const b = raw?.business ?? {};
    const c = raw?.contact ?? {};
    base.business = {
      tradingName: str(b.tradingName, 160),
      businessType: str(b.businessType, 80),
      industry: str(b.industry, 80),
      website: str(b.website, 200).trim(),
      address: str(b.address, 400),
      localRegistrationNumber: str(b.localRegistrationNumber, 40).trim(),
      taxId: str(b.taxId, 40).trim(),
      expectedMonthlyVolume: num(b.expectedMonthlyVolume),
    };
    base.contact = { name: str(c.name, 120), email: str(c.email, 254).trim(), phone: str(c.phone, 30).trim(), supportEmail: str(c.supportEmail, 254).trim() };
    for (const f of cfg.bankFields) base.bank[f.key] = str(raw?.bank?.[f.key], 120).trim();
    base.directors = (Array.isArray(raw?.directors) ? raw.directors : []).slice(0, 20).map(
      (d: any): Director => ({
        id: str(d?.id, 20) || randomToken(6),
        name: str(d?.name, 120),
        nationality: str(d?.nationality, 60),
        idNumber: str(d?.idNumber, 40),
        role: ['director', 'beneficial_owner', 'director_and_owner'].includes(d?.role) ? d.role : 'director',
        ownershipPct: num(d?.ownershipPct),
      }),
    );
    const docTypes = new Set(cfg.documents.map((d) => d.type));
    base.documents = (Array.isArray(raw?.documents) ? raw.documents : [])
      .filter((d: any) => docTypes.has(d?.type))
      .slice(0, 40)
      .map((d: any): DocumentRecord => ({ id: str(d.id, 20) || randomToken(6), type: d.type, fileName: str(d.fileName, 160), sizeKb: num(d.sizeKb) ?? 0, uploadedAt: num(d.uploadedAt) ?? this.now(), sample: d.sample !== false }));
    base.pricing = cfg.paymentMethods.map((m) => {
      const line = (Array.isArray(raw?.pricing) ? raw.pricing : []).find((p: any) => p?.code === m.code);
      return { code: m.code, enabled: line?.enabled === true, mdr: line ? num(line.mdr) : m.defaultMdr };
    });
    return base;
  }

  // ---------------------------------------------------------------- storage

  /** Explicit demo reset only (mobiDemo.reset / resetMerchants). Never called automatically. */
  async resetAll() {
    this.opts.storage.removeItem(this.storageKey);
    this.ensureSeeded();
  }

  /** Copy of the data as it was before the first upgrade to schema revision 3. Written once, never overwritten. */
  get backupKey() {
    return `${this.storageKey}.backup.r2`;
  }

  /** Prototype/QA: upgrade status, history and records that couldn't be upgraded safely. Writes nothing beyond a normal load. */
  dataReport(): MerchantDataReport {
    this.ensureSeeded();
    const db = this.load();
    return {
      schemaRevision: db.schemaRevision ?? null,
      backupKey: this.backupKey,
      backupPresent: this.opts.storage.getItem(this.backupKey) !== null,
      upgradePending: this.upgradePending,
      log: db.migrationLog ?? [],
      flags: migrationFlags(db),
    };
  }

  /** Prototype/QA, run by hand only: puts the pre-upgrade backup back, keeping a copy of the data it replaces. */
  restoreBackup(): string {
    const backup = this.opts.storage.getItem(this.backupKey);
    if (backup === null) return 'There is no pre-upgrade backup to restore.';
    const current = this.opts.storage.getItem(this.storageKey);
    const copyKey = `${this.storageKey}.backup.pre-restore.${this.now()}`;
    if (current !== null) this.opts.storage.setItem(copyKey, current);
    this.opts.storage.setItem(this.storageKey, backup);
    return `Restored the pre-upgrade backup. The data it replaced is kept under ${copyKey}. This build upgrades it again on the next request; an older build uses it as it is.`;
  }

  /**
   * Seeds only a browser that has no merchant data. Existing data is never reseeded: unreadable
   * data or data from another version is left in place (and backed up) and requests fail clearly.
   */
  private ensureSeeded() {
    const raw = this.opts.storage.getItem(this.storageKey);
    if (raw === null) {
      const now = this.now();
      this.save(normaliseMerchantDb(buildMerchantSeed(now, DB_VERSION), now).db);
      return;
    }
    let version: unknown;
    try {
      version = JSON.parse(raw)?.version;
    } catch {
      fail(500, 'DATA_UNREADABLE', { message: 'Stored merchant data could not be read. It has been left unchanged.' });
    }
    if (version !== DB_VERSION) {
      const key = `${this.storageKey}.backup.v${String(version)}`;
      try {
        if (this.opts.storage.getItem(key) === null) this.opts.storage.setItem(key, raw);
      } catch {
        // Backing up is best effort here; the data itself is not touched either way.
      }
      fail(503, 'DATA_VERSION_UNSUPPORTED', {
        message: `Stored merchant data is from an unsupported version (${String(version)}). It has been kept unchanged. Run mobiDemo.resetMerchants() to start again with demo data.`,
      });
    }
  }

  // Re-read on every request so changes made in another tab apply immediately. Each read also
  // applies the data upgrade (merchant-migrations.ts); it is saved only after a backup exists.
  private load(): MerchantDb {
    const raw = this.opts.storage.getItem(this.storageKey)!;
    const stored = JSON.parse(raw) as MerchantDb;
    const { db, changed } = normaliseMerchantDb(stored, this.now());
    let current = db;
    if (!changed) this.upgradePending = false;
    else if (!this.persistUpgrade(stored, raw, db)) current = stored;
    current.lifecycleEvents ??= [];
    for (const merchant of current.merchants) merchant.lifecycleStatus ??= 'active';
    return current;
  }

  /**
   * Saves upgraded data in one write, after backing up the original the first time. If the backup
   * or the write fails, nothing is changed: the data is served as it was and the upgrade is
   * retried on the next request (go-live waits for it).
   */
  private persistUpgrade(stored: MerchantDb, raw: string, db: MerchantDb): boolean {
    try {
      if ((stored.schemaRevision ?? 2) < SCHEMA_REVISION && this.opts.storage.getItem(this.backupKey) === null) {
        this.opts.storage.setItem(this.backupKey, raw);
      }
      // Another tab may have written in the meantime; its data is upgraded on the next read instead.
      if (this.opts.storage.getItem(this.storageKey) !== raw) throw new Error('changed');
      this.opts.storage.setItem(this.storageKey, JSON.stringify(db));
      this.upgradePending = false;
      return true;
    } catch {
      this.upgradePending = true;
      return false;
    }
  }

  private save(db: MerchantDb) {
    this.opts.storage.setItem(this.storageKey, JSON.stringify(db));
  }
}

const ok = (body: unknown, status = 200): ServerReply => ({ status, body });
const mccRef = (m: MccRef | null | undefined): MccRef | null => (m ? { code: m.code, description: m.description } : null);
const mccText = (m: MccRef | null) => (m ? `${m.code} (${m.description})` : 'none');
