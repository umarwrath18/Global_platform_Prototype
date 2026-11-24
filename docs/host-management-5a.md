# Host Management · Batch 5A (November 2026, simplified 24 Nov 2026)

The payment providers ("hosts") Mobi connects to. Two jobs only: **register a provider** with the
countries and payment methods it handles, and **switch the host, or one of its methods, on and
off**. Routing Management, routing priorities, fallback and Smart Routing are **not** part of this
batch.

## Rework (24 Nov 2026)
Removed, on product decision: the **Associated Partner** link and sample partner list; the
**credential reference**, Replace Credentials and Validate Configuration; the two statuses
(Integration Status, Operational Status with Attention Required), replaced by one status; and all
**simulated health** (Host Health tab, Check Connection, health history, Last Health Check column).
Health monitoring comes back only when real provider data exists.

## Decisions
| Topic | Decision |
|---|---|
| Pricing | Host Management holds technical setup and availability only. Commercial cost / MDR stays in pricing. |
| Markets and methods | The shared catalogue: Malaysia, Indonesia, Vietnam and each country's configured payment methods (no second list). |
| Who | Team **Tech Ops** (login `MOBI-TECHOPS`; the prototype admin can **View as** Tech Ops) manages hosts. Every other internal team can view. Merchant users have no access. |
| Navigation | Sidebar **Host Management** with tabs **Hosts · Activity Log**. Host details has four tabs: **Overview · Payment Methods · Integration · Activity Log**. |
| Status | One status: **Draft · Active · Disabled · Maintenance**. Draft = saved incomplete. A saved host starts **Disabled**. |
| Setup checklist | Shown on the host (Overview) and as "n of 4 done" in the list: Basic information complete · At least one payment method Available · Integration details complete · Production endpoint set. |
| Enable | Only when all four checklist items are done. Enabling makes the host eligible for routing later; no routing rules are created. |
| Active host stays ready | An Active or Maintenance host can't be edited into a state that fails the checklist (e.g. switched to a Sandbox endpoint); disable it first. Switching off its last payment method is allowed and shows a warning banner. |
| Disable / Maintenance | Disable: reason, tick-box confirmation. Maintenance: reason, optional expected end; ended with **Re-enable**. Nothing is rerouted automatically. |
| Authenticator code | Enable, Disable and Maintenance (5-minute window, as elsewhere). |
| Payment methods | One row per country + catalogue method; flow and currency follow the method and country. Each is Available / Unavailable / Disabled and can be switched on (**Enable**) or off (**Disable**) on its own; this never changes the host's status. |
| Integration details | Kept: integration name, adapter, API base URL, API version, environment, authentication method with its non-secret fields (key header, signature, token URL, client ID, scope), timeout (5–120 s), connection configuration and notes. Checked on save: a valid URL; Production must be https and not a test URL. |
| Credentials | None are entered, shown or stored. Anything that looks like a secret or credential reference in a request is refused. |
| Descriptive fields | Kept: description, notes, internal owner / responsible team, country of registration. |
| Activity log | Every create, edit, payment-method change, integration change and status change, with who, when and details. |
| Sample data | HARSYA, WINPAY, LINKQU, Public Bank, Saigon PayLink (fictional) and CIMB Collect, all marked sample; none is a live integration. No volumes, success rates or health are shown. |

## Data model (`src/app/core/hosts/hosts.ts`)
Host · HostCapability · HostIntegration · HostActivity, linked by host ID and stored apart
(`mobi.gp.hostdb`, version 2: older data is replaced with the new sample data). `status` and the
`checklist` are worked out from the stored records. Future Routing Management can read `status` and
capabilities (country, method, flow, currency, availability) without knowing provider APIs.

## API (simulated, `src/app/core/mock-server/host-server.ts`)
`GET /api/hosts` · `GET /api/hosts/activity` · `GET /api/hosts/:id` · `POST /api/hosts` ·
`PUT /api/hosts/:id` · `POST /api/hosts/:id/capabilities` · `PUT /api/hosts/:id/capabilities/:capId` ·
`POST /api/hosts/:id/status` (`enable` / `disable` / `maintenance`, code).

## Deferred
- **Routing (5B / 5C) is built: see `routing-5b-5c.md`.** Still deferred: linking Transactions'
  "Provider" to hosts, real health monitoring, credential management in a real vault, maker-checker
  for production changes, and a Partner module.

## Tests
`src/app/core/mock-server/host-server.spec.ts` (10 tests): status and checklist, permissions, add
with validation and duplicate code, draft, no credentials, endpoint checks, payment methods on/off,
enable / maintenance / re-enable / disable, active host stays ready, persistence.
