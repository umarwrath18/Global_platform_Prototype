# Mobi Global Platform — Prototype

Angular 21 prototype of the Global Platform **Login & Authentication** workflow
(Batch 1). Other MVP modules are intentionally not built yet.

There is no real server or database. A simulated backend runs in the browser
(`src/app/core/mock-server/`) and stores its data in `localStorage`. It answers
`/api/*` calls through an HTTP interceptor and enforces every rule as a real
backend would, so it can later be replaced by Mobi's real API without changing the screens.

## Run locally

```bash
npm install
npm start          # http://localhost:4200
npm test           # unit tests for the auth rules
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

### QA hooks (browser console)

```js
mobiDemo.suspendAccount('GA-1001')   // revokes all sessions of that account
mobiDemo.reactivateAccount('GA-1001')
mobiDemo.disableUser('123')          // revokes only that user's sessions
mobiDemo.enableUser('123')
mobiDemo.expireSessions()            // simulate 30-minute idle timeout
mobiDemo.audit()                     // print audit events
mobiDemo.reset()                     // restore the demo data
```

## Deploy to Vercel

`vercel.json` is included. In Vercel: **Add New → Project → Import** this
repository → **Deploy**. No environment variables are needed.

## Documentation

See [`docs/authentication-batch-1.md`](docs/authentication-batch-1.md) for the
workflows, screen inventory, rules, security controls, QA cases, gap list and open
decisions for review.
