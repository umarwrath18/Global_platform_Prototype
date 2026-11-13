# Mobi Global Platform — Prototype

Angular 21 prototype of the Global Platform:

- **Batch 1:** Login & Authentication.
- **Batch 4:** Merchant Portal MVP for merchant users: Dashboard (available balance, transaction summary) and My Transactions (filters, CSV export).
- **Batch 3:** Two-factor authentication (Merchant Portal MFA, Phase 1: authenticator app / TOTP).
- **Batch 2:** Merchant Management & Onboarding (Global Merchants, country applications, country expansion, Risk review, simulated CS readiness and go-live, notifications).
- **Transaction Management, phase 1:** Transactions (PayIn and Payout lists, details, filters, export, notes and investigation flags) in the Global Platform, and the same records in the Merchant Portal's My Transactions.

Other MVP modules are intentionally not built yet.

There is no real server or database. A simulated backend runs in the browser
(`src/app/core/mock-server/`) and stores its data in `localStorage`. It answers
`/api/*` calls through an HTTP interceptor and enforces every rule as a real
backend would, so it can later be replaced by Mobi's real API without changing the screens.
Batch 2 merchant data is kept separately under `mobi.gp.merchantdb`.

## Two apps in this repository

| App | Who signs in | Code | Local URL |
| --- | --- | --- | --- |
| **Mobi Global Platform** (internal) | Mobi staff demo users (`123`, `TANJUNG-ADMIN`, …) | `src/` | http://localhost:4200 |
| **Mobi Merchant Portal** | Merchant users (`TANJUNG-MERCHANT`, `LUMI-MERCHANT`) | `projects/merchant-portal/` | http://localhost:4201 |

They share the sign-in screens, 2FA, design, API services and the simulated backend (in `src/app`,
which the merchant app imports as `@gp/...`). Each app only lets in its own kind of user: a merchant
account at the Global Platform, or an internal account at the Merchant Portal, gets "Use the other
portal" after the password check. The server enforces this too.

## Run locally

```bash
npm install
npm start                  # Global Platform  → http://localhost:4200
npm run start:merchant     # Merchant Portal  → http://localhost:4201 (run in a second terminal)
npm test                   # unit tests (auth, 2FA, merchant onboarding, merchant portal)
npm run build              # Global Platform production build → dist/global-platform/browser
npm run build:merchant     # Merchant Portal production build → dist/merchant-portal/browser
```

### Running in GitHub Codespaces

1. Terminal 1: `npm start`. Terminal 2 (the **+** in the terminal panel): `npm run start:merchant`.
2. Open the **Ports** tab: click the globe icon next to **4200** for the Global Platform and next to
   **4201** for the Merchant Portal.

The dev servers already allow `*.app.github.dev` addresses (see `allowedHosts` in `angular.json`).
If you see a "page can't be found" or "Blocked request" page, pull the latest `main` and restart.

**Sample data is separate per app.** The simulated backend keeps its data in the browser, and the
browser keeps data separate for each address. So the two apps don't share demo data: a change made
in the Global Platform (for example switching a payment method on) doesn't show in the Merchant
Portal. Each app starts from the same demo data. Once Mobi's real backend is connected, both apps
read the same server and this goes away.

## Demo accounts

All test users share the password **`Mobi@123`**. The login screen also lists
them under "Use a test account". **Testers: start with [`docs/testing-guide.md`](docs/testing-guide.md)**,
which explains each login's team and walks through registration → Risk → CS → pricing change → FinOps.

Each internal login belongs to **one fixed team**, like real staff. The sidebar shows the team as a
fixed label. Only `MOBI-ADMIN` has the **View as** switcher, to review every team's screens from one login.

