# Merchant and sub-merchant suspension (November 2026)

How Mobi suspends a merchant, one of its countries, or one sub-merchant when it is flagged for
fraud, compliance or commercial reasons. Replaces the earlier one-step Suspend / Reactivate, which
only paused onboarding. Design reviewed on 13 Nov 2026; all recommendations agreed.

## Decisions
| Topic | Decision |
|---|---|
| Suspension type | Required: **Suspected fraud · Confirmed fraud · Compliance / KYC · Commercial (e.g. unpaid fees) · Merchant request**. The type sets the default payment controls and who may act. |
| Scope | **Whole merchant** (all countries and all sub-merchants) · **One country** (that MID and its sub-merchants) · **One sub-merchant**. A sub-merchant row's **Suspend** opens the same sheet with that sub-merchant pre-selected. |
| Cascade | A whole-merchant suspension covers its sub-merchants ("With the merchant"). Reactivating the merchant never reactivates a sub-merchant that has its own suspension. |
| Payment controls | **Block new pay-ins · Block payouts · Hold settlement · Block refunds**. Defaults: fraud types all on; Compliance / KYC and Merchant request block pay-ins and payouts; Commercial none (onboarding on hold only). Risk can change any switch. Transactions already in progress finish. |
| Who suspends | Risk: any type. Sales / Ops: Commercial and Merchant request only. |
| Second review | Fraud types take effect at once; a **second Risk person** reviews within **24 hours** in Approvals (*Confirm suspension* or *Lift suspension*). The person who raised it can't review it. |
| Reactivate | Risk only. Fraud: another Risk person approves it in Approvals. Other types: at once. Fields: **Outcome** (No fraud found · Resolved with the merchant · Suspended in error) and **Reason**. |
| Settlement release | Held settlement is released only by **FinOps** (Approvals → *Settlement release*: **Release settlement** or **Keep on hold** with a reason). Risk can untick *Release settlement* when reactivating and ask FinOps later. |
| MFA | Suspend, review, reactivate, approve and release each need a current authenticator code (the same 5-minute window as other sensitive actions). |
| Case | **Case reference** (required for fraud and compliance), **Detected by** (Transaction monitoring, Chargeback ratio, Scheme / bank alert, Law enforcement request, Internal review, Merchant request), **Reason** (internal only), and **Linked transactions** picked from Transactions flagged *Under investigation*. |
| Notifications | In-app and (simulated) email to Risk, Sales / Ops, CS and FinOps, and email to Mobi Support. The merchant gets a neutral message whenever a payment control is on: "**Your account is under review** – Some services are paused while we complete a routine review. Contact support@mobi.xyz if you have questions." It never mentions fraud or suspension. |
| Merchant Portal | Fraud and compliance: read only (no exports) with the same neutral banner; blocked transactions show "Payments are paused", held ones "Settlement paused". Ships when the Merchant Portal is released (its production deploy is on hold). |
| Transactions | New pay-ins / payouts in scope fail at Mobi with reason **Merchant suspended** (path: Mobi ✕). Successful pay-ins under a hold show **Settlement on hold**. New flag and filter **Merchant suspended**. |
| Not in scope | Terminate / offboarding (later topic). "Under review" watch state (the Transactions investigation flag covers it). |

## Screens
- **Merchant page → Suspend**: side sheet with type, scope, payment controls, case reference, detected
  by, reason, linked transactions, *What happens now*, the message to the merchant, then the
  authenticator code. Button: **Suspend merchant** / **Suspend country** / **Suspend sub-merchant**.
- **Merchant page while suspended**: a banner per suspension (type, since / by, case, scope, detected
  by, control chips, *Merchant Portal read only*, what's waiting) with **View case** and the step the
  login can take (**Review**, **Reactivate**, **Approve reactivation**, **Release settlement**).
  Countries show *Suspended – With the merchant / With the country*; sub-merchants show the same, or
  their own suspension with its actions. The lifecycle history shows each step with its details.
- **Approvals**: new types **Suspension review** and **Reactivation** (Risk) and **Settlement release**
  (FinOps). Each opens the merchant page with the step's side sheet.

## API (simulated)
- `POST /api/merchants/{gmid}/suspensions` — type, scope, country / subMerchantId, controls, caseRef, detectedBy, reason, linkedTransactions, code.
- `POST /api/suspensions/{id}/review` — decision confirm | lift, note, code (second Risk person).
- `POST /api/suspensions/{id}/reactivation` — outcome, reason, releaseSettlement, code.
- `POST /api/suspensions/{id}/reactivation/decision` — approve | reject, note, code (second Risk person).
- `POST /api/suspensions/{id}/settlement` — release | keep, note, code (FinOps).
- `POST /api/suspensions/{id}/settlement/request` — Risk asks FinOps to release settlement kept on hold.
- `GET /api/merchants/{gmid}` adds `suspensions` and `effects` (what each country MID and sub-merchant is under).
- The earlier `POST …/lifecycle` (merchant and sub-merchant) still works: it records a Commercial
  suspension with no payment controls (older screens and tests).

## Tests
`suspensions.spec.ts` (roles, MFA, case, scope, cascade, second review, maker ≠ checker, reactivation,
settlement release, transactions blocked, Merchant Portal read only, the earlier one-step calls).
