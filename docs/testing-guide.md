# Testing guide: demo logins and team walkthrough

This guide is for anyone testing the prototype. Each demo login belongs to **one fixed team**, the
same way real staff will. To see another team's view, sign in with that team's login. Only
`MOBI-ADMIN` has the **View as** switcher, so it can look at every team's screens from one login.

## Before you start

- **Password:** every demo login uses **`Mobi@123`**.
- **MFA codes:** after the password you need a 6-digit code. Use the **Demo authenticator** card on
  the screen (dashed pink, labelled *Prototype*). It shows the live code the screen is waiting for.
  You can also scan the QR code with any authenticator app. Each code works once, so after using one,
  wait for the next.
- **First sign-in for `123`, `TANJUNG-MERCHANT` and `LUMI-ADMIN`:** you set up MFA first (scan or
  type the key, then enter a code). Other logins already have MFA on.
- **Two windows:** some steps need two people, such as submitter and approver. Use a normal window
  and a private window, or two browsers, so both sessions stay signed in.
- **Demo data:** it lives in your browser and resets when a new build changes the data. Run
  `mobiDemo.reset()` in the browser console to start again.

## Internal app (Global Platform)

| Login            | Team                       | Use it to                                                               |
| ---------------- | -------------------------- | ----------------------------------------------------------------------- |
| `123`            | Sales / Operations         | Register merchants, submit applications, request changes and pricing changes |
| `MOBI-RISK`      | Risk                       | Approve, return or reject applications, change requests and sub-merchants |
| `MOBI-CS`        | Customer Success           | Readiness: products, onboarding pricing, IPN, Confirm onboarding, Go live |
| `TANJUNG-ADMIN`  | FinOps                     | Approve or reject pricing changes on **Pricing Approvals**              |
| `MOBI-SUPPORT`   | Mobi Support               | **User security**: open MFA reset requests for users who lost their device |
| `MOBI-SECURITY`  | Security Admin (Tech)      | **User security**: verify and reset MFA, waive blocks, see Tech alerts  |
| `MOBI-ADMIN`     | Prototype admin            | Switch teams with **View as** to review any screen                      |
| `TANJUNG-VIEWER` | Viewer (Sales / Operations) | Check read-only access                                                 |

`123` has access to **Malaysia, Indonesia and Vietnam**. The sidebar shows the login's team as a
fixed **Team** label; only `MOBI-ADMIN` gets the **View as** dropdown.

Mobi Support and Security Admin have no merchant permissions. They see only Dashboard and User
security, and the system refuses any merchant change they try.

## Merchant Portal

| Login                | Merchant                                         |
| -------------------- | ------------------------------------------------ |
| `NUSANTARA-MERCHANT` | Nusantara Home Retail, live in Malaysia and Indonesia (best for testing) |
| `TANJUNG-MERCHANT`   | Tanjung Global Trading (MFA setup on first sign-in) |
| `LUMI-MERCHANT`      | Lumi Home Living, no live countries yet          |

Screens: **Dashboard**, **My Transactions** and **Pricing & settings**. Pricing & settings is read
only: it shows the pricing in effect, any approved change that starts later, the settlement cycle,
the IPN callback URL, limits and the MID for each live country. Transactions and balances are sample
data.

## Walkthrough: from registration to a pricing change

1. **Sales registers the merchant.** Sign in as `123`. Go to **Merchants**, create a merchant, then
   start a country application (Malaysia, Indonesia or Vietnam). Fill in the registration form and
   **Submit** it for Risk review.
2. **Risk reviews it.** Sign in as `MOBI-RISK`. Open the application from **Approvals** or
   **Applications** and approve it (or return it with a reason to test the round trip back to Sales).
3. **CS completes readiness.** Sign in as `MOBI-CS`. Open the application. In the readiness panel:
   - turn on products and set their pricing (onboarding pricing applies when saved, no approval);
   - set a settlement cycle for each PayIn product;
   - set the **IPN callback URL**;
   - choose **Confirm onboarding** (this also issues the production keys);
   - finish the go-live checks and choose **Go live**.
4. **Sales requests a pricing change.** Sign in as `123`. Open **Merchant Pricing**, pick the
   merchant and submit a new rate with a start date. It goes to FinOps as *Pending approval*.
5. **FinOps approves it.** Sign in as `TANJUNG-ADMIN`. Open **Pricing Approvals**, review the change
   and approve or reject it. You'll be asked for a current authenticator code. The person who
   submitted a change can never approve it.
6. **The merchant sees it.** Sign in to the Merchant Portal as the merchant's portal user (for the
   seeded merchant, `NUSANTARA-MERCHANT`) and open **Pricing & settings**. A future-dated change
   shows as an upcoming change until its start date.

Shortcut: the seeded Nusantara Home Retail (Malaysia) is already live, so you can start at step 4.

## Other things to try

- **Deactivate a payment method:** as `123`, open Merchant Pricing → a live merchant → **View** on an
  active rule → **Deactivate**. Choose the whole MID or one sub-merchant, Immediately or On a date,
  add a reason, then enter your authenticator code. Sign in as `TANJUNG-ADMIN` to see the FinOps alert
  under Notifications. In **Sub-Merchant View** you can deactivate or reactivate one sub-merchant's method.
- **Settlement or USD fee change:** saving a settlement cycle, or submitting a Fixed Fee in USD, asks for
  your authenticator code once; for the next 5 minutes it isn't asked again.
- **Unusual-change alert:** as `123`, submit a pricing change that drops a rate by 30% or more (e.g.
  FPX 1% → 0.6%), or sets it to 0. FinOps gets a warning; the change is still submitted.
- **E-wallets and payouts:** Product & Payment Config shows the e-wallets grouped, and Bank Transfer plus
  one e-wallet payout already on for the live demo merchants.

- **IPN after go-live:** as `MOBI-CS` or `123`, open a live application and change the IPN callback
  URL in the Go-live panel. It saves directly, no Risk approval, and appears in the application
  history. As `MOBI-RISK` the field is read only.
- **Profile or bank change after Risk approval:** as `123`, request a change on an approved merchant;
  approve it as `MOBI-RISK` from **Approvals**.
- **Lost authenticator:** as `MOBI-SUPPORT`, open a reset request for a user in **User security**;
  as `MOBI-SECURITY`, verify and reset it. The user sets up MFA again at the next sign-in.
- **MFA block and Tech alert:** enter a wrong code more than 3 times for a login. The user is
  blocked, and `MOBI-SECURITY` sees a Tech alert marked *Emailed tech-alerts@mobi.xyz (simulated)*.
  Security Admin can waive the block.
- **Login scenarios:** `TANJUNG-RAVI` (user disabled), `SERIMUTIARA-ADMIN` (account suspended),
  `NUSAPANGAN-ADMIN` (account inactive), `TANJUNG-KEVIN` (service unavailable), `LUMI-ADMIN`
  (no active countries).

## What isn't real

No emails are sent: OTP codes appear in an on-screen **Email preview**, and Tech alert emails are
recorded as simulated. There is no transaction service, and the exchange rates used for pricing
limits are fixed sample rates.
