// API contract for the merchant-facing portal (Dashboard, My Transactions).
// PROPOSED CONTRACT: Mobi has no transaction or balance API in this codebase yet. The simulated
// backend serves clearly labelled sample data in this shape until the real services exist.

export type TransactionStatus = 'successful' | 'failed' | 'pending' | 'refunded';

export const TRANSACTION_STATUS_LABEL: Record<TransactionStatus, string> = {
  successful: 'Successful',
  failed: 'Failed',
  pending: 'Pending',
  refunded: 'Refunded',
};

export type DatePreset = 'today' | '7d' | '30d';

export const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

export interface PortalPaymentMethod {
  code: string;
  name: string;
  country: string;
}

export interface MerchantPortalOverview {
  merchant: { id: string; name: string };
  /** One entry per currency the merchant trades in (one per live country). Never converted. */
  balances: { currency: string; available: number }[];
  asOf: number;
  paymentMethods: PortalPaymentMethod[];
  /** True while the data is generated sample data, not a live ledger. */
  sampleData: boolean;
}

export interface TransactionSummary {
  from: number;
  to: number;
  total: number;
  successful: number;
  failed: number;
  sampleData: boolean;
}

export interface MerchantTransaction {
  invoiceId: string;
  transactionId: string;
  paymentMethod: { code: string; name: string };
  createdAt: number;
  amount: number;
  currency: string;
  status: TransactionStatus;
}

export interface TransactionQuery {
  /** A preset, or `custom` with `from` / `to` as local dates (YYYY-MM-DD, inclusive). */
  range: DatePreset | 'custom';
  from?: string;
  to?: string;
  method?: string;
  status?: TransactionStatus;
  /** Transaction ID (or part of it). */
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface TransactionPage {
  items: MerchantTransaction[];
  total: number;
  page: number;
  pageSize: number;
  sampleData: boolean;
}

export interface TransactionExport {
  filename: string;
  csv: string;
  rows: number;
}

/** Decimal places shown for each currency (IDR and VND have no minor unit in practice). */
export const CURRENCY_DECIMALS: Record<string, number> = { MYR: 2, IDR: 0, VND: 0, THB: 2, PHP: 2, USD: 2, SGD: 2 };

export function formatAmount(amount: number, currency: string): string {
  const d = CURRENCY_DECIMALS[currency] ?? 2;
  return amount.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** "Pricing & settings" (read only): what the merchant has agreed with Mobi, per live country. */
export interface MerchantSettingsView {
  merchant: { id: string; name: string };
  countries: {
    country: string;
    countryName: string;
    currency: string;
    /** Master MID for the country. */
    mid: string | null;
    ipnCallbackUrl: string;
    dailyLimit: number | null;
    minTransactionValue: number | null;
    sendReceipts: boolean;
    products: {
      name: string;
      flow: 'payin' | 'payout';
      /** PayIn only. */
      settlement: string | null;
      /** Pricing in effect today (merchant level); null when none. */
      pricing: string | null;
      effective: string | null;
      /** Subscription and promotion, if any. */
      extras: string | null;
      /** An approved change that starts later, e.g. "Percentage: 1.2% from 01 Dec 2026". */
      upcoming: string | null;
    }[];
  }[];
}
