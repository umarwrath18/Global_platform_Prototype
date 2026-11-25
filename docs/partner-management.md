# Partner Management (November 2026)

Replaces Host Management. A **partner** is a payment provider Mobi connects to (bank, gateway,
aggregator, e-wallet provider). One record holds who they are, what they process, how Mobi connects
to them, what they charge Mobi (**cost pricing**) and where they sit in **routing**. Screens reuse
the existing patterns: New merchant, the country application form, the merchant page and the
pricing editor.

## Journey
1. **New partner** (`/partners/new`, like New merchant): name, code, type, country of registration,
   operations email and phone, internal owner. Creates a **draft** with its ID (`PTR-VN-002`).
2. **Setup** (`/partners/:id/setup`, like the country application form): sections with their state
   and "n of 3 complete", Save / Save and continue, then Review → **Finish setup**.
   - Partner details (plus escalation contact, description, notes).
   - Payment methods per country, grouped by category (QR, Cards, Online banking, E-wallets,
     Over the counter, Payout) with select-all per category; from each country's catalogue.
   - Integration: adapter, environment, API base URL, authentication and its non-secret fields,
     timeout, callback/IP notes, partner portal username, and the **write-only credentials**.
   The same page edits an existing partner.
3. **Partner page** (`/partners/:id`, like the merchant page):
   - Payment methods & cost: each method's status (switch on / off), cost to Mobi (current, next,
     waiting for FinOps), routing position; Set / Change cost; FinOps **Review**; Withdraw.
   - Routing: position in each route (#2, 70 %, Smart rank), overrides pinned to the partner,
     skipped warnings; **Edit route** opens the same route sheet as the Routing page.
   - Integration with credentials, partner details, setup checklist, history.
   - Enable / Disable / Maintenance (authenticator code), as before.

## Rules
| Topic | Decision |
|---|---|
| Status | Draft · Active · Disabled · Maintenance. |
| Enable | Checklist complete: partner details, ≥1 method Available, integration complete, Production endpoint, and **cost pricing approved for every Available method**. An Active partner can't be edited into an incomplete state (cost pricing excepted, so new methods can be added). |
| Cost pricing | Uses the merchant pricing engine (same models, tiers, dates, versions, calculator, overlap rules), labelled COST. Scoped per partner + country + method; local currency; no sub-merchants, VA bank splits or secondary charges. Tech Ops submits; **FinOps approves or rejects** (a reason is required to reject; the submitter can't decide). The cost in effect stays until approval; a change starts on its date. Pending changes appear in the Approvals inbox as "Partner cost". |
| Credentials | API key / client secret, secret key, partner portal password: **write-only**. Entered once in a side sheet with an authenticator code; only the last 4 characters, who and when are kept and shown. Never returned or stored in the prototype. |
| Who | Tech Ops manages partners and submits cost pricing; FinOps decides cost pricing; everyone internal can view; merchants have no access. |
| Routing | Unchanged rules (see `routing-5b-5c.md`); eligible = partner Active and method Available. |

## Data and API (simulated, `src/app/core/mock-server/host-server.ts`, `mobi.gp.hostdb` v3)
`GET/POST /api/hosts` · `GET/PUT /api/hosts/:id` · capabilities · `POST /api/hosts/:id/status` (code) ·
`POST /api/hosts/:id/secrets` (code) · `POST /api/hosts/:id/cost-pricing` ·
`POST /api/hosts/:id/cost-pricing/:vid/decision` · `POST /api/hosts/:id/cost-pricing/:vid/cancel`.
(Internal names keep "host"; screens say "partner". `/hosts` URLs redirect to `/partners`.)

## Not yet
Margin reporting (merchant MDR − partner cost), a real credential vault, real health monitoring,
linking Transactions to the routed partner.

## Tests
`src/app/core/mock-server/host-server.spec.ts` (12 tests) and `routing-server.spec.ts` (9 tests).
