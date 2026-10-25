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
  MerchantApiError,
  MerchantApiErrorCode,
  MerchantDetail,
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
import { randomToken } from './crypto';
import { buildMerchantSeed } from './merchant-seed';
import { simulateVerification } from './verification';

// Simulated Merchant Management & Onboarding backend (Batch 2). Like the auth server it
// runs in the browser for the prototype, but enforces every rule itself: role permissions,
// status transitions, validation and duplicate checks are never left to the UI.

const DB_VERSION = 1;

export type MerchantRecord = Omit<GlobalMerchant, 'globalStatus'>;

export interface MerchantDb {
  version: number;
  seq: { merchant: number; application: number; notification: number };
  merchants: MerchantRecord[];
  applications: CountryApplication[];
  notifications: PortalNotification[];
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
  /** Marks the country active on the merchant's Global Account, creating the account if needed. Returns its ID. */
  activateCountry(accountId: string | null, accountName: string, country: string): Promise<string>;
}

export interface MerchantServerOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey?: string;
  now?: () => number;
  auth: AuthBridge;
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

const STAFF_ROLES: StaffRole[] = ['sales', 'risk', 'cs'];
const EDITABLE: ApplicationStatus[] = ['draft', 'returned'];

/** Simulated team mailboxes for the target email behaviour. */
export const TEAM_MAILBOX: Record<StaffRole, string> = {
  sales: 'sales-ops@mobi-demo.test',
  risk: 'risk-review@mobi-demo.test',
  cs: 'cs-onboarding@mobi-demo.test',
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

  constructor(private readonly opts: MerchantServerOptions) {
    this.storageKey = opts.storageKey ?? 'mobi.gp.merchantdb';
    this.now = opts.now ?? Date.now;
  }

  static handles(path: string) {
    return /^\/api\/(merchants|applications|notifications)(\/|\?|$)/.test(path);
  }

  async handle(method: string, path: string, body: any, token: string | null, roleHeader: string | null): Promise<ServerReply> {
    const auth = await this.opts.auth.authenticate(token);
    if (!auth.ok) return auth.response;
    const caller = auth.caller;
    const role = STAFF_ROLES.includes(roleHeader as StaffRole) ? (roleHeader as StaffRole) : 'sales';
    this.ensureSeeded();
    try {
      const [rawPath, rawQuery] = path.split('?');
      const query = new URLSearchParams(rawQuery ?? '');
      const seg = rawPath.split('/').filter(Boolean).slice(1); // drop "api"
      const m = method.toUpperCase();
      const [resource, id, sub] = seg;

      if (resource === 'merchants') {
        if (!id && m === 'GET') return ok(this.listMerchants());
        if (!id && m === 'POST') return ok(this.createMerchant(body, caller, role), 201);
        if (id && !sub && m === 'GET') return ok(this.merchantDetail(id));
        if (id && !sub && m === 'PATCH') return ok(this.updateMerchant(id, body, role));
        if (id && sub === 'applications' && m === 'POST') return ok(this.createApplication(id, body, caller, role), 201);
      }
      if (resource === 'applications') {
        if (!id && m === 'GET') return ok(this.listApplications(query));
        if (id && !sub && m === 'GET') return ok(this.applicationDetail(id));
        if (id && !sub && m === 'PUT') return ok(this.saveDraft(id, body, caller, role));
        if (id && sub === 'submit' && m === 'POST') return ok(this.submit(id, body, caller, role));
        if (id && sub === 'review' && m === 'POST') return ok(this.review(id, body, caller, role));
        if (id && sub === 'readiness' && m === 'POST') return ok(await this.readiness(id, body, caller, role));
      }
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
        const apps = db.applications.filter((a) => a.merchantId === m.id).map((a) => this.summary(a, m));
        const lastUpdatedAt = Math.max(m.updatedAt, ...apps.map((a) => a.updatedAt));
        return { ...this.withStatus(db, m), applications: apps, lastUpdatedAt };
      })
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  }

  private merchantDetail(id: string): MerchantDetail {
    const db = this.load();
    const m = this.findMerchant(db, id);
    return { merchant: this.withStatus(db, m), applications: db.applications.filter((a) => a.merchantId === m.id).sort((a, b) => a.createdAt - b.createdAt) };
  }

  private createMerchant(body: any, caller: Caller, role: StaffRole): GlobalMerchant {
    this.requireRole(role, 'sales');
    const input = this.readMerchantInput(body);
    const db = this.load();

    // Hard stop: the same registration number in the same country is the same organisation.
    const sameReg = db.merchants.find((x) => x.registrationCountry === input.registrationCountry && normReg(x.registrationNumber) === normReg(input.registrationNumber));
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

  private updateMerchant(id: string, body: any, role: StaffRole): GlobalMerchant {
    this.requireRole(role, 'sales');
    const db = this.load();
    const m = this.findMerchant(db, id);
    const input = this.readMerchantInput({ ...m, ...body });
    const clash = db.merchants.find((x) => x.id !== m.id && x.registrationCountry === input.registrationCountry && normReg(x.registrationNumber) === normReg(input.registrationNumber));
    if (clash) fail(409, 'DUPLICATE_MERCHANT', { existingMerchantId: clash.id, message: `${clash.legalName} (${clash.id}) already uses this registration number.` });
    Object.assign(m, { legalName: input.legalName, registrationCountry: input.registrationCountry, registrationNumber: input.registrationNumber, primaryContact: input.primaryContact, updatedAt: this.now() });
    this.save(db);
    return this.withStatus(db, m);
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
    if (errors.length) fail(422, 'VALIDATION_FAILED', { errors });
    return { legalName, registrationCountry, registrationNumber, primaryContact };
  }

  // ----------------------------------------------------------- applications

  private listApplications(query: URLSearchParams): ApplicationSummary[] {
    const db = this.load();
    const statuses = query.get('status')?.split(',').filter(Boolean) ?? [];
    return db.applications
      .filter((a) => !statuses.length || statuses.includes(a.status))
      .map((a) => this.summary(a, this.findMerchant(db, a.merchantId)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private applicationDetail(id: string): ApplicationDetail {
    const db = this.load();
    const application = this.findApplication(db, id);
    return { application, merchant: this.withStatus(db, this.findMerchant(db, application.merchantId)) };
  }

  private createApplication(merchantId: string, body: any, caller: Caller, role: StaffRole): CountryApplication {
    this.requireRole(role, 'sales');
    const db = this.load();
    const merchant = this.findMerchant(db, merchantId);
    const country = str(body?.country, 2).toUpperCase();
    const cfg = ONBOARDING_COUNTRIES[country];
    if (!cfg) fail(422, 'COUNTRY_NOT_SUPPORTED', { message: 'Onboarding is not available for this country.' });

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
      country,
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
    if (errors.length) {
      app.updatedAt = this.now();
      this.save(db);
      fail(422, 'APPLICATION_INCOMPLETE', { errors, message: `${errors.length} item${errors.length === 1 ? '' : 's'} must be completed before submission.` });
    }
    const resubmission = app.status === 'returned';
    const from = app.status;
    const now = this.now();
    app.status = 'pending_risk_review';
    app.submissionCount += 1;
    app.submittedProfile = { legalName: merchant.legalName, registrationCountry: merchant.registrationCountry, registrationNumber: merchant.registrationNumber };
    app.verification = simulateVerification(merchant, app.data, now);
    app.corrections = null;
    app.updatedAt = now;
    const note = str(body?.comment, 1000).trim() || undefined;
    this.event(app, caller, role, resubmission ? 'Resubmitted after correction' : 'Submitted for Risk review', from, app.status, note);
    this.event(app, null, 'system', 'Verification evidence received (simulated)', null, null);
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
    if (errors.length) fail(422, 'VALIDATION_FAILED', { errors });

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
      if (open.length) fail(409, 'CHECKLIST_INCOMPLETE', { message: `Complete: ${open.map((i) => i.label).join('; ')}.` });
    };
    const now = this.now();

    switch (body?.action) {
      case 'start_configuration':
        move('risk_approved', 'cs_configuration', 'CS configuration started');
        break;
      case 'set_item': {
        const stageStatus: Record<ReadinessStage, ApplicationStatus> = { configuration: 'cs_configuration', integration: 'integration', go_live: 'go_live_verification' };
        if (!(body.stage in stageStatus) || app.status !== stageStatus[body.stage]) fail(409, 'INVALID_TRANSITION', { message: 'This checklist is not open at the current stage.' });
        const item = r[body.stage].find((i) => i.key === body.key);
        if (!item) fail(404, 'NOT_FOUND');
        item!.done = body.done === true;
        item!.doneAt = item!.done ? now : null;
        item!.doneBy = item!.done ? caller.name : null;
        this.event(app, caller, role, `${item!.done ? 'Completed' : 'Reopened'}: ${item!.label}`, null, null);
        break;
      }
      case 'generate_keys':
        requireDone('configuration');
        move('cs_configuration', 'keys_generated', 'Production keys generated (simulated)');
        r.keySet = { reference: `KS-DEMO-${randomToken(3).toUpperCase()}`, generatedAt: now, environment: 'production', simulated: true };
        this.notify(db, 'configuration_ready', app, merchant, ['cs', 'sales'], {
          title: `Configuration ready: ${merchant.legalName} · ${cname}`,
          body: `CS configuration is complete and production keys are generated (simulated) for ${app.id}. Merchant integration can start.`,
          to: [merchant.primaryContact.email, TEAM_MAILBOX.cs],
        });
        break;
      case 'start_integration':
        move('keys_generated', 'integration', 'Merchant integration started');
        break;
      case 'request_go_live':
        requireDone('integration');
        move('integration', 'go_live_verification', 'Integration complete; go-live verification started');
        break;
      case 'confirm_go_live': {
        requireDone('go_live');
        if (app.status !== 'go_live_verification') fail(409, 'INVALID_TRANSITION', { message: 'Go-live can only be confirmed after verification.' });
        const accountId = await this.opts.auth.activateCountry(merchant.linkedAccountId, merchant.legalName, app.country);
        const created = merchant.linkedAccountId === null;
        merchant.linkedAccountId = accountId;
        merchant.updatedAt = now;
        move('go_live_verification', 'operational', 'Go-live verified; country is operational');
        this.event(app, null, 'system', `${cname} activated on Global Account ${accountId}${created ? ' (account created)' : ''}`, null, null);
        this.notify(db, 'go_live', app, merchant, ['sales', 'cs', 'risk'], {
          title: `Live: ${merchant.legalName} · ${cname}`,
          body: `${app.id} passed go-live verification. ${cname} is now operational for ${merchant.id}.`,
          to: [merchant.primaryContact.email, TEAM_MAILBOX.sales, TEAM_MAILBOX.cs],
        });
        break;
      }
      default:
        fail(400, 'VALIDATION_FAILED', { message: 'Unknown readiness action.' });
    }
    app.updatedAt = now;
    this.save(db);
    return app;
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

  // ---------------------------------------------------------------- helpers

  private requireRole(role: StaffRole, needed: StaffRole) {
    if (role !== needed) fail(403, 'ROLE_NOT_PERMITTED', { message: `Only ${needed === 'sales' ? 'Sales / Operations' : needed === 'risk' ? 'Risk' : 'Customer Success'} can do this.` });
  }

  private findMerchant(db: MerchantDb, id: string): MerchantRecord {
    return db.merchants.find((m) => m.id === id) ?? fail(404, 'NOT_FOUND', { message: `No Global Merchant ${id}.` });
  }

  private findApplication(db: MerchantDb, id: string): CountryApplication {
    return db.applications.find((a) => a.id === id) ?? fail(404, 'NOT_FOUND', { message: `No application ${id}.` });
  }

  private withStatus(db: MerchantDb, m: MerchantRecord): GlobalMerchant {
    return { ...m, globalStatus: deriveGlobalStatus(db.applications.filter((a) => a.merchantId === m.id)) };
  }

  private summary(a: CountryApplication, m: MerchantRecord): ApplicationSummary {
    return { id: a.id, merchantId: a.merchantId, merchantName: m.legalName, country: a.country, currency: a.currency, status: a.status, submissionCount: a.submissionCount, createdAt: a.createdAt, updatedAt: a.updatedAt };
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

  async resetAll() {
    this.opts.storage.removeItem(this.storageKey);
    this.ensureSeeded();
  }

  private ensureSeeded() {
    const raw = this.opts.storage.getItem(this.storageKey);
    if (raw && JSON.parse(raw).version === DB_VERSION) return;
    this.save(buildMerchantSeed(this.now(), DB_VERSION));
  }

  // Re-read on every request so changes made in another tab apply immediately.
  private load(): MerchantDb {
    return JSON.parse(this.opts.storage.getItem(this.storageKey)!);
  }

  private save(db: MerchantDb) {
    this.opts.storage.setItem(this.storageKey, JSON.stringify(db));
  }
}

const ok = (body: unknown, status = 200): ServerReply => ({ status, body });
