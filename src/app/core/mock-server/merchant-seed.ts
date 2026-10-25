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
import type { MerchantDb, MerchantRecord } from './merchant-server';
import { simulateVerification } from './verification';

// DEMO DATA — fictional merchants for the prototype. Names, registration numbers, bank
// accounts and people are invented and marked `demo: true`. GM-100101 and GM-100102 are
// linked to Batch 1 Global Accounts GA-1001 and GA-4004, and their application statuses
// match those accounts' country access (active / pending / failed).

const DAY = 24 * 60 * 60_000;
const STAFF: Record<StaffRole, string> = { sales: 'Aisyah Rahman', risk: 'Daniel Tan', cs: 'Mei Ling Wong' };

const SAMPLE_BUSINESS: Record<string, { reg: string; tax: string; bank: (holder: string) => Record<string, string> }> = {
  MY: { reg: '', tax: '', bank: (h) => ({ bankName: 'Maybank', accountName: h, accountNumber: '514012345678', swiftCode: 'MBBEMYKL' }) },
  ID: { reg: '9120001234567', tax: '012345678901000', bank: (h) => ({ bankName: 'Bank Central Asia', accountName: h, accountNumber: '0123456789' }) },
  VN: { reg: '0312345678', tax: '0312345678', bank: (h) => ({ bankName: 'Vietcombank', branch: 'Ho Chi Minh City', accountName: h, accountNumber: '0071001234567' }) },
  TH: { reg: '0105561234567', tax: '0105561234567', bank: (h) => ({ bankName: 'Kasikornbank', branch: 'Silom', accountName: h, accountNumber: '0123456789' }) },
  PH: { reg: 'CS201912345', tax: '123456789000', bank: (h) => ({ bankName: 'BDO Unibank', accountName: h, accountNumber: '001234567890' }) },
};

const ADDRESSES: Record<string, string> = {
  MY: 'Level 12, Menara Demo, Jalan Sultan Ismail, 50250 Kuala Lumpur',
  ID: 'Jl. Jend. Sudirman Kav. 1 (Demo), Jakarta Selatan 12190',
  VN: '12 Nguyen Hue (Demo), District 1, Ho Chi Minh City',
  TH: '88 Silom Road (Demo), Bang Rak, Bangkok 10500',
  PH: '6750 Ayala Avenue (Demo), Makati City 1226',
};

type Step = [daysAgo: number, action: string, to: ApplicationStatus | null, role: StaffRole | 'system', comment?: string, sections?: SectionKey[]];

interface AppSeed {
  id: string;
  merchant: MerchantRecord;
  country: string;
  industry: string;
  website?: string;
  directors?: Director[];
  steps: Step[];
  /** Leave sections empty to represent a partially completed draft. */
  incomplete?: ('bank' | 'documents' | 'pricing')[];
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

  const person = (name: string, nationality: string, idNumber: string, role: Director['role'], ownershipPct: number | null, i: number): Director => ({ id: `seed${i}`, name, nationality, idNumber, role, ownershipPct });

  const trading = merchant(100101, 'Mobi Demo Trading Sdn Bhd', 'MY', '201901012345', ['Farah Ismail', 'farah.ismail@mobidemo.test', '+60 12 345 6789'], 230, 'GA-1001');
  const newDemo = merchant(100102, 'New Demo Merchant Sdn Bhd', 'MY', '202301045678', ['Nguyen Lan', 'lan@mobidemo.test', '+60 13 222 3344'], 95, 'GA-4004');
  const kopi = merchant(100103, 'PT Demo Kopi Nusantara', 'ID', '9120007654321', ['Rina Wijaya', 'rina@kopi-demo.test', '+62 812 3456 7890'], 20);
  const saigon = merchant(100104, 'Demo Saigon Travel JSC', 'VN', '0398765432', ['Tran Minh', 'minh@saigontravel-demo.test', '+84 90 123 4567'], 4);
  const bites = merchant(100105, 'Demo Bangkok Bites Co., Ltd.', 'TH', '0105569876543', ['Somchai Prasert', 'somchai@bites-demo.test', '+66 81 234 5678'], 45);
  const manila = merchant(100106, 'Demo Manila Learning Inc.', 'PH', 'CS202054321', ['Maria Santos', 'maria@learning-demo.test', '+63 917 123 4567'], 60);
  const fresh = merchant(100107, 'Demo FreshMart Sdn Bhd', 'MY', '201801098765', ['Kumar Selvam', 'kumar@freshmart-demo.test', '+60 16 789 0123'], 14);
  const pixel = merchant(100108, 'Demo Pixel Games Pte. Ltd.', 'SG', '201912345K', ['Alex Lee', 'alex@pixelgames-demo.test', '+65 9123 4567'], 1);

