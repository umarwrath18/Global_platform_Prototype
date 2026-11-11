# Pricing Engine – Part B: Product & Payment Config (November 2026)

Built from "Build Prompt – Mobi Pricing Engine", §2.2, §3.3, §4–6 and §8, with the decisions agreed
in this project.

## Decisions applied
| Topic | Decision |
|---|---|
| Corridors | MY, ID, VN (launched). Catalog per §3.3, including Bank Transfer payout. |
| Roles | "Ops" = Sales / Operations. CS in onboarding mode, Ops in change mode, FinOps decides. |
| Stages | "Pending CS review" = Product & Payment Config; "Confirm onboarding" replaces "Issue production keys" and also issues the keys. |
| Methods | All six, plus subscription-only pricing. |
| Percentage minimum fee | Applied as a floor. |
| Volume-Based | One tier for the whole transaction; volume = month-to-date. |
| Historical Volume | No previous-period data: the default MDR applies. |
| Conditional promotion | Applies to transactions after the condition is met; the highest matching threshold wins. |
| Subscription | Charged on the 1st for the previous month; the table shows the next charge. |
| MDR limit | Hard limit 10%; a warning above each method's usual maximum. |
| Rounding and tax | Half up to the currency's smallest unit (MYR 2 dp, IDR / VND 0 dp); no tax. |
| FX | Prototype static rates (USD-7). |
| Edit | Technique and scope locked; start defaults to tomorrow (or the version's future start). |
| Approvals | Maker ≠ checker (different login) and a current MFA code for every decision. |
| Daily job | Simulated on every data load. |
| Hosts | Not part of this batch (future host management). |

## Not built (later)
- Standalone Merchant Pricing engine (Part A): merchant list, sub-merchant view, MDR history page.
- Sub-merchant pricing for MIDs (§8.9), merchant-facing pricing view.
- Production FX rate handling (USD-5/6) and per-transaction fee records (no transactions exist yet).
- Re-authentication for settlement and USD fee changes (§9) and unusual-change alerts: built in Part C.
- Finance sign-off for settlement changes on live MIDs (§8.3 [DECIDE]): not required for now.
