import { calculateFee, deactivationFor, PricingVersion, resolvePricing, roundFee, todayIso } from '../merchants/products';
import { PaymentType, paymentTypeOf, TxnFlow, TxnStatus } from '../transactions/transactions';
import type { TxnSource } from './merchant-server';

// SAMPLE transaction data (Transaction Management phase 1). There is no transaction service in this
// codebase, so these records are generated, deterministically, for every live MID from what it
// really has: its switched-on products, its sub-merchants and its pricing versions. Every reply that
// carries them says `sampleData: true`.
//
// Layout (Option A, docs/transaction-management-phase-1.md):
// - `payin` / `payout`: the main tables (one row per transaction, fields every transaction has);
// - `details`: one table per payment type, keyed by transaction ID.
//
// Nothing here is stored: the same MIDs and pricing always give the same transactions, in both
// apps. Each record keeps the times of its steps, and its status is worked out from the time of the
// request, so a transaction moves from Pending to its outcome as time passes.

export const HISTORY_DAYS = 60;
const DAY = 86_400_000;
const MIN = 60_000;

/** Sample providers per country and payment type. Generic names: Provider management will replace them. */
const PROVIDERS: Record<string, Partial<Record<`${TxnFlow}:${PaymentType}`, string>>> = {
  MY: { 'payin:online_banking': 'MY-B', 'payin:qr': 'MY-B', 'payin:ewallet': 'MY-A', 'payin:cards': 'MY-C', 'payin:otc': 'MY-D', 'payout:bank_transfer': 'MY-E', 'payout:ewallet': 'MY-A' },
  ID: { 'payin:virtual_account': 'ID-A', 'payin:qr': 'ID-B', 'payin:ewallet': 'ID-C', 'payout:bank_transfer': 'ID-D', 'payout:ewallet': 'ID-C' },
  VN: { 'payin:qr': 'VN-A', 'payin:ewallet': 'VN-B', 'payin:bank_transfer': 'VN-A', 'payout:bank_transfer': 'VN-C' },
};

/** How long a pay-in waits for the customer before it expires (sample values; not an agreed rule, Q5). */
const VALIDITY_MIN: Record<PaymentType, number> = { qr: 15, ewallet: 15, virtual_account: 24 * 60, otc: 48 * 60, cards: 30, online_banking: 30, bank_transfer: 24 * 60 };

const BANKS: Record<string, string[]> = {
  MY: ['Maybank', 'CIMB Bank', 'Public Bank', 'RHB Bank', 'Hong Leong Bank', 'AmBank', 'Bank Islam'],
  ID: ['BCA', 'BRI', 'Mandiri', 'BNI', 'CIMB Niaga', 'Permata'],
  VN: ['Vietcombank', 'Techcombank', 'VietinBank', 'BIDV', 'ACB', 'MB Bank'],
};
const VA_BANKS = ['BRI', 'BCA', 'BNI', 'Mandiri', 'Permata', 'CIMB Niaga'];
const OUTLETS = ['7-Eleven', 'KK Mart', '99 Speedmart', 'myNEWS'];
const NAMES: Record<string, string[]> = {
  MY: ['Aisyah Rahman', 'Tan Wei Ming', 'Kavitha Raj', 'Muhammad Hafiz', 'Lee Mei Ling', 'Nurul Huda', 'Jason Lim', 'Siti Aminah'],
  ID: ['Putri Lestari', 'Budi Hartono', 'Dewi Sartika', 'Agus Pratama', 'Rina Wijaya', 'Andi Saputra'],
  VN: ['Nguyen Thi Lan', 'Tran Van Minh', 'Le Hoang Anh', 'Pham Thu Trang', 'Vo Quoc Bao', 'Dang Ngoc Mai'],
};
const DIAL: Record<string, string> = { MY: '+60', ID: '+62', VN: '+84' };
const DEVICES = ['iPhone · iOS 18 · Safari', 'Android 15 · Chrome', 'Windows 11 · Chrome', 'macOS · Safari', 'Android 14 · Samsung Internet'];
const PAYOUT_PURPOSES = ['Supplier payment', 'Customer refund', 'Seller payout', 'Payroll', 'Agent commission'];

