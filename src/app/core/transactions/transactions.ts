// Transaction Management, phase 1 (docs/transaction-management-phase-1.md).
// Shared by the Global Platform, the Merchant Portal and the simulated backend.
//
// PROPOSED CONTRACT: Mobi has no transaction service in this codebase. The simulated backend
// serves clearly labelled sample data in this shape. The data model follows Option A:
// - one main table per flow (`payin_transactions`, `payout_transactions`) with the fields every
//   transaction has; lists, filters, summaries and exports read only these;
// - one detail table per payment type (not per payment method), read for a single transaction
//   when its details are opened, or joined once when a list is narrowed to one payment type.

export type TxnFlow = 'payin' | 'payout';
export const TXN_FLOWS: TxnFlow[] = ['payin', 'payout'];
export const TXN_FLOW_LABEL: Record<TxnFlow, string> = { payin: 'PayIn', payout: 'Payout' };

export type TxnStatus = 'pending' | 'processing' | 'successful' | 'failed' | 'expired';
export const TXN_STATUSES: TxnStatus[] = ['pending', 'processing', 'successful', 'failed', 'expired'];
export const TXN_STATUS_LABEL: Record<TxnStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  successful: 'Successful',
  failed: 'Failed',
  expired: 'Expired',
};
/** Badge tone per status (same colours in both apps). */
export const TXN_STATUS_TONE: Record<TxnStatus, string> = {
  pending: 'neutral',
  processing: 'info',
  successful: 'success',
  failed: 'danger',
  expired: 'warning',
};

/** Payment types group payment methods that store the same kind of data (one detail table each). */
export type PaymentType = 'online_banking' | 'ewallet' | 'qr' | 'cards' | 'virtual_account' | 'otc' | 'bank_transfer';

/** Labels per flow: the PayIn group is "E-Wallets", the Payout group "E-Wallet" (as in Product & Payment Config). */
export const PAYMENT_TYPE_LABEL: Record<TxnFlow, Partial<Record<PaymentType, string>>> = {
  payin: {
    online_banking: 'Online Banking',
    ewallet: 'E-Wallets',
    qr: 'QR',
    cards: 'Cards',
    virtual_account: 'Virtual Account',
    otc: 'Over the Counter',
    bank_transfer: 'Bank Transfer',
  },
  payout: { bank_transfer: 'Bank Transfer', ewallet: 'E-Wallet' },
};
/** Display order of the payment type chips. */
export const PAYMENT_TYPE_ORDER: Record<TxnFlow, PaymentType[]> = {
  payin: ['online_banking', 'ewallet', 'qr', 'cards', 'virtual_account', 'otc', 'bank_transfer'],
  payout: ['bank_transfer', 'ewallet'],
};

/** Payment type of each catalog method (every corridor). Unknown codes fall back by flow. */
const METHOD_TYPE: Record<string, PaymentType> = {
  fpx: 'online_banking',
  duitnow_qr: 'qr',
  qris: 'qr',
  vietqr: 'qr',
  tng: 'ewallet',
  grabpay: 'ewallet',
  boost: 'ewallet',
  shopeepay: 'ewallet',
  shopee: 'ewallet',
  dana: 'ewallet',
  ovo: 'ewallet',
  linkaja: 'ewallet',
  momo: 'ewallet',
  zalopay: 'ewallet',
  cards: 'cards',
  va: 'virtual_account',
  ezycash: 'otc',
  bank_transfer: 'bank_transfer',
  bank_transfer_payout: 'bank_transfer',
};

export function paymentTypeOf(methodCode: string, flow: TxnFlow): PaymentType {
  if (flow === 'payout') return methodCode === 'bank_transfer_payout' ? 'bank_transfer' : 'ewallet';
  return METHOD_TYPE[methodCode] ?? 'ewallet';
}

export type TxnRange = '1h' | '24h' | 'today' | '7d' | '30d' | 'custom';
export const TXN_RANGE_LABEL: Record<Exclude<TxnRange, 'custom'>, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};
export const TXN_PAGE_SIZES = [10, 25, 50];

