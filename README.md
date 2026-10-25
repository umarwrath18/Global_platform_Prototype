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

All demo users share the password **`Mobi@123`**. The login screen also lists
them under "View sample accounts".

| Global Account ID     | Scenario                                              |
| --------------------- | ----------------------------------------------------- |
| `123`                 | Active admin · MY/ID/VN active, TH pending, PH failed |
| `MOBI-DEMO-ADMIN`     | Second user on the same Global Account (GA-1001)      |
| `MOBI-DEMO-VIEWER`    | Viewer role on GA-1001                                |
| `MOBI-DEMO-NOCOUNTRY` | Active account with no active countries               |
| `MOBI-DEMO-DISABLED`  | Individual user disabled                              |
| `MOBI-DEMO-SUSPENDED` | Global Account suspended                              |
| `MOBI-DEMO-INACTIVE`  | Global Account inactive                               |
| `MOBI-DEMO-OUTAGE`    | Simulated auth service outage                         |

Registered emails for password recovery follow the user, e.g. `admin@mobidemo.test`
(user `123`), `aisyah@mobidemo.test`, `budi@mobidemo.test`, `lan@mobidemo.test`.
`bounce@mobidemo.test` simulates an email delivery failure. OTP codes appear on
screen in a **Demo inbox** card instead of being emailed.

### Merchant onboarding (Batch 2)

Sign in as `123`, then open **Merchants** in the sidebar. Use the pink **Prototype · Acting as** control in the
sidebar to switch between Sales / Operations, Risk and Customer Success. It is a
prototype-only stand-in for real role permissions. All sample merchants are labelled *Demo data*.

### QA hooks (browser console)

```js
mobiDemo.suspendAccount('GA-1001')   // revokes all sessions of that account
mobiDemo.reactivateAccount('GA-1001')
mobiDemo.disableUser('123')          // revokes only that user's sessions
mobiDemo.enableUser('123')
mobiDemo.expireSessions()            // simulate 30-minute idle timeout
mobiDemo.audit()                     // print audit events
mobiDemo.reset()                     // restore all demo data (auth + merchants)
mobiDemo.resetMerchants()            // restore only the merchant demo data
```

## Deploy to Vercel

`vercel.json` is included. In Vercel: **Add New → Project → Import** this
repository → **Deploy**. No environment variables are needed.

## Documentation

- [`docs/authentication-batch-1.md`](docs/authentication-batch-1.md): login workflows, rules, security controls, QA cases and open decisions.
- [`docs/merchant-onboarding-batch-2.md`](docs/merchant-onboarding-batch-2.md): merchant data model, workflows, statuses, demo data, QA cases, limitations and open questions.
