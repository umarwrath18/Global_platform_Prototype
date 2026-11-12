# Transaction Management – Phase 1 (November 2026)

Built from [`transaction-management-requirements.md`](transaction-management-requirements.md) and the
decisions below. Phase 1 covers **finding and understanding** transactions: list, details, search,
filters, export, investigation flags and notes. There is still no transaction service, so every
record is **sample data** (marked *Sample data · not live*).

## Decisions applied
| Topic | Decision |
|---|---|
| Scope | Transactions page and details, investigation flag, notes, audit, export. **On hold:** Requery, Refunds (Q4) and payout retry (Q3: not built; a failed payout is re-created as a new payout). |
| Flows | **PayIn** and **Payout** are separate tabs, each its own API call reading its own table. Never one combined list. |
| Payment types | Methods are grouped by **Payment type**. PayIn: *Online Banking · E-Wallets · QR · Cards · Virtual Account · Over the Counter · Bank Transfer*. Payout: *Bank Transfer · E-Wallet*. Only the types that exist in the selected country show. |
| Data model | **Option A** (below). |
| Host label | **Provider**. Sample providers are generic (*Provider MY-A*…); Provider management replaces them later. |
| Statuses | Pending, Processing, Successful, Failed, Expired (§5.1). **Q1 (b):** "Refunded" is no longer a status; refunds will be separate records with a tag on the original. |
| No pricing in effect (Q9) | The transaction is **blocked**: Failed, reason "No pricing in effect", stopped by Mobi. |
| Fees for merchants (Q8) | **Shown**: Fee and Net amount in the Merchant Portal list, summary and details. |
| Customer data (Q6) | All customer fields are optional (merchants send little). Staff see email and phone masked; the merchant sees what it sent. **IP address and Device**: Risk and Mobi Support only. |
| Permissions (Q13) | §4 as proposed: Sales / Ops, Risk, CS, FinOps and Mobi Support view; fees only for Sales / Ops, CS and FinOps; export for all but Mobi Support; Security Admin has no access; viewer logins can't add notes or flags. |
| Defaults | Sidebar **Transactions** under Dashboard; **Last 24 hours**; 25 rows per page (shared pager 10 / 25 / 50). |
| Expiry windows (Q5) | Not decided here. Sample data uses example windows (QR / e-wallet 15 min, cards / FPX 30 min, VA and bank transfer 24 h, over the counter 48 h) only to produce Expired records. |
| Status conflict (Q7) | Some sample Expired records get a late provider success: flagged **Status conflict**, never applied. The resolution queue comes later. |
| Export (Q10) | Direct CSV download of every matching row (limit 50,000). Background exports come later. |

## Data model (Option A)
- **Main tables:** `payin_transactions`, `payout_transactions`. One row per transaction with the fields
  every transaction has: IDs, merchant / GMID / Master MID / sub-merchant MID, country, currency,
  method, payment type, provider, amount, fee and pricing version, status and times, customer
  fields, Mobi request ID, provider and bank references. Lists, filters, summaries and exports read
  only these (indexed on created date, MID, status, method).
- **Detail tables, one per payment type** (not per method): online banking (buyer bank, FPX ID),
  e-wallet (wallet, account, wallet transaction ID), QR (type, payer app / bank, reference), cards
  (brand, last 4, type, issuer, issuer country, 3-D Secure, approval code, RRN), virtual account (bank,
  VA number), over the counter (outlet, payment code), bank transfer (bank, reference, beneficiary).
  A new wallet is a new catalog row, not a new table.
- Opening a transaction reads its main row plus **one** detail table. A list narrowed to one payment
  type joins that one detail table for its extra columns.
- At real volumes, list / search / export should run on a read replica or search index, not the
  payment database (for Engineering).

In the prototype the records are generated from each live MID's real setup (switched-on products,
live sub-merchants, pricing versions in effect each day) and are the same in both apps. Each record
keeps the time of each step, so a recent transaction moves from Pending / Processing to its outcome
as time passes. Notes, flags and the audit log are stored (`mobi.gp.txnops`).