export type TxnFlag = 'investigation' | 'status_conflict';
export const TXN_FLAG_LABEL: Record<TxnFlag, string> = { investigation: 'Under investigation', status_conflict: 'Status conflict' };

export type TxnSort = 'created' | 'amount' | 'updated';

// ------------------------------------------------------------------ list

/** One extra column a payment type adds to the list (from its detail table). */
export interface TypeColumn {
  key: string;
  label: string;
}

/** Extra list columns per payment type (internal list). */
export const TYPE_COLUMNS: Record<TxnFlow, Partial<Record<PaymentType, TypeColumn[]>>> = {
  payin: {
    online_banking: [
      { key: 'bank', label: 'Bank' },
      { key: 'fpxTransactionId', label: 'FPX transaction ID' },
    ],
    ewallet: [{ key: 'walletAccount', label: 'Wallet account' }],
    qr: [{ key: 'payerApp', label: 'Payer app / bank' }],
    cards: [
      { key: 'card', label: 'Card' },
      { key: 'approvalCode', label: 'Approval code' },
    ],
    virtual_account: [
      { key: 'vaBank', label: 'VA bank' },
      { key: 'vaNumber', label: 'VA number' },
    ],
    otc: [{ key: 'paymentCode', label: 'Payment code' }],
    bank_transfer: [{ key: 'bank', label: 'Bank' }],
  },
  payout: {
    bank_transfer: [
      { key: 'beneficiaryBank', label: 'Beneficiary bank' },
      { key: 'beneficiaryAccount', label: 'Beneficiary account' },
    ],
    ewallet: [
      { key: 'wallet', label: 'Wallet' },
      { key: 'walletAccount', label: 'Wallet account' },
    ],
  },
};

export interface TxnListRow {
  transactionId: string;
  invoiceId: string;
  flow: TxnFlow;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  merchantName: string;
  gmid: string;
  subMerchantName: string | null;
  mid: string;
  country: string;
  countryName: string;
  methodCode: string;
  methodName: string;
  paymentType: PaymentType;
  providerName: string;
  amount: number;
  currency: string;
  status: TxnStatus;
  /** Fee and net only for roles allowed to see fees, and only once a transaction is Successful. */
  fee?: number | null;
  net?: number | null;
  flags: TxnFlag[];
  /** Values of the selected payment type's extra columns. */
  typeValues?: Record<string, string>;
}

export interface CurrencyAmount {
  currency: string;
  amount: number;
}

export interface TxnSummary {
  total: number;
  totalAmounts: CurrencyAmount[];
  byStatus: Record<TxnStatus, { count: number; amounts: CurrencyAmount[] }>;
}

export interface TxnFilterOptions {
  countries: { code: string; name: string; currency: string }[];
  merchants: { gmid: string; name: string }[];
  subMerchants: { id: string; name: string; gmid: string }[];
  methods: { code: string; name: string; type: PaymentType; country: string }[];
  providers: { id: string; name: string }[];
  /** Payment types that exist in the selected country (all countries when none is selected). */
  paymentTypes: PaymentType[];
}

export interface TxnListResponse {
  items: TxnListRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: TxnSummary;
  typeColumns: TypeColumn[];
  options: TxnFilterOptions;
  /** A searched ID that is not in this flow but is in the other one. */
  otherFlowMatch: TxnFlow | null;
  /** What this login may do on the page. */
  can: { export: boolean; seeFees: boolean };
  sampleData: true;
}

// ------------------------------------------------------------------ details

export type PathStepKey = 'customer' | 'merchant' | 'mobi' | 'provider' | 'bank';
export const PATH_STEP_LABEL: Record<PathStepKey, string> = { customer: 'Customer', merchant: 'Merchant', mobi: 'Mobi', provider: 'Provider', bank: 'Bank' };
export type PathStepState = 'done' | 'current' | 'failed' | 'expired' | 'off';

export interface PathStep {
  key: PathStepKey;
  state: PathStepState;
  caption: string;
}

/** A label/value pair in a details section; `restricted` names the teams that may see it. */
export interface DetailField {
  label: string;
  value: string;
  restricted?: string;
  link?: { kind: 'merchant' | 'pricing'; id: string };
  tone?: 'success' | 'danger' | 'warning';
}

