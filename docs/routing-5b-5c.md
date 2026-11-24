# Routing · Batches 5B + 5C (November 2026)

Which host each payment goes to. Design approved 24 Nov 2026
(canvas "Routing (Batch 5B + 5C)"). Sidebar **Routing** (under Host Management), tabs
**Routes · Merchant overrides · Route checker · Performance · Activity Log**.

## Rules
| Topic | Decision |
|---|---|
| Default route | One per country + payment method. The list shows every combination with a host registered in Host Management ("Not set" until a route is saved). |
| Modes (5B) | **Priority**: ordered hosts, the first eligible one is used. **Percentage split**: whole-number shares adding up to 100 (at least two hosts). |
| Smart (5C) | Hosts ranked by **simulated** success rate and response time, weighted per route (default 70 % success / 30 % speed), skipping hosts below a minimum success rate (default 90 %). Score = weight × success rate + (1 − weight) × speed (1 at 0 ms, 0 at 3,000 ms or slower). |
| Eligible host | Status **Active** in Host Management and that payment method **Available**. Read live, so disabling a host or switching a method off changes routing at once. |
| Fallback (per route) | Priority: next eligible host. Split: the skipped host's share is re-divided in proportion. Smart: next in the ranking, or the best-ranked host when none meets the minimum. Off: the payment fails. |
| Merchant overrides (5B) | Pin a merchant or sub-merchant to one host for one country + method. Checked first (a sub-merchant's own override before its parent's). Option: fall back to the default route, or fail, when the pinned host isn't eligible. One override per merchant + country + method; reason required. |
| Route states | Routing · Fallback in use · Some payments fail (split, fallback off) · No eligible host · Not set. |
| Route checker | "Which host would this payment use?" for a merchant (optional), country and method; shows the host and every step of the decision. Nothing is sent to a provider. |
| Performance (5C) | Simulated success rate, average response and attempts per host + method, stable for 15 minutes, labelled Simulated everywhere. Hosts that are not Active have none. Not real data. |
| Who | Tech Ops (or the prototype admin viewing as Tech Ops) changes routes and overrides, each with an authenticator code (5-minute window). Every other internal team can view. Merchant users have no access. |
| Activity log | Route created / changed (before → after), override added / changed / removed, with who, when and reason. |

## Data and API (simulated)
`src/app/core/routing/routing.ts` (types and the routing engine), `src/app/core/mock-server/routing-server.ts`
(`mobi.gp.routingdb`). Hosts come from `HostServer.snapshot()`, live merchants from
`MerchantServer.transactionSources()`.

`GET /api/routing` · `GET /api/routing/performance` · `GET /api/routing/activity` ·
`POST /api/routing/check` · `PUT /api/routing/routes/:country/:method` (code) ·
`POST /api/routing/overrides` (code) · `PUT /api/routing/overrides/:id` (code) ·
`POST /api/routing/overrides/:id/remove` (code).

## Sample data
ID Virtual Account: Priority HARSYA → WINPAY → LINKQU · ID QRIS: Smart (HARSYA) · ID Bank Transfer
payout: Split WINPAY 70 / LINKQU 30 (LINKQU disabled, so 100 % to WINPAY) · MY FPX and Cards:
Public Bank · MY DuitNow QR: CIMB Collect (under maintenance: No eligible host). One override: the
first live Indonesian merchant with Virtual Account pinned to WINPAY.

## Not in this batch
Linking Transactions' "Provider" to the routed host, real performance data, amount- or
time-based rules, and maker-checker for routing changes.

## Tests
`src/app/core/mock-server/routing-server.spec.ts` (9 tests): states from Host Management, live
fallback, permissions and codes, route validation, split with and without fallback, overrides,
Smart ranking and simulated figures, the engine, unregistered hosts.
