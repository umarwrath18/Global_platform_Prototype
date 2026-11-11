# Global Platform — Two-factor authentication (Batch 3)

Status: **Prototype built, awaiting Product, Engineering and Security review.**
Source: *Merchant Portal — Multi-Factor Authentication (MFA), Phase 1: 2FA* PRD (final version).
Scope: mandatory authenticator-app (TOTP) second factor for merchant users, recovery codes,
lost-device recovery, authenticator replacement, admin reset and block waive-off, audit, and
ending existing sessions at rollout. Also: the left-hand picture on the sign-in screens is now a
neutral, generic dashboard wireframe with no merchant data.

> **Update: recovery codes removed.** Product decided to use **admin-assisted recovery only**
> (PRD FR-04 option 2). There are no recovery codes anywhere:
> - Setup is 2 steps: scan the QR code, then enter a code. A valid code turns 2FA on and signs the user in.
> - "Use a recovery code" and "Generate new codes" are gone, along with their APIs.
> - A user who loses their authenticator contacts Mobi Support. Support opens a reset request, a
>   Security Admin verifies identity and resets, and the user sets up a new authenticator at next sign-in.
> - Existing demo data has stored recovery-code hashes deleted (auth data version 8).
>
> Sections below that mention recovery codes, the "rebind" or "acknowledge" steps, QA cases M-04
> and M-13 to M-16, and open question 7 no longer apply.

---

## 1. Decisions confirmed before build

| Question | Decision |
| --- | --- |
| Recovery method (FR-04, "take a call") | ~~2 single-use recovery codes~~ → **Admin-assisted recovery only** (updated decision): lost device → contact Mobi Support. |
| After signing in with a recovery code | **A new authenticator must be registered before portal access** (OWASP MFA / NIST 800-63B best practice). The old one is revoked when the new one is verified, 2 new codes are issued, and the user is emailed. |
| More than 3 wrong codes (FR-03) | **Blocked until a Security Admin waives it.** No time-based unlock. Only that user is blocked, not the merchant or the Global Account. A Tech alert is raised. |
| Who is the admin / Tech team | Two new prototype **View as** roles: **Mobi Support** (opens reset requests) and **Security Admin (Tech)** (verifies identity, resets, waives blocks). Both use the new **User security** page. They grant no merchant permissions. |
| Admin identity verification (FR-07) | The admin enters a fresh code from **their own** authenticator ("Confirm it's you"), valid for 5 minutes. It's asked again after switching role. |
| Who must use 2FA | **Merchant users only**, i.e. everyone who signs in on the Login screen (the Global Account users). Staff roles are only the demo switcher, not separate logins. |
| Multi-user support | Each merchant user has **their own** authenticator, recovery codes and block. Account admins inviting or managing users is **future scope** and wasn't built. |
| Testing without a phone | Real authenticator apps work by scanning the QR code, **and** an on-screen **Demo authenticator** card (prototype only) shows the live code. |
| Notification channel | Email, shown in the on-screen **Email preview**, after authenticator replacement and admin reset. |
| Remember this device | Remembers the Global Account ID only. It never skips 2FA (PRD §8 Q3). |
| Existing sessions (FR-09) | All sessions end at rollout; everyone signs in again and sets up 2FA if they haven't. |

## 2. Flows

**Sign-in (FR-01, FR-03).**
1. Password check, unchanged (lockout, account status).
2. A correct password returns a **2FA challenge** (valid 5 minutes), never a session:
   - **No authenticator yet → setup.**
   - **Authenticator registered → enter code.**
   - **Blocked → "Sign-in blocked"** (shown only after a correct password).
3. A session is created only after the second factor passes.

**First-time setup (FR-02).** Intro (mandatory, no skip; *Sign out* only) → QR code and setup key →
enter a code from the app (2FA activates only if the backend accepts it; 5 tries, then start again) →
2 recovery codes, shown once, with copy / download and a required "I've saved these" tick → "2FA is on"
→ portal.

**Recovery code (FR-04).** "Use a recovery code instead" → a valid unused code → "Set up a new
authenticator" (the same setup steps) → new recovery codes → portal. Used codes are refused. When none
are left, the user is pointed to Mobi Support.

**Lost device (FR-05).** "Lost your device?" explains both routes: a recovery code, or Mobi Support.
The user can't start a reset themselves:
1. Support opens a request (ticket reference and reason).
2. A Security Admin records how identity was verified, ticks the confirmation, gives a reason, then resets.
3. The user's sessions end and they're emailed.
4. At their next sign-in they must register a new authenticator.

**Replace authenticator (FR-06).** Account security → enter the current app's code → scan the new QR
code → enter the new app's code → the old authenticator is revoked → email. Until the new code is
verified, the current authenticator keeps working. Without the current authenticator, the screen
points to a recovery code or Mobi Support.

