# Global Platform – Transaction Management: Functional Requirements

**Status:** Draft for review by Product, Operations and Engineering · **Date:** 11 Nov 2026
**Scope:** requirements only. No application code is changed by this document.

How to read the tags:
- **[CONFIRM-P] / [CONFIRM-O] / [CONFIRM-E]**: needs a decision from Product, Operations or Engineering.
- **[HOST]**: depends on what each payment provider (host) actually supports. Nothing tagged [HOST] may
  be built as a general capability until the host integration confirms it.
- "Proposed" means this document suggests it, but it isn't agreed yet.

---

## 1. Objective and scope

### 1.1 Objective
Give Mobi staff one internal place to find, inspect and act on every pay-in and payout transaction,
across all launched countries, payment methods and hosts. Every action is permission-checked and
audited. The figures and statuses agree with the source of truth (§5.3).

### 1.2 In scope
1. Transaction listing (pay-in and payout, all launched countries).
2. Transaction details, including lifecycle timeline, references and fee breakdown.
3. Search and filters.
4. Operations: requery, retry, refund, investigation, notes. All are subject to host support.
5. Status lifecycle definitions and transition rules.
6. Export (filtered, including large exports).
7. Audit and security for all of the above.

### 1.3 Out of scope (separate modules or later)
- Payment processing itself (creating payments, routing to hosts): owned by the payment gateway.
- Host configuration and routing rules: **Host management** module.
- Settlement batches, payouts of settled funds and reconciliation files: **Settlements** module.
- Payout creation by merchants: **Payouts** module (this module *lists and monitors* payout transactions).
- Disputes and chargebacks. **[CONFIRM-P]** Are they a separate module, or a later phase of this one?
- Merchant-facing views: the Merchant Portal already has Dashboard and My Transactions (Batch 4). This
  module must use the same transaction records and statuses so both views always agree.

### 1.4 What exists today in the prototype (constraints)
| Area | Current state | Impact on this module |
|---|---|---|
| Countries | Malaysia, Indonesia, Vietnam launched | Corridor filter values |
| Payment methods | Per-country catalog (Pricing Engine §3.3, plus §3.1 being added) | Method filter values; payout = Bank Transfer (+ e-wallet payouts in MY/ID after §3.1) |
| Merchants | GMID, Master MID per country, sub-merchants with their own MID | Merchant / sub-merchant association |
| Pricing | Versioned pricing with fee-engine contract (Pricing Engine §7.9, §9, USD-6) | Fee fields on each transaction |
| Transaction settings | Daily limit, minimum transaction value, payment receipts, IPN callback URL per MID | Shown in details; limit-related failure reasons |
| Hosts | Not modelled yet | Host fields depend on Host management |
| Merchant Portal | Uses statuses Successful, Failed, Pending, Refunded on **sample data** | Must be aligned with §5 (open question Q1) |
| Teams | Sales / Ops, Risk, CS, FinOps, Mobi Support, Security Admin | Roles in §4 |

---

## 2. Feature breakdown

| # | Feature | Sub-features |
|---|---|---|
| F1 | Transaction list | Unified pay-in / payout list · column set · sorting · pagination · summary strip (count and amount per currency) · saved country workspace |
| F2 | Transaction details | Overview · parties (merchant, sub-merchant, MID) · payment (method, host) · amounts and fees · references · lifecycle timeline · merchant notification (IPN) attempts · notes · audit |
| F3 | Search and filters | Exact ID search · filters (§7) · combinable filters · clear all · filter state in the URL |
| F4 | Operations | Requery · retry · refund (full / partial) · investigation flag · notes |
| F5 | Status management | Status lifecycle · transition rules · source of truth · late updates and conflicts |
| F6 | Export | Filtered CSV · field set per role · large exports in the background · export audit |
| F7 | Audit and security | Immutable audit log · masking · role permissions · MFA re-authentication for sensitive actions |

---

## 3. Functional requirements

### F1 Transaction list
- **TL-1** One list for pay-in and payout transactions. A **Flow** column and filter (PayIn / Payout)
  identifies each one.
