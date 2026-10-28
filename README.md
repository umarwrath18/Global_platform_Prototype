# Mobi Global Platform — Prototype

Angular 21 prototype of the Global Platform:

- **Batch 1:** Login & Authentication.
- **Batch 2:** Merchant Management & Onboarding (Global Merchants, country applications, country expansion, Risk review, simulated CS readiness and go-live, notifications).

Other MVP modules are intentionally not built yet.

There is no real server or database. A simulated backend runs in the browser
(`src/app/core/mock-server/`) and stores its data in `localStorage`. It answers
`/api/*` calls through an HTTP interceptor and enforces every rule as a real
backend would, so it can later be replaced by Mobi's real API without changing the screens.
Batch 2 merchant data is kept separately under `mobi.gp.merchantdb`.

## Run locally

```bash
npm install
npm start          # http://localhost:4200
npm test           # unit tests for the auth and merchant onboarding rules
npm run build      # production build → dist/global-platform/browser
```

### Running in GitHub Codespaces

Run `npm start`, then open the **Ports** tab and click the globe icon next to port **4200**.
The dev server already allows `*.app.github.dev` addresses (see `allowedHosts` in
`angular.json`). If you see a "page can't be found" or "Blocked request" page, pull the
latest `main` and restart `npm start`.

## Demo accounts

All test users share the password **`Mobi@123`**. The login screen also lists
them under "Use a test account".

| Global Account ID     | Scenario                                              |
| --------------------- | ----------------------------------------------------- |
| `123`                 | Administrator · Tanjung Global Trading (GA-1001): MY/ID/VN active, TH pending, PH failed |
| `TANJUNG-ADMIN`       | Second administrator on the same account (GA-1001)    |
| `TANJUNG-VIEWER`      | Viewer on GA-1001                                     |
| `LUMI-ADMIN`          | Active account with no active countries (GA-4004)     |
| `TANJUNG-RAVI`        | Individual user disabled                              |
| `SERIMUTIARA-ADMIN`   | Account suspended (GA-2002)                           |
| `NUSAPANGAN-ADMIN`    | Account inactive (GA-3003)                            |
| `TANJUNG-KEVIN`       | Sign-in service unavailable                           |

Registered emails for password recovery follow the user, e.g. `sarah.lim@tanjungtrading.example`
(user `123`), `aisyah@tanjungtrading.example`, `budi@tanjungtrading.example`, `lan@lumihome.example`.
`farid@tanjungtrading.example` simulates an email delivery failure. OTP codes appear on
screen in an **Email preview** card instead of being emailed.

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
used there. **No approved catalogue has been supplied, so the catalogue is empty by default** and MCC
isn't required anywhere. Where a catalogue covers a country, Sales / Operations choose the MCC in the
country application (only codes available there are listed) and it's required at submission.
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
application history. Until products are first saved, they are shown from the Risk-approved
application: its MDRs become legacy pricing only where the history records the approval and the
MDR is in range; no settlement cycle is assumed. There is no standalone pricing page or popup.
After onboarding, open Merchants → the card icon on a row, or a country's "Products & pricing" link.

**Changes after Risk approval.** Once Risk has approved a merchant, anything Risk reviewed changes
only through a change request that Risk approves: the legal identity (merchant page → "Request
identity change") and, per country, business details, bank / settlement account, directors and
beneficial owners, and documents (application page → "Changes after approval"). Sales / Operations
request and can withdraw their own requests; Risk approves (the change is applied at once) or
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

## Deploy to Vercel

`vercel.json` is included. In Vercel: **Add New → Project → Import** this
repository → **Deploy**. No environment variables are needed.

## Documentation

- [`docs/authentication-batch-1.md`](docs/authentication-batch-1.md): login workflows, rules, security controls, QA cases and open decisions.
- [`docs/merchant-onboarding-batch-2.md`](docs/merchant-onboarding-batch-2.md): merchant data model, workflows, statuses, demo data, QA cases, limitations and open questions.
