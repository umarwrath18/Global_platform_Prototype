# Pricing Engine – Part C: gap-review follow-ups (November 2026)

Built from the gap review agreed after Parts A and B. The labels and messages from the Build
Prompt are kept; anything new is listed here with its exact wording.

## Decisions applied
| Topic | Decision |
|---|---|
| "Merchant Level" | Renamed **Master Merchant**, shown on every rule. Sub-merchants without their own rule show **Inherited from Master Merchant**. The sub-merchant picker's first option is "Master Merchant". |
| §3.1 catalog | Added to the Malaysia and Indonesia product lists (so CS / Ops can switch them on), grouped as **E-Wallets** (PayIn) and **E-Wallet** (PayOut). Vietnam unchanged. |
| Payout demo data | Live demo MIDs have Bank Transfer and one e-wallet payout (Touch 'n Go in MY, OVO in ID) switched on, Fixed Fee pricing. A flow with no products shows: "No Payout products are switched on. Switch on Bank Transfer or an e-wallet payout in Product & Payment Config." |
| Deactivation | Ops, after onboarding, with an MFA code. Scope: the whole MID (Master Merchant and all sub-merchants) or one sub-merchant. When: **Immediately** or **On a date**. No FinOps approval; FinOps is alerted in-app and by (simulated) email to `finops@mobi.xyz`. |
| Settlement per sub-merchant | Not built: settlement stays at MID level (sub-merchants settle into the parent's account). |
| MFA re-authentication | Settlement saves, USD Fixed Fee submissions and deactivations (and cancelling / reactivating) ask for a current code. One code is valid for 5 minutes in that session. |
| Unusual-change alerts (§9) | Warn FinOps in-app and by (simulated) email; never block. 5+ pricing submissions for one merchant within an hour; 20+ by one person in a day; pricing that charges nothing (MDR and fees 0); a drop of 30% or more against the pricing in effect for the same scope (same technique only). "High-volume" needs transaction data, so the drop rule applies to every merchant for now. |
| Side sheets | Pricing editor, pricing details, Select Pricing to Edit, pricing decisions in the Approvals inbox, deactivation, change requests (country and legal identity) and User security actions open in side sheets. Registration and readiness stay full pages. Confirmations (discard draft, reject reason, MFA code, cancel rule, switch product off) appear inside the sheet or card, not as browser dialogs. |

## Deactivation rules
- **Immediately:** pricing in scope that is active ends today and is expired; scheduled or pending pricing in scope is cancelled. Whole MID: the product switches off and its settlement cycle is removed.
- **On a date (from tomorrow):** pricing running past the date ends the day before; pricing starting on or after it, and pending pricing, is cancelled. The daily job applies the stop on the date.
- While a stop is scheduled, new pricing in that scope must end before it: "{method} stops {scope} from {date}. Set an end date up to {day before}, or cancel the deactivation first."
- One scheduled stop per scope: "{method} is already scheduled to stop {scope} from {date}. Cancel that first to change it."
- A sub-merchant with the method deactivated gets no pricing (it no longer inherits): "{method} is deactivated for {sub-merchant}. Reactivate it first."
- **Cancel** a scheduled stop: shortened pricing gets its end date back; cancelled pricing stays cancelled.
- **Reactivate** (sub-merchant only): it inherits the Master Merchant's pricing again. The whole MID comes back by switching the product on and pricing it.
- Messages: "Only Ops can deactivate payment methods." · "Payment methods can be deactivated once onboarding is confirmed. During onboarding, CS switches the product off." · "Choose a date from tomorrow." · "Enter a reason for the deactivation."

## Where to find it
- Merchant Pricing → merchant → **View** on an active rule → **Deactivate**; the **Deactivated payment methods** list has Cancel / Reactivate.
- Merchant Pricing → **Sub-merchants** → **Deactivate** / **Reactivate** per row (Ops).
- Product & Payment Config → Products: e-wallet groups; settlement save asks for the code.
- Notifications (FinOps): "Payment method deactivated" and "Unusual pricing change".

## Design system additions
`shared/side-sheet.ts` (detail 560 px, editor 640 px, full screen below 768 px; slides in from the
right; Esc and backdrop close; focus kept inside and returned), `shared/code-prompt.ts` (one 6-digit
field, inside the sheet), `shared/date-field.ts` (always "12 Nov 2026"). Units sit inside fields;
a currency with one option shows as text. The prototype's Demo authenticator moves to the left
while a sheet is open.

## Tests
`pricing-deactivation.spec.ts` (deactivation, re-authentication window, alerts), catalog and
grouping tests in `product-pricing.spec.ts` / `products.spec.ts`, and component tests for the inline
confirmations.

## Navigation and lists (UX review, 12 Nov 2026)
| Topic | Decision |
|---|---|
| Approvals | One **Approvals** inbox for every team: *Waiting for {team}* / *All open* / *Decided*, filters for type and country, 25 rows per page. Pricing is approved or rejected in a side sheet there (MFA code). The sidebar's *Pricing Approvals* and the Approvals tab in Merchant Pricing are gone; old links redirect (`/pricing-approvals` → `/approvals?type=pricing`). |
| Merchant Pricing | One header for its screens (title, corridor, tabs, "N waiting for FinOps"). Tabs: **Merchants · Sub-merchants · History**. The duplicate Sub-Merchant View button is gone. A merchant row opens the merchant; Edit Pricing and Configure are on that page. |
| History | *Versions* and *Audit log* in one tab (`/pricing-audit` → History → Audit log). The audit log has merchant, period (7 / 30 / 90 days / all) and person filters, CSV export of every matching entry, and shows each change as *old → new* with the effective period. |
| Versions | Kept (the spec requires them) but shown only where they matter: pricing details, History and the audit log. Rule tables group methods under **PayIn** and **PayOut** instead of repeating "PayIn · v1" on every row; a pending change says what it replaces. The merchant page links to its history instead of repeating a version table. |
| Long lists | Paginated with one shared pager (10 / 25 / 50, default 25), not endless scroll: audit entries are searched and cited, and the page keeps its place. |
| Text | Names, IDs, dates, amounts and statuses never wrap in tables; descriptions may take two lines; emails in detail grids are cut with "…" (full value on hover). |
| Cancel pricing (Product & Payment Config) | **Cancel** on a pricing row opens the **Pricing Detail** side sheet (what changes, details, activity) with the confirmation inside it: "Cancel {technique} pricing for {method}?", optional reason, **Keep it** / **Cancel Rule**, the same as Merchant Pricing. It no longer appears under the table. |