**Regenerate recovery codes.** Account security → current code → 2 new codes shown once (tick to
finish). The previous codes stop working.

**Waive a block (FR-03, FR-07).** User security → Tech alerts or Users → *Waive block* → confirm it's
you → reason → the failed-attempt count is cleared, the alert is resolved, and the user can sign in.

## 3. Screens and states

| Screen | States |
| --- | --- |
| Login | As before, plus "Sign-in blocked", "2FA is now required" (rollout), "2FA was reset" notices. Left panel: generic wireframe. |
| 2FA intro (`/two-factor`) | first-time setup · after a recovery code (rebind) · preparing · error |
| Scan | QR code (loading placeholder) · grouped setup key with copy · app instructions |
| Confirm code | invalid / expired code (attempts left) · too many attempts → back to sign in · verifying |
| Recovery codes | codes + copy / download · acknowledgement required · codes hidden after a refresh (tick to continue, regenerate later) |
| 2FA on | confirmation → Continue |
| Enter code | invalid / expired (attempts left) · code already used · sign-in step countdown · verifying · "Use a recovery code" · "Lost your device?" |
| Recovery code | invalid (attempts left) · already used · none left |
| Lost device | recovery-code route · Support route with "Contact Mobi Support" |
| Signed in | "You're signed in", continues automatically |
| Blocked | Support contact, back to sign in |
| Timed out | the 5-minute second step expired → back to sign in |
| Account security (`/account/security`) | status (method, registered, last used, recovery codes left / running low / none) · replace (current code → new QR + code → done · "I don't have my current authenticator") · regenerate codes · load error |
| User security (`/security/users`) | not a security role (explains how to switch) · Users (search, status, actions) · Reset requests · Tech alerts · Audit log · confirm-it's-you dialog · request / reset / waive dialogs with validation · errors · success toasts |
| Demo authenticator | live code + 30-second timer, copy, minimise. Only shown where a code is needed; marked *Prototype*. |

## 4. Rules (simulated backend: `src/app/core/mock-server/auth-server.ts`, `totp.ts`)

