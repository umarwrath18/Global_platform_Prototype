# Global Platform — Merchant Management & Onboarding (Batch 2)

Status: **Prototype built, awaiting Product, Risk and Engineering review.**
Scope: Global Merchant creation, country onboarding applications, country expansion,
Risk review, simulated CS readiness → go-live, merchant list/detail and notifications.
Country, currency, payment-method and pricing configuration appear only where the onboarding
workflow needs them. Self-onboarding, and full Risk, Finance, Settlement and Host modules,
are **not** built.

---

## 1. Decisions confirmed before build

| Question | Decision |
| --- | --- |
| Who acts as internal Sales/Ops, Risk and CS? | Any signed-in demo user. A **prototype-only "Acting as" switcher** in the top bar (dashed pink, labelled *Prototype*) sets the role. The simulated backend enforces it via an `X-Demo-Role` header. Batch 1 users and roles are unchanged. |
| Link to Batch 1 Global Accounts? | **Linked on go-live.** When a country application becomes *Operational*, that country is set to `active` on the merchant's Global Account. The account is created (with no users) on the first go-live if the merchant has none. Nothing changes before go-live. |
| Country rules | **Sample demo configuration** for MY, ID, VN, TH and PH in `src/app/core/merchants/onboarding-config.ts`. Not approved by Risk/Legal. |
| Pricing permission | **Sales/Ops** sets MDR per payment method, within each country's sample min–max range. Risk and CS see it read-only. |

## 2. Architecture (how it extends Batch 1)

- **No new dependencies.** Same Angular 21 standalone components, signals and design tokens.
- **Simulated backend:** `src/app/core/mock-server/merchant-server.ts`, served by the existing mock interceptor for `/api/merchants*`, `/api/applications*` and `/api/notifications*`. It validates the session with the auth server's own rules (`AuthServer.authenticate`) and enforces role permissions, status transitions, validation and duplicate checks itself.
- **Persistence:** browser `localStorage`, key `mobi.gp.merchantdb`. It is separate from the auth store (`mobi.gp.mockdb`), so Global Merchant / application data stays apart from login data.
- **API contract:** `src/app/core/merchants/merchant-models.ts`. Validation is shared by the UI and the server: `application-rules.ts`.
- **Layout:** a new `PortalShell` (top bar: navigation, notifications bell, prototype role switcher, user menu) wraps the dashboard and all merchant pages. The dashboard's top bar moved into this shell unchanged (same country switcher and user menu). The Login and Forgot Password screens are untouched.
- **Batch 1 changes, kept minimal:** `AuthServer` gained `authenticate()` and `activateCountry()`; `AuthService` gained `refresh()`; `mobiDemo.reset()` now resets merchant data too. The dashboard's "Features" card links to Merchant Management.

## 3. Data model

**Global Merchant** (`GM-100101` …): legal name, registration country, registration number, primary contact, created date/by, linked Global Account ID, and a **derived** global status: *Onboarding* (no operational country yet), *Active* (at least one operational country) or *No active applications* (all rejected). Creating the ID does not mean the merchant is approved.

**Country Application** (`APP-2026-0001` …): Global Merchant ID, country, currency, business/contact/bank/director data, document records, pricing lines, status, prefill sources, Risk corrections, simulated verification evidence, readiness checklists, sample key-set reference, submission count, link to the previous rejected application, and full history. Each application is independent: approval, configuration and go-live of one country never change another.

Rules:
- One open (non-rejected) application per merchant per country (`APPLICATION_EXISTS`).
- The same registration number in the same registration country is blocked as a duplicate (`DUPLICATE_MERCHANT`). A very similar legal name needs explicit confirmation (`POSSIBLE_DUPLICATE`).
- When a draft is submitted, the Global profile values are snapshotted onto the application, so Risk reviews what was submitted.

## 4. Workflows

**Flow A — Add new merchant** (`/merchants/new`): minimum global info → *Create Global Merchant ID* (ID issued immediately) → pick country → new draft application with prefill → guided form → Save draft / Submit.

**Flow B — Add country to existing merchant** (`/merchants/expand`): search → profile and existing applications shown → pick a country (countries with an open application are disabled) → new application linked to the same Global Merchant.

**Prefill:**

| Source | What is copied |
| --- | --- |
| Global profile | Trading name (from legal name), contact name/email/phone. The local registration number is copied when the merchant is registered in that country; it is then read-only. |
| Latest non-rejected application | Industry, website, support email, and directors (only if the country requires them, marked "please confirm"). |
| Never copied | Bank details, documents, pricing and tax IDs. These are always country-specific. |