| Global Account ID     | Scenario                                              |
| --------------------- | ----------------------------------------------------- |
| `123`                 | **Sales / Operations** · Tanjung Global Trading (GA-1001): Malaysia, Indonesia and Vietnam active · **MFA not set up yet** |
| `MOBI-RISK`           | **Risk** · MFA on                                     |
| `MOBI-CS`             | **Customer Success** · MFA on                         |
| `TANJUNG-ADMIN`       | **FinOps** (second administrator on GA-1001) · MFA on |
| `MOBI-SUPPORT`        | **Mobi Support** (User security only) · MFA on        |
| `MOBI-SECURITY`       | **Security Admin (Tech)** (User security only) · MFA on |
| `MOBI-ADMIN`          | **Prototype admin**: can switch teams with "View as" · MFA on |
| `TANJUNG-VIEWER`      | Viewer on GA-1001 · **2FA on**                        |
| `LUMI-ADMIN`          | Active account with no active countries (GA-4004) · **2FA not set up yet** |
| `TANJUNG-RAVI`        | Individual user disabled                              |
| `SERIMUTIARA-ADMIN`   | Account suspended (GA-2002)                           |
| `NUSAPANGAN-ADMIN`    | Account inactive (GA-3003)                            |
| `TANJUNG-KEVIN`       | Sign-in service unavailable                           |
| `TANJUNG-MERCHANT`    | **Merchant user** of Tanjung Global Trading (GM-100101): Merchant Portal only · 2FA not set up yet |
| `NUSANTARA-MERCHANT`  | **Merchant user** of Nusantara Home Retail (GM-109001, GA-1005): live in Malaysia and Indonesia, sample transactions and MYR / IDR balances · 2FA on |
| `LUMI-MERCHANT`       | **Merchant user** of Lumi Home Living (GM-100102, no live countries yet) · 2FA on |

Registered emails for password recovery follow the user, e.g. `sarah.lim@tanjungtrading.example`
(user `123`), `aisyah@tanjungtrading.example`, `budi@tanjungtrading.example`, `lan@lumihome.example`.
`farid@tanjungtrading.example` simulates an email delivery failure. OTP codes appear on
screen in an **Email preview** card instead of being emailed.

### Merchant Portal (Batch 4)