| Rule | Value |
| --- | --- |
| Algorithm | RFC 6238 TOTP, HMAC-SHA1, 6 digits, 30 s (checked against the RFC test vectors) |
| Clock drift | ±1 step (±30 s) |
| Replay | each time step is accepted once per user ("code already used") |
| Block | on the 4th consecutive failed code or recovery code, anywhere (sign-in, Account security, admin confirmation); sign-in blocked and sessions ended until waived |
| Sign-in second step | must finish within 5 minutes of the password |
| New-authenticator confirmation | 5 wrong codes, then start again (doesn't count toward the block) |
| Recovery codes | 2, format `XXXX-XXXX-XXXX` (60 bits, no ambiguous characters), single use, case and dashes ignored |
| Admin confirmation | own TOTP code, valid 5 minutes, needed for every admin action |
| Who can do what | Support: view, open reset requests. Security Admin: view, reset (only with an open request), waive. No one can act on their own account. |
| Secrets | encrypted at rest (AES-GCM; the prototype keeps the key in browser storage to simulate a KMS); never returned after setup; never shown to admins |
| Recovery codes at rest | SHA-256 hashes only; plaintext shown once |
| Sessions | created only after both factors; ended on block, reset and rollout |

**Audit (FR-08)**, shown in User security → Audit log with the actor, affected user, time, reason
and detail. Events recorded:
- registration started / completed, and failed codes while confirming a new authenticator
- verified, failed and reused codes
- block, Tech alert, sign-in refused while blocked, waive-off
- recovery code used, codes regenerated
- replacement started / completed
- admin identity confirmed
- reset requested, identity verified, reset
- user notified
- rollout sessions ended

## 5. Acceptance criteria → evidence

| PRD criterion | Evidence |
| --- | --- |
| QR + manual key; valid TOTP activates, invalid doesn't | `mfa.spec.ts` FR-01/FR-02; browser walkthrough |
| Valid credentials alone don't grant access | `mfa.spec.ts` "requires a valid code…"; `auth-server.spec.ts` "never returns a session…" |
| Unique recovery codes, single use, used codes rejected | `mfa.spec.ts` FR-04 |
| Current factor required to replace; new verified before old revoked | `mfa.spec.ts` FR-06; browser walkthrough |
| Identity verification before an authorised reset | `mfa.spec.ts` FR-05/FR-07 (open request + identity confirmation + admin confirmation) |
| Permission and identity checked; reason and actor logged; user re-registers | `mfa.spec.ts` "Support opens a request, Security Admin verifies identity and resets…" |
| Security events logged and traceable | Audit log tab; audit assertions in `mfa.spec.ts` |
| Zero sessions without the second factor | session only from `/mfa/verify` or `/mfa/setup/complete`; rollout ends old sessions (`mfa.spec.ts` FR-09) |

Automated tests: 211 passing (30 new in `mfa.spec.ts`; the earlier suites now sign in through 2FA
via `testing/sign-in.ts`). A browser walkthrough covered setup, a wrong setup code, recovery codes,
regenerating codes, replacement, a recovery-code sign-in with forced re-setup, the block, lost
device, waive, reset request, reset, the audit log, and the mobile layout (no horizontal scroll,
no console errors).

## 6. QA test cases

| ID | Steps | Expected |
| --- | --- | --- |
| M-01 | Sign in as `123` / `Mobi@123` | 2FA intro; no *Skip*; only *Sign out* |
| M-02 | Continue → scan with a real authenticator app | Account "Mobi Global Platform: 123" appears in the app |
| M-03 | Enter a wrong code | "Incorrect or expired", 4 attempts left; 2FA not active |
| M-04 | Enter the right code | 2 recovery codes; *Finish setup* disabled until ticked |
| M-05 | Tick, Finish | "Two-factor authentication is on" → dashboard |
| M-06 | Sign out, sign in as `123` | "Enter your authenticator code" |
| M-07 | Enter the same code twice within 30 s (sign out between) | 2nd time: "That code was already used" |
| M-08 | Wait 5 min on the code screen | "Please sign in again" |
| M-09 | `TANJUNG-VIEWER`: 4 wrong codes | 3, 2, 1 attempts left, then "Too many incorrect codes" |
| M-10 | Sign in again as `TANJUNG-VIEWER` (correct password) | "Sign-in blocked"; `TANJUNG-ADMIN` still signs in |
| M-11 | View as Security Admin → Tech alerts | Open alert for Budi Santoso |
| M-12 | Waive block → confirm with own code → reason | Toast; alert resolved; Budi can sign in |
| M-13 | Sign in, "Use a recovery code instead", use a code | "Set up a new authenticator"; no portal access until done |
| M-14 | Finish the new setup | Email "authenticator was replaced"; old app's codes and the used recovery code no longer work |
| M-15 | Use the same recovery code again | "Already been used" |
| M-16 | Account security → Generate new codes (current code) | 2 new codes; old codes refused at sign-in |
| M-17 | Account security → Replace authenticator: current code, then new | "Authenticator replaced"; email; old app refused |
| M-18 | Replace: wrong code for the new authenticator | Error; old authenticator still works |
| M-19 | View as Mobi Support → Open reset request (ticket ref + reason) | Request RST-… listed as waiting |
| M-20 | View as Security Admin → Verify & reset (method, tick, reason) | Toast; user's sessions end; email; next sign-in asks for setup |
| M-21 | Try reset without the tick / method / reason | Button disabled; the server also refuses (`VALIDATION_FAILED`) |
| M-22 | Admin acts on their own row | No actions ("You"); the server refuses |
| M-23 | User security as Sales / Ops | Page explains how to switch; API returns `ROLE_NOT_PERMITTED` |
| M-24 | Audit log | Every step above, with actor, user, reason |
| M-25 | Open the site with a session from the previous build | Signed out: "Two-factor authentication is now required" |
| M-26 | Tick *Remember this device*, sign in, sign out | ID pre-filled; 2FA code still required |

## 7. What isn't real in this build

- No server: secrets and codes live in this browser's storage. The AES key sits next to the data,
  standing in for a KMS. Production must keep secrets in a service only the verification service can read.
- **Demo authenticator:** a prototype-only bypass that reads the current code from the simulated
  backend. Remove it with the mock backend.
- **Email:** notifications appear in the Email preview; nothing is sent.
- **Roles:** Support and Security Admin now have their own logins (`MOBI-SUPPORT`, `MOBI-SECURITY`)
  with fixed teams. Only `MOBI-ADMIN` can switch with "View as", so it could open and complete its
  own request. Production needs separate staff accounts and separation of duties.
- **Identity check:** the identity-verification method is free text, because the approved process
  isn't defined yet.

## 8. Open questions

1. **Identity verification for resets (PRD Q5):** what is the approved procedure? Should the reset
   form record specific checks?
2. **Notification channel (PRD Q6, §12):** confirm email is the approved channel, and its wording.
3. **Staff 2FA:** should Mobi staff (Support / Security Admin) logins also need 2FA when they become
   real accounts?
4. **Merchant-side multi-user management** (invite, roles, remove): confirm it's a later phase.
5. **Blocks:** should repeated blocks escalate (e.g. require a reset after N waive-offs)? Who on the
   Tech team gets the alert, and how (email, Slack, pager)?
6. **Rate limits:** confirm 3 failures / block-until-waived, the 5-minute second step, and ±30 s drift.
7. **Recovery codes:** confirm 2 codes, and whether a user with none left should be prompted at sign-in.
8. **Success metrics:** baselines and targets (§7) still to be agreed.