**Application form** (`/applications/:id`): seven sections (Business, Contact, Bank, Directors, Documents, Payment methods & pricing, Review & submit). Each section shows its completion status, prefilled fields carry a source tag, and country-specific fields are tagged (e.g. *MY-specific*). Errors show on blur or when you leave a section; submission re-validates on the server. Missing required documents block submission. Unsaved changes are flagged, and leaving the page asks for confirmation.

**Statuses:**

```
Review:     Draft → Pending Risk review → Returned for correction ↺ / Rejected (final) / Risk approved
Readiness:  Risk approved → CS configuration → Production keys generated → Merchant integration
            → Go-live verification → Operational
```

- *Returned:* Risk gives a reason and picks the sections to correct. Sales/Ops edits the **same** application and resubmits; the ID, submission count and history are kept.
- *Rejected:* final. The application stays recorded. *Start a new application* creates a new ID linked to the same Global Merchant (`previousApplicationId`).
- *Approved:* not operational. CS must complete the configuration checklist before **Generate production keys (simulated)**, then integration, then go-live checks, then **Confirm go-live**.

**Verification:** generic, simulated evidence (registry lookup, sanctions/PEP screening, bank-name match, website check) produced on each submission. Labelled "Verification provider (to be confirmed) · Simulated". It never decides; Risk must confirm they reviewed it. Demo trigger: a person whose name contains "Flag" returns a screening match (see `APP-2026-0013`).

**Notifications:** events for submitted, resubmitted, returned, approved, rejected, configuration ready (keys generated) and go-live. Each is shown in-portal to the relevant teams (bell + `/notifications`, read state per role) and records a **simulated** email with its intended recipients. No email is sent.

## 5. Screens

| Route | Purpose | States |
| --- | --- | --- |
| `/merchants` | Merchant list: GM ID, name, registration, country applications with status, global status, created, last updated; search; application status / global status / registration country filters plus the top-bar filters; quick-filter counters | loading, error + retry, empty, no results + clear |
| `/merchants/new` | Flow A | field errors, duplicate (hard) and possible-duplicate (soft), role not permitted, success with GM ID |
| `/merchants/expand` | Flow B | search, no match, merchant summary, disabled countries, previous rejection note |
| `/merchants/:id` | Global profile (editable by Sales/Ops), country applications with progress, history across all countries | not found, empty applications |
| `/applications` | Team queues: Drafts & returned, Risk review, CS readiness, Operational, Rejected, All | empty per queue |
| `/applications/:id` | Two-lane status tracker, "Next: owner" hint (with a prototype "Act as" shortcut), status banners, guided form / Risk panel / CS readiness panel / read-only summary, history | loading, not found, read-only, toasts |
| `/notifications` | Notification history (for my team / all teams, filter by event) | empty |

## 5a. Visual design update (portal-wide)

Applied from the supplied UI reference, after these decisions were confirmed:

| Decision | Implementation |
| --- | --- |
| Scope | All screens, including Login / Forgot Password (style only; behaviour unchanged). |
| Navigation | Dark navy sidebar: workspace card, prototype role switcher, Dashboard / Merchants / Applications / Notifications. Approved MVP modules not yet built (Pay-ins, Payouts, Settlements, Transactions, Payment Methods, Hosts & Routing, Reports, Settings) are shown **disabled with a LATER tag** and are not clickable. Collapsible on desktop, off-canvas on mobile. |
| Dashboard | Reference layout (KPI cards with sparklines, pipeline row, by-country chart, *Attention required*), computed **only from prototype onboarding data**. No payment volumes, revenue or success rates are shown. The Batch 1 workspace/country access content is kept; the workspace switch (still `/dashboard/:country`, authorised by the server) is a labelled **Workspace** control in the page header. |
| Top bar | **Country, Merchant, Currency, Date range** filters (date = last update) applied to the dashboard, Merchants, Applications and Notifications; search for merchants and applications (Ctrl/⌘ + K); a prototype help popover; notifications. The filters are dimmed on pages they don't affect. Filter choices are remembered in this browser. |

Tokens added in `styles.scss`: `--nav-bg`, `--nav-bg-raised`, `--nav-border`, `--nav-text`, `--nav-text-muted`, `--nav-active`. Headings are now bold (700), as in the reference.

## 6. Demo data (`merchant-seed.ts`, all marked *Demo data*)

| Merchant | Scenario |
| --- | --- |
| GM-100101 Mobi Demo Trading Sdn Bhd → GA-1001 | MY/ID/VN operational, **TH in CS configuration** (2 of 4 done), PH rejected. This matches GA-1001's active/pending/failed countries. |
| GM-100102 New Demo Merchant Sdn Bhd → GA-4004 | MY pending Risk review, VN rejected |
| GM-100103 PT Demo Kopi Nusantara | ID returned for correction (documents, business) |
| GM-100104 Demo Saigon Travel JSC | VN partial draft |
| GM-100105 Demo Bangkok Bites Co., Ltd. | TH in merchant integration |
| GM-100106 Demo Manila Learning Inc. | PH in go-live verification; MY expansion draft (prefilled) |
| GM-100107 Demo FreshMart Sdn Bhd | MY resubmitted after a return; screening flag |
| GM-100108 Demo Pixel Games Pte. Ltd. (SG) | No applications yet |

