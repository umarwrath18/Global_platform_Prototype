# Global Platform — Login & Authentication (Batch 1)

Status: **Prototype built, awaiting Product & Engineering review.**
Scope: Login, Forgot Password (email OTP), account status, session security,
country access and post-login redirect only. No other MVP module is included.

---

## 1. Current state

| Item | Finding |
| --- | --- |
| Existing screens | Login, Forgot Password (email), OTP entry were supplied as designs (screenshots). They were rebuilt in Angular, keeping the same layout, copy and visual direction. |
| Existing backend / APIs | **None available to this project.** The repository was empty and no API documentation was provided. |
| What was built instead | A simulated backend in the browser (`src/app/core/mock-server/auth-server.ts`) behind an `/api/*` contract (`src/app/core/api/models.ts`). It applies every rule server-side, so the contract can be compared with, or swapped for, Mobi's real auth services. |

> Gap: the brief asks to reuse Mobi's working auth backend. That backend still needs
> to be inspected against this contract before production work begins (see §8).

## 2. Future-state workflows

### Login
1. User enters Global Account ID + password (ID is trimmed and case-insensitive).
2. Client validates the required fields → `POST /api/auth/login`.
3. Server checks the lockout state, then verifies the password hash (unknown IDs take the same path and timing).
4. Server checks Global Account status (suspended / inactive) and user status (disabled). These messages are only shown **after** the credentials are verified.
5. Server creates a session (random 256-bit token, stored hashed; 30-min idle and 12-h absolute timeout).
6. Server returns the user, Global Account, role, permissions, countries (with status), base currency (USD) and landing path.
7. Client redirects to the safe `returnUrl` if there is one, otherwise to the landing path (`/dashboard`).
8. The dashboard shows the active countries in the switcher. Switching country changes the URL only, with no new login, and each country is authorised by the server (`GET /api/workspace/context?country=XX`).

### Forgot password (OTP only, no reset link)
1. Login → *Forgot password?* → enter the registered email → *Send OTP*.
2. The server always answers the same way (registered or not), with a `requestId`. Only eligible users get a code.
3. User enters the 6-digit code → `POST /otp/verify` → the server returns a single-use reset token (10 min).
4. User enters and confirms the new password; the policy is shown live and enforced on the server.
5. Server saves the new password hash, burns the token, **revokes all of that user's sessions**, clears the lockout, and writes an audit event.
6. Success screen → *Back to Login* → sign in with the new password.

## 3. Screen & state inventory

| Screen | States implemented |
| --- | --- |
| Login | default · field required / too long · submitting · invalid credentials · *n attempts left* warning · temporary lockout with countdown · account suspended · account inactive · user disabled · offline · service unavailable · notices on return: signed out, session expired, sign-in required, suspended / disabled mid-session, password updated |
| Forgot password – email | default · invalid email · sending · resend cooldown · hourly send limit · delivery failure · offline / service error |
| Forgot password – OTP *(designed)* | neutral "if registered" notice · code expiry countdown · verify disabled until 6 digits · verifying · incorrect code (*n attempts left*) · expired · already used · attempts exceeded · resend cooldown countdown · resent confirmation · change email |
| Set new password *(new — no design supplied)* | live policy checklist · policy violation · confirm mismatch · confirm required · show/hide on both fields · updating · verification expired → start again |
| Password updated *(new)* | success confirmation · back to login |
| Dashboard placeholder *(new)* | loading skeleton · global workspace (USD) · country workspace (local currency) · country not authorised · country pending / failed · no active countries · load error with retry · user menu · sign out |
| Demo inbox *(prototype only)* | shows the OTP email on screen; copy code; dismiss |

## 4. Global Account, country & role rules (as implemented)

- **Multi-user model:** one Global Account (e.g. `GA-1001`) has many users. Each user has their own login ID, password, email and role. The demo uses the "Global Account ID" field as the per-user login identifier, as instructed for the prototype.
- Suspending or deactivating a Global Account revokes the sessions of **all** its users and blocks new logins.
- Disabling a user revokes **only** that user's sessions.
- Emails are unique per user in the demo data. A user can't be resolved across accounts by email alone.
- **Countries** are linked to a Global Account with a status of `active`, `pending` or `failed`. Only `active` countries appear in the switcher or can be opened. The server rejects the others even if the URL is edited.
- **Currency:** the global workspace uses USD; a country workspace uses that country's currency (MYR, IDR, VND …).
- **Roles:** `Administrator (placeholder)` and `Viewer (placeholder)`, with no permissions yet. Role permissions and country activation are kept as separate controls.