- **TL-2** Default columns: Created (date and time), Transaction ID, Invoice ID, Flow, Merchant (with
  sub-merchant on a second line when present), Country, Payment Method, Host, Amount, Currency, Status.
  Optional columns: MID, Fee, Net Amount, Last Updated, Completed At.
- **TL-3** Default view: last 24 hours, newest first, all statuses. **[CONFIRM-O]** Default period.
- **TL-4** Amounts are shown in the transaction's own currency and never converted. Summary totals are
  grouped by currency (same rule as the Merchant Portal balances).
- **TL-5** Country scope follows the user's workspace: a country workspace shows that country only.
  The global workspace shows all countries the user may access.
- **TL-6** Server-side pagination (proposed 50 per page) and sorting by Created, Amount or Last Updated.
- **TL-7** A summary strip for the current filters: total count, and count and amount by status per
  currency.
- **TL-8** Status badges use the labels in §5.1 and the same colours as the Merchant Portal.
- **TL-9** Rows open the details in a side sheet (detail size); the URL updates so the link can be shared.
- **TL-10** Empty state: "No transactions match these filters." with a "Clear filters" action.

### F2 Transaction details
- **TD-1 Overview:** Transaction ID, Invoice ID, Flow, Status (with status reason when there is one),
  Amount and Currency, Created At, Last Updated At, Completed At.
- **TD-2 Parties:** merchant legal name, GMID, Master MID, country; sub-merchant name and its MID when
  present; links to the merchant and sub-merchant pages.
- **TD-3 Payment:** payment method; for Indonesia Virtual Account, the VA bank; host name and host
  transaction reference. **[HOST]**
- **TD-4 Amounts and fees** (fee-engine contract, Pricing Engine §9 and USD-6): gross amount, fee
  charged (local), pricing version ID and version number (linked to MDR history), technique and rate,
  promotional or sub-merchant rule applied (if any), and for USD fixed fees: the USD fee, rate used, rate
  date, rate source and local fee. Net amount. Settlement cycle in effect (pay-in). Settlement batch
  reference once the Settlements module exists.
- **TD-5 References** (shown only where permitted, §9): Mobi request ID, host request reference, host
  response code and message, and the merchant's IPN callback URL used. Raw request and response
  payloads are **not** shown by default (Q6).
- **TD-6 Lifecycle timeline:** every status change in order, with time, previous → new status, source
  (host callback, requery result, expiry job, refund, manual action), and the actor for staff actions.
- **TD-7 Merchant notifications:** each IPN delivery attempt with time, HTTP result and retry number.
  **[CONFIRM-E]** whether IPN attempt data is available from the gateway.
- **TD-8 Refunds:** list of refunds linked to this transaction (amount, status, reference, requested by,
  time). Refunded and remaining refundable amounts.
- **TD-9 Notes and audit:** operational notes (§F4) and the audit entries for this transaction.
- **TD-10** Actions (§F4) appear in the sheet footer only when the user's role, the status and the
  host allow them. Otherwise they are hidden, not shown disabled.

### F3 Search and filters
See §7 for the full field list and rules.

### F4 Transaction operations
All operations are server-side, idempotent and audited, and are refused with a clear message when not
allowed.

| Op | What it does | Allowed when | Who | Notes |
|---|---|---|---|---|
| **Requery** | Asks the host for the transaction's current status and applies the result (§5.3) | Status Pending or Processing; host supports status enquiry **[HOST]** | Support, CS, Ops (proposed) | Rate-limited per transaction (proposed 1 per minute). The result is shown even when unchanged. |
| **Retry** | Re-sends a request to the host | **Only payout**, status Failed with a retryable reason, host supports retry **[HOST]**; **never** for pay-in (the customer initiates pay-ins) | Ops with FinOps approval (proposed) | Uses the same idempotency key to prevent double payouts. **[CONFIRM-P/E]** whether retry exists at all, or a new payout is created instead. |
| **Refund** | Returns all or part of a successful pay-in to the customer | Pay-in Successful; method and host support refunds **[HOST]**; within the refund window **[CONFIRM-O]**; amount ≤ remaining refundable | Request: CS or Ops. Approve: FinOps (maker ≠ checker) | Reason required. MFA re-authentication on approval. Partial refunds **[CONFIRM-P]**. |
| **Investigation flag** | Marks a transaction "Under investigation", with a reason and an optional ticket reference | Any status | Support, CS, Ops, Risk | A flag, not a status. It doesn't change the transaction. Cleared with a resolution note. |
| **Add note** | Free-text operational note | Any status | All staff roles except read-only | Notes can't be edited or deleted; corrections are new notes. |

