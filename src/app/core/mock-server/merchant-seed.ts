import { emptyApplicationData } from '../merchants/application-rules';
import {
  ApplicationData,
  ApplicationStatus,
  CountryApplication,
  Director,
  HistoryEvent,
  PortalNotification,
  SectionKey,
  StaffRole,
} from '../merchants/merchant-models';
import { ONBOARDING_COUNTRIES, READINESS_CHECKLISTS as READINESS } from '../merchants/onboarding-config';
import { periodText, pricingSummary, type PricingAuditEvent, type PricingVersion, type ProductConfig } from '../merchants/products';
import type { MerchantDb, MerchantRecord } from './merchant-server';
import { formatEntityId, type MerchantEntity } from './merchant-identity';
import { SUB_MERCHANT_CHECKS } from '../merchants/sub-merchants';
import { simulateVerification } from './verification';

// Seed merchants. Names, registration numbers, bank accounts and people are fictional
// and marked `demo: true`. GM-100101 and GM-100102 are
// linked to Batch 1 Global Accounts GA-1001 and GA-4004, and their application statuses
// match those accounts' country access (active / pending / failed).

const DAY = 24 * 60 * 60_000;
const STAFF: Record<Exclude<StaffRole, 'finops'>, string> = { sales: 'Hafiz Ismail', risk: 'Daniel Tan', cs: 'Mei Ling Wong' };

const SAMPLE_BUSINESS: Record<string, { reg: string; tax: string; bank: (holder: string) => Record<string, string>; dailyLimit: number; minValue: number }> = {
  MY: { reg: '201901099999', tax: 'C2584563202', bank: (h) => ({ bankName: 'Maybank', accountName: h, accountNumber: '514012345678', swiftCode: 'MBBEMYKL' }), dailyLimit: 200_000, minValue: 1 },
  ID: { reg: '9120001234567', tax: '012345678901000', bank: (h) => ({ bankName: 'Bank Central Asia', accountName: h, accountNumber: '0123456789', bankCode: 'CENAIDJA' }), dailyLimit: 3_000_000_000, minValue: 10_000 },
  VN: { reg: '0312345678', tax: '0312345678', bank: (h) => ({ bankName: 'Vietcombank', branch: 'Ho Chi Minh City', accountName: h, accountNumber: '0071001234567', swiftCode: 'BFTVVNVX' }), dailyLimit: 5_000_000_000, minValue: 10_000 },
};

const ADDRESSES: Record<string, string> = {
  MY: 'Level 12, Menara Kencana, Jalan Sultan Ismail, 50250 Kuala Lumpur',
  ID: 'Jl. Jend. Sudirman Kav. 1, Jakarta Selatan 12190',
  VN: '12 Nguyen Hue, District 1, Ho Chi Minh City',
};

type Step = [daysAgo: number, action: string, to: ApplicationStatus | null, role: Exclude<StaffRole, 'finops'> | 'system', comment?: string, sections?: SectionKey[]];

interface AppSeed {
  id: string;
  merchant: MerchantRecord;
  country: string;
  industry: string;
  website?: string;
  directors?: Director[];
  steps: Step[];
  /** Leave sections empty to represent a partially completed draft. */
  incomplete?: ('bank' | 'transaction' | 'documents')[];
  /** Products switched on once CS configuration is complete (default: the country's first three). */
  enabledMethods?: string[];
  priority?: CountryApplication['data']['business']['approvalPriority'];
  category?: CountryApplication['data']['transaction']['merchantCategory'];
  incorporated?: string;
  configDone?: number;
  integrationDone?: number;
  goLiveDone?: number;
  previousApplicationId?: string;
}