const PAYIN_RANGE: Record<string, [number, number]> = { MYR: [8, 2_500], IDR: [25_000, 4_500_000], VND: [50_000, 9_000_000] };
const PAYOUT_RANGE: Record<string, [number, number]> = { MYR: [300, 25_000], IDR: [1_000_000, 150_000_000], VND: [2_000_000, 300_000_000] };

export type FailStage = 'customer' | 'mobi' | 'provider' | 'bank';

/** Main table row (`payin_transactions` / `payout_transactions`). */
export interface TxnRecord {
  id: string;
  flow: TxnFlow;
  invoiceId: string;
  gmid: string;
  merchantName: string;
  applicationId: string;
  country: string;
  countryName: string;
  currency: string;
  /** The Master MID of the country. */
  masterMid: string;
  subMerchantId: string | null;
  subMerchantName: string | null;
  subMerchantMid: string | null;
  methodCode: string;
  methodName: string;
  paymentType: PaymentType;
  providerId: string;
  providerName: string;
  amount: number;
  /** Fee charged once Successful (null when no pricing applies). */
  fee: number | null;
  pricing: { versionId: string; version: number; level: 'merchant' | 'sub_merchant'; technique: PricingVersion['technique']; summary: PricingVersion; feeText: string } | null;
  channel: string;
  description: string | null;
  customer: { name?: string; email?: string; phone?: string; reference?: string; ip?: string; device?: string };
  createdAt: number;
  /** Pay-in: the customer paid; payout: sent to the provider. Null when it never got there. */
  sentAt: number | null;
  /** When the outcome is reached. */
  finalAt: number;
  outcome: 'successful' | 'failed' | 'expired';
  failStage: FailStage | null;
  reasonCode: string | null;
  reasonText: string | null;
  merchantReason: string | null;
  expiresAt: number | null;
  /** HTTP status of each IPN attempt (null = timeout); attempts are 2 s, 1 min and 5 min after the outcome. */
  ipn: (number | null)[];
  mobiRequestId: string;
  providerReference: string | null;
  providerResponse: { code: string; message: string } | null;
  bankResponse: { code: string; message: string } | null;
  settlementCycle: string | null;
  /** A provider success that arrived after the transaction expired (not applied; flagged). */
  lateSuccessAt: number | null;
  /** The MID or sub-merchant has settlement on hold (suspension) right now. */
  settlementHeld: boolean;
}

/** Detail tables, one per payment type (fields only that type has). */
export type TxnDetailRecord =
  | { type: 'online_banking'; bank: string; fpxTransactionId: string }
  | { type: 'ewallet'; wallet: string; walletAccount: string; walletTransactionId: string; beneficiaryName?: string }
  | { type: 'qr'; qrType: string; payerApp: string; qrReference: string }
  | { type: 'cards'; brand: string; last4: string; cardType: string; issuer: string; issuerCountry: string; threeDs: string; approvalCode: string | null; rrn: string }
  | { type: 'virtual_account'; vaBank: string; vaNumber: string }
  | { type: 'otc'; outlet: string; paymentCode: string }
  | { type: 'bank_transfer'; bank: string; transferReference: string; beneficiaryName?: string; beneficiaryAccount?: string };

export interface TxnTables {
  payin: TxnRecord[];
  payout: TxnRecord[];
  details: Record<PaymentType, Map<string, TxnDetailRecord>>;
  byId: Map<string, TxnRecord>;
}

/** Status at a point in time. */
export function statusAt(t: TxnRecord, now: number): TxnStatus {
  if (now >= t.finalAt) return t.outcome;
  if (t.outcome === 'expired' || t.sentAt === null || now < t.sentAt) return 'pending';
  return 'processing';
}

/** Time of the latest change visible at `now`. */
export function updatedAt(t: TxnRecord, now: number): number {
  return [t.createdAt, t.sentAt ?? 0, t.finalAt, t.lateSuccessAt ?? 0].filter((x) => x <= now).reduce((a, b) => Math.max(a, b), t.createdAt);
}

// ------------------------------------------------------------------ generation