- **OP-1** No operation may set a transaction to Successful or Failed by hand. Status changes only
  through §5.3 sources. **[CONFIRM-O]** whether a controlled "manual status correction" with FinOps
  approval is ever needed (for example, a host confirms by email). If it is, it needs its own spec.
- **OP-2** Every operation shows a confirmation in the side sheet with the impact ("Refund MYR 50.00
  of MYR 120.00 to the customer").
- **OP-3** A pending operation (for example, a refund awaiting approval) blocks a second one of the
  same type on the same transaction.
- **OP-4** Operations are blocked while the merchant is suspended, except Requery, Add note and
  Investigation flag. **[CONFIRM-O]**

### F5 Status management
See §5.

### F6 Export
See §8.

### F7 Audit and security
See §9.

---

## 4. User roles and permissions (proposed)

| Capability | Sales / Ops | Risk | CS | FinOps | Mobi Support | Security Admin | Merchant user |
|---|---|---|---|---|---|---|---|
| View list and details | ✓ | ✓ | ✓ | ✓ | ✓ | – | Own transactions only, in the Merchant Portal |
| View references (TD-5) | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| View fee breakdown (TD-4) | ✓ | – | ✓ | ✓ | – | – | – (Q8) |
| Requery | ✓ | – | ✓ | – | ✓ | – | – |
| Request refund | ✓ | – | ✓ | – | – | – | – |
| Approve or reject refund | – | – | – | ✓ | – | – | – |
| Retry payout (if confirmed) | request | – | – | approve | – | – | – |
| Investigation flag / notes | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Export | ✓ | ✓ | ✓ | ✓ | – | – | Own, in the Merchant Portal (exists) |

- **RP-1** All checks run on the server and are object-level: the user's country access applies to
  every list, detail, action and export.
- **RP-2** Security Admin has no merchant or transaction permissions, consistent with the MFA batch.
- **RP-3** [CONFIRM-O] the whole matrix, especially Risk's access to fees and Support's access to
  references.

---

## 5. Transaction lifecycle and status definitions

### 5.1 Statuses (proposed; to confirm with the gateway and hosts)
Only these statuses are proposed. Nothing else may be added without confirmation.

| Status | Label | Meaning | Final? |
|---|---|---|---|
| `pending` | Pending | Created by Mobi; waiting for the customer (pay-in) or not yet sent to the host (payout) | No |
| `processing` | Processing | Sent to or accepted by the host; waiting for the host's final result | No |
| `successful` | Successful | Host confirmed the payment or disbursement | Yes, but a refund can still follow |
| `failed` | Failed | Host or Mobi declined it, with a reason code | Yes |
| `expired` | Expired | No final result within the payment's validity window (for example, an unpaid VA or QR) | Yes |

Refunds are **separate records** linked to the original transaction, with their own statuses:
Refund pending approval, Refund processing, Refunded, Refund failed, Refund rejected. The original
transaction stays **Successful** and shows a "Refunded" or "Partially refunded" tag.

> **Q1 [CONFIRM-P]** The Merchant Portal currently shows "Refunded" as a transaction status. Choose one:
> (a) keep Refunded as a status on the original transaction, or (b) use the tag model above and update
> the Merchant Portal. Recommendation: (b), because partial refunds can't be one status.
>
> **Q2 [CONFIRM-E]** Payout-specific outcomes, such as a bank return after success ("returned" /
> "reversed"), are **not** defined here. Confirm with the hosts whether they exist.

### 5.2 Allowed transitions
```
pending ──► processing ──► successful
   │             │
   │             ├──────► failed
   │             └──────► expired      (validity window passed, no final result)
   ├──────────────────────► failed     (rejected before sending, e.g. limit or validation)
   └──────────────────────► expired
```
- **ST-1** Final statuses (successful, failed, expired) never move to another status, with one
  exception. **Late success:** a host success arriving after Mobi marked the transaction expired or
  failed is **not** applied automatically. The transaction gets a "Status conflict" flag and appears in
  an investigation queue, and Ops decides with the host. **[CONFIRM-O/E]**
- **ST-2** Each transition stores time, previous and new status, source, host reference or code, and
  actor (for staff-initiated requery).
- **ST-3** Transitions are applied once even if the same callback arrives several times (idempotent on
  host reference and status).

### 5.3 Source of truth
- **ST-4** The **host's** final response (callback or requery result) is the source of truth for
  successful and failed. Mobi's own system is the source of truth for pending, for expiry and for
  pre-send failures (limits, validation).
- **ST-5** The **Mobi transaction record** is the single record that the Global Platform, the Merchant
  Portal, IPN, fees and Settlements all read. No module keeps its own status copy.
- **ST-6** Expiry runs as a scheduled job per payment method's validity window. **[CONFIRM-O]**
  windows per method (for example, VA validity in Indonesia).

### 5.4 Pre-send failure reasons already implied by the platform
These come from settings that exist today. Exact reason codes are **[CONFIRM-E]**.
- Below the MID's minimum transaction value.
- Over the MID's daily transaction limit.
- Payment method not switched on for the MID, or merchant suspended.
- No pricing in effect for the method (Pricing Engine §7.9 resolution returns none). **[CONFIRM-P]**
  Block the transaction, or process it with no fee and alert FinOps?

---

## 6. Required data fields

| Field | Type | Source | Notes |
|---|---|---|---|
| transactionId | string, unique | Mobi | Shown everywhere; primary search key |
| invoiceId | string | Merchant | Merchant's order reference; not unique across merchants |
| flow | payin / payout | Mobi | |
| status, statusReasonCode, statusReasonText | enum, string | Mobi / host | §5 |
| amount, currency | decimal, ISO 4217 | Merchant request | Minor-unit precision per currency |
| fee (local), net amount | decimal | Fee engine | Pricing §9 |
| pricingVersionId, pricingVersion, technique, rateApplied | string, int, enum, string | Fee engine | |
| usdFee, fxRate, fxRateDate, fxRateSource | decimal, decimal, date, string | Fee engine | USD fixed fee only (USD-6) |
| gmid, merchantName, masterMid | string | Merchant records | Snapshot at creation |
| subMerchantId, subMerchantName, subMerchantMid | string | Merchant records | Optional |
| country | ISO 3166 | MID | |
| paymentMethodCode, paymentMethodName, vaBank | string | Catalog | vaBank for Indonesia VA only |
| hostId, hostName, hostReference | string | Host management / host | **[HOST]** |
| mobiRequestId, hostResponseCode, hostResponseMessage | string | Gateway | Restricted (§9) |
| createdAt, updatedAt, completedAt, expiresAt | timestamp (UTC) | Mobi | Displayed in the country's local time, with UTC available on hover |
| settlementCycle, settlementBatchId | string | Product config / Settlements | Pay-in only |
| customer reference | string, masked | Gateway | **[CONFIRM-P]** which customer data may be stored or shown at all (Q6) |
| ipnAttempts[] | list | Gateway | TD-7 |
| refunds[] | list | Mobi | TD-8 |
| notes[], flags[] | list | Global Platform | F4 |

---

## 7. Search, filter and export requirements

### 7.1 Search
- **SF-1** One search box for an exact **Transaction ID** or **Invoice ID**. A transaction ID search
  ignores all other filters and the date range, so an ID always finds its record.
  **[CONFIRM-E]** partial-match support (Merchant Portal "My Transactions" allows partial transaction ID).
- **SF-2** An invoice ID that matches several merchants lists them all.

### 7.2 Filters (all combinable)
| Filter | Control | Values |
|---|---|---|
| Date and time range | Presets (Last hour, Today, Last 7 days, Last 30 days) + custom from/to with time | Applies to Created At by default; option to filter on Completed At **[CONFIRM-O]** |
| Flow | Segmented | All, PayIn, Payout |
| Country | Multi-select | Countries the user can access |
| Currency | Multi-select | Currencies of those countries |
| Merchant | Searchable select (name or GMID) | |
| Sub-merchant | Searchable select, scoped to the chosen merchant | |
| Payment method | Grouped multi-select (as in the catalog) | |
| Host | Multi-select | From Host management |
| Status | Multi-select | §5.1 statuses + "Has refund" + "Under investigation" + "Status conflict" |
| Amount | From / to | In the selected currency only (enabled when exactly one currency is chosen) |

- **SF-3** Maximum custom range: **[CONFIRM-E]** (proposed 93 days in the list; longer ranges are export only).
- **SF-4** Filters are kept in the URL and restored on reload.
- **SF-5** Performance: first page in ≤ 2 s for the 90-day range at expected volume **[CONFIRM-E]**.

---

## 8. Reporting and export

- **EX-1** "Export CSV" exports **every** row matching the current filters and search, not just the
  current page (same rule as the Merchant Portal).
- **EX-2** Fields: all default and optional list columns, plus status reason, fee, net amount, pricing
  version, USD fee fields, refund totals and flags. References (TD-5) only for roles allowed to see them.
- **EX-3** File name: `mobi-transactions-{country|global}-{YYYY-MM-DD-HHmm}.csv`. Dates in ISO 8601
  with time zone; amounts as plain decimals; UTF-8 with header row.
- **EX-4 Large exports:** up to the threshold (proposed 50,000 rows **[CONFIRM-E]**) the file downloads
  directly. Above it, a background job creates the file and the user gets an in-app notification
  (and email **[CONFIRM-P]**). The link expires (proposed 7 days) and only the requester can use it.
  Hard maximum per export **[CONFIRM-E]**.
- **EX-5** Every export is audited: who, when, filters, row count. Exports contain no full card data
  or secrets.
- **EX-6** Scheduled or recurring reports belong to the Reports module, not this one.

---

## 9. Audit and security requirements

- **AS-1** Append-only audit for: views of restricted references, every operation (request, approve,
  reject, result), notes, flags, exports and status changes from requery. Each entry records actor, team,
  time, transaction ID, action, before → after and reason.
- **AS-2** Staff sessions require MFA (existing). **Re-authentication** with an authenticator code for:
  approving refunds, approving payout retries and large exports **[CONFIRM-P]**. It reuses the
  5-minute step-up window.
- **AS-3** Maker ≠ checker for refunds and retries (person-level, as in Pricing Approvals).
- **AS-4** Masking: no full card numbers (PAN) are ever stored or shown. Customer account numbers and
  phone numbers are masked (for example, last 4 digits). Raw host payloads aren't shown in the UI
  **[CONFIRM-E]** with PCI DSS and local data-protection requirements per country.
- **AS-5** Country and merchant scoping is enforced on every API call (object-level authorization).
- **AS-6** Rate limits on requery and export.
- **AS-7** Retention: transactions and audit kept at least 7 years, or longer where local regulation
  requires it **[CONFIRM-O]**.

---

## 10. User stories and acceptance criteria

**US-1 Find a transaction.** As Mobi Support, I want to find a transaction by its transaction ID or
invoice ID, so I can answer a merchant's query.
- Given a valid transaction ID, when I search, then exactly that transaction is shown, whatever the
  other filters and date range are.
- Given an invoice ID used by two merchants, then both transactions are listed with their merchant names.
- Given an ID in a country I can't access, then "No transactions match these filters." is shown and
  nothing leaks.

**US-2 Monitor a corridor.** As Ops, I want to filter by country, payment method, host, status and
time, so I can spot problems quickly.
- Filters combine with AND, and the summary strip updates to the filtered set.
- Totals are per currency, never converted.
- Reloading the page keeps the filters.

**US-3 See the full story.** As CS, I want a transaction's details and timeline, so I can explain what
happened.
- The details show all fields in TD-1 to TD-9 that my role is allowed to see.
- The timeline lists every status change with source and time, in order.
- The fee shows the pricing version that was applied, linked to MDR history.

**US-4 Requery a stuck transaction.** As Support, I want to ask the host for the latest status of a
Pending or Processing transaction.
- The button shows only when the status and host allow it.
- A result that changes the status adds a timeline entry with source "Requery"; an unchanged result is
  shown in a message and audited.
- A second requery within the rate limit is refused with the time to wait.

**US-5 Refund a payment.** As CS, I want to request a full or partial refund of a successful pay-in,
and as FinOps I want to approve it.
- I can't request more than the remaining refundable amount.
- A reason is required. The request shows "Refund pending approval".
- FinOps can't approve their own request, and must enter an authenticator code to approve.
- The original transaction stays Successful, with a "Refunded" or "Partially refunded" tag once the
  refund completes.

**US-6 Flag for investigation.** As Risk, I want to flag a transaction with a reason, so others know
it's being looked at.
- The flag shows in the list and details, and can be filtered.
- Clearing it needs a resolution note. Both actions are audited.

**US-7 Export.** As FinOps, I want to export the filtered transactions, so I can reconcile.
- The file contains every matching row, with the EX-2 fields for my role.
- Above the threshold, I'm told the file is being prepared and get a notification when it's ready.
- The export is in the audit log with its filters and row count.

**US-8 Payout visibility.** As Ops, I want payouts in the same list, clearly marked, so I can follow
disbursements.
- The Flow filter separates PayIn and Payout. Payouts show the beneficiary bank or wallet (masked).
- Payouts have no settlement cycle field.

---

## 11. Validation rules (operations)

| Rule | Message (proposed) |
|---|---|
| Requery on a final status | "This transaction is final. Requery is available only for Pending or Processing transactions." |
| Requery not supported by host | "{Host} doesn't support status requery." |
| Requery too soon | "Try again in {n} seconds." |
| Refund on a non-successful pay-in | "Only successful pay-ins can be refunded." |
| Refund amount | "Enter an amount up to {CUR} {remaining}." · "Enter an amount greater than 0." |
| Refund window passed | "The refund window for this payment method has ended." |
| Refund reason missing | "Enter a reason for the refund." |
| Approver is requester | "You submitted this refund, so someone else must approve it." |
| Merchant suspended | "{Merchant} is suspended. Only requery, notes and investigation flags are available." |
| Duplicate pending operation | "A refund for this transaction is already waiting for approval." |

---

## 12. Dependencies

1. **Payment gateway / transaction service:** transaction records, status callbacks, requery API,
   refund API, IPN delivery logs. (Not in this codebase today.)
2. **Host management:** host list, host per transaction, and per-host capabilities (requery, refund,
   partial refund, retry, refund window).
3. **Pricing Engine fee contract:** fee, version ID and USD fields written on each transaction (§9, USD-6).
4. **Settlements:** settlement batch reference on pay-ins.
5. **Merchant records:** GMID, MID, sub-merchant MIDs, suspension state, transaction settings.
6. **Notifications:** in-app (exists) and email for large exports and refund approvals.
7. **Merchant Portal:** same records and statuses (Q1).

## 13. Open questions

| # | Question | Owner |
|---|---|---|
| Q1 | "Refunded": a status on the transaction, or a tag with separate refund records? | Product |
| Q2 | Do payout returns or reversals after success exist with our hosts? | Engineering |
| Q3 | Does payout retry exist, or is a failed payout re-created as a new payout? | Product / Engineering |
| Q4 | Refund window per method and host; are partial refunds allowed; are refunds possible for every method (e.g. QR, VA)? | Operations / Engineering |
| Q5 | Validity (expiry) window per payment method | Operations |
| Q6 | Which customer data and host request/response data may be stored and shown, per country regulation | Product / Compliance |
| Q7 | Late success after Expired/Failed: manual decision (proposed) or automatic? | Operations |
| Q8 | Should merchants see fees per transaction in the Merchant Portal? | Product |
| Q9 | Transactions with no pricing in effect: block, or process with no fee and alert FinOps? | Product / FinOps |
| Q10 | Large-export threshold, hard maximum, link expiry, and email notification | Engineering / Product |
| Q11 | Is a manual status correction (with approval) ever needed? | Operations |
| Q12 | Disputes and chargebacks: separate module or later phase? | Product |
| Q13 | Final permission matrix (§4) | Operations |
| Q14 | Expected volumes per country (sizes the performance targets in SF-5) | Engineering |