Open the **Merchant Portal app** (http://localhost:4201 locally) and sign in as `TANJUNG-MERCHANT`
(after 2FA). There are three screens:
- **Dashboard:** available balance (one figure per currency the merchant trades in, never converted),
  and total, successful and failed transaction counts for Today, Last 7 days or Last 30 days.
- **My Transactions:** **PayIn | Payout** tabs and payment type chips; date and time, invoice ID,
  transaction ID, sub-merchant (when the merchant has live ones), payment method, amount, **Fee**,
  **Net amount** (payouts: Total debited), currency and status (Pending, Processing, Successful,
  Failed, Expired). Filters: search (Transaction ID or Invoice ID), date range, country, sub-merchant,
  payment method, status; a summary of gross volume, fees and net per currency. A row opens the
  details in a side sheet (fees, customer, bank reference, settlement, IPN, timeline).
  **Export CSV** downloads every record matching the filters, as
  `<merchant-name>-<flow>-transactions-YYYY-MM-DD.csv`.
- **Pricing & settings** (read only): for each live country, the pricing in effect per product, any
  approved change that starts later, the settlement cycle, the IPN callback URL, limits and the MID.
  `NUSANTARA-MERCHANT` shows the most data.

Merchant users never see internal modules, the View as switcher, filters or staff notifications. Every
internal API refuses them, and the merchant API refuses internal users. A merchant's data always comes from
its session, never from the request. **There is no transaction or balance service yet:** the figures are
generated sample data for the merchant's live countries and switched-on payment methods, marked
*Sample data · not live*. They are the same records the Global Platform's Transactions page shows. See [`docs/merchant-portal-batch-4.md`](docs/merchant-portal-batch-4.md) for the
API contracts the real backend needs to provide.

### MFA (Batch 3)

> Named **MFA** everywhere users see it (previously "two-factor authentication" / "2FA"). The sign-in
> step's URL is `/mfa`. Messages are kept short on purpose: they tell the user what to do next, never
> why an account is restricted or how lockouts work. The **"Use a test account"** list on the login
> page shows each account's registered email, and the Forgot password page has **"Use a test email"**,
> so the OTP can be tested (it appears in the Email preview). Unregistered emails get the same screen
> but no code, by design.


Every sign-in needs a password **and** a 6-digit code from an authenticator app. A correct
password alone never creates a session.

- **First sign-in (e.g. `123`):** mandatory setup that can't be skipped. You scan a QR code or type
  the setup key, then enter a code from the app. That turns 2FA on and signs you in.
- **Later sign-ins (e.g. `TANJUNG-ADMIN`):** enter the current code. There's no "trusted device";
  *Remember this device* only remembers the Global Account ID.
- **Getting codes:** scan the QR code with Google Authenticator, Microsoft Authenticator or any
  standard (RFC 6238) app. Or use the on-screen **Demo authenticator** card (dashed pink,
  labelled *Prototype*), which shows the live code for whatever the screen is waiting for. Each
  code works once, so after using one, wait for the next.
- **Lost phone:** there are **no recovery codes**. "Lost your device?" tells the user to contact
  Mobi Support: Support opens a reset request, a Security Admin verifies identity and resets 2FA,
  and the user sets up a new authenticator at their next sign-in.
- **Blocked:** more than 3 consecutive wrong codes block that user (only that user) and raise a
  Tech alert, shown in User security and emailed to `tech-alerts@mobi.xyz` (simulated in this
  prototype). The block stays until a Security Admin waives it.
- **Account security** (sidebar user menu → Account security): replace your authenticator
  (verify the current one, then the new one). This sends a confirmation email to the Email preview.
- **User security** (sign in as `MOBI-SUPPORT` or `MOBI-SECURITY`): users' 2FA status, reset
  requests, Tech alerts and the audit log. Support opens a reset request for a lost device. Security
  Admin verifies identity and resets, or waives a block. Every admin action needs a reason, and
  admins first confirm it's them with their own authenticator code. Admins never see authenticator
  secrets. Support and Security Admin have no merchant pages.
- **Rollout:** the first load of this build keeps all existing data but ends every session, so
  everyone signs in again with 2FA (FR-09).

`mobiDemo.clearAuthenticator('TANJUNG-ADMIN')` forgets a user's authenticator so setup can be
tested again. See [`docs/mfa-batch-3.md`](docs/mfa-batch-3.md) for the full review document.

### Merchant onboarding (Batch 2)

Sign in as `123` (Sales / Operations), then open **Merchants** in the sidebar. Sign in as
`MOBI-RISK` or `MOBI-CS` for the Risk and Customer Success steps, or use `MOBI-ADMIN` with
**View as** to switch teams from one login. Teams are fixed per login, in the screens and in the
simulated backend.

**Validation modes.** By default the app runs in *guided* mode:
- Fields validate and show errors as they would in production, but missing input never
  blocks a step.
- Submitting with gaps asks for confirmation.
- Risk decisions without a reason get a default reason.
- Moving a CS step forward completes any open checklist items.

Run `mobiDemo.strictValidation(true)` in the browser console, then reload, to apply the full
production rules. Run `mobiDemo.strictValidation(false)` to go back to guided mode.
Use guided mode for demos and walkthroughs. Use strict mode for formal acceptance testing
against the original brief (acceptance criterion 7).

**Merchant and sub-merchant suspension** ([`docs/merchant-suspension.md`](docs/merchant-suspension.md)).
Merchant page → **Suspend** opens a side sheet:
- **Type:** Suspected fraud, Confirmed fraud, Compliance / KYC, Commercial or Merchant request.
- **Scope:** the whole merchant (all countries and sub-merchants), one country, or one sub-merchant.
- **Payment controls:** block new pay-ins, block payouts, hold settlement, block refunds.
- **Case:** case reference, how it was detected, reason, and linked transactions flagged *Under investigation*.
- An authenticator code confirms it.

Who can do what:
- Fraud is Risk only, takes effect at once, and a second Risk person reviews it in **Approvals** within 24 hours.
- Reactivating a fraud suspension also needs a second Risk person.
- Held settlement is released only by FinOps (Approvals → Settlement release).
- Sales / Ops can suspend for commercial reasons or at the merchant's request.

While suspended:
- New pay-ins and payouts fail at Mobi with "Merchant suspended", and successful pay-ins show "Settlement on hold".
- The merchant gets a neutral "Your account is under review" message. Under fraud or compliance, its Merchant Portal is read only.
- For a whole-merchant suspension, new country applications, go-live and new sub-merchants are refused (`MERCHANT_SUSPENDED`). Existing applications continue their review.

**Country applications (registration).** Registration is open for the launched countries
**Malaysia, Indonesia and Vietnam**. India, the Philippines and the UAE are shown as **Planned**
(disabled) in the country picker; Thailand was removed. Step 1 (the Global Merchant ID) is
unchanged. The guided form has six sections:
- **Business information:** Approval priority (Urgent / High / Medium / Low, default Medium; it
  orders the Risk queue), Merchant trading name, Business name (from the profile), the country's
  registration number (MY SSM, ID NIB, VN ERC), Date of incorporation, Company type, Tax
  registration (MY TIN + optional SST, ID NPWP, VN Tax Code), Website URL, Nature of business, MCC
  and Registered address.
- **Contact information:** Phone (country code preset), Email, Current address ("Same as registered
  address") and 1 to 4 Settlement emails.
- **Bank details:** per country (MY SWIFT / BIC optional, ID Bank code / SWIFT optional, VN Bank
  branch required + SWIFT optional).
- **Transaction settings:** Daily transaction limit and Minimum transaction value (local currency),
  Merchant category (Enterprise / SME / Micro), Merchant connection type, IPN callback URL (https,
  required before go-live: CS can set it during readiness) and "Send payment receipts to customers".
- **Directors:** name, contact number, nationality, ID / passport (MY NRIC, ID KTP, VN CCCD) and an
  optional website / LinkedIn.
- **Documents:** one file per document type.

**Preview** shows everything by section with Edit links and highlights what's missing; submitting
asks "Confirmation – You're about to register this merchant. Please confirm to proceed." (No /
Confirm & Register). Products, pricing and settlement are set in Product & Payment Config, not in
registration. Browsers holding the earlier demo data get the new demo data once on load; the old
data is kept under `mobi.gp.merchantdb.backup.v2`.

**Dashboard and Applications.** The Operations Dashboard shows transaction KPIs (Total
transactions, Successful, Failed, Success rate, Volume) as "—" with "No transaction data yet".
The onboarding figures moved to the **Applications** page: a summary strip (Drafts, Pending review,
Returned, In readiness, Operational) and "Needs attention", ordered by approval priority.

**Country rules.** Each country's onboarding rules (availability, business types, registration and
tax ID rules, bank fields, documents and director/owner rules) are backend configuration. There is
no screen for them: when a country is added or changed in the backend, the registration form follows
it. New and draft applications use the current rules; a submitted application keeps a snapshot of
the rules it was submitted under. In the prototype the rules are stored under `mobi.gp.countryconfig`.

**IPN callback URL.** A technical setting, not a Risk change: Customer Success or Sales / Operations
set it during readiness and can change it directly after go-live (Go-live panel). Every change is
recorded in the application history. Transaction change requests to Risk never change it.

**Merchant identity and live MIDs.** A GMID (`GM-…`) is the merchant shared by a parent and its
sub-merchants; the Global Account (`GA-…`) is the separate portal login; internal merchant entities
(`ME-…`) are never shown. Each region (for now one per country) gets at most one live MID per
entity, issued only when CS confirms go-live. MIDs are opaque (`MID-000000001`): region and country
are stored on the record, never read from the string. Go-live is safe to retry: repeating a
completed go-live returns the same result, and a go-live interrupted after the Global Account was
activated finishes on retry without a second account or MID. Sub-merchants exist only in the data
model and its rules so far; there is no screen to create them yet.

**Merchant category codes (MCC).** The MCC belongs to the parent merchant (GMID) and is shared by
its sub-merchants. Codes come from one catalogue with per-country availability: *available*, or
*restricted* (can be chosen but is flagged for Risk review); codes not listed for a country can't be
used there. Until an approved catalogue is supplied, the app uses a **standard MCC shortlist
(ISO 18245)** grouped by nature of business, as payment providers present it (`mcc-standard.ts`).
Codes providers usually treat as high risk (gambling, money transfer, quasi-cash, etc.) are
*restricted*; this follows provider practice and is not an approved Mobi Risk rule. Sales /
Operations search and choose the MCC in the country application (codes for the selected nature of
business are listed first), and it's required at submission.
Before the merchant's first Risk approval the MCC can be changed directly; after that, changes go
through a request that Risk approves or rejects, and the MCC changes only on approval. Every change,
request and decision is recorded with the old and new MCC, reason, requester, approver, times and
outcome (merchant page → MCC history). Suspended merchants can still request MCC changes.
To try it, load the clearly labelled test fixture: `mobiDemo.loadMccTestFixture()`, then reload.
Its entries are test data, not approved Mobi, scheme or regulatory rules.

**Product & Payment Config (Pricing Engine).** Stage 4 of onboarding, built from the Pricing Engine
document §8 (Part B). Two steps on one screen:
1. **Products:** the corridor catalog (MY: FPX, DuitNow QR, Touch 'n Go, GrabPay, Cards; ID: Virtual
   Account, QRIS, DANA, OVO; VN: VietQR, MoMo, ZaloPay, Bank Transfer; every corridor: Bank Transfer
   payout). Drafts until saved; a settlement cycle (T+0 to T+5) per saved PayIn product, which never
   creates a pricing version.
2. **Pricing**, versioned per MID + flow + payment method (+ VA banks for Indonesia VA): Percentage
   (minimum fee applied as a floor), Fixed Fee (local or USD at the prototype's static rates),
   Percentage + Fixed, Higher of, Volume-Based (one tier for the whole transaction, month-to-date
   volume) and Historical Volume (default MDR when there's no history), or subscription only.
   Secondary charges: a monthly subscription (charged on the 1st for the previous month) and
   unconditional or conditional promotions (after the condition is met; highest threshold wins).
   Effective dates follow the document's overlap and supersession rules; a simulated daily job moves
   scheduled → active → expired whenever data loads. MDR is capped at 10%, with a warning above each
   method's usual maximum. Fees round half up to the currency's smallest unit; no tax.

**Modes** are derived from the MID's state: *onboarding* (CS; pricing applies when saved), *change*
after "Confirm onboarding" (Sales / Ops submit, FinOps approves in the **Approvals** inbox), and
*read only* before CS review or while the merchant is suspended. Editing keeps the scope and the
pricing method and creates v+1. **Maker ≠ checker:** the person who submitted a change can't decide
it, so test approvals with two logins (e.g. submit as `123`, approve as `TANJUNG-ADMIN`, the FinOps
login). Each decision asks for a current code from the approver's authenticator. **"Confirm
onboarding"** replaces "Issue production keys" (it also issues them) and is blocked until a product
is on, every product has pricing in effect and every PayIn product has a settlement cycle. Every
pricing create, approval, rejection and cancellation is in the audit log (Merchant Pricing → History → Audit log) and the application
history.

**Merchant Pricing (Pricing Engine Part A).** Sidebar → **Merchant Pricing**, scoped to a corridor
(MY, ID or VN; it follows the header's country filter). It works on the same pricing as Product &
Payment Config, for MIDs whose onboarding is confirmed:
- **Merchants** (§7.1): search, Flow and Status filters, active / total rules, MDR range, pagination.
  Ops (Sales / Operations) get *Edit Pricing* and *Configure*; FinOps and others *View Pricing*.
- **Merchant detail** (§7.2): Active, Scheduled and Pending rules for the **Master Merchant** and
  per sub-merchant, version history and deactivated payment methods. Each row has one **View**: the
  details open in a side sheet with *What changes*, an activity timeline, and Edit Pricing, Cancel
  Rule or Deactivate. The editor opens in a side sheet with an optional **sub-merchant** scope.
- **Sub-merchants** (§7.3): the pricing that applies to each sub-merchant and payment method – its
  own rule, otherwise *Inherited from Master Merchant* (§7.9). Ops can deactivate or reactivate a
  method for one sub-merchant here.
- **History**: *Versions* (§7.11, every rule with its version) and *Audit log* (§7.10: who did what;
  filters for merchant, period and person; CSV export). Long lists are paginated (25 rows by default).
- Pricing changes are approved in the one **Approvals** inbox (sidebar), in a side sheet with an MFA code
  (§7.8, maker ≠ checker). Merchant Pricing shows "N waiting for FinOps" linking there.
Demo: Nusantara Home Retail (Malaysia) has two sub-merchants; the Online Store has its own Cards
rule and the Penang Outlet inherits the Master Merchant's. See
[`docs/pricing-engine-part-c.md`](docs/pricing-engine-part-c.md) for this batch.

**Pricing Part C.** Added after the gap review (details in `docs/pricing-engine-part-c.md`):
- **More payment methods (§3.1):** Malaysia: Boost, ShopeePay, EzyCash - COTC and e-wallet payouts
  (Boost, Touch 'n Go, GrabPay, ShopeePay). Indonesia: LinkAja, Shopee and e-wallet payouts (OVO, DANA,
  LinkAja, ShopeePay). E-wallets are grouped. Live demo MIDs pay out by Bank Transfer and one e-wallet.
- **Deactivate a payment method** (Ops, after onboarding, with an MFA code): for the whole MID or one
  sub-merchant, **immediately** or **from a date**. Pricing ends the day before (today when immediate);
  later or pending pricing is cancelled; FinOps is alerted in-app and by (simulated) email. A
  scheduled stop can be cancelled; a sub-merchant can be reactivated and inherits again.
- **MFA code** for settlement saves, USD fixed fees and deactivations; one code lasts 5 minutes.
- **Unusual-change alerts** to FinOps (in-app and simulated email, warning only): 5+ pricing changes
  for a merchant within an hour, 20+ by one person in a day, pricing set to 0, or a drop of 30%+.
- **Side sheets** for pricing, change requests and User security (registration and readiness stay
  full pages). Dates show as "12 Nov 2026"; % and currency sit inside fields.
Not built: settlement cycles per sub-merchant (MID only, by decision), Slack alerts (pipeline), host
management.

**Transactions (Transaction Management phase 1).** Sidebar → **Transactions** (under Dashboard) for
Sales / Ops, Risk, CS, FinOps and Mobi Support; Security Admin has no access. Built from
[`docs/transaction-management-phase-1.md`](docs/transaction-management-phase-1.md):
- **PayIn | Payout** tabs (separate APIs and tables) and **Payment type** chips (Online Banking,
  E-Wallets, QR, Cards, Virtual Account, Over the Counter, Bank Transfer; payouts: Bank Transfer,
  E-Wallet). A chosen type adds its own columns.
- Search by exact Transaction ID or Invoice ID (ignores other filters), date range (default Last 24
  hours), country, merchant, sub-merchant, payment method, **Provider**, status, and More filters
  (currency, amount, flags). Filters stay in the URL. Summary per status and currency; Export CSV.
- Details in a side sheet: the **payment path** (Customer → Merchant → Mobi → Provider → Bank) and the
  same sections, plus Timeline, IPN, Notes and Audit tabs. **Flag for investigation** / Clear flag and
  **Add note**. Fees only for Sales / Ops, CS and FinOps; IP address and device only for Risk and Mobi
  Support; customer email and phone masked for staff.
- Records are **sample data** generated from each live MID's real setup (switched-on products, live
  sub-merchants, pricing in effect), so fees follow Merchant Pricing. Recent ones move from Pending to
  their outcome as time passes. Requery, refunds and payout retry come later.

**Changes after Risk approval.** Once Risk has approved a merchant, anything Risk reviewed changes
only through a change request that Risk approves: the legal identity (merchant page → "Request
identity change") and, per country, business details, bank / settlement account, transaction settings,
directors and documents (application page → "Changes after approval"). Sales / Operations
request and can withdraw their own requests (transaction settings too); Risk approves (the change is applied at once) or
rejects with a reason (nothing changes). Contact details stay directly editable. Every edit,
request and decision is recorded (merchant page → Profile history, and the application history),
with the old and new values; bank account numbers are always masked and are never shown in full
in the request form (leave the field blank to keep the current number). The application's
submitted profile and rules snapshot keep what Risk originally reviewed. Before the first Risk
approval, profile edits stay direct and are recorded too.

**Sub-merchants.** Lightweight child records under a parent merchant (merchant page → Sub-merchants).
Each has exactly one parent and shares its GMID and MCC; it can trade under the parent or be a
separate legal entity (legal name and registration number, checked with the country's format). It
collects no documents, directors, bank details or keys: the parent's products, pricing and
settlement account in that country apply. Sales / Operations create them in countries where the
parent has applied and Country configuration allows it ("Sub-merchant creation"; parent-created
sub-merchants need a merchant-facing portal, which doesn't exist yet). Risk approves or rejects each
one; Customer Success completes two go-live checks and takes it live with its own MID, only when the
parent is live in that country and neither is suspended. Suspending a parent blocks new
sub-merchants and their go-live but doesn't suspend them; a sub-merchant's suspension affects only
itself. Every step is recorded on the sub-merchant.

**Approvals.** One page lists what is waiting for the acting team: Risk sees profile, country and
MCC change requests and new sub-merchants; FinOps sees pricing changes; Sales / Operations see their own requests; CS
sees everything, read only. Each item links to the page where the decision is made. Approval is
checked by team, and each login has a fixed team. `MOBI-ADMIN` can switch teams, so it could approve
its own request; use team logins for approval tests. Pricing approvals also check maker ≠ checker by
person.

**Data upgrade.** The first request with this build upgrades existing merchant data in place
(schema revision 3, still `version: 2`): it copies the original to `mobi.gp.merchantdb.backup.r2`
first, adds entities, regions and MIDs, and changes nothing else. Operational countries get an MID
only if their history records the go-live; the MID shows "Assigned during data upgrade". Records
that can't be upgraded safely are flagged, not changed. Auth and session data are never touched.
Data that can't be read, or that has another version, is left as it is and is no longer reseeded.

**What isn't real in this build.** Everything runs in the browser, with no external services:
- Verification results are generated from the application data.
- Production key-set references are generated locally; no credentials are created.
- No emails are sent. Notifications record the intended recipients, and OTP codes appear
  in an on-screen **Email preview**.
- Uploaded documents keep only their file name and size.
- Company names, people and domains (`*.example`) are fictional.

### QA hooks (browser console)

```js
mobiDemo.suspendAccount('GA-1001')   // revokes all sessions of that account
mobiDemo.reactivateAccount('GA-1001')
mobiDemo.disableUser('123')          // revokes only that user's sessions
mobiDemo.enableUser('123')
mobiDemo.expireSessions()            // simulate 30-minute idle timeout
mobiDemo.clearAuthenticator('123')   // forget a user's authenticator so 2FA setup can be tested again
mobiDemo.audit()                     // print audit events
mobiDemo.transactionAudit()          // print the transactions audit log (views, exports, notes, flags)
mobiDemo.reset()                     // restore all demo data (auth, merchants, country configuration, transaction notes and flags)
mobiDemo.resetMerchants()            // restore only the merchant data
mobiDemo.resetCountryConfig()        // restore the default country configuration
mobiDemo.merchantDataReport()        // upgrade status, backup, and records flagged for review
mobiDemo.restoreMerchantBackup()     // put back the pre-upgrade copy (keeps a copy of current data)
mobiDemo.loadMccTestFixture()        // load the labelled TEST FIXTURE MCC catalogue (not approved data)
mobiDemo.loadMccCatalogue(entries, { name, version })   // load a supplied catalogue (validated first)
mobiDemo.clearMccCatalogue()         // remove the catalogue; assigned merchant MCCs are kept
mobiDemo.strictValidation(true)      // full production validation (reload after)
```

## Deploy to Vercel (two projects, two URLs)

Both apps deploy from this one repository, as **two Vercel projects**. `vercel.json` runs
`npm run vercel-build`, which builds the app named by the `PORTAL` environment variable and puts
it in `dist/vercel`.

| Vercel project | Environment variable | Result |
| --- | --- | --- |
| Global Platform (your existing project) | none needed (or `PORTAL` = `internal`) | internal portal, unchanged |
| Merchant Portal (new project) | `PORTAL` = `merchant` | Mobi Merchant Portal |

To create the Merchant Portal project:
1. In Vercel: **Add New → Project → Import** this same repository.
2. Give it a name, e.g. `mobi-merchant-portal`.
3. Open **Environment Variables**, add `PORTAL` with value `merchant` (all environments), then **Deploy**.
4. Optional: **Settings → Domains** to add a custom domain, e.g. `merchant.mobi.xyz`.

Every push to `main` redeploys the Global Platform. **Merchant Portal production deploys are on hold**
(since 12 Nov 2026, because its link has been shared): `vercel.json` skips them and
`scripts/vercel-build.mjs` stops any that start, so the live Merchant Portal stays as it is. Branch
previews still build. To release, remove the hold, or set `MERCHANT_RELEASE` = `true` on the Merchant
Portal project and redeploy. If you created the Merchant Portal project before
adding `PORTAL`, add it and choose **Redeploy**.

## Documentation

- [`docs/testing-guide.md`](docs/testing-guide.md): demo logins, teams and a step-by-step test walkthrough.
- [`docs/pricing-engine-part-c.md`](docs/pricing-engine-part-c.md): Master Merchant, §3.1 methods, deactivation, MFA re-authentication, unusual-change alerts and side sheets.
- [`docs/merchant-suspension.md`](docs/merchant-suspension.md): merchant, country and sub-merchant suspension – types, scope, payment controls, second review, reactivation, settlement release.
- [`docs/transaction-management-phase-1.md`](docs/transaction-management-phase-1.md): Transactions phase 1 – decisions, data model (Option A), screens, labels and API.
- [`docs/transaction-management-requirements.md`](docs/transaction-management-requirements.md): Transaction Management requirements (draft for review).
- [`docs/authentication-batch-1.md`](docs/authentication-batch-1.md): login workflows, rules, security controls, QA cases and open decisions.
- [`docs/merchant-onboarding-batch-2.md`](docs/merchant-onboarding-batch-2.md): merchant data model, workflows, statuses, demo data, QA cases, limitations and open questions.
- [`docs/merchant-portal-batch-4.md`](docs/merchant-portal-batch-4.md): Merchant Portal MVP screens, access rules, API contracts, tests and open questions.
- [`docs/mfa-batch-3.md`](docs/mfa-batch-3.md): two-factor authentication decisions, screens, rules, security controls, QA cases and open questions.