/** Builds every MID's sample transactions from the start of the history up to the end of today (local time). */
export function generateTables(sources: TxnSource[], now: number): TxnTables {
  const tables: TxnTables = {
    payin: [],
    payout: [],
    details: { online_banking: new Map(), ewallet: new Map(), qr: new Map(), cards: new Map(), virtual_account: new Map(), otc: new Map(), bank_transfer: new Map() },
    byId: new Map(),
  };
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  for (const src of sources) {
    const invoiceStyle = hash(src.gmid) % 2 === 0 ? 'INV' : 'ORD';
    const volume = new Map<string, number>(); // month-to-date successful volume per method
    let seq = 0;
    for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
      const dayStart = new Date(todayStart);
      dayStart.setDate(dayStart.getDate() - d);
      const dayMs = dayStart.getTime();
      if (!src.midDemo && dayMs + DAY <= src.midIssuedAt) continue;
      const ymd = localYmd(dayMs);
      if (dayStart.getDate() === 1) volume.clear();
      const rand = mulberry32(hash(`${src.mid}|${ymd}`));
      for (const flow of ['payin', 'payout'] as TxnFlow[]) {
        const count = flow === 'payin' ? 6 + Math.floor(rand() * 9) : rand() < 0.55 ? 1 + Math.floor(rand() * 2) : 0;
        const times = Array.from({ length: count }, () => dayMs + Math.floor((7 + rand() * 16.5) * 3_600_000) + Math.floor(rand() * 3_600_000)).sort((a, b) => a - b);
        for (const at of times) {
          if (!src.midDemo && at < src.midIssuedAt) continue;
          seq++;
          const made = makeTxn(src, flow, at, seq, ymd, invoiceStyle, rand, volume, tables);
          if (!made) continue;
          tables[flow].push(made.row);
          tables.details[made.detail.type].set(made.row.id, made.detail);
          tables.byId.set(made.row.id, made.row);
        }
      }
    }
  }
  tables.payin.sort((a, b) => b.createdAt - a.createdAt);
  tables.payout.sort((a, b) => b.createdAt - a.createdAt);
  return tables;
}