export interface DetailSection {
  key: 'customer' | 'beneficiary' | 'merchant' | 'mobi' | 'provider' | 'bank' | 'method' | 'payment' | 'fees' | 'settlement';
  title: string;
  fields: DetailField[];
}

export interface TimelineEntry {
  at: number;
  title: string;
  /** Previous → new status, when the entry is a status change. */
  from?: TxnStatus | null;
  to?: TxnStatus | null;
  source: string;
  detail?: string;
  actor?: string;
}

export interface IpnAttempt {
  attempt: number;
  at: number;
  httpStatus: number | null;
  result: string;
  ok: boolean;
}

export interface TxnNote {
  id: string;
  at: number;
  by: string;
  team: string;
  text: string;
}

export interface TxnFlagView {
  flag: TxnFlag;
  label: string;
  reason: string;
  ticket: string | null;
  raisedBy: string;
  raisedAt: number;
}

export interface TxnAuditEntry {
  id: string;
  at: number;
  actor: string;
  team: string;
  transactionId: string | null;
  action: string;
  detail: string;
}

export interface TxnDetail {
  transactionId: string;
  invoiceId: string;
  flow: TxnFlow;
  status: TxnStatus;
  statusReason: string | null;
  amount: number;
  currency: string;
  methodName: string;
  paymentTypeLabel: string;
  countryName: string;
  createdAt: number;
  completedAt: number | null;
  path: PathStep[];
  sections: DetailSection[];
  timeline: TimelineEntry[];
  ipn: { status: string; url: string; attempts: IpnAttempt[] };
  notes: TxnNote[];
  flags: TxnFlagView[];
  audit: TxnAuditEntry[];
  can: { addNote: boolean; flag: boolean };
  sampleData: true;
}

// ------------------------------------------------------------------ merchant portal

export interface MerchantTxnRow {
  transactionId: string;
  invoiceId: string;
  flow: TxnFlow;
  createdAt: number;
  subMerchantName: string | null;
  methodCode: string;
  methodName: string;
  paymentType: PaymentType;
  amount: number;
  fee: number | null;
  net: number | null;
  currency: string;
  status: TxnStatus;
}

export interface MerchantTxnSummary {
  total: number;
  successful: number;
  /** Per currency, successful transactions only. */
  gross: CurrencyAmount[];
  fees: CurrencyAmount[];
  net: CurrencyAmount[];
}

export interface MerchantTxnListResponse {
  items: MerchantTxnRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: MerchantTxnSummary;
  options: {
    countries: { code: string; name: string; currency: string }[];
    subMerchants: { id: string; name: string }[];
    methods: { code: string; name: string; type: PaymentType; country: string }[];
    paymentTypes: PaymentType[];
  };
  sampleData: true;
}

export interface MerchantTxnDetail {
  transactionId: string;
  invoiceId: string;
  flow: TxnFlow;
  status: TxnStatus;
  statusReason: string | null;
  amount: number;
  currency: string;
  methodName: string;
  countryName: string;
  createdAt: number;
  completedAt: number | null;
  sections: DetailSection[];
  timeline: TimelineEntry[];
  ipn: { status: string; attempts: IpnAttempt[] };
  sampleData: true;
}

export interface TxnExport {
  filename: string;
  csv: string;
  rows: number;
}

// ------------------------------------------------------------------ formatting

/** Decimal places of the currency's smallest unit (IDR and VND have none in practice). */
export const txnDecimals = (currency: string) => (currency === 'IDR' || currency === 'VND' ? 0 : 2);

/** "1,234.50" (no currency). */
export function fmtAmount(amount: number, currency: string): string {
  const d = txnDecimals(currency);
  return amount.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** "MYR 1,234.50". */
export const fmtMoney = (amount: number, currency: string) => `${currency} ${fmtAmount(amount, currency)}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** "12 Nov 2026, 14:32" in the browser's local time. */
export function fmtDateTime(t: number, seconds = false): string {
  const d = new Date(t);
  return `${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}${seconds ? `:${p2(d.getSeconds())}` : ''}`;
}

/** "12 Nov 2026". */
export function fmtDate(t: number): string {
  const d = new Date(t);
  return `${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
