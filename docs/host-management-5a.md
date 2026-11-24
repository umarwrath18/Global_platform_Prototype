# Host Management · Batch 5A (November 2026)

Technical payment-processing providers ("hosts") that Mobi connects to: register, configure,
monitor (simulated) and control them. Design approved on 24 Nov 2026. Routing Management, routing
priorities, fallback and Smart Routing are **not** part of this batch.

## Decisions
| Topic | Decision |
|---|---|
| Partner vs Host | A **Partner** is the commercial relationship; a **Host** is the technical provider. A host may link to one partner; a partner may have several hosts. This app had no Partner module, so a small read-only **sample partner list** is used only to pick an Associated Partner. No partner screens or pricing were built. |
| Pricing | Host Management holds technical setup and availability only. Commercial cost / MDR stays in pricing; nothing here changes pricing. |
| Markets and methods | The shared catalogue: Malaysia, Indonesia, Vietnam and each country's configured payment methods (no second list). India appears once it is added to the country configuration. |
| Who | New team **Tech Ops** (login `MOBI-TECHOPS`; the prototype admin can **View as** Tech Ops) manages hosts. Every other internal team can view. Merchant users have no access. |
| Navigation | Sidebar **Host Management** (replaces the "Hosts & Routing" placeholder; **Routing** stays Coming soon) with tabs **Hosts · Host Health · Activity Log**. Host details is its own page with five tabs. |
| Add / Edit | A four-step side sheet like the pricing editor: Basic information → Markets & capabilities → Integration → Review. **Save as Draft** keeps an unfinished host (name and code only). A saved host is never Active. |
| Integration Status | Not Configured (none) · Configuration Incomplete (required fields missing) · Configured (complete, not validated or changed since) · Testing (validated in Sandbox) · Verified (validated in Production) · Integration Error (last validation failed). |
| Operational Status | Disabled on creation · Active · Maintenance · **Attention Required** (derived: Active but the last check was Unreachable or the integration is no longer Verified). |
| Enable | Needs a Verified integration and at least one Available capability. Enabling makes the host eligible for routing later; no routing rules are created. |
| Disable / Maintenance | Disable: reason, tick-box confirmation. Maintenance: reason, optional expected end; ended with **Re-enable**. Nothing is rerouted automatically. |
| Authenticator code | Enable, Disable, Maintenance and Replace Credentials (5-minute window, as elsewhere). |
| Capabilities | One row per country + catalogue method; flow (PayIn / Payout) and currency follow the method and country (a provider doing both has two rows). Each is Available / Unavailable / Disabled on its own; disabling one never disables the host. |
| Credentials | Never entered or stored. Mobi assigns an opaque reference shown masked (`cred_••••7Q2K`); **Replace Credentials** generates a new one (simulated) and the configuration must be validated again. Anything that looks like a secret in a request is refused. |
| Validation | Simulated, no request to the provider: Configuration Valid · Configuration Incomplete (lists what's missing) · Validation Failed (e.g. production endpoint not https, or a test URL in Production). |
| Health | Simulated **Check Connection**: Healthy · Degraded · Unreachable; **Unknown** until checked or while the configuration is incomplete. Saving a configuration never makes a host Healthy. All health data is labelled simulated. |
| Activity log | Every create, edit, capability change, integration change, credential replacement, validation, status change and health check, with who, when and details. |
| Sample data | HARSYA, WINPAY, LINKQU, Public Bank, Saigon PayLink (fictional Vietnam provider) and CIMB Collect, all marked sample; none is a live integration. No transaction volumes, success rates or uptime are shown. |

## Data model (`src/app/core/hosts/hosts.ts`)
Host · HostCapability · HostIntegration · HostHealthCheck · HostActivity · Partner, linked by host
ID and stored apart (`mobi.gp.hostdb`). Integration status and operational status are derived from
the stored configuration, validation and last health check. Future Routing Management can read
`operationalStatus`, capabilities (country, method, flow, currency, availability) and health without
knowing provider APIs; provider-specific handling belongs to the integration adapter.

## API (simulated, `src/app/core/mock-server/host-server.ts`)
`GET /api/hosts` · `GET /api/hosts/health` · `GET /api/hosts/activity` · `GET /api/hosts/:id` ·
`POST /api/hosts` · `PUT /api/hosts/:id` · `POST /api/hosts/:id/capabilities` ·
`PUT /api/hosts/:id/capabilities/:capId` · `POST /api/hosts/:id/validate` ·
`POST /api/hosts/:id/health-check` · `POST /api/hosts/:id/credentials` (code) ·
`POST /api/hosts/:id/status` (`enable` / `disable` / `maintenance`, code).

## Deferred
- **5B / 5C:** Routing Management (priorities, fallback, Smart Routing), linking Transactions'
  "Provider" to hosts, real health monitoring, a real credential vault, maker-checker for
  production changes, and the Partner module (registration and partner MDR pricing).

## Tests
`src/app/core/mock-server/host-server.spec.ts` (11 tests): summary, permissions, add with
validation and duplicate code, draft, no secrets, capabilities, validation states, credential
replacement, enable / maintenance / re-enable / disable, simulated health checks, persistence.