## Screens
**Global Platform → Transactions**
- Tabs PayIn | Payout; payment type chips; filters: Search (exact Transaction ID or Invoice ID;
  ignores other filters and the date range), Date range (Last hour, Last 24 hours, Today, Last 7 days,
  Last 30 days, Custom up to 93 days), Country, Merchant, Sub-merchant (live sub-merchants only),
  Payment method, Provider, Status; **More filters**: Currency, Amount from / to (one country or
  currency), Flags (Under investigation, Status conflict). Filters live in the URL.
- Summary per status with amounts per currency (never converted).
- Columns: Created, Transaction ID, Invoice ID, Merchant (sub-merchant below), Country, Payment method,
  Provider, Amount, Currency, Status (flags below). Choosing a payment type adds its own columns
  (e.g. E-Wallets: Wallet account; Cards: Card, Approval code; Payout Bank Transfer: Beneficiary
  bank, Beneficiary account). Sort by Created or Amount.
- Details side sheet (`?txn=`): payment path, then numbered sections Customer → Merchant → Mobi →
  Provider → Bank and "{Payment type} details"; tabs Timeline, IPN, Notes, Audit; footer **Flag for
  investigation** / **Clear flag** and **Add note**.

**Merchant Portal → My Transactions**
- Same tabs, chips and filters (Search, Date range, Country when more than one, Sub-merchant when it
  has live ones, Payment method, Status). Summary: Transactions, Successful, Gross volume, Fees, Net
  amount. Columns add **Fee** and **Net amount** (— until Successful).
- Details side sheet: path Customer → Mobi → Bank (payout: Mobi → Bank → Beneficiary); Payment,
  Amount and fees, Customer, Bank (Payment reference), Settlement, IPN, Timeline (Created → Paid →
  Settled). No provider, provider codes, pricing version or Mobi request ID.

## New labels and messages (please review)
- Payment path: **Beneficiary** (payout step, in place of Customer).
- Payout amounts: **Total debited** (amount + fee) in place of Net amount.
- Details: **Master MID** (shown when the transaction belongs to a sub-merchant), **Status reason**,
  **Expires**, **Last updated**, **Sent to provider at**, **Bank response code**, **Rate**, **USD fee**,
  **FX rate**, **Rate date**, **Rate source**, **Settlement status** ("Not settled yet" until the
  Settlements module exists), merchant **Reason** (plain-language failure reason).
- Search hint: "Searching for {ID}: other filters and the date range don't apply to an ID search."
- Other flow: "This is a {PayIn / Payout} transaction" · "Show in {flow}".
- Flag: "Flag for investigation" (Reason *, Ticket reference optional) · "Clear the investigation
  flag" (Resolution note *) · "Enter a reason for the investigation." · "Enter a resolution note." ·
  "This transaction is already under investigation."
- Notes: "Enter a note." · "Notes can't be edited or deleted. To correct one, add a new note."
- Footer note: "Requery and refunds come in a later phase."

## API (simulated, proposed contract)
- `GET /api/transactions/{payin|payout}` — list, summary, filter options, type columns, `can`.
- `GET /api/transactions/{flow}/export` — CSV (fees only for fee roles); audited.
- `GET /api/transactions/{flow}/{id}` — details (role-filtered); audited as "Viewed details".
- `POST /api/transactions/{flow}/{id}/notes` · `/flag` · `/flag/clear`.
- Merchant Portal: `GET /api/merchant-portal/transactions?flow=` · `/transactions/export?flow=` ·
  `/transactions/{flow}/{id}`. The merchant is always taken from the session.

## Not in phase 1
Requery, refunds, payout retry, background exports, the status-conflict queue, manual status
correction (OP-1), Provider management, Settlements references, scheduled reports. Demo sub-merchants
(Nusantara's Online Store and Penang Outlet) are approved but not live, so they have no MID and no
transactions; a sub-merchant that CS takes live gets transactions from its go-live.

## Tests
`transaction-server.spec.ts` (records, filters, ID search, permissions, masking, notes, flags,
export, merchant view and isolation); `merchant-portal-server.spec.ts` updated for the shared records.