export function buildMerchantSeed(now: number, version: number): MerchantDb {
  const ago = (d: number) => now - d * DAY;

  const merchant = (id: number, legalName: string, registrationCountry: string, registrationNumber: string, contact: [string, string, string], createdDaysAgo: number, linkedAccountId: string | null = null): MerchantRecord => ({
    id: `GM-${id}`,
    legalName,
    registrationCountry,
    registrationNumber,
    primaryContact: { name: contact[0], email: contact[1], phone: contact[2] },
    linkedAccountId,
    createdAt: ago(createdDaysAgo),
    updatedAt: ago(createdDaysAgo),
    createdBy: STAFF.sales,
    demo: true,
  });

  const person = (name: string, nationality: string, idNumber: string, contactNumber: string, i: number, profileUrl = ''): Director => ({ id: `seed${i}`, name, contactNumber, nationality, profileUrl, idNumber });

  const trading = merchant(100101, 'Tanjung Global Trading Sdn Bhd', 'MY', '201901012345', ['Farah Ismail', 'farah.ismail@tanjungtrading.example', '+60 12 345 6789'], 230, 'GA-1001');
  const lumi = merchant(100102, 'Lumi Home Living Sdn Bhd', 'MY', '202301045678', ['Nguyen Lan', 'lan@lumihome.example', '+60 13 222 3344'], 95, 'GA-4004');
  const kopi = merchant(100103, 'PT Kopi Nusantara Sejahtera', 'ID', '9120007654321', ['Rina Wijaya', 'rina@kopinusantara.example', '+62 812 3456 7890'], 20);
  const saigon = merchant(100104, 'Saigon Journeys JSC', 'VN', '0398765432', ['Tran Minh', 'minh@saigonjourneys.example', '+84 90 123 4567'], 4);
  const bites = merchant(100105, 'PT Rasa Bali Kuliner', 'ID', '9120005551234', ['Made Wirawan', 'made@rasabali.example', '+62 813 3777 2211'], 45);
  const manila = merchant(100106, 'Hanoi Learning Hub JSC', 'VN', '0109876543', ['Pham Thu Ha', 'ha@hanoilearning.example', '+84 91 234 5678'], 60);
  const fresh = merchant(100107, 'FreshMart Retail Sdn Bhd', 'MY', '201801098765', ['Kumar Selvam', 'kumar@freshmart.example', '+60 16 789 0123'], 14);
  const pixel = merchant(100108, 'Pixel Forge Games Pte. Ltd.', 'SG', '201912345K', ['Alex Lee', 'alex@pixelforge.example', '+65 9123 4567'], 1);

  const tradingDirectors = [person('Farah Ismail', 'Malaysian', '850101-14-5678', '+60 12 345 6789', 1, 'https://www.linkedin.com/in/farah-ismail-example'), person('Lim Wei Jie', 'Malaysian', '820315-10-1234', '+60 12 987 6543', 2)];

  const seeds: AppSeed[] = [
    // GM-100101 · linked to GA-1001 (MY/ID/VN live)
    {
      id: 'APP-2026-0001', merchant: trading, country: 'MY', industry: 'Retail & e-commerce', website: 'https://tanjungtrading.example', directors: tradingDirectors, category: 'enterprise', enabledMethods: ['fpx', 'duitnow_qr', 'tng', 'cards'],
      steps: [[225, 'Application created', 'draft', 'sales'], [221, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [218, 'Approved by Risk', 'risk_approved', 'risk', 'Documents and screening clear.'], [217, 'CS configuration started', 'cs_configuration', 'cs'], [214, 'Production keys generated', 'keys_generated', 'cs'], [213, 'Merchant integration started', 'integration', 'cs'], [205, 'Integration complete; go-live verification started', 'go_live_verification', 'cs'], [203, 'Go-live verified; country is operational', 'operational', 'cs']],
    },
    {
      id: 'APP-2026-0002', merchant: trading, country: 'ID', industry: 'Retail & e-commerce', website: 'https://tanjungtrading.example', directors: tradingDirectors, category: 'enterprise',
      steps: [[190, 'Application created', 'draft', 'sales'], [186, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [181, 'Approved by Risk', 'risk_approved', 'risk'], [180, 'CS configuration started', 'cs_configuration', 'cs'], [176, 'Production keys generated', 'keys_generated', 'cs'], [175, 'Merchant integration started', 'integration', 'cs'], [168, 'Integration complete; go-live verification started', 'go_live_verification', 'cs'], [166, 'Go-live verified; country is operational', 'operational', 'cs']],
    },
    {
      id: 'APP-2026-0003', merchant: trading, country: 'VN', industry: 'Retail & e-commerce', website: 'https://tanjungtrading.example', directors: tradingDirectors, category: 'enterprise',
      steps: [[150, 'Application created', 'draft', 'sales'], [147, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [143, 'Approved by Risk', 'risk_approved', 'risk'], [142, 'CS configuration started', 'cs_configuration', 'cs'], [139, 'Production keys generated', 'keys_generated', 'cs'], [138, 'Merchant integration started', 'integration', 'cs'], [130, 'Integration complete; go-live verification started', 'go_live_verification', 'cs'], [128, 'Go-live verified; country is operational', 'operational', 'cs']],
    },
    // GM-100102 · linked to GA-4004 (MY pending, VN failed)
    {
      id: 'APP-2026-0008', merchant: lumi, country: 'VN', industry: 'Retail & e-commerce',
      directors: [person('Nguyen Lan', 'Vietnamese', '079190001234', '+84 90 555 1234', 3)],
      steps: [[60, 'Application created', 'draft', 'sales'], [57, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [52, 'Rejected by Risk', 'rejected', 'risk', 'Home-furnishing marketplace sales in Vietnam are outside our current risk appetite for this category.']],
    },
    {
      id: 'APP-2026-0012', merchant: lumi, country: 'MY', industry: 'Retail & e-commerce', website: 'https://lumihome.example', priority: 'high',
      directors: [person('Nguyen Lan', 'Vietnamese', 'C1234567', '+60 13 222 3344', 4)],
      steps: [[6, 'Application created', 'draft', 'sales'], [1, 'Submitted for Risk review', 'pending_risk_review', 'sales']],
    },
    // GM-100103 · returned for correction
    {
      id: 'APP-2026-0011', merchant: kopi, country: 'ID', industry: 'Food & beverage', website: 'https://kopinusantara.example',
      directors: [person('Rina Wijaya', 'Indonesian', '3171234567890001', '+62 812 3456 7890', 5), person('Agus Pratama', 'Indonesian', '3171234567890002', '+62 812 9876 5432', 6)],
      steps: [[18, 'Application created', 'draft', 'sales'], [9, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [2, 'Returned for correction', 'returned', 'risk', 'The bank account proof is older than 3 months and the NPWP does not match the deed of establishment. Upload a recent bank statement and confirm the NPWP.', ['documents', 'business']]],
    },
    // GM-100104 · partially completed draft
    {
      id: 'APP-2026-0014', merchant: saigon, country: 'VN', industry: 'Travel & hospitality', website: 'https://saigonjourneys.example',
      directors: [person('Tran Minh', 'Vietnamese', '079085004321', '+84 90 123 4567', 7)],
      steps: [[4, 'Application created', 'draft', 'sales'], [3, 'Draft saved', null, 'sales']],
      incomplete: ['bank', 'transaction', 'documents'],
    },
    // GM-100105 · ID in merchant integration, MY in Product & Payment Config
    {
      id: 'APP-2026-0009', merchant: bites, country: 'ID', industry: 'Food & beverage', website: 'https://rasabali.example',
      directors: [person('Made Wirawan', 'Indonesian', '5171010101800001', '+62 813 3777 2211', 8)],
      steps: [[40, 'Application created', 'draft', 'sales'], [35, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [30, 'Approved by Risk', 'risk_approved', 'risk'], [29, 'CS configuration started', 'cs_configuration', 'cs'], [25, 'Production keys generated', 'keys_generated', 'cs'], [24, 'Merchant integration started', 'integration', 'cs']],
      configDone: 4, integrationDone: 1,
    },
    {
      id: 'APP-2026-0010', merchant: bites, country: 'MY', industry: 'Food & beverage', website: 'https://rasabali.example', priority: 'high',
      directors: [person('Made Wirawan', 'Indonesian', 'B7654321', '+62 813 3777 2211', 9)],
      steps: [[12, 'Application created', 'draft', 'sales'], [8, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [3, 'Approved by Risk', 'risk_approved', 'risk', 'Approved. Standard monitoring.'], [2, 'CS configuration started', 'cs_configuration', 'cs']],
      // CS has switched on and priced three products; settlement isn't set yet.
      enabledMethods: ['cards', 'duitnow_qr', 'tng'],
      configDone: 2,
    },
    // GM-100106 · VN in go-live verification, MY expansion draft
    {
      id: 'APP-2026-0007', merchant: manila, country: 'VN', industry: 'Education', website: 'https://hanoilearning.example',
      directors: [person('Pham Thu Ha', 'Vietnamese', '001190012345', '+84 91 234 5678', 10), person('Le Van Duc', 'Vietnamese', '001088054321', '+84 91 876 5432', 11)],
      steps: [[55, 'Application created', 'draft', 'sales'], [50, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [44, 'Approved by Risk', 'risk_approved', 'risk'], [43, 'CS configuration started', 'cs_configuration', 'cs'], [39, 'Production keys generated', 'keys_generated', 'cs'], [38, 'Merchant integration started', 'integration', 'cs'], [5, 'Integration complete; go-live verification started', 'go_live_verification', 'cs']],
      configDone: 4, integrationDone: 3, goLiveDone: 1,
    },
    {
      id: 'APP-2026-0015', merchant: manila, country: 'MY', industry: 'Education', website: 'https://hanoilearning.example', priority: 'low',
      directors: [person('Pham Thu Ha', 'Vietnamese', 'C7654321', '+84 91 234 5678', 12)],
      steps: [[2, 'Application created', 'draft', 'sales']],
      incomplete: ['bank', 'transaction', 'documents'],
    },
    // GM-100107 · resubmitted after correction (same application ID)
    {
      id: 'APP-2026-0013', merchant: fresh, country: 'MY', industry: 'Retail & e-commerce', website: 'https://freshmart.example', priority: 'urgent',
      directors: [person('Kumar Selvam', 'Malaysian', '800202-08-4321', '+60 16 789 0123', 13), person('Tan Ah Kow', 'Malaysian', '790909-07-1111', '+60 16 111 2222', 14)],
      steps: [[13, 'Application created', 'draft', 'sales'], [10, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [7, 'Returned for correction', 'returned', 'risk', 'Bank statement is missing the account holder name. Upload a statement that shows it.', ['documents']], [1, 'Resubmitted after correction', 'pending_risk_review', 'sales', 'Uploaded the full March bank statement with the account holder name.']],
    },
  ];

  const applications = seeds.map((s) => buildApplication(s, ago));
  const products = seeds.map((s, i) => seedProducts(s, applications[i]));

  const notifications: PortalNotification[] = [];
  let nt = 1;
  const note = (daysAgo: number, event: PortalNotification['event'], app: CountryApplication, m: MerchantRecord, audience: StaffRole[], title: string, body: string, to: string[]) =>
    notifications.push({ id: `NT-${nt++}`, at: ago(daysAgo), event, title, body, applicationId: app.id, merchantId: m.id, country: app.country, audience, email: { to, subject: `[Mobi Global Platform] ${title}`, status: 'simulated' }, readBy: [] });
  const byId = (id: string) => applications.find((a) => a.id === id)!;
  note(25, 'configuration_ready', byId('APP-2026-0009'), bites, ['cs', 'sales'], `Configuration ready: ${bites.legalName} · Indonesia`, 'CS configuration is complete and production keys are generated for APP-2026-0009. Merchant integration can start.', [bites.primaryContact.email, 'cs-onboarding@mobi.xyz']);
  note(3, 'approved', byId('APP-2026-0010'), bites, ['sales', 'cs'], `Risk approved: ${bites.legalName} · Malaysia`, 'APP-2026-0010 is approved. CS can now start country configuration. The merchant is not operational yet.', ['sales-ops@mobi.xyz', 'cs-onboarding@mobi.xyz']);
  note(2, 'returned', byId('APP-2026-0011'), kopi, ['sales'], `Returned for correction: ${kopi.legalName} · Indonesia`, 'Risk asked for corrections on APP-2026-0011: the bank account proof is older than 3 months and the NPWP does not match the deed.', ['sales-ops@mobi.xyz']);
  note(1, 'submitted', byId('APP-2026-0012'), lumi, ['risk', 'sales'], `Submitted: ${lumi.legalName} · Malaysia`, 'APP-2026-0012 is waiting for Risk review.', ['risk-review@mobi.xyz']);
  note(1, 'resubmitted', byId('APP-2026-0013'), fresh, ['risk', 'sales'], `Resubmitted: ${fresh.legalName} · Malaysia`, 'APP-2026-0013 is waiting for Risk review after correction.', ['risk-review@mobi.xyz']);
  notifications.sort((a, b) => b.at - a.at);

  const extra = buildSeedAdditions(now);
  applications.push(...extra.applications);
  products.push(...extra.products);
  const merchants = [trading, lumi, kopi, saigon, bites, manila, fresh, pixel, ...extra.merchants];
  for (const m of merchants) {
    const own = applications.filter((a) => a.merchantId === m.id);
    if (own.length) m.updatedAt = Math.max(m.updatedAt, ...own.map((a) => a.updatedAt));
  }

  // A pricing change waiting for FinOps: Sales / Operations proposed new Cards pricing for Tanjung (MY).
  const pricingVersions = products.flatMap((p) => p?.versions ?? []);
  pricingVersions.push(
    blankVersion({
      id: 'PV-SEED-0001-cards-v2',
      applicationId: 'APP-2026-0001',
      methodCode: 'cards',
      currency: 'MYR',
      technique: 'higher_of',
      mdrPct: 2.0,
      minimumFee: 0.5,
      version: 2,
      status: 'pending_approval',
      source: 'change',
      settlementSnapshot: 'T+1',
      startDate: new Date(now + 7 * DAY).toISOString().slice(0, 10),
      createdAt: ago(1),
      createdBy: STAFF.sales,
      createdById: 'seed-sales',
      createdRole: 'sales',
    }),
  );
  notifications.unshift({ id: `NT-${nt++}`, at: ago(1), event: 'pricing_approval_requested', title: `Pricing to approve: ${trading.legalName} · Cards`, body: `${STAFF.sales} submitted pricing change v2 for APP-2026-0001: Higher of Percentage or Fixed Fee: 2% + Min: MYR 0.5.`, applicationId: 'APP-2026-0001', merchantId: trading.id, country: 'MY', audience: ['finops'], readBy: [] });

  return {
    version,
    seq: { merchant: 100109, application: 16, notification: nt },
    seedAdditions: [...SEED_ADDITION_MERCHANT_IDS],
    merchants,
    applications,
    notifications,
    productConfigs: products.flatMap((p) => (p ? [p.config] : [])),
    pricingVersions,
    pricingAudit: seedAudit(pricingVersions, applications, merchants),
  };
}

const CONFIGURED: ApplicationStatus[] = ['keys_generated', 'integration', 'go_live_verification', 'operational'];

/** Demo MDRs (Percentage) for seeded pricing. Illustrative only, not approved Mobi prices. */
const SEED_MDR: Record<string, number> = { fpx: 1.0, duitnow_qr: 0.8, tng: 1.5, grabpay: 1.5, cards: 2.2, va: 0.9, qris: 0.7, dana: 1.5, ovo: 1.5, vietqr: 0.6, momo: 1.6, zalopay: 1.6, bank_transfer: 0.6 };

/** Demo payout pricing (Fixed Fee per transfer, local currency). Illustrative only. */
const SEED_PAYOUT_FEE: Record<string, number> = { MYR: 1, IDR: 2500, VND: 5000 };
/** Payout products switched on for live demo merchants: Bank Transfer plus one e-wallet where the catalog has one. */
const SEED_PAYOUTS: Record<string, string[]> = { MY: ['bank_transfer_payout', 'tng_payout'], ID: ['bank_transfer_payout', 'ovo_payout'], VN: ['bank_transfer_payout'] };

const blankVersion = (over: Partial<PricingVersion> & Pick<PricingVersion, 'id' | 'applicationId' | 'methodCode' | 'startDate' | 'createdAt'>): PricingVersion => ({
  flow: 'payin',
  vaBanks: [],
  technique: 'variable_rate',
  currency: 'MYR',
  mdrPct: 1,
  fixedFee: null,
  minimumFee: 0,
  volumePeriod: null,
  tiers: null,
  historical: null,
  subscription: null,
  promotion: null,
  endDate: null,
  version: 1,
  status: 'active',
  usd: null,
  source: 'onboarding',
  settlementSnapshot: null,
  editOf: null,
  createdBy: STAFF.cs,
  createdById: 'seed-cs',
  createdRole: 'cs',
  approvedBy: null,
  approvedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  cancelledBy: null,
  cancelledAt: null,
  ...over,
});

/**
 * Products and pricing for seed applications that are past Product & Payment Config: the chosen
 * PayIn products (default: the country's first three), settlement T+1, Percentage pricing at the
 * demo MDR from the day CS configuration started. An application still in configuration gets its
 * chosen products and pricing only, with no settlement. Others have none: CS sets them in Stage 4.
 */
function seedProducts(s: AppSeed, app: CountryApplication): { config: ProductConfig; versions: PricingVersion[] } | null {
  const configured = CONFIGURED.includes(app.status);
  if (!configured && !(app.status === 'cs_configuration' && s.enabledMethods)) return null;
  const cycle = configured ? ('T+1' as const) : null;
  const cfg = ONBOARDING_COUNTRIES[s.country];
  const payin = cfg.paymentMethods.filter((m) => m.flow === 'payin');
  const payinCodes = s.enabledMethods ?? payin.slice(0, 3).map((m) => m.code);
  // Configured MIDs also pay out: Bank Transfer and one e-wallet (onboarding stays PayIn only).
  const payoutCodes = configured ? (SEED_PAYOUTS[s.country] ?? []).filter((c) => cfg.paymentMethods.some((m) => m.code === c)) : [];
  const codes = [...payinCodes, ...payoutCodes];
  const started = app.history.find((h) => h.toStatus === 'cs_configuration') ?? app.history[0];
  const config: ProductConfig = {
    applicationId: app.id,
    products: cfg.paymentMethods.map((m) => ({ methodCode: m.code, flow: m.flow, enabled: codes.includes(m.code) })),
    settlement: cycle ? Object.fromEntries(payinCodes.map((c) => [c, cycle])) : {},
    revision: 1,
    savedAt: started.at,
    savedBy: STAFF.cs,
  };
  const startDate = new Date(started.at).toISOString().slice(0, 10);
  const versions = [
    ...payin
      .filter((m) => payinCodes.includes(m.code))
      .map((m) => blankVersion({ id: `PV-SEED-${app.id.slice(-4)}-${m.code}`, applicationId: app.id, methodCode: m.code, currency: cfg.currency, mdrPct: SEED_MDR[m.code] ?? 1, startDate, createdAt: started.at, settlementSnapshot: cycle })),
    ...payoutCodes.map((code) =>
      blankVersion({ id: `PV-SEED-${app.id.slice(-4)}-${code}`, applicationId: app.id, methodCode: code, flow: 'payout', technique: 'fixed_fee', currency: cfg.currency, mdrPct: null, fixedFee: SEED_PAYOUT_FEE[cfg.currency] ?? 1, startDate, createdAt: started.at }),
    ),
  ];
  return { config, versions };
}

/** MDR audit entries for seeded versions (as CS set them during onboarding, or Ops submitted them). */
function seedAudit(versions: PricingVersion[], applications: CountryApplication[], merchants: MerchantRecord[]): PricingAuditEvent[] {
  return versions.map((v, i) => {
    const app = applications.find((a) => a.id === v.applicationId)!;
    const cfg = ONBOARDING_COUNTRIES[app.country];
    const pending = v.status === 'pending_approval';
    return {
      id: `PA-SEED-${String(i + 1).padStart(3, '0')}`,
      at: v.createdAt,
      user: v.createdBy,
      role: pending ? 'Ops' : 'CS',
      applicationId: app.id,
      merchantId: app.merchantId,
      merchantName: merchants.find((m) => m.id === app.merchantId)?.legalName ?? app.merchantId,
      country: app.country,
      methodCode: v.methodCode,
      methodName: cfg.paymentMethods.find((m) => m.code === v.methodCode)?.name ?? v.methodCode,
      flow: v.flow,
      versionId: v.id,
      version: v.version,
      previous: pending ? `${pricingSummary(versions.find((x) => x.applicationId === v.applicationId && x.methodCode === v.methodCode && x.version === v.version - 1)!)} (v${v.version - 1})` : 'No pricing configured',
      next: pricingSummary(v),
      effective: periodText(v),
      status: v.status,
      reason: null,
    };
  });
}

function buildApplication(s: AppSeed, ago: (d: number) => number): CountryApplication {
  const cfg = ONBOARDING_COUNTRIES[s.country];
  const sample = SAMPLE_BUSINESS[s.country];
  const m = s.merchant;
  const data: ApplicationData = emptyApplicationData(s.country);
  const sameCountry = m.registrationCountry === s.country;
  const domain = m.primaryContact.email.split('@')[1];
  data.business = {
    approvalPriority: s.priority ?? 'medium',
    tradingName: m.legalName,
    localRegistrationNumber: sameCountry ? m.registrationNumber : sample.reg,
    incorporationDate: s.incorporated ?? new Date(m.createdAt - 3 * 365 * DAY).toISOString().slice(0, 10),
    businessType: cfg.businessTypes[0],
    taxId: sample.tax,
    secondaryTaxId: '',
    website: s.website ?? '',
    industry: s.industry,
    address: ADDRESSES[s.country],
  };
  data.contact = { phone: m.primaryContact.phone, email: m.primaryContact.email, currentAddress: '', sameAsRegistered: true, settlementEmails: [`finance@${domain}`] };
  data.directors = s.directors ?? [];
  if (!s.incomplete?.includes('bank')) data.bank = sample.bank(m.legalName);
  if (!s.incomplete?.includes('transaction')) {
    const integrating = s.steps.some((x) => x[2] === 'integration');
    data.transaction = { dailyLimit: sample.dailyLimit, minTransactionValue: sample.minValue, merchantCategory: s.category ?? 'sme', connectionType: 'direct', ipnCallbackUrl: integrating ? `https://${domain}/payments/ipn` : '', sendReceipts: false };
  }
  if (!s.incomplete?.includes('documents')) {
    data.documents = cfg.documents
      .filter((d) => d.required)
      .map((d, i) => ({ id: `${s.id}-d${i}`, type: d.type, fileName: `${d.type.replace(/_/g, '-')}.pdf`, sizeKb: 240 + i * 37, uploadedAt: ago(s.steps[0][0] - 1), sample: true }));
  }

  const history: HistoryEvent[] = [];
  let status: ApplicationStatus = 'draft';
  let submissionCount = 0;
  let corrections: CountryApplication['corrections'] = null;
  let verification: CountryApplication['verification'] = null;
  for (const [daysAgo, action, to, role, comment, sections] of s.steps) {
    const e: HistoryEvent = { at: ago(daysAgo), action, by: role === 'system' ? 'System' : STAFF[role], role, fromStatus: to && action !== 'Application created' ? status : null, toStatus: to };
    if (comment) e.comment = comment;
    if (sections) e.sections = sections;
    history.push(e);
    if (to === 'pending_risk_review') {
      submissionCount++;
      corrections = null;
      verification = simulateVerification(m, data, ago(daysAgo));
      history.push({ at: ago(daysAgo), action: 'Verification checks completed', by: 'System', role: 'system', fromStatus: null, toStatus: null });
    }
    if (to === 'returned') corrections = { reason: comment ?? '', sections: sections ?? [] };
    if (to === 'operational') {
      history.push({ at: ago(daysAgo), action: `${cfg.name} activated on Global Account ${m.linkedAccountId}`, by: 'System', role: 'system', fromStatus: null, toStatus: null });
    }
    if (to) status = to;
  }

  const readiness = newSeedReadiness(s, ago);
  if (['keys_generated', 'integration', 'go_live_verification', 'operational'].includes(status)) {
    readiness.keySet = { reference: `KS-${s.id.slice(-4)}A7`, generatedAt: history.find((h) => h.toStatus === 'keys_generated')!.at, environment: 'production', simulated: true };
  }

  return {
    id: s.id,
    merchantId: m.id,
    country: s.country,
    currency: cfg.currency,
    status,
    data,
    prefill: [],
    submittedProfile: submissionCount ? { legalName: m.legalName, registrationCountry: m.registrationCountry, registrationNumber: m.registrationNumber } : null,
    corrections,
    verification,
    readiness,
    previousApplicationId: s.previousApplicationId ?? null,
    submissionCount,
    createdAt: ago(s.steps[0][0]),
    updatedAt: history[history.length - 1].at,
    createdBy: STAFF.sales,
    history,
    demo: true,
  };
}

function newSeedReadiness(s: AppSeed, ago: (d: number) => number) {
  const status = s.steps[s.steps.length - 1][2];
  const past = ['keys_generated', 'integration', 'go_live_verification', 'operational'];
  const full = (stage: 'configuration' | 'integration' | 'go_live') =>
    (stage === 'configuration' && past.includes(status!)) || (stage === 'integration' && ['go_live_verification', 'operational'].includes(status!)) || (stage === 'go_live' && status === 'operational');
  const count = { configuration: s.configDone ?? 0, integration: s.integrationDone ?? 0, go_live: s.goLiveDone ?? 0 };
  const r = {
    configuration: [] as CountryApplication['readiness']['configuration'],
    integration: [] as CountryApplication['readiness']['integration'],
    go_live: [] as CountryApplication['readiness']['go_live'],
    keySet: null as CountryApplication['readiness']['keySet'],
  };
  const lastAt = ago(s.steps[s.steps.length - 1][0]);
  for (const stage of ['configuration', 'integration', 'go_live'] as const) {
    r[stage] = READINESS[stage].map((i, idx) => {
      const done = full(stage) || idx < count[stage];
      return { ...i, done, doneAt: done ? lastAt : null, doneBy: done ? STAFF.cs : null };
    });
  }
  return r;
}

// ---------------------------------------------------------------- seed additions

/** IDs of demo merchants added after the original seed. Fixed, outside the normal sequences. */
export const SEED_ADDITION_MERCHANT_IDS = ['GM-109001'];

/**
 * Demo merchants added after the original seed: Nusantara Home Retail (GM-109001, linked to
 * GA-1005), live in Malaysia and Indonesia with the Merchant Portal user NUSANTARA-MERCHANT.
 * Used by the fresh seed and to add them to existing data (see MerchantServer).
 */
export function buildSeedAdditions(now: number): { merchants: MerchantRecord[]; applications: CountryApplication[]; products: ({ config: ProductConfig; versions: PricingVersion[] } | null)[] } {
  const ago = (d: number) => now - d * DAY;
  const nusantara: MerchantRecord = {
    id: 'GM-109001',
    legalName: 'Nusantara Home Retail Sdn Bhd',
    registrationCountry: 'MY',
    registrationNumber: '202001023456',
    primaryContact: { name: 'Siti Aminah', email: 'siti@nusantarahome.example', phone: '+60 12 888 4321' },
    linkedAccountId: 'GA-1005',
    createdAt: ago(170),
    updatedAt: ago(170),
    createdBy: STAFF.sales,
    demo: true,
  };
  const directors: Director[] = [
    { id: 'seed90', name: 'Siti Aminah', contactNumber: '+60 12 888 4321', nationality: 'Malaysian', profileUrl: '', idNumber: '880404-14-2468' },
    { id: 'seed91', name: 'Hendra Gunawan', contactNumber: '+62 811 2345 6789', nationality: 'Indonesian', profileUrl: '', idNumber: '3171234567890090' },
  ];
  const live = (start: number): Step[] => [
    [start, 'Application created', 'draft', 'sales'],
    [start - 4, 'Submitted for Risk review', 'pending_risk_review', 'sales'],
    [start - 8, 'Approved by Risk', 'risk_approved', 'risk', 'Documents and screening clear.'],
    [start - 9, 'CS configuration started', 'cs_configuration', 'cs'],
    [start - 12, 'Production keys generated', 'keys_generated', 'cs'],
    [start - 13, 'Merchant integration started', 'integration', 'cs'],
    [start - 20, 'Integration complete; go-live verification started', 'go_live_verification', 'cs'],
    [start - 22, 'Go-live verified; country is operational', 'operational', 'cs'],
  ];
  const seeds: AppSeed[] = [
    { id: 'APP-2026-9001', merchant: nusantara, country: 'MY', industry: 'Retail & e-commerce', website: 'https://nusantarahome.example', directors, steps: live(165), enabledMethods: ['fpx', 'duitnow_qr', 'tng', 'cards'] },
    { id: 'APP-2026-9002', merchant: nusantara, country: 'ID', industry: 'Retail & e-commerce', website: 'https://nusantarahome.example', directors, steps: live(130), enabledMethods: ['va', 'qris', 'ovo'] },
  ];
  const applications = seeds.map((x) => buildApplication(x, ago));
  nusantara.updatedAt = Math.max(...applications.map((a) => a.updatedAt));
  return { merchants: [nusantara], applications, products: seeds.map((x, i) => seedProducts(x, applications[i])) };
}

// ---------------------------------------------------------------- demo sub-merchants

/**
 * Demo sub-merchants for Merchant Pricing (added after the data upgrade has created the parent
 * entities): Nusantara Home Retail's Online Store and Penang Outlet in Malaysia, both approved.
 * The Online Store has its own Cards pricing; the Penang Outlet falls back to the merchant's.
 */
export function addDemoSubMerchants(db: MerchantDb, now: number) {
  const parent = (db.entities ?? []).find((e) => e.gmid === 'GM-109001' && e.kind === 'parent');
  const app = db.applications.find((a) => a.id === 'APP-2026-9001');
  if (!parent || !app || (db.entities ?? []).some((e) => e.kind === 'sub' && e.gmid === 'GM-109001')) return;
  const created = now - 60 * DAY;
  db.seq.entity ??= 1;
  const sub = (displayName: string, email: string): MerchantEntity => ({
    id: formatEntityId(db.seq.entity!++),
    gmid: 'GM-109001',
    kind: 'sub',
    parentEntityId: parent.id,
    legalEntity: null,
    displayName,
    email,
    website: 'https://nusantarahome.example',
    tradingLicenseUrl: null,
    lifecycleStatus: 'active',
    lifecycleReason: null,
    createdAt: created,
    createdBy: STAFF.sales,
    country: 'MY',
    status: 'approved',
    createdVia: 'ops',
    goLiveChecks: SUB_MERCHANT_CHECKS.map((c) => ({ ...c, done: false, doneAt: null, doneBy: null })),
    history: [
      { at: created, action: 'Sub-merchant created', by: STAFF.sales, role: 'sales', comment: null },
      { at: created + DAY, action: 'Approved by Risk', by: STAFF.risk, role: 'risk', comment: null },
    ],
    submittedBy: STAFF.sales,
    submittedAt: created,
    decidedBy: STAFF.risk,
    decidedRole: 'risk',
    decidedAt: created + DAY,
    decisionComment: null,
  });
  const online = sub('Nusantara Home – Online Store', 'online@nusantarahome.example');
  const penang = sub('Nusantara Home – Penang Outlet', 'penang@nusantarahome.example');
  db.entities!.push(online, penang);
  const at = created + 2 * DAY;
  const v = blankVersion({
    id: 'PV-SEED-9001-cards-online',
    applicationId: app.id,
    methodCode: 'cards',
    subMerchantId: online.id,
    currency: 'MYR',
    mdrPct: 1.9,
    startDate: new Date(at).toISOString().slice(0, 10),
    createdAt: at,
    source: 'change',
    settlementSnapshot: 'T+1',
    createdBy: STAFF.sales,
    createdById: 'seed-sales',
    createdRole: 'sales',
    approvedBy: 'Nurul Huda',
    approvedAt: at,
  });
  (db.pricingVersions ??= []).push(v);
  const [audit] = seedAudit([v], db.applications, db.merchants);
  (db.pricingAudit ??= []).push({ ...audit, id: 'PA-SEED-SUB-1', role: 'Ops', previous: 'No pricing configured', subMerchantName: online.displayName });
}