## 5. Security controls (placeholder values — need approval)

| Control | Prototype value | Basis |
| --- | --- | --- |
| Password storage | PBKDF2-SHA256, 600k iterations, per-user salt (browser limitation) — **use Argon2id in production** | OWASP Password Storage |
| Password policy | 12–128 chars, any characters, no composition rules; blocks common/breached, repetitive/sequential, and values containing the ID or email | NIST SP 800-63B |
| Breached-password check | Local blocklist (stand-in for a k-anonymity breach API) | NIST 800-63B §3.1.1.2 |
| Login lockout | 5 free attempts, then 1 → 5 → 15 → 30 min locks; applied to unknown IDs too | OWASP Authentication |
| Generic errors | Same response for an unknown ID and a wrong password; status only revealed after valid credentials | OWASP ASVS V2 |
| OTP | 6 digits, CSPRNG with rejection sampling, stored hashed, 10-min expiry, single use, 5 attempts, 60-s resend cooldown, 5 sends/hour/email, a resend invalidates the earlier code | OWASP Forgot Password |
| Account enumeration | Identical OTP response for registered / unregistered / ineligible emails | OWASP Forgot Password |
| Sessions | 256-bit random token stored hashed; 30-min idle, 12-h absolute; logout and password reset revoke; status re-checked on every request; background polling every 30 s (doesn't extend idle) | OWASP Session Management |
| Suspension | Immediate revocation of all account sessions; client signs out with reason on its next request or poll (≤30 s) | Brief §6 |
| Authorisation | Every protected call validates the session and country access on the server; UI guards are convenience only | Brief §4 |
| Redirects | `returnUrl` limited to in-app paths (no open redirect) | OWASP |
| Audit | LOGIN_SUCCESS / FAILED / DENIED / BLOCKED_LOCKED, LOGOUT, SESSION_EXPIRED, OTP_SENT / NOT_SENT / VERIFY_FAILED / VERIFIED / DELIVERY_FAILED, PASSWORD_RESET, ACCOUNT_SUSPENDED, USER_DISABLED / REACTIVATED, ACCESS_DENIED_COUNTRY. No passwords, OTPs or tokens are logged. | Brief §6 |
| Headers | nosniff, frame DENY, referrer policy, noindex (`vercel.json`) | OWASP Secure Headers |

**Prototype-only limitations** (must be server-side in production): the data lives in the
browser's `localStorage`, the session token is held in `sessionStorage` rather than an
HttpOnly cookie, and the OTP is shown on screen instead of being emailed.

## 6. Acceptance criteria → evidence

| # | Criterion | Covered by |
| --- | --- | --- |
| 1 | Valid active user signs in | unit + browser walkthrough |
| 2 | Invalid credentials rejected safely | unit (identical responses) |
| 3 | Suspended / inactive users blocked | unit + walkthrough |
| 4 | Workspace opens with correct countries & role | walkthrough (`123`) |
| 5 | Only active countries available | unit (`TH`/`PH`/`SG` denied) |
| 6 | Country switch without re-login | walkthrough (switcher → `VN`) |
| 7 | URL manipulation blocked server-side | unit + `/dashboard/SG` |
| 8 | Recovery via email OTP only | walkthrough |
| 9 | Expired / invalid / reused OTP rejected | unit |
| 10 | Policy enforced, old password replaced | unit + walkthrough |
| 11 | Suspension invalidates sessions immediately | unit + `mobiDemo.suspendAccount` |
| 12 | Error / loading / success / retry / expiry states | §3 inventory |
| A1–A5 | Multi-user, own credentials, consistent role, disable one user, suspend account | unit |
| 13, A7 | Security & role review; user lifecycle audit | **Pending review** |

## 7. QA test cases

| ID | Steps | Expected |
| --- | --- | --- |
| L-01 | Submit an empty login form | Both field errors shown; no request sent |
| L-02 | `123` / `Mobi@123` | Dashboard, "All countries · USD" |
| L-03 | `123` / wrong password | "Global Account ID or password is incorrect"; password field cleared |
| L-04 | `GHOST` / anything | Same message as L-03 |
| L-05 | 4 wrong attempts | Warning shows 1 attempt left |
| L-06 | 5th wrong attempt | Locked for 1 minute with countdown; button disabled |
| L-07 | `MOBI-DEMO-SUSPENDED` / correct password | "Account suspended… contact Mobi Support" |
| L-08 | `MOBI-DEMO-INACTIVE` / correct password | "Account inactive" |
| L-09 | `MOBI-DEMO-DISABLED` / correct password | "Access disabled" |
| L-10 | `MOBI-DEMO-OUTAGE` | "Service unavailable" |
| L-11 | Go offline (DevTools) and sign in | "No connection" |
| L-12 | Tick *Remember this device*, sign in, sign out | Global Account ID is pre-filled |
| S-01 | Open `/dashboard/MY` signed out | Redirect to login with "Please sign in"; after login, lands on MY |
| S-02 | Signed in, run `mobiDemo.expireSessions()`, then click anything or reload | Back on login: "Your session expired" |
| S-03 | Signed in as `123`, run `mobiDemo.suspendAccount('GA-1001')` | Within 30 s, or on the next action: signed out with "Account suspended" |
| S-04 | Signed in as `123` and `MOBI-DEMO-ADMIN` in two windows; `mobiDemo.disableUser('123')` | Only `123` is signed out |
| S-05 | Sign out via the user menu | Login shows "You have been signed out"; Back doesn't restore access |
| C-01 | Switch country to Vietnam | URL `/dashboard/VN`, currency VND, no login prompt |
| C-02 | Visit `/dashboard/TH` | "Country activation pending" |
| C-03 | Visit `/dashboard/PH` | "Country activation failed" |
| C-04 | Visit `/dashboard/SG` | "You don't have access to this country" |
| C-05 | Sign in as `MOBI-DEMO-NOCOUNTRY` | "No active countries yet"; no switcher |
| F-01 | Forgot password, enter `abc` | Email format error |
| F-02 | Enter `admin@mobidemo.test` | OTP screen + Demo inbox code |
| F-03 | Enter `ghost@example.com` | Same OTP screen; no inbox email |
| F-04 | Wrong code | "Incorrect, 4 attempts remaining" |
| F-05 | 5 wrong codes | "Too many incorrect attempts"; *Send a new code* |
| F-06 | Click *Resend* before 60 s | Not possible (countdown); after 60 s, a new code arrives and the old code fails |
| F-07 | Wait 10 min, then verify | "Code expired" |
| F-08 | `bounce@mobidemo.test` | "We couldn't send the code" |
| F-09 | New password `Mobi@123` | Too short + common; blocked |
| F-10 | Confirm field doesn't match | "Passwords don't match" |
| F-11 | Valid passphrase | Success screen; old password no longer works; new one does |
| F-12 | 6th code request within an hour | "Too many code requests" |

## 8. Gap list & open decisions

**Confirmed gaps (vs brief)**
1. Mobi's existing auth backend and APIs haven't been inspected. The API contract here needs to be mapped onto them.
2. Official Mobi logo SVG not supplied; the wordmark is approximated.
3. No designs exist for the *Set new password*, *Success* and dashboard screens. They were built in the same visual style and need Design review.

**Proposed improvements (need approval)**
4. Production: HttpOnly Secure SameSite cookies for sessions; Argon2id; a real breached-password API; server-push revocation.
5. MFA for privileged roles (assessed separately, not introduced).
6. Idle warning dialog ("You'll be signed out in 2 minutes") before timeout.

**Open questions for Product**
7. Login identifier: should the field stay "Global Account ID", or become Global Account ID + user-specific ID/email?
8. What should *Remember this device* do? (The prototype only remembers the ID on this browser and doesn't extend the session.)
9. Duplicate emails across users / accounts: allowed? How is recovery routed?
10. Final password policy, lockout and OTP values (§5 placeholders).
11. Role list and the role-to-permission matrix, and who can assign roles.
12. Invite / registration / activation / removal flow for users.
13. *Contact Mobi Support* destination (email, phone or portal) and the Privacy / Security / Terms links.
14. Landing page per role (currently `/dashboard` for everyone).

## 9. Tasks by team

- **Product:** answer §8 items 7–14; approve the §5 values; sign off on the acceptance criteria.
- **BA:** map this API contract to the existing Mobi auth services; document the user lifecycle and audit requirements.
- **Design:** review the new screens (set new password, success, dashboard placeholder, error states); supply the logo SVG.
- **Engineering:** confirm the real backend's capabilities against §2 and §5; plan the cookie-based sessions and Argon2id; review the security controls.
- **QA:** run §7 on the Vercel deployment; add cross-browser and mobile checks.

## 10. Sign-off

| Role | Name | Date | Decision |
| --- | --- | --- | --- |
| Product | | | |
| Engineering | | | |