function makeTxn(src: TxnSource, flow: TxnFlow, at: number, seq: number, ymd: string, invoiceStyle: string, rand: () => number, volume: Map<string, number>, tables: TxnTables): { row: TxnRecord; detail: TxnDetailRecord } | null {
  const day = todayIso(at);
  // Sub-merchants take pay-ins; payouts are made by the MID (sub-merchants settle into the parent's account).
  const subs = flow === 'payin' ? src.subMerchants.filter((s) => s.demo || s.issuedAt <= at) : [];
  const sub = subs.length && rand() < 0.6 ? subs[Math.floor(rand() * subs.length)] : null;
  const methods = src.products.filter((p) => p.flow === flow && !deactivationFor({ deactivations: src.deactivations }, p.methodCode, p.flow, sub?.id ?? null, day));
  if (!methods.length) return null;
  const method = methods[Math.floor(rand() * methods.length)];
  const type = paymentTypeOf(method.methodCode, flow);
  const providerCode = PROVIDERS[src.country]?.[`${flow}:${type}`] ?? `${src.country}-X`;
  const cur = src.currency;
  const [lo, hi] = (flow === 'payin' ? PAYIN_RANGE : PAYOUT_RANGE)[cur] ?? [10, 1000];
  let amount = roundAmount(lo + rand() * rand() * (hi - lo), cur);

  let id = '';
  do {
    id = `${flow === 'payin' ? 'TXN' : 'PYO'}${ymd}${Math.floor(rand() * 0xffffff).toString(16).toUpperCase().padStart(6, '0')}${String(seq % 100).padStart(2, '0')}`;
  } while (tables.byId.has(id));
  const invoiceId = flow === 'payout' ? `PO-${ymd}-${String(seq).padStart(4, '0')}` : invoiceStyle === 'INV' ? `INV-${ymd}-${String(seq).padStart(4, '0')}` : `ORD-${String(70000 + (hash(id) % 29999)).padStart(5, '0')}`;

  // Outcome, failure stage and timings.
  const r = rand();
  let outcome: TxnRecord['outcome'] = 'successful';
  let failStage: FailStage | null = null;
  const validity = flow === 'payin' ? VALIDITY_MIN[type] * MIN : null;
  if (flow === 'payin') {
    if (r < 0.06) outcome = 'expired';
    else if (r < 0.15) {
      outcome = 'failed';
      failStage = rand() < 0.25 ? 'customer' : rand() < 0.3 ? 'provider' : 'bank';
    } else if (r < 0.16 && src.minTransactionValue) {
      // A request below the MID's minimum is stopped by Mobi before sending.
      amount = roundAmount(Math.max(src.minTransactionValue / 4, cur === 'MYR' ? 1 : 1000), cur);
      outcome = 'failed';
      failStage = 'mobi';
    }
  } else if (r < 0.06) {
    outcome = 'failed';
    failStage = rand() < 0.3 ? 'provider' : 'bank';
  }
  if (flow === 'payin' && src.minTransactionValue && amount < src.minTransactionValue && failStage !== 'mobi') {
    outcome = 'failed';
    failStage = 'mobi';
  }

  // Pricing in effect on the day (§7.9); none → stopped by Mobi (decision Q9: block the transaction).
  const resolved = resolvePricing(src.versions, method.methodCode, day, flow, sub?.id ?? null);
  let reason: [string, string, string] | null = null;
  if (!resolved) {
    outcome = 'failed';
    failStage = 'mobi';
    reason = ['MOBI-PRICING', 'No pricing in effect', 'This payment method is not available.'];
  }

  const paidDelay = (20 + Math.floor(rand() * 160)) * 1000;
  const slow = rand() < 0.03; // a provider that takes hours to answer
  const resultDelay = slow ? (2 + rand() * 3) * 3_600_000 : (2 + Math.floor(rand() * 28)) * 1000;
  let sentAt: number | null = at + (flow === 'payin' ? paidDelay : 3000);
  let finalAt = sentAt + resultDelay;
  let expiresAt: number | null = validity ? at + validity : null;
  if (outcome === 'expired') {
    sentAt = null;
    finalAt = expiresAt!;
  } else if (failStage === 'mobi') {
    sentAt = null;
    finalAt = at + 1000;
    expiresAt = null;
    if (!reason) reason = ['MOBI-MIN', 'Below the minimum transaction value', 'The amount is below your minimum transaction value.'];
  } else if (failStage === 'customer') {
    finalAt = at + paidDelay;
    sentAt = at + Math.floor(paidDelay / 2);
  }
  if (outcome !== 'expired' && failStage !== 'mobi' && flow === 'payin' && expiresAt && finalAt > expiresAt) expiresAt = finalAt + MIN;
  // A suspension that blocks this flow at this time stops the transaction at Mobi.
  const block = (src.suspensionBlocks ?? []).find((b) => at >= b.from && (b.to === null || at < b.to) && (flow === 'payin' ? b.payins : b.payouts) && (b.subMerchantId === '*' || b.subMerchantId === sub?.id));
  if (block) {
    outcome = 'failed';
    failStage = 'mobi';
    sentAt = null;
    finalAt = at + 1000;
    expiresAt = null;
    reason = ['MOBI-SUSPENDED', 'Merchant suspended', 'Payments are paused.'];
  }
  if (!reason && outcome === 'failed') reason = pick(rand, failureReasons(type, flow, failStage!));
  if (!reason && outcome === 'expired') reason = ['EXPIRED', 'No payment within the validity window', "The customer didn't pay in time."];

  // Fee from the pricing version in effect that day (fee engine contract, §9).
  let fee: number | null = null;
  let pricing: TxnRecord['pricing'] = null;
  if (resolved) {
    const key = method.methodCode;
    const res = calculateFee({ ...resolved.version, localCurrency: cur }, { amount, date: day, periodVolume: volume.get(key) ?? 0, previousPeriodVolume: null });
    fee = roundFee(res.fee, cur);
    pricing = { versionId: resolved.version.id, version: resolved.version.version, level: resolved.level, technique: resolved.version.technique, summary: resolved.version, feeText: res.explanation };
    if (outcome === 'successful') volume.set(key, (volume.get(key) ?? 0) + amount);
  }

  const names = NAMES[src.country] ?? NAMES['MY'];
  const name = pick(rand, names);
  const phoneTail = String(1000 + Math.floor(rand() * 8999));
  const customer: TxnRecord['customer'] = {};
  if (flow === 'payin') {
    // Merchants send little customer data; most fields are optional.
    if (rand() < 0.45) customer.name = name;
    if (rand() < 0.35) customer.email = `${name.split(' ')[0].toLowerCase()}.${name.split(' ').slice(-1)[0][0].toLowerCase()}@mail.example`;
    if (rand() < 0.35) customer.phone = `${DIAL[src.country] ?? ''} 1${Math.floor(rand() * 9)} ${String(100 + Math.floor(rand() * 899))} ${phoneTail}`;
    if (rand() < 0.5) customer.reference = `CUST-${String(10000 + Math.floor(rand() * 89999))}`;
    if (rand() < 0.7) {
      customer.ip = `${pick(rand, ['175.139', '115.164', '36.85', '113.161', '210.186'])}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`;
      customer.device = pick(rand, DEVICES);
    }
  }

  const banks = BANKS[src.country] ?? BANKS['MY'];
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join('');
  const last4 = digits(4);
  let detail: TxnDetailRecord;
  switch (type) {
    case 'online_banking':
      detail = { type, bank: pick(rand, banks), fpxTransactionId: `${ymd.slice(2)}${digits(8)}` };
      break;
    case 'ewallet':
      detail = { type, wallet: method.methodName, walletAccount: `•••• ${last4}`, walletTransactionId: `${method.methodCode.replace(/_payout$/, '').slice(0, 3).toUpperCase()}${digits(10)}`, ...(flow === 'payout' ? { beneficiaryName: name } : {}) };
      break;
    case 'qr':
      detail = { type, qrType: method.methodName, payerApp: rand() < 0.6 ? pick(rand, banks) : pick(rand, src.country === 'MY' ? ["Touch 'n Go", 'GrabPay', 'Boost'] : src.country === 'ID' ? ['GoPay', 'OVO', 'DANA'] : ['MoMo', 'ZaloPay']), qrReference: digits(16) };
      break;
    case 'cards': {
      const brand = rand() < 0.6 ? 'Visa' : 'Mastercard';
      detail = { type, brand, last4, cardType: rand() < 0.6 ? 'Debit' : 'Credit', issuer: pick(rand, banks), issuerCountry: rand() < 0.9 ? src.countryName : 'Singapore', threeDs: failStage === 'provider' ? 'Failed' : rand() < 0.85 ? 'Authenticated' : 'Attempted', approvalCode: outcome === 'successful' ? String(100000 + Math.floor(rand() * 899999)) : null, rrn: digits(12) };
      break;
    }
    case 'virtual_account':
      detail = { type, vaBank: pick(rand, VA_BANKS), vaNumber: `•••• ${last4}` };
      break;
    case 'otc':
      detail = { type, outlet: pick(rand, OUTLETS), paymentCode: digits(12) };
      break;
    case 'bank_transfer':
      detail = flow === 'payout' ? { type, bank: pick(rand, banks), transferReference: `BT${digits(12)}`, beneficiaryName: name, beneficiaryAccount: `•••• ${last4}` } : { type, bank: pick(rand, banks), transferReference: `BT${digits(12)}` };
      break;
  }

  const ipnRoll = rand();
  const ipn: (number | null)[] = ipnRoll < 0.85 ? [200] : ipnRoll < 0.95 ? [500, 200] : [null, 503, 500];
  const providerReference = sentAt !== null ? `P${providerCode.replace('-', '')}-${digits(8)}` : null;
  const providerResponse = finalAt && failStage !== 'mobi' && outcome !== 'expired' ? (outcome === 'successful' ? { code: '00', message: 'Approved' } : { code: reason![0], message: reason![1] }) : null;
  const bankResponse = outcome === 'successful' ? { code: '00', message: 'Success' } : failStage === 'bank' ? { code: reason![0], message: reason![1] } : null;
  const lateSuccessAt = outcome === 'expired' && rand() < 0.08 ? finalAt + (5 + Math.floor(rand() * 20)) * MIN : null;

  const row: TxnRecord = {
    id,
    flow,
    invoiceId,
    gmid: src.gmid,
    merchantName: src.merchantName,
    applicationId: src.applicationId,
    country: src.country,
    countryName: src.countryName,
    currency: cur,
    masterMid: src.mid,
    subMerchantId: sub?.id ?? null,
    subMerchantName: sub?.name ?? null,
    subMerchantMid: sub?.mid ?? null,
    methodCode: method.methodCode,
    methodName: method.methodName,
    paymentType: type,
    providerId: providerCode,
    providerName: `Provider ${providerCode}`,
    amount,
    fee: outcome === 'successful' ? fee : null,
    pricing,
    channel: flow === 'payout' ? 'API' : pick(rand, ['Hosted payment page', 'Hosted payment page', 'API', 'API', 'Payment link']),
    description: flow === 'payout' ? pick(rand, PAYOUT_PURPOSES) : rand() < 0.6 ? `Order ${String.fromCharCode(65 + Math.floor(rand() * 6))}-${1000 + Math.floor(rand() * 8999)} · ${1 + Math.floor(rand() * 4)} items` : null,
    customer,
    createdAt: at,
    sentAt,
    finalAt,
    outcome,
    failStage,
    reasonCode: reason?.[0] ?? null,
    reasonText: reason?.[1] ?? null,
    merchantReason: reason?.[2] ?? null,
    expiresAt,
    ipn,
    mobiRequestId: `REQ-${hex(rand, 8)}-${hex(rand, 4)}`,
    providerReference,
    providerResponse,
    bankResponse,
    settlementCycle: flow === 'payin' ? (src.settlement[method.methodCode] ?? null) : null,
    lateSuccessAt,
    settlementHeld: flow === 'payin' && (src.suspensionBlocks ?? []).some((b) => b.settlementHeld && (b.subMerchantId === '*' || b.subMerchantId === sub?.id)),
  };
  return { row, detail };
}

