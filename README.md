# Mobi Global Platform — Prototype

Angular 21 prototype of the Global Platform:

- **Batch 1:** Login & Authentication.
- **Batch 4:** Merchant Portal MVP for merchant users: Dashboard (available balance, transaction summary) and My Transactions (filters, CSV export).
- **Batch 3:** Two-factor authentication (Merchant Portal MFA, Phase 1: authenticator app / TOTP).
- **Batch 2:** Merchant Management & Onboarding (Global Merchants, country applications, country expansion, Risk review, simulated CS readiness and go-live, notifications).

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
them under "Use a test account".

| Global Account ID     | Scenario                                              |
| --------------------- | ----------------------------------------------------- |
| `123`                 | Administrator · Tanjung Global Trading (GA-1001): MY/ID/VN active (the Batch 1 account also lists TH pending, PH failed) · **2FA not set up yet** |
| `TANJUNG-ADMIN`       | Second administrator on the same account (GA-1001) · **2FA on** |
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
(after 2FA). There are only two screens:
- **Dashboard:** available balance (one figure per currency the merchant trades in, never converted),
  and total, successful and failed transaction counts for Today, Last 7 days or Last 30 days.
- **My Transactions:** invoice ID, transaction ID, payment method, date and time, amount, currency and
  status, with filters for date range (presets or custom), payment method, status and transaction ID.
  **Export CSV** downloads every record matching the filters, as
  `<merchant-name>-transactions-YYYY-MM-DD.csv`.

Merchant users never see internal modules, the View as switcher, filters or staff notifications. Every
internal API refuses them, and the merchant API refuses internal users. A merchant's data always comes from
its session, never from the request. **There is no transaction or balance service yet:** the figures are
generated sample data for the merchant's live countries and switched-on payment methods, marked
*Sample data · not live*. See [`docs/merchant-portal-batch-4.md`](docs/merchant-portal-batch-4.md) for the
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
  Tech alert. The block stays until a Security Admin waives it.
- **Account security** (sidebar user menu → Account security): replace your authenticator
  (verify the current one, then the new one). This sends a confirmation email to the Email preview.
- **User security** (View as → *Mobi Support* or *Security Admin*): users' 2FA status, reset
  requests, Tech alerts and the audit log. Support opens a reset request for a lost device. Security
  Admin verifies identity and resets, or waives a block. Every admin action needs a reason, and
  admins first confirm it's them with their own authenticator code. Admins never see authenticator
  secrets. Support and Security Admin have no merchant pages.
- **Rollout:** the first load of this build keeps all existing data but ends every session, so
  everyone signs in again with 2FA (FR-09).

`mobiDemo.clearAuthenticator('TANJUNG-ADMIN')` forgets a user's authenticator so setup can be
tested again. See [`docs/mfa-batch-3.md`](docs/mfa-batch-3.md) for the full review document.

### Merchant onboarding (Batch 2)

Sign in as `123`, then open **Merchants** in the sidebar. Use **View as** in the sidebar to
switch between Sales / Operations, Risk and Customer Success. This control stands in for
real role permissions and exists only in this prototype.

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

**Merchant suspension.** Sales / Ops or Risk can suspend a merchant that has at least one
operational country; only Risk can reactivate it. While a merchant is suspended, the simulated
backend refuses new country applications and go-live (`MERCHANT_SUSPENDED`). Existing applications
continue their controlled review: Sales / Ops can edit and submit them, Risk can approve, return or
reject, and CS can work through readiness up to the go-live step. Suspension does not change the
linked Global Account or its portal logins.

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

**Country configuration (MVP feature 5).** Open **Countries** in the sidebar to see each country's
onboarding rules: availability, business types, registration and tax ID rules, bank fields,
documents and director/owner rules, with a change history. New and draft applications follow the
live rules; a submitted application keeps a snapshot of the rules it was submitted under.
Only **Sales / Operations** (chosen in "View as") can edit; Risk and CS see the page as view only.
Every change needs a reason and is recorded in the change history with the person and team.
Like the other team checks, this relies on the prototype's role switcher, not real permissions.
Data is stored separately under `mobi.gp.countryconfig`.

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

**Product & Payment Config.** The onboarding stage after Risk approval (formerly "CS configuration")
sets up what each country MID offers, in two steps:
1. **Products:** switch PayIn products on or off (the country's configured payment methods) and set
   a settlement cycle (T+0 to T+5) for each saved PayIn product. **No PayOut methods have been
   approved, so PayOut shows "No payout methods configured" and stays disabled.** Settlement is a
   product setting: saving it never creates or changes a pricing version and needs no approval.
2. **Pricing:** MDR % only (no fees, tiers or techniques), in versions with effective dates and
   statuses (pending approval, scheduled, active, superseded, rejected, cancelled). Unpriced
   switched-on products appear as "Not priced" rows with "Set pricing". The editor opens inline.

"Issue production keys" is the onboarding handoff. It stays blocked, in guided and strict mode,
until at least one product is on, every switched-on product has pricing in effect and every PayIn
product has a settlement cycle; the missing items are listed. During onboarding Customer Success
changes everything and it applies when saved. After the handoff, Sales / Operations change products
and settlement, and pricing changes wait for **FinOps** (a prototype-only "View as" option, not a
login), who approves or rejects them; a late approval takes effect when approved. A product with
active pricing can't be switched off after onboarding; switching off cancels pending or scheduled
pricing (during onboarding, after a confirmation, any pricing). Every save is recorded in the
application history. The registration form no longer collects products or MDR: until CS first
saves products, every product is off and there is no pricing; no settlement cycle is assumed.
There is no standalone pricing page or popup.
After onboarding, open Merchants → the card icon on a row, or a country's "Products & pricing" link.

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
checked by team only: in this prototype one login can switch teams in "View as" and approve its own
request. Production needs person-level separation of duties.

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
mobiDemo.reset()                     // restore all demo data (auth, merchants, country configuration)
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

Every push to `main` redeploys both projects. If you created the Merchant Portal project before
adding `PORTAL`, add it and choose **Redeploy**.

## Documentation

- [`docs/authentication-batch-1.md`](docs/authentication-batch-1.md): login workflows, rules, security controls, QA cases and open decisions.
- [`docs/merchant-onboarding-batch-2.md`](docs/merchant-onboarding-batch-2.md): merchant data model, workflows, statuses, demo data, QA cases, limitations and open questions.
- [`docs/merchant-portal-batch-4.md`](docs/merchant-portal-batch-4.md): Merchant Portal MVP screens, access rules, API contracts, tests and open questions.
- [`docs/mfa-batch-3.md`](docs/mfa-batch-3.md): two-factor authentication decisions, screens, rules, security controls, QA cases and open questions.
