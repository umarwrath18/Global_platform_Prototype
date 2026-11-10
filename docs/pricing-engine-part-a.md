# Pricing Engine – Part A: Merchant Pricing (November 2026)

Built from "Build Prompt – Mobi Pricing Engine" §7, on the same pricing data as Part B.

## Decisions applied
| Topic | Decision |
|---|---|
| Data model | One shared pricing: Merchant Pricing is the cross-merchant view of the MID pricing versions. Merchant-level rules are the MID's pricing; sub-merchant rules are added as their own scope. One approval queue, one audit log. |
| Corridors and catalog | MY, ID, VN with the §3.3 catalog (the §3.1 extras can be added later). |
| Status filter | The app's merchant statuses: Onboarding, Active, Suspended, No active applications. |
| Pages | Approvals and the audit log are shared with Part B; MDR History is new. |
| Who | Ops = Sales / Operations (maker), FinOps (checker). Merchants appear once CS confirms onboarding. |
| Cancel | The shared MID rule: after onboarding only scheduled or pending pricing can be cancelled. |
| Sub-merchants | Priced after onboarding, for the merchant's own sub-merchants in the corridor, and only for products switched on at the MID (§8.9). Resolution: sub-merchant rule, else merchant-level, else none (§7.9). |

## Not built (later)
- §3.1 standalone catalog methods.
- Sub-merchant settlement cycles; a merchant-facing pricing view.
- Re-authentication for settlement and USD fee changes; unusual-change alerts.
