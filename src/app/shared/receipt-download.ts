import { buildReceiptPdf, loadLogoAsJpeg } from '../core/transactions/receipt-pdf';
import { fmtDateTime, fmtMoney, TXN_STATUS_LABEL, TxnFlow, TxnStatus } from '../core/transactions/transactions';

/** What a Sales slip / Payment advice needs; both portals' transaction details have these fields. */
export interface ReceiptSource {
  flow: TxnFlow;
  status: TxnStatus;
  transactionId: string;
  invoiceId: string;
  amount: number;
  currency: string;
  paidAt: number | null;
  merchantName: string;
  methodName: string;
  methodDetail: string | null;
  bankReference: string | null;
  customerName: string | null;
  beneficiary: { name: string | null; account: string | null; bank: string | null } | null;
}

/**
 * Downloads the Sales slip (pay-in) or Payment advice (payout) as a one-page PDF with the Mobi logo.
 * It shows what was paid and its references, never Mobi's fee or net.
 */
export async function downloadReceipt(t: ReceiptSource): Promise<void> {
  const logo = await loadLogoAsJpeg('brand/mobi-wordmark-blue.png');
  const payin = t.flow === 'payin';
  const rows: [string, string][] = payin
    ? [
        ['Merchant', t.merchantName],
        ['Merchant Ref ID', t.invoiceId],
        ['Mobi Ref ID', t.transactionId],
        ['Payment method', [t.methodName, t.methodDetail].filter(Boolean).join(' · ')],
        ['Bank reference', t.bankReference ?? '—'],
        ['Customer', t.customerName ?? '—'],
      ]
    : [
        ['From', t.merchantName],
        ['Merchant Ref ID', t.invoiceId],
        ['Mobi Ref ID', t.transactionId],
        ['Beneficiary', t.beneficiary?.name ?? '—'],
        ['Bank / wallet', t.beneficiary?.bank ?? t.methodName],
        ['Account', t.beneficiary?.account ?? '—'],
        ['Bank reference', t.bankReference ?? '—'],
      ];
  const pdf = buildReceiptPdf(
    {
      title: payin ? 'Sales slip' : 'Payment advice',
      amount: fmtMoney(t.amount, t.currency),
      status: TXN_STATUS_LABEL[t.status],
      subtitle: `${payin ? 'Paid' : 'Paid out'} ${t.paidAt ? fmtDateTime(t.paidAt) : ''}`.trim(),
      rows,
      note: payin
        ? 'This slip confirms the payment to the merchant. It shows what the customer paid and its references; Mobi fees are not shown. Sample document from the Mobi prototype.'
        : 'This advice confirms the payout to the beneficiary. Sample document from the Mobi prototype.',
    },
    logo,
  );
  const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${payin ? 'sales-slip' : 'payment-advice'}-${t.transactionId}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