  const tradingDirectors = [person('Farah Ismail', 'Malaysian', '850101-14-5678', 'director_and_owner', 60, 1), person('Lim Wei Jie', 'Malaysian', '820315-10-1234', 'director_and_owner', 40, 2)];

  const seeds: AppSeed[] = [
    // GM-100101 · linked to GA-1001 (MY/ID/VN active, TH pending, PH failed)
    {
      id: 'APP-2026-0001', merchant: trading, country: 'MY', industry: 'Retail & e-commerce', website: 'https://trading-demo.test', directors: tradingDirectors,
      steps: [[225, 'Application created', 'draft', 'sales'], [221, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [218, 'Approved by Risk', 'risk_approved', 'risk', 'Documents and screening clear.'], [217, 'CS configuration started', 'cs_configuration', 'cs'], [214, 'Production keys generated (simulated)', 'keys_generated', 'cs'], [213, 'Merchant integration started', 'integration', 'cs'], [205, 'Integration complete; go-live verification started', 'go_live_verification', 'cs'], [203, 'Go-live verified; country is operational', 'operational', 'cs']],
    },
    {
      id: 'APP-2026-0002', merchant: trading, country: 'ID', industry: 'Retail & e-commerce', website: 'https://trading-demo.test', directors: tradingDirectors,
      steps: [[190, 'Application created', 'draft', 'sales'], [186, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [181, 'Approved by Risk', 'risk_approved', 'risk'], [180, 'CS configuration started', 'cs_configuration', 'cs'], [176, 'Production keys generated (simulated)', 'keys_generated', 'cs'], [175, 'Merchant integration started', 'integration', 'cs'], [168, 'Integration complete; go-live verification started', 'go_live_verification', 'cs'], [166, 'Go-live verified; country is operational', 'operational', 'cs']],
    },
    {
      id: 'APP-2026-0003', merchant: trading, country: 'VN', industry: 'Retail & e-commerce', website: 'https://trading-demo.test',
      steps: [[150, 'Application created', 'draft', 'sales'], [147, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [143, 'Approved by Risk', 'risk_approved', 'risk'], [142, 'CS configuration started', 'cs_configuration', 'cs'], [139, 'Production keys generated (simulated)', 'keys_generated', 'cs'], [138, 'Merchant integration started', 'integration', 'cs'], [130, 'Integration complete; go-live verification started', 'go_live_verification', 'cs'], [128, 'Go-live verified; country is operational', 'operational', 'cs']],
    },
    {
      id: 'APP-2026-0006', merchant: trading, country: 'PH', industry: 'Retail & e-commerce', website: 'https://trading-demo.test', directors: tradingDirectors,
      steps: [[80, 'Application created', 'draft', 'sales'], [76, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [70, 'Rejected by Risk', 'rejected', 'risk', 'Beneficial ownership of the Philippine distributor could not be verified against the GIS. A new application is needed with the corrected ownership structure.']],
    },
    {
      id: 'APP-2026-0010', merchant: trading, country: 'TH', industry: 'Retail & e-commerce', website: 'https://trading-demo.test', directors: tradingDirectors,
      steps: [[12, 'Application created', 'draft', 'sales'], [8, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [3, 'Approved by Risk', 'risk_approved', 'risk', 'Approved. Standard monitoring.'], [2, 'CS configuration started', 'cs_configuration', 'cs']],
      configDone: 2,
    },
    // GM-100102 · linked to GA-4004 (MY pending, VN failed)
    {
      id: 'APP-2026-0008', merchant: newDemo, country: 'VN', industry: 'Food & beverage',
      steps: [[60, 'Application created', 'draft', 'sales'], [57, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [52, 'Rejected by Risk', 'rejected', 'risk', 'Business activity in Vietnam is outside the approved risk appetite for this demo merchant category.']],
    },
    {
      id: 'APP-2026-0012', merchant: newDemo, country: 'MY', industry: 'Food & beverage', website: 'https://newdemo-merchant.test',
      directors: [person('Nguyen Lan', 'Vietnamese', 'C1234567', 'director_and_owner', 100, 3)],
      steps: [[6, 'Application created', 'draft', 'sales'], [1, 'Submitted for Risk review', 'pending_risk_review', 'sales']],
    },
    // GM-100103 · returned for correction
    {
      id: 'APP-2026-0011', merchant: kopi, country: 'ID', industry: 'Food & beverage', website: 'https://kopi-demo.test',
      directors: [person('Rina Wijaya', 'Indonesian', '3171234567890001', 'director_and_owner', 70, 4), person('Agus Pratama', 'Indonesian', '3171234567890002', 'beneficial_owner', 30, 5)],
      steps: [[18, 'Application created', 'draft', 'sales'], [9, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [2, 'Returned for correction', 'returned', 'risk', 'The bank account proof is older than 3 months and the NPWP does not match the deed of establishment. Upload a recent bank statement and confirm the NPWP.', ['documents', 'business']]],
    },
    // GM-100104 · partially completed draft
    {
      id: 'APP-2026-0014', merchant: saigon, country: 'VN', industry: 'Travel & hospitality', website: 'https://saigontravel-demo.test',
      steps: [[4, 'Application created', 'draft', 'sales'], [3, 'Draft saved', null, 'sales']],
      incomplete: ['bank', 'documents', 'pricing'],
    },
    // GM-100105 · in merchant integration
    {
      id: 'APP-2026-0009', merchant: bites, country: 'TH', industry: 'Food & beverage', website: 'https://bites-demo.test',
      directors: [person('Somchai Prasert', 'Thai', '3100500123456', 'director_and_owner', 100, 6)],
      steps: [[40, 'Application created', 'draft', 'sales'], [35, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [30, 'Approved by Risk', 'risk_approved', 'risk'], [29, 'CS configuration started', 'cs_configuration', 'cs'], [25, 'Production keys generated (simulated)', 'keys_generated', 'cs'], [24, 'Merchant integration started', 'integration', 'cs']],
      configDone: 4, integrationDone: 1,
    },
    // GM-100106 · PH in go-live verification, MY expansion draft
    {
      id: 'APP-2026-0007', merchant: manila, country: 'PH', industry: 'Education', website: 'https://learning-demo.test',
      directors: [person('Maria Santos', 'Filipino', 'P1234567A', 'director_and_owner', 55, 7), person('Jose Reyes', 'Filipino', 'P7654321B', 'director_and_owner', 45, 8)],
      steps: [[55, 'Application created', 'draft', 'sales'], [50, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [44, 'Approved by Risk', 'risk_approved', 'risk'], [43, 'CS configuration started', 'cs_configuration', 'cs'], [39, 'Production keys generated (simulated)', 'keys_generated', 'cs'], [38, 'Merchant integration started', 'integration', 'cs'], [5, 'Integration complete; go-live verification started', 'go_live_verification', 'cs']],
      configDone: 4, integrationDone: 3, goLiveDone: 1,
    },
    {
      id: 'APP-2026-0015', merchant: manila, country: 'MY', industry: 'Education', website: 'https://learning-demo.test',
      directors: [person('Maria Santos', 'Filipino', 'P1234567A', 'director_and_owner', 55, 9), person('Jose Reyes', 'Filipino', 'P7654321B', 'director_and_owner', 45, 10)],
      steps: [[2, 'Application created', 'draft', 'sales']],
      incomplete: ['bank', 'documents', 'pricing'],
    },
    // GM-100107 · resubmitted after correction (same application ID)
    {
      id: 'APP-2026-0013', merchant: fresh, country: 'MY', industry: 'Retail & e-commerce', website: 'https://freshmart-demo.test',
      directors: [person('Kumar Selvam', 'Malaysian', '800202-08-4321', 'director_and_owner', 80, 11), person('Demo Flag Tan', 'Malaysian', '790909-07-1111', 'beneficial_owner', 20, 12)],
      steps: [[13, 'Application created', 'draft', 'sales'], [10, 'Submitted for Risk review', 'pending_risk_review', 'sales'], [7, 'Returned for correction', 'returned', 'risk', 'Bank statement is missing the account holder name. Upload a statement that shows it.', ['documents']], [1, 'Resubmitted after correction', 'pending_risk_review', 'sales', 'Uploaded the full bank statement for March.']],
    },
  ];

  const applications = seeds.map((s) => buildApplication(s, ago));

  const notifications: PortalNotification[] = [];
  let nt = 1;
  const note = (daysAgo: number, event: PortalNotification['event'], app: CountryApplication, m: MerchantRecord, audience: StaffRole[], title: string, body: string, to: string[]) =>
    notifications.push({ id: `NT-${nt++}`, at: ago(daysAgo), event, title, body, applicationId: app.id, merchantId: m.id, country: app.country, audience, email: { to, subject: `[Mobi Global Platform] ${title}`, status: 'simulated' }, readBy: [] });
  const byId = (id: string) => applications.find((a) => a.id === id)!;
  note(25, 'configuration_ready', byId('APP-2026-0009'), bites, ['cs', 'sales'], `Configuration ready: ${bites.legalName} · Thailand`, 'CS configuration is complete and production keys are generated (simulated) for APP-2026-0009. Merchant integration can start.', [bites.primaryContact.email, 'cs-onboarding@mobi-demo.test']);
  note(3, 'approved', byId('APP-2026-0010'), trading, ['sales', 'cs'], `Risk approved: ${trading.legalName} · Thailand`, 'APP-2026-0010 is approved. CS can now start country configuration. The merchant is not operational yet.', ['sales-ops@mobi-demo.test', 'cs-onboarding@mobi-demo.test']);
  note(2, 'returned', byId('APP-2026-0011'), kopi, ['sales'], `Returned for correction: ${kopi.legalName} · Indonesia`, 'Risk asked for corrections on APP-2026-0011: the bank account proof is older than 3 months and the NPWP does not match the deed.', ['sales-ops@mobi-demo.test']);
  note(1, 'submitted', byId('APP-2026-0012'), newDemo, ['risk', 'sales'], `Submitted: ${newDemo.legalName} · Malaysia`, 'APP-2026-0012 is waiting for Risk review.', ['risk-review@mobi-demo.test']);
  note(1, 'resubmitted', byId('APP-2026-0013'), fresh, ['risk', 'sales'], `Resubmitted: ${fresh.legalName} · Malaysia`, 'APP-2026-0013 is waiting for Risk review after correction.', ['risk-review@mobi-demo.test']);
  notifications.sort((a, b) => b.at - a.at);

  const merchants = [trading, newDemo, kopi, saigon, bites, manila, fresh, pixel];
  for (const m of merchants) {
    const own = applications.filter((a) => a.merchantId === m.id);
    if (own.length) m.updatedAt = Math.max(m.updatedAt, ...own.map((a) => a.updatedAt));
  }

  return {
    version,
    seq: { merchant: 100109, application: 16, notification: nt },
    merchants,
    applications,
    notifications,
  };
}

function buildApplication(s: AppSeed, ago: (d: number) => number): CountryApplication {
  const cfg = ONBOARDING_COUNTRIES[s.country];
  const sample = SAMPLE_BUSINESS[s.country];
  const m = s.merchant;
  const data: ApplicationData = emptyApplicationData(s.country);
  const sameCountry = m.registrationCountry === s.country;
  data.business = {
    tradingName: m.legalName,
    businessType: cfg.businessTypes[0],
    industry: s.industry,
    website: s.website ?? '',
    address: ADDRESSES[s.country],
    localRegistrationNumber: sameCountry ? m.registrationNumber : sample.reg || '201901099999',
    taxId: sample.tax,
    expectedMonthlyVolume: 250_000,
  };
  data.contact = { ...m.primaryContact, supportEmail: `support@${m.primaryContact.email.split('@')[1]}` };
  if (cfg.directors.required) data.directors = s.directors ?? [];
  if (!s.incomplete?.includes('bank')) data.bank = sample.bank(m.legalName);
  if (!s.incomplete?.includes('documents')) {
    data.documents = cfg.documents
      .filter((d) => d.required)
      .map((d, i) => ({ id: `${s.id}-d${i}`, type: d.type, fileName: `${d.type.replace(/_/g, '-')}-sample.pdf`, sizeKb: 240 + i * 37, uploadedAt: ago(s.steps[0][0] - 1), sample: true }));
  }
  if (!s.incomplete?.includes('pricing')) {
    data.pricing = cfg.paymentMethods.map((p, i) => ({ code: p.code, enabled: i < 3, mdr: p.defaultMdr }));
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
      history.push({ at: ago(daysAgo), action: 'Verification evidence received (simulated)', by: 'System', role: 'system', fromStatus: null, toStatus: null });
    }
    if (to === 'returned') corrections = { reason: comment ?? '', sections: sections ?? [] };
    if (to === 'operational') {
      history.push({ at: ago(daysAgo), action: `${cfg.name} activated on Global Account ${m.linkedAccountId}`, by: 'System', role: 'system', fromStatus: null, toStatus: null });
    }
    if (to) status = to;
  }

  const readiness = newSeedReadiness(s, ago);
  if (['keys_generated', 'integration', 'go_live_verification', 'operational'].includes(status)) {
    readiness.keySet = { reference: `KS-DEMO-${s.id.slice(-4)}`, generatedAt: history.find((h) => h.toStatus === 'keys_generated')!.at, environment: 'production', simulated: true };
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