Reset all data with `mobiDemo.reset()`, or only the merchant data with `mobiDemo.resetMerchants()`, in the browser console.

## 7. QA test cases

| ID | Steps | Expected |
| --- | --- | --- |
| M-01 | Sign in `123` → *Merchants* | 8 merchants. Counters, search and filters work. |
| M-02 | *Add new merchant* with registration no. `201901012345` (MY) | "This merchant already exists" + link to add a country to GM-100101 |
| M-03 | Legal name "Mobi Demo Trading", new reg. no. | Possible duplicate warning; *create anyway* works |
| M-04 | Valid new merchant | GM ID shown immediately; status *Onboarding* |
| M-05 | Pick Malaysia | Draft with contact and SSM number prefilled (tagged) |
| M-06 | Review & submit an empty draft | Blocked; items grouped by section with *Go to* links |
| M-07 | Enter a 5-digit account number / MDR outside the range | Field-level format and range errors |
| M-08 | Save draft, reload | Data resumed |
| M-09 | Complete all sections incl. sample documents → Submit | Pending Risk review; notification to Risk |
| M-10 | Act as Risk → *Applications* | Risk queue lists it; verification evidence shown |
| M-11 | Return without sections / comment | Validation errors |
| M-12 | Return (Documents) → act as Sales | Correction banner; Documents flagged; edit; resubmit with a note; same ID; submissions = 2 |
| M-13 | Risk approves | "Risk approved, not yet operational"; merchant still *Onboarding* |
| M-14 | Act as CS | Keys blocked until checklist done → keys (KS-DEMO-…) → integration → go-live → *Operational*; merchant *Active*; GA created |
| M-15 | *Add country* on the same merchant | Malaysia disabled; Thailand application prefilled; merchant count unchanged |
| M-16 | Risk rejects APP-2026-0012 | Confirmation step; final; Sales *Start a new Malaysia application* → new ID linked to the rejected one |
| M-17 | CS completes APP-2026-0010 (TH) to go-live | `/dashboard/TH` now opens for user `123` (TH active on GA-1001); PH still failed |
| M-18 | Notifications bell / history | Per-role unread count, mark read, simulated email recipients |
| M-20 | Top bar: Country = Indonesia | Merchants shows 2 (GM-100101, GM-100103); add Currency = THB → empty state; *Clear* restores 8 |
| M-21 | Ctrl/⌘ + K, type `APP-2026-0011`, Enter | Opens that application |
| M-22 | Collapse the sidebar; resize to mobile | Icon-only sidebar; on mobile the menu button opens the navigation drawer |
| M-19 | Batch 1 regression | Login, wrong password, sign-out, `/merchants` while signed out → login → back to `/merchants`; Forgot Password |

Automated: `npm test` runs 14 merchant-server unit tests (plus the 30 Batch 1 auth tests). The browser walkthrough above was also run with Playwright at desktop and 390 px widths.

## 8. Limitations (prototype only)

- Data lives in this browser's `localStorage`; it is not shared between users or devices, and clearing site data or `mobiDemo.reset()` restores the seed.
- Documents: only the file name and size are recorded; files are not uploaded or stored.
- Verification, production keys, integration, go-live checks and emails are **simulated**. No real provider, credentials or email are used.
- The acting role is a client-chosen header that the mock server trusts. In production the role must come from the authenticated user's permissions.
- Country rules, documents, payment methods and MDR ranges are sample values.

## 9. Open questions for Product / Risk

1. Real per-country requirements (documents, bank fields, director/UBO thresholds, tax IDs), and who owns that configuration.
2. Role-to-permission matrix: which Mobi users are Sales/Ops, Risk and CS, and can one user hold several roles?
3. Pricing: approval flow for MDR outside the standard range, and whether Risk/Finance must approve pricing.
4. Should a rejected application set the country to `failed`, or a submitted one to `pending`, on the linked Global Account? Currently only go-live changes it.
5. Who receives each email (merchant contact vs. internal teams), and is there an approved notification service?
6. Verification provider selection (AI Precise or another) and which checks are mandatory.
7. Duplicate-detection rules beyond registration number + name (e.g. tax ID, directors, bank account).
8. Should editing the Global profile after submission notify Risk or require re-review?
9. Merchant users on the linked Global Account: invitation and activation flow (out of scope here).
10. Self-onboarding (future): the application API is role-checked per action, so a merchant-facing role can later be allowed to edit drafts and submit without changing the review flow.
