# User journeys: Global Platform, by team (November 2026)

Every admin feature in the Global Platform prototype, written as journeys per user. Use it to test
the prototype end to end and as the input for the PRD. Each journey gives the login, where to start,
the steps and what you should see.

## Before you start

- **Password:** every demo login uses **`Mobi@123`**.
- **Authenticator code:** after the password, enter the 6-digit code from the **Demo authenticator**
  card on screen (dashed pink, labelled *Prototype*). Each code works once; wait for the next one if
  you need another.
- **First sign-in for `123`:** you set up MFA first (scan or type the key, enter a code, save the two
  recovery codes). Other internal logins already have MFA on.
- **Sensitive actions** (pricing decisions, settlement changes, USD fees, deactivations, suspensions)
  ask for an authenticator code once; it isn't asked again for 5 minutes.
- **Two people at once:** use **two tabs in the same browser window**. Each tab keeps its own sign-in,
  and both share the demo data. A private window has its own separate data, so it won't see what the
  other window did.
- **Reset the demo:** run `mobiDemo.reset()` in the browser console.

## Who's who

| Login | Name | Team | In one line |
|---|---|---|---|
| `123` | Sarah Lim | Sales / Operations | Registers merchants and countries, requests changes, prices merchants after go-live, deactivates payment methods |
| `MOBI-RISK` | Daniel Tan | Risk | Reviews applications, change requests, sub-merchants and MCC changes; suspends and reactivates |
| `MOBI-CS` | Mei Ling Wong | Customer Success | Readiness: products, onboarding pricing, settlement, IPN, Confirm onboarding, go-live; sub-merchant go-live |
| `TANJUNG-ADMIN` | Aisyah Rahman | FinOps | Approves pricing changes, releases held settlement, gets pricing alerts |
| `MOBI-SUPPORT` | Priya Nair | Mobi Support | Opens MFA reset requests; looks up transactions |
| `MOBI-SECURITY` | Wei Jie Chen | Security Admin (Tech) | Verifies identity and resets MFA, waives sign-in blocks, handles Tech alerts |
| `MOBI-ADMIN` | Prototype Admin | Prototype only | Switches teams with **View as**; acts as a second Risk person |
| `TANJUNG-VIEWER` | Budi Santoso | Viewer (Sales / Ops) | Read-only checks |

Seeded merchants: **Tanjung Global Trading** (GM-100101, live in MY, ID, VN), **Nusantara Home Retail**
(GM-109001, live in MY and ID, with sub-merchants), **Saigon Journeys** (GM-100104, draft in VN).

---

## 1. Every user

### 1.1 Sign in
1. Open the Global Platform, enter the login and `Mobi@123`, then the code from the Demo authenticator.
2. You land on the **Dashboard**. The sidebar shows your team (only `MOBI-ADMIN` has **View as**).

Try also: **Forgot password?** (OTP shown in the on-screen Email preview), a wrong code more than 3
times (the login is blocked and Security gets a Tech alert), and **Use a recovery code instead**.

### 1.2 Account security
1. Avatar menu → **Account security**.
2. **Replace authenticator:** enter the current code, scan the new QR, enter the new app's code. The
   old one stops working.
3. **Regenerate recovery codes:** enter a code, save the two new codes, tick to finish.

### 1.3 Notifications
- The bell and **Notifications** list events for your team (submitted, returned, approved, go-live,
  pricing alerts, suspensions…). Emails are recorded as simulated, never sent.

---

## 2. Sales / Operations (`123`)

### 2.1 Register a new merchant
1. **Merchants** → **New merchant**. Enter legal name, registration country and number, contact.
2. **Create Global Merchant ID**: the GM ID is issued at once. Duplicates are blocked; near-matches warn.
3. Pick a country (Malaysia, Indonesia or Vietnam) to open a draft application.

### 2.2 Fill and submit a country application
1. **Applications** → the draft (or open it from the merchant page).
2. Complete Business information, Contact, Bank details, Transaction settings, Directors, Documents
   (PDF, JPG or PNG up to 10 MB, one per type). Prefilled fields show their source.
3. **Save draft** any time. **Preview** highlights anything missing.
4. **Submit** → confirm. Status: *Pending Risk review*. Risk is notified.

### 2.3 Correct a returned application
1. **Applications** → *To complete* → the returned application. Risk's reason and the sections
   to fix are shown.
2. Edit those sections and **Submit** again. Same application ID, submission count goes up.

### 2.4 Add a country to an existing merchant
1. **Merchants** → the merchant → **Add country** (or **Merchants** → expand flow).
2. Countries with an open application are disabled. The new draft is prefilled from the profile and
   the latest application; bank details and documents are never copied.

### 2.5 Edit the profile and request legal identity changes
1. Merchant page → Profile → **Edit**: contact details save straight away and are recorded.
2. After Risk approval, legal name and registration change only by request: **Request identity
   change** → side sheet → reason → **Send to Risk**.