function failureReasons(type: PaymentType, flow: TxnFlow, stage: FailStage): [string, string, string][] {
  if (flow === 'payout') {
    if (stage === 'provider') return [['PO-96', 'Provider system error', 'The payout could not be processed. Try again later.']];
    return type === 'ewallet'
      ? [['PO-W1', 'Wallet account not found', 'The wallet account was not found.']]
      : [
          ['PO-14', 'Invalid beneficiary account', 'The beneficiary account number is not valid.'],
          ['PO-91', 'Beneficiary bank unavailable', 'The beneficiary bank was unavailable.'],
        ];
  }
  if (stage === 'customer') return [['CANCELLED', 'Customer cancelled', 'The customer cancelled the payment.']];
  if (stage === 'provider') return type === 'cards' ? [['3DS-F', '3-D Secure authentication failed', "The customer didn't complete card authentication."]] : [['PRV-96', 'Provider system error', 'The payment could not be processed.']];
  switch (type) {
    case 'cards':
      return [
        ['51', 'Insufficient funds', 'The card has insufficient funds.'],
        ['05', 'Do not honour', 'The card issuer declined the payment.'],
        ['54', 'Expired card', 'The card has expired.'],
      ];
    case 'ewallet':
      return [['EW-51', 'Insufficient wallet balance', "The customer's wallet balance was too low."]];
    default:
      return [['BNK-05', 'Declined by bank', "The customer's bank declined the payment."]];
  }
}

// ------------------------------------------------------------------ helpers

function roundAmount(raw: number, cur: string) {
  if (cur === 'IDR') return Math.max(1000, Math.round(raw / 100) * 100);
  if (cur === 'VND') return Math.max(1000, Math.round(raw / 1000) * 1000);
  return Math.round(raw * 100) / 100;
}

function pick<T>(rand: () => number, list: T[]): T {
  return list[Math.floor(rand() * list.length)];
}

function hex(rand: () => number, n: number) {
  return Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
}

const pad = (n: number) => String(n).padStart(2, '0');
function localYmd(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Deterministic PRNG, so the same MID and day always give the same transactions. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
