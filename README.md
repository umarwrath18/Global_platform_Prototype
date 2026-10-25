# Mobi Global Platform — Prototype

Angular 21 prototype of the Global Platform:

- **Batch 1:** Login & Authentication.
- **Batch 2:** Merchant Management & Onboarding (Global Merchants, country applications, country expansion, Risk review, simulated CS readiness and go-live, notifications).

Other MVP modules are intentionally not built yet.

There is no real server or database. A simulated backend runs in the browser
(`src/app/core/mock-server/`) and stores its data in `localStorage`. It answers
`/api/*` calls through an HTTP interceptor and enforces every rule as a real
backend would, so it can later be replaced by Mobi's real API without changing the screens.
Batch 2 merchant data is kept separately under `mobi.gp.merchantdb`.

## Run locally

```bash
npm install
npm start          # http://localhost:4200
npm test           # unit tests for the auth and merchant onboarding rules
npm run build      # production build → dist/global-platform/browser
```

## Demo accounts

All test users share the password **`Mobi@123`**. The login screen also lists
them under "Use a test account".

| Global Account ID     | Scenario                                              |
| --------------------- | ----------------------------------------------------- |
| `123`                 | Administrator · Tanjung Global Trading (GA-1001): MY/ID/VN active, TH pending, PH failed |
| `TANJUNG-ADMIN`       | Second administrator on the same account (GA-1001)    |
| `TANJUNG-VIEWER`      | Viewer on GA-1001                                     |
| `LUMI-ADMIN`          | Active account with no active countries (GA-4004)     |
| `TANJUNG-RAVI`        | Individual user disabled                              |
| `SERIMUTIARA-ADMIN`   | Account suspended (GA-2002)                           |
| `NUSAPANGAN-ADMIN`    | Account inactive (GA-3003)                            |
| `TANJUNG-KEVIN`       | Sign-in service unavailable                           |

Registered emails for password recovery follow the user, e.g. `sarah.lim@tanjungtrading.example`
(user `123`), `aisyah@tanjungtrading.example`, `budi@tanjungtrading.example`, `lan@lumihome.example`.
`farid@tanjungtrading.example` simulates an email delivery failure. OTP codes appear on
screen in an **Email preview** card instead of being emailed.

### Merchant onboarding (Batch 2)

Sign in as `123`, then open **Merchants** in the sidebar. Use **View as** in the sidebar to
switch between Sales / Operations, Risk and Customer Success. This control stands in for
real role permissions and exists only in this prototype.

**Validation modes.** By default the app runs in *guided* mode:
- Fields validate and show errors as they would in production, but missing input never
  blocks a step.
- Submitting with gaps asks for confirmation.
- Risk decisions without a reason get a default reason.
- Moving a CS step forward completes any open checklist items.

Run `mobiDemo.strictValidation(true)` in the browser console, then reload, to apply the full
production rules. Run `mobiDemo.strictValidation(false)` to go back to guided mode.
Use guided mode for demos and walkthroughs. Use strict mode for formal acceptance testing
against the original brief (acceptance criterion 7).

**What isn't real in this build.** Everything runs in the browser, with no external services:
- Verification results are generated from the application data.
- Production key-set references are generated locally; no credentials are created.
- No emails are sent. Notifications record the intended recipients, and OTP codes appear
  in an on-screen **Email preview**.
- Uploaded documents keep only their file name and size.
- Company names, people and domains (`*.example`) are fictional.

### QA hooks (browser console)

```js
mobiDemo.suspendAccount('GA-1001')   // revokes all sessions of that account
mobiDemo.reactivateAccount('GA-1001')
mobiDemo.disableUser('123')          // revokes only that user's sessions
mobiDemo.enableUser('123')
mobiDemo.expireSessions()            // simulate 30-minute idle timeout
mobiDemo.audit()                     // print audit events
mobiDemo.reset()                     // restore all demo data (auth + merchants)
mobiDemo.resetMerchants()            // restore only the merchant data
mobiDemo.strictValidation(true)      // full production validation (reload after)
```

## Deploy to Vercel

`vercel.json` is included. In Vercel: **Add New → Project → Import** this
repository → **Deploy**. No environment variables are needed.

## Documentation

- [`docs/authentication-batch-1.md`](docs/authentication-batch-1.md): login workflows, rules, security controls, QA cases and open decisions.
- [`docs/merchant-onboarding-batch-2.md`](docs/merchant-onboarding-batch-2.md): merchant data model, workflows, statuses, demo data, QA cases, limitations and open questions.