### 2.6 Request an MCC change
1. Merchant page (merchant approved by Risk) → Profile → **Request MCC change**.
2. Side sheet: choose the **New MCC** (only codes available in every country are listed; restricted
   ones are marked), give a **Reason** → **Send to Risk**.
3. Profile shows the MCC with *Change requested* and the pending panel until Risk decides.

### 2.7 Request a change to country details after approval
1. Application page → **Changes after approval** → **Request a change**.
2. Choose Business details, Bank account, Transaction settings, Directors or **Documents** (upload the
   replacement file), give a reason → **Send to Risk**. You can **Withdraw** it while it waits.

### 2.8 Add a sub-merchant
1. Merchant page → **Add sub-merchant** (or Sub-merchants → **Add sub-merchant**).
2. Enter its details and country, save, then **Submit** it to Risk. It uses the parent's products,
   pricing and settlement and gets its own MID once live.

### 2.9 Change pricing after go-live (maker)
1. **Merchant Pricing** → pick the merchant (or Product & Payment Config on a live application).
2. **Edit Pricing** on a rule, or **Configure Primary Pricing** for a new one: Scope → Technique →
   Configure Rules → Summary (check the rate, tiers and **Test the pricing**) → Secondary Charges
   (subscription, promotion) → **Submit for Approval**.
3. Status *Pending FinOps approval*. A USD fixed fee asks for your code. A drop of 30% or more, or zero
   pricing, warns FinOps but still submits.
4. Cancel a pending or scheduled rule: **View** → **Cancel Rule** → reason.

### 2.10 Price a sub-merchant
1. **Merchant Pricing** → **Sub-merchants** → choose the sub-merchant → configure. Without its own rule
   it shows *Inherited from Master Merchant*.

### 2.11 Deactivate a payment method
1. **Merchant Pricing** → merchant → **View** on an active rule → **Deactivate**.
2. Scope: whole MID or one sub-merchant. When: **Immediately** or **On a date**. Reason → code.
3. FinOps is alerted. **Cancel** a scheduled stop, or **Reactivate** a sub-merchant, from the
   Deactivated payment methods list.

### 2.12 Suspend for commercial reasons
1. Merchant page → **Suspend**. Sales can choose *Commercial* or *Merchant request* only.
2. Scope (whole merchant, one country, one sub-merchant), payment controls, reason → code.

### 2.13 Look up transactions and documents
- **Transactions**: PayIn | Payout tabs, filters, details sheet with fees, flag for investigation,
  notes, **Export** CSV.
- Application page → **Application** → Documents: click a file to open it; views and downloads are
  recorded in Activity.

---

## 3. Risk (`MOBI-RISK`)

### 3.1 Review an application
1. **Approvals** or **Applications** → *Risk review* → the application.
2. Read the summary, open documents (click a file name), check the simulated verification evidence.
3. Tick *I've reviewed the documents and verification results*, then:
   - **Approve** → *Risk approved*, CS is notified;
   - **Return for correction** → pick sections and give a reason → back to Sales;
   - **Reject** → final, with a reason.

### 3.2 Decide a country change request
1. Application page → **Changes after approval** (or **Approvals**).
2. See Current vs Proposed. For documents, both files show side by side; click either to open it.
3. **Approve and apply** or **Reject** (comment required to reject).

### 3.3 Decide a legal identity or MCC change
1. Merchant page → Profile. A pending MCC change shows Current → Proposed, reason and any
   restricted-country flag; legal identity requests are in **Approvals**.
2. **Approve change** or **Reject** (comment required). MCC history records it.

### 3.4 Approve a sub-merchant
1. Merchant page → Sub-merchants → the submitted one (or **Approvals**) → **Approve** or **Reject**.

### 3.5 Suspend a merchant for fraud or compliance
1. Merchant page → **Suspend**. Type (e.g. *Suspected fraud*), scope, payment controls (block pay-ins,
   payouts, refunds, hold settlement), case reference, detected by, reason, optional linked
   transactions → **Suspend merchant** → code.
2. The banner shows the controls and the second review due in 24 hours. The merchant sees only "Your
   account is under review".

### 3.6 Second review, reactivation and approval (two Risk people)
1. Second Risk person (`MOBI-ADMIN`, **View as** Risk): **Approvals** → *Suspension review* →
   **Confirm suspension** or **Lift suspension** → code. The person who raised it can't review it.
2. Reactivate: banner → **Reactivate** → outcome, reason, release settlement or not → code. Fraud
   needs the other Risk person to **Approve reactivation**.

### 3.7 Investigate transactions
- **Transactions** → row → details (IP address and device are shown to Risk) → **Flag for
  investigation**, **Add note**, **Clear flag** with a resolution note.

---

## 4. Customer Success (`MOBI-CS`)

