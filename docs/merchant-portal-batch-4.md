# Merchant Portal MVP — Dashboard & My Transactions (Batch 4)

Status: **Built on sample data. Needs Mobi's transaction and balance APIs before it can show real figures.**

> **Update: separate app.** The Merchant Portal is now its own app with its own URL
> (`projects/merchant-portal`, local port 4201; Vercel project with `PORTAL=merchant`). Its routes are
> `/dashboard`, `/transactions` and `/account-security` (previously `/merchant/...` inside the Global
> Platform app). The merchant screens were removed from the Global Platform app. Sign-in sends the
> app's portal, and the server refuses the other kind of user (`WRONG_PORTAL`, after the password
> check). See the README section "Two apps in this repository".
>
> **Update: third merchant.** `NUSANTARA-MERCHANT` (Siti Aminah, Nusantara Home Retail Sdn Bhd,
> `GM-109001` / `GA-1005`, 2FA on) is live in Malaysia (Visa / Mastercard, FPX, DuitNow QR, Touch 'n Go)
> and Indonesia (QRIS, Bank virtual account, OVO), with sample transactions and MYR / IDR balances. It is
> fully onboarded in the Global Platform (applications `APP-2026-9001` / `9002`, live MIDs). Browsers
> that already have demo data get it added once (`seedAdditions`); nothing else changes.

## 1. Decisions confirmed before build

| Question | Decision |
| --- | --- |
| Merchant login | New user **`TANJUNG-MERCHANT`** (Farah Ismail, Tanjung Global Trading `GM-100101` / `GA-1001`), 2FA not set up yet. Plus **`LUMI-MERCHANT`** (Lumi Home Living `GM-100102`, no live countries, 2FA on) for isolation and empty-state testing. Password `Mobi@123`. |
| Internal vs merchant users | A user record now has `portal: 'merchant'` + `merchantId`. All existing users stay internal and unchanged. |
| Data | No transaction or balance source exists, so the simulated backend generates **sample data** (about 90 days, 1–4 a day). It covers only the merchant's live countries and switched-on PayIn methods, and every screen is tagged *Sample data · not live*. |
| Statuses | **Updated in Transactions phase 1:** Pending, Processing, Successful, Failed, Expired (Refunded is no longer a status; see `transaction-management-phase-1.md`). The Dashboard shows Total (all statuses), Successful and Failed for pay-ins. |
| Currency | One available-balance figure per currency (MYR, IDR, VND), never converted. Amounts show in their own currency. |
| Date filters | Dashboard: Today, Last 7 days, Last 30 days. My Transactions: the same, plus a custom from–to date (up to 1 year). |

## 2. Screens

| Route | Content | States |
| --- | --- | --- |
| `/merchant/dashboard` | Available balance per currency (with "as of" time); Total / Successful / Failed for the chosen range; link to My Transactions | loading, error + retry, no live countries ("No balance yet"), no transactions in range |
| `/merchant/transactions` | Table: Invoice ID, Transaction ID, Payment method, Date & time, Amount, Currency, Status. Filters: date range (+ custom), payment method (merchant's own, with country when it has several), status, transaction ID search. 25 per page. Export CSV. | loading, refreshing, error + retry, no results (with Clear filters), invalid custom range, invalid search, nothing to export, export error / too large |
| `/merchant/account-security` | The existing 2FA settings page, reached from the user menu (not a nav item) | as Batch 3 |

Navigation is exactly **Dashboard** and **My Transactions**, plus the user menu (Account security, Sign out).
No View as switcher, internal modules, filters, search or staff notifications.
Status labels: Pending (grey), Processing (blue), Successful (green), Failed (red), Expired (amber) – the same in both apps.
Nothing about hosts, providers or routing is shown.

**CSV export.**
- Exports every record matching the current filters (not just the visible page), up to 10,000 rows.
- Columns are the same as the table. Dates are local `YYYY-MM-DD HH:mm:ss`; amounts are plain numbers with the currency's decimals.
- UTF-8 with a BOM, so Excel opens it correctly.
- Formula-like cells are neutralised against CSV injection.
- File name: `<merchant-name>-transactions-YYYY-MM-DD.csv`.

## 3. Access control (enforced in the simulated backend)

- A merchant user's session exists only after password **and** 2FA (Batch 3).
- `/api/merchant-portal/*` accepts only merchant users, and takes the merchant from the session. Query
  parameters such as `merchantId` are ignored, and payment-method filters must be the merchant's own.
- Every internal API refuses merchant users (`ROLE_NOT_PERMITTED`), whatever role header they send. This
  covers merchants, applications, approvals, configuration, MCC, workspace context and security admin.
- Route guards keep each kind of user in their own portal. This is for convenience only; the server checks are what protect the data.

## 4. API contracts the real backend must provide

Proposed contract: `src/app/core/merchants/merchant-portal.ts`. The simulated version is in
`src/app/core/mock-server/merchant-portal-server.ts`.

| Endpoint | Returns | Notes |
| --- | --- | --- |
| `GET /api/merchant-portal/overview` | merchant `{id, name}`, `balances[] {currency, available}`, `asOf`, `paymentMethods[] {code, name, country}`, `sampleData` | Available balance must come from the ledger (after settlements, reserves, fees). The sample uses the net of the last 7 days' successful pay-ins, which is **not** a real balance. |
| `GET /api/merchant-portal/summary?range=today\|7d\|30d` | `{from, to, total, successful, failed}` | Ranges in the merchant's local time zone (open question). |
| `GET /api/merchant-portal/transactions?range&from&to&method&status&q&page&pageSize` | `{items[], total, page, pageSize}` | Payment-method level only; newest first; `pageSize` 10/25/50/100. |
| `GET /api/merchant-portal/transactions/export?…same filters` | `{filename, csv, rows}` | Could also be an async export job for large volumes. |

Errors: `401` not signed in · `403 ROLE_NOT_PERMITTED` · `400 VALIDATION_FAILED` (bad range, method, status or search) · `413 EXPORT_TOO_LARGE`.

## 5. Files

**New**
- `core/merchants/merchant-portal.ts`: API contract, labels, amount formatting.
- `core/merchants/merchant-portal-api.service.ts`: client API.
- `core/mock-server/merchant-portal-server.ts`: simulated API and sample data.
- `core/mock-server/merchant-portal-server.spec.ts`: 14 tests.
- `features/merchant-portal/merchant-shell.ts`: merchant layout, reusing the portal shell styles.
- `features/merchant-portal/merchant-dashboard.ts`, `merchant-transactions.ts`, `merchant-portal.scss`.

**Changed**
- `core/api/models.ts`: session gains `portal` and `merchant`.
- `core/mock-server/seed.ts`: 2 merchant users, a "Merchant user" role.
- `core/mock-server/auth-server.ts`:
  - portal-aware sessions and landing page;
  - `authenticate()` takes a portal, so internal services refuse merchant users;
  - security admin and workspace context are internal only;
  - the data upgrade (v6) adds the new users and keeps existing data.
- `core/mock-server/merchant-server.ts`: read-only `portalProfile()` (live countries and enabled PayIn methods).
- `core/mock-server/mock-backend.ts`: routes `/api/merchant-portal/*`; `mobiDemo.reset()` also clears portal sample data.
- `core/auth/auth.guards.ts`: `portalGuard`.
- `app.routes.ts`: `/merchant/*` routes; the internal shell is guarded as internal only.
- `mfa.spec.ts`: data version 6.

The internal portal's screens, navigation and onboarding workflows are unchanged.

## 6. Tests

- 225 automated tests pass (14 new), and the production build succeeds.
- Browser walkthrough:
  - merchant 2FA setup lands on the Dashboard;
  - the range switch updates the counts (Today 3 → 7 days 17 → 30 days 68);
  - status, method, search and custom-range filters work;
  - CSV download has the right file name, header and row count;
  - empty results and the empty export are handled;
  - a merchant user is sent back from `/merchants`, `/dashboard`, `/applications` and `/security/users`;
  - an internal user is sent back from `/merchant/*`, and internal navigation is unchanged;
  - Lumi shows "No balance yet";
  - no horizontal scroll at 390 px, and no console errors.

## 7. Open questions / backend dependencies

1. **Transaction and balance APIs**: owner, source system and delivery date. How fresh is the
   available balance (real-time or as of the last settlement)?
2. **Statuses**: confirm Successful / Failed / Pending / Refunded, or give the real list and mapping. Should
   Total include pending and refunded? (It does today.)
3. **Time zone** for "Today" and the exported times: the merchant's country, or the user's browser?
4. **Multi-country merchants**: one balance per currency is assumed. Confirm there's no conversion or base-currency total.
5. **Merchant user provisioning**: how merchant users are created and linked to a merchant is not defined
   (the demo seeds them). It ties in with the "multi-user" item deferred from Batch 3.
6. **Sub-merchants**: should a parent merchant's user see its sub-merchants' transactions?
7. **Export limits**: is 10,000 rows enough, or is an async export needed?