### 4.1 Readiness after Risk approval
1. **Applications** → *Setup & go-live* → the application.
2. **Product & Payment Config**: switch products on, set onboarding pricing (applies when saved, no
   approval), set the settlement cycle per PayIn product (asks for your code).
3. Set the **IPN callback URL** (CS or Sales; it saves directly and is recorded).
4. **Confirm onboarding** → production keys are issued (simulated).
5. Work through the go-live checks → **Go live** → *Operational*, live MID assigned.

### 4.2 Take a sub-merchant live
1. Merchant page → Sub-merchants → approved sub-merchant (parent live in that country, neither
   suspended).
2. Complete the two checks (live low-value transaction, merchant sign-off) → **Go live**.

### 4.3 Support views
- **Transactions** with fees, documents on applications, notifications for readiness events.

---

## 5. FinOps (`TANJUNG-ADMIN`)

### 5.1 Approve a pricing change (checker)
1. **Approvals** → *Waiting for FinOps* → the pricing item → side sheet with the new rate, current
   rate and who asked.
2. **Approve** or **Reject** (reason) → code. Maker and checker must be different people.

### 5.2 Release held settlement after a suspension
1. **Approvals** → *Settlement release* → review the held amount → **Release settlement** or **Keep
   on hold** (reason) → code.

### 5.3 Pricing alerts and history
- **Notifications**: *Payment method deactivated*, *Unusual pricing change*.
- **Merchant Pricing** → **History**: MDR versions and the audit trail.
- **Transactions** with fees and export.

---

## 6. Mobi Support (`MOBI-SUPPORT`)

### 6.1 Open an MFA reset request
1. A user lost their device and has no recovery code. **User security** → find the user →
   **Open reset request** → ticket reference and reason → **Confirm**.
2. Security Admin is asked to verify and reset.

### 6.2 Look up transactions
- **Transactions** (view only; IP address and device shown; no fees, no export).
- Support has no merchant permissions: any merchant change is refused.

---

## 7. Security Admin (`MOBI-SECURITY`)

### 7.1 Verify identity and reset MFA
1. **User security** → reset requests → **Verify & reset** → how identity was verified, tick the
   confirmation, reason → reset. The user's sessions end; they set up MFA at next sign-in.

### 7.2 Waive a sign-in block
1. **User security** → Tech alerts or Users → **Waive block** → confirm it's you → reason. The
   failed-attempt count clears and the user can sign in.

---

## 8. Prototype Admin (`MOBI-ADMIN`) and Viewer (`TANJUNG-VIEWER`)

- **View as** (sidebar) switches between Sales / Ops, Risk, CS and FinOps (and Mobi Support / Security
  Admin for User security). A new team asks for your code again before sensitive actions. Use it as
  the second person in maker-checker steps.
- `TANJUNG-VIEWER` sees the same screens as Sales / Ops but can't change anything, add notes or flags.

---

## 9. End-to-end journeys across teams

| # | Journey | Who, in order |
|---|---|---|
| A | New merchant to live | Sales registers and submits (2.1–2.2) → Risk approves (3.1) → CS readiness, Confirm onboarding, Go live (4.1) |
| B | Returned application | Sales submits → Risk returns for correction (3.1) → Sales corrects and resubmits (2.3) → Risk approves |
| C | Pricing change | Sales submits (2.9) → FinOps approves (5.1) → the merchant sees it in the Merchant Portal (on hold for release) |
| D | Document replaced after approval | Sales requests with the new file (2.7) → Risk opens Current and Proposed and decides (3.2) |
| E | MCC change | Sales requests (2.6) → Risk approves or rejects in Profile (3.3) |
| F | Sub-merchant | Sales adds and submits (2.8) → Risk approves (3.4) → CS takes it live (4.2) → Sales prices it (2.10) |
| G | Fraud suspension | Risk suspends (3.5) → second Risk confirms (3.6) → Risk reactivates, another Risk approves → FinOps releases settlement (5.2) |
| H | Payment method stop | Sales deactivates (2.11) → FinOps alerted (5.3) |
| I | Lost authenticator | Support opens a reset (6.1) → Security verifies and resets (7.1) → the user sets up MFA again (1.1) |
| J | Locked out | User fails the code 4 times → Security waives the block (7.2) |

## 10. Sign-in scenarios to check

| Login | What you should see |
|---|---|
| `TANJUNG-RAVI` | User access disabled |
| `SERIMUTIARA-ADMIN` | Account suspended |
| `NUSAPANGAN-ADMIN` | Account inactive |
| `TANJUNG-KEVIN` | Sign-in service unavailable |
| `LUMI-ADMIN` | No active countries (MFA setup first) |

## What isn't real

Emails are simulated, verification evidence is simulated, transactions and held settlement are
sample data, uploaded files stay in the browser they were uploaded from, and exchange rates are fixed
sample rates. The Merchant Portal is covered in `testing-guide.md`; its production release is on hold.
