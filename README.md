<p align="center">
  <img src="public/icons/logo.svg" alt="ServeFlow logo" width="96" />
</p>

<h1 align="center">ServeFlow</h1>

<p align="center">
  Ordering, kitchen workflow and sales management for a café or food vendor, used by its staff
  and administrators on a shared counter device.
</p>

<p align="center">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white" />
  <img alt="TypeScript 6" src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white" />
  <img alt="Vite 8" src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white" />
  <img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" />
  <img alt="shadcn/ui" src="https://img.shields.io/badge/shadcn%2Fui-components-000000?logo=shadcnui&logoColor=white" />
  <img alt="React Router 8" src="https://img.shields.io/badge/React_Router-8-CA4245?logo=reactrouter&logoColor=white" />
  <img alt="Firebase 12" src="https://img.shields.io/badge/Firebase-12-DD2C00?logo=firebase&logoColor=white" />
  <img alt="Vitest 5" src="https://img.shields.io/badge/Vitest-5-6E9F18?logo=vitest&logoColor=white" />
  <img alt="Testing Library" src="https://img.shields.io/badge/Testing_Library-React-E33332?logo=testinglibrary&logoColor=white" />
  <img alt="Prettier 3" src="https://img.shields.io/badge/Prettier-3-F7B93E?logo=prettier&logoColor=black" />
</p>

## Overview

ServeFlow is a web-based point-of-sale and sales-management system. Staff ring up orders on a
shared touch device, move them through the kitchen and record payment; an administrator manages
the menu, cost prices and till operators, and reads the day's takings, cost and estimated profit.

It is a React single-page application running directly on Firebase Authentication and Cloud
Firestore, served from Firebase Hosting. Firestore security rules are the authorization
boundary. There are two exceptions, each needing a trusted server: checking an Admin PIN to
authorise a void, and working out what an order costs. Four small Cloud Functions in `functions/`
do that and nothing else.

There are no customer accounts. Everyone who signs in works for the business, as either
**Staff** or **Admin**.

## Features

### Staff

- **New Order** — a touch terminal with the menu grouped by category, a running cart with
  quantity controls, and **dine-in** (with a required table number) or **takeaway**. The till
  asks who is making each order before it can be rung up.
- **Customisation** — items can offer modifier groups (for example sugar level or add-ons),
  single- or multiple-choice, required or optional, with per-option price adjustments.
- **Queue** — the kitchen board for the day: pending → preparing → ready → delivered, one step
  at a time, with a live timer from order creation to handover. A mis-tapped step can be taken
  back until the order is delivered, which is final.
- **Orders** — every order for a business date, with filters (payment state, fulfilment state,
  order type) and search. Orders are numbered per business date and cannot be edited.
- **Payment** — recorded as its own step, by cash (with change) or e-wallet, usually when the
  customer collects.
- **Voids** — staff can start a void on a sale; an administrator authorises it by signing in
  on the same screen.

### Admin

- **Dashboard** — today's orders, takings and kitchen state at a glance.
- **Reports** — any date range (presets or a custom range of up to 366 days): revenue,
  collected and outstanding money, estimated cost and profit, margin, cost coverage, payment
  breakdown, item performance and voided sales, with CSV export.
- **Orders** — the same order record staff see, with the ability to record payments and void a
  sale directly.
- **Menu management** — categories, items, prices, sort order, visibility and modifier groups
  (per item or shared across items), with translations for item and option names.
- **Cost prices** — an admin-only cost for each menu item and each modifier option, kept with
  an append-only history (see [Cost & Reporting](#cost--reporting)).
- **Staff roster** — the named till operators recorded on orders. They are identities, not
  Firebase accounts; operators can be added, renamed and deactivated but not deleted.

### Everyone

- **Settings** — the signed-in account's display name, the interface language and the colour
  theme (light, dark or follow the system).
- **Record keeping** — orders, payments and voids are immutable once written; every kitchen
  step is journalled; each record stores both the signed-in account and the till operator, and
  a void stores who requested it and who authorised it.

## Tech Stack

| Area            | Technology                                                                                 | Version (`package.json`) |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| UI              | React, React DOM                                                                           | ^19.2                    |
| Language        | TypeScript                                                                                 | ~6.0                     |
| Build           | Vite with `@vitejs/plugin-react`                                                           | ^8.3                     |
| Styling         | Tailwind CSS (via `@tailwindcss/vite`), `tw-animate-css`                                   | ^4.3                     |
| Components      | shadcn/ui components on Radix UI primitives (`radix-ui`), `class-variance-authority`, `cn` | radix-ui ^1.6            |
| Icons           | Lucide React                                                                               | ^1.44                    |
| Font            | Geist (`@fontsource-variable/geist`)                                                       | ^5.3                     |
| Routing         | React Router                                                                               | ^8.3                     |
| Backend         | Firebase Authentication (email/password), Cloud Firestore                                  | firebase ^12.19          |
| Local dev       | Firebase Local Emulator Suite (Auth, Firestore), via `firebase-tools`                      | ^15.30                   |
| Hosting         | Firebase Hosting                                                                           | —                        |
| Tests           | Vitest, Testing Library (React, user-event), jsdom, `@firebase/rules-unit-testing`         | vitest ^5.0              |
| Lint and format | oxlint, Prettier                                                                           | ^1.81, ^3.9              |

Server state is read through small custom hooks over Firestore's live listeners rather than a
query library, and forms use plain component state with pure validation functions.

## Architecture

```text
Browser (React SPA)
  └─ Route guards        RequireAuth, RequireRole      src/features/auth/
      └─ Feature pages   POS, orders, queue, menu, reports, staff, settings
          ├─ Read hooks  live Firestore listeners, scoped to one business date or one document
          └─ Write APIs  one module per operation: create order, record payment, move an
                         order through the kitchen, void, edit the menu, manage the roster
              └─ Firebase JS SDK ──► Firebase Authentication
                                  └► Cloud Firestore ◄── firestore.rules
```

- **Feature-based source.** Each area of the product lives in `src/features/<area>/`, holding
  its pages, its Firestore hooks and write APIs, and its pure logic (cart arithmetic, money,
  fulfilment transitions, report aggregation). The pure modules have no React or Firestore
  imports, so they are unit-tested directly.
- **Shared UI.** `src/components/ui/` holds the shadcn/ui components, `src/components/layout/`
  the app shell (top bar, sidebar, mobile navigation) and `src/components/data/` the small
  display components used by the dashboard and reports.
- **Reads.** Pages subscribe to exactly what they show — the orders of one business date and
  their payment, fulfilment and void records — rather than whole collections. The Orders list
  and the Queue share one workspace hook, so both always show the same state for an order.
- **Writes.** Orders are never updated. Payment, fulfilment and voids are separate documents
  keyed by the order id, so the sale itself stays exactly as it was rung up. Order numbers come
  from a per-day counter updated in a transaction.
- **Security rules.** `firestore.rules` decide who may read and write what, and validate the
  shape and values of every write: role checks, required fields, the one-step-at-a-time
  kitchen workflow, amounts matching the order, and immutability. The route guards only keep
  people out of screens they cannot use.
- **Development and production.** Locally the app talks to the Firebase Local Emulator Suite;
  in production it is built by Vite and served from Firebase Hosting.

### Firestore collections

| Collection                                                                                 | Purpose                                                   |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `users`                                                                                    | Account profiles: display name, role, active flag         |
| `staffMembers`                                                                             | Named till operators                                      |
| `categories`, `menuItems`, `modifierGroups`                                                | The menu                                                  |
| `menuItemCosts`, `menuItemCostHistory`, `modifierOptionCosts`, `modifierOptionCostHistory` | Cost prices and their history (admin only)                |
| `orders`, `counters`                                                                       | Sales, and the per-day order number                       |
| `orderPayments`, `orderFulfillment` (+ `transitions`), `orderVoids`                        | Payment, kitchen state and its journal, and cancellations |

## Project Structure

```text
├── public/
│   ├── manifest.webmanifest    Web app manifest
│   ├── icons/                  Logo, wordmark, favicon and PWA icons
│   └── screenshots/            Install-dialog screenshots (the empty sign-in page)
├── src/
│   ├── App.tsx                 Routes and providers
│   ├── main.tsx                Entry point
│   ├── index.css               Tailwind theme and design tokens
│   ├── components/
│   │   ├── ui/                 shadcn/ui components
│   │   ├── layout/             App shell, navigation
│   │   └── data/               Stat cards, panels, empty states
│   ├── features/
│   │   ├── auth/               Sign-in, AuthProvider, route guards, profiles
│   │   ├── pos/                New Order, Orders, Queue, payments, fulfilment, voids
│   │   ├── menu/               Menu, categories, modifiers, costs, translations
│   │   ├── reports/            Report data, aggregation, CSV export
│   │   ├── dashboard/          Today's summary
│   │   ├── staff/              Till operator roster and selection
│   │   ├── settings/           Account, language and theme
│   │   ├── i18n/               Languages, dictionaries, LanguageProvider
│   │   └── theme/              Light, dark and system theme
│   ├── lib/                    Firebase setup, environment checks, money, shared hooks
│   └── pages/                  403 and 404 pages
├── tests/
│   ├── unit/                   Pure logic
│   ├── components/             React components in jsdom
│   ├── rules/                  Firestore security rules
│   └── integration/            Write APIs against the emulators
├── design/                     Source artwork (not shipped)
├── firebase.json               Emulators, Hosting and rules configuration
├── firestore.rules             Security rules
├── firestore.indexes.json      Firestore indexes
└── .env.example                Required environment variable names
```

## Authentication & Authorization

- **Firebase Email/Password Authentication.** There is no sign-up screen and no customer
  account. Accounts are created by an administrator in Firebase Authentication, and each needs
  a profile document at `users/{uid}` holding its `role` (`admin` or `staff`), `displayName`
  and `active` flag.
- **Profile checks.** A signed-in user with no profile, or with `active: false`, is signed out
  again. A deactivated profile ends an open session without a reload.
- **Roles.** Staff reach New Order, Queue, Orders and Settings; admins reach Dashboard,
  Reports, Orders, Menu, Staff and Settings. The kitchen workflow belongs to staff; menu, cost,
  roster and reporting data belong to admins.
- **Enforcement.** Route guards (`RequireAuth`, `RequireRole`) keep people out of screens they
  cannot use, but the real boundary is `firestore.rules`: a staff account cannot read cost data,
  edit the menu or void a sale however the request is made.
- **Server-priced orders.** The till sends only what was chosen. The `placeOrder` function reads
  the prices and names from the menu, enforces the customisation rules, works out the total and
  writes the order and its number in one transaction, using the café's own calendar
  (`Asia/Kuala_Lumpur`). If a price or a name differs from what the till showed, nothing is
  written and the cart shows the current ones first. A retry with the same request id returns the
  same order.
- **Admin PIN for voids.** When staff start a void, an administrator enters their own six-digit
  PIN. The PIN is checked by a Cloud Function, never in the browser: PINs are stored only as
  salted scrypt hashes in `adminPins/{uid}`, which no client can read or write. The function
  derives who is asking from the signed-in token, re-checks every condition the void rule
  imposes, and writes the same `orderVoids` record as before. Five wrong PINs lock that signed-in
  account's PIN attempts for 15 minutes; failures across all accounts are logged as a warning
  once they pass 15 in an hour, without locking anyone else out. Admins set or change their own
  PIN in Settings after re-entering their password; no two admins may share a PIN.
- **Manager sign-in (fallback).** Until an administrator has set a PIN, or if the functions
  cannot be reached, a void is authorised as before: an administrator signs in on a second,
  in-memory Firebase Auth session that exists only for that one write. The till's own session is
  never elevated.
- **Till operators** chosen on the device are a record of who did what, not an authorization
  boundary.

## Cost & Reporting

Reports estimate cost and profit from the cost prices administrators record.

- **Recorded costs.** Each menu item and each modifier option can have a cost price, visible
  only to administrators.
- **History.** Every change is appended to a cost history with the time it took effect
  (`effectiveFrom`). History entries are never edited or deleted.
- **Cost at the time of sale.** For each order line, reports use the newest history entry whose
  `effectiveFrom` is on or before the order's `createdAt`. Changing a cost today therefore never
  changes the cost, profit or margin of sales already made.
- **Missing costs.** A line with no cost in force when it was sold is left uncosted rather than
  given an invented figure. Reports show cost coverage — the share of revenue whose cost is
  known — and treat profit as an upper bound when coverage is incomplete. An item recorded
  before cost history existed, and never changed since, uses its current cost.
- **Voided sales** are excluded from revenue, cost and profit and listed separately.

## Internationalization

- **Languages:** English, Bahasa Melayu and Chinese (Simplified). The language is chosen per
  device, stored in `localStorage` and applied to `<html lang>`. English is the fallback.
- **Dictionaries:** interface text lives in typed dictionaries in
  `src/features/i18n/translations/`, with `en.ts` as the source of truth. Every dictionary has
  the `Dictionary` type, so a missing key is a build error.
- **Vendor text stays as typed.** Categories, modifier group names, staff names and void reasons
  are shown exactly as entered. Components can only translate keys, not arbitrary strings.
- **Multilingual menu names.** A menu item's name and a modifier option's name can each be
  translated by the vendor; a missing translation falls back to English.
- **Orders keep what the customer was shown.** The item and option names are snapshotted onto
  each order line in the till's language, so later renames or translations never change a past
  sale.
- CSV exports keep stable English column headers.

To add a language, add its code, endonym and tag in `src/features/i18n/languages.ts`, copy
`translations/en.ts` to a new dictionary typed as `Dictionary`, and register it in
`LanguageProvider.tsx`.

## PWA & Hosting

ServeFlow can be installed from the browser as an app. `public/manifest.webmanifest` sets the
name, a short description, the `standalone` display mode, `/` as start URL and scope, the theme
colour, 192 × 192, 512 × 512 and maskable 512 × 512 icons, and two screenshots for the install
dialog. Orientation is not locked, so a tablet can rotate.

### Installing

- **Windows, Chrome or Edge:** open the production URL, then use the install icon at the right of
  the address bar, or the browser menu's install entry (its wording varies between versions).
  ServeFlow then has its own window, Start menu entry and taskbar icon.
- **Android, Chrome:** open the production URL, then choose **Install app** (or **Add to Home
  screen**) from the ⋮ menu. Chrome may also offer it on its own once the page has been used for
  a short while.
- **iPhone and iPad (optional, not tested):** Safari's Share menu, **Add to Home Screen**. The
  home-screen icon is the full-bleed maskable icon, linked as `apple-touch-icon`.

The install dialog shows the description and the screenshots in `public/screenshots/`: the empty
sign-in page, wide for desktop and narrow for phones. They must never show real orders, staff,
customers or prices; retake them from the sign-in page or from synthetic demo data only.

### Running as an installed app

- It opens in its own window without the address bar, at `/`, which leads to sign-in or the
  signed-in user's start page. Every route stays inside the app.
- It shares the browser's storage for the site, so signing in or out in one also applies to the
  other on the same browser profile.
- With no service worker there is nothing cached to go stale: each launch or reload loads the
  build currently deployed, exactly like a browser tab. A window left open keeps running the build
  it loaded, so reload every till after a deploy.

### Online only

ServeFlow is an online-first point of sale. Signing in, the menu, placing an order (priced by
`placeOrder` on the server), payments, voids and the kitchen queue all need a network connection.

- There is **no service worker and no offline mode**. Nothing is cached for offline use: not the
  app, not sign-in tokens, not Firestore data, not orders. Firestore uses its in-memory cache only.
- Without a connection the installed app shows the browser's offline page or a connection error.
  Orders and payments are never taken offline; that is deliberate, not missing.
- `tests/unit/web-app-manifest.test.ts` fails if a service worker or worker script is added, so
  that change has to be made on purpose.

### Hosting

Firebase Hosting serves the Vite build from `dist/` and rewrites every path to `index.html` for
client-side routing. Hashed files under `/assets/` are cached for a year as immutable; everything
else, including `index.html`, every route, the manifest, icons and screenshots, is `no-cache`, so
a browser revalidates it on every load.

## Measuring performance

Timings only: nothing here changes how an order, a void or a payment is handled, and none of it
reads or writes Firestore.

**Server.** `placeOrder` and `voidOrderWithAdminPin` add a `perf` object to the line they already
log on success (`Order placed`, `Order voided with admin PIN`). It holds whole milliseconds per
stage (`authMs`, `catalogueMs`, `txMs`, `adminLookupMs`, `attemptSpendMs`, `pinCheckMs`,
`attemptResetMs`, `voidTxMs`) and `totalMs`, attempt counts (`txAttempts`, `attemptSpendAttempts`,
`voidTxAttempts`), `pinChecks`, `replayed` (an idempotent retry answered with the existing order),
and `firstRequestOnInstance`, `requestOrdinal`, `instanceAgeMs` and `moduleLoadMs`. It never holds a
name, id, price, table, reason or PIN (`functions/src/telemetry.ts`). Refused calls log no line, as
before. Container start-up and the token check happen before the handler, so they are not in
`totalMs`: Cloud Run's own request and system logs have them, joined by the `instanceId` label and
trace Cloud Run attaches to every line.

**Order warm-up.** After a quiet spell `placeOrder` has no running instance, and the first order
used to pay for starting one and for its first Firestore connection. The till now sends
`{ warmup: true }` to `placeOrder` when it opens, when it comes back into view, when an operator is
chosen and on the first item of an order — never on a timer. The function checks the caller exactly
as it does for an order (one read of their own profile), logs an `Order warm-up` line holding only
`perf` timings, and answers `{ warm: true }`: it writes nothing and places nothing. The till sends
one at a time, none within five minutes of one that succeeded, and only for the account Firebase
Auth is signed in as; nothing waits for it, and a failure is silent
(`src/features/pos/order-warmup.ts`). Cloud Run may still serve the order from another instance.

**Browser (off by default).** On the device to measure, run
`localStorage.setItem('serveflow.perf', '1')` in the DevTools console and reload; remove the key and
reload to stop. Each measurement then appears as a `[perf]` console line and a `serveflow:` entry
in the Performance panel: session restore and sign-in, the first answer for each menu collection,
the order warm-up, the order call and Place order → payment question, the PIN status and void calls and a confirmed
void → shown on the page, and orders reaching the Queue (whose `approxSinceCreatedMs` compares this
device's clock with the server's, so is only approximate). Nothing is sent anywhere or stored
(`src/lib/perf.ts`).

## Getting Started

### Prerequisites

| Requirement         | Notes                                                                      |
| ------------------- | -------------------------------------------------------------------------- |
| Node.js 22 or newer | Developed on Node 24. The Cloud Functions run on Node 22.                  |
| JDK 21 or newer     | Required by the Firebase emulators.                                        |
| A Firebase project  | Spark is enough locally; deploying the Admin PIN functions requires Blaze. |

The Firebase CLI is a dev dependency, so nothing needs installing globally; run it with `npx`.

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. In the Firebase console, add a Web app, enable **Authentication → Email/Password** and create
   a **Firestore** database.
3. Copy `.env.example` to `.env.local` and fill in the values from **Project settings → General →
   Your apps**. Keep `VITE_USE_EMULATORS=true` for local development. Set your project id in
   `.firebaserc`. `.env.local` is gitignored; a missing variable stops the app at startup and names
   the one that is missing.
4. Create accounts: add a user in Authentication (the Emulator UI locally, the Firebase console
   in production), then create `users/{uid}` in Firestore with `uid`, `email`, `displayName`,
   `role` (`admin` or `staff`), `active: true` and `createdAt`.

### Running locally

```bash
npm --prefix functions install   # once: the Cloud Functions' own dependencies
npm run emulators                # builds functions/, then Auth, Firestore, Functions and the UI
npm run dev                      # Vite dev server
```

The emulators run as the local-only project `demo-serveflow` (a `demo-` id can never reach a
real Firebase project). Set `VITE_FIREBASE_PROJECT_ID=demo-serveflow` in `.env.local` so the app,
the Auth emulator and the Functions emulator all use the same project. Emulator data is held in
memory and is lost when the emulators stop.

### Scripts

| Command                   | Purpose                              |
| ------------------------- | ------------------------------------ |
| `npm run dev`             | Start the Vite dev server            |
| `npm run build`           | Type-check and build for production  |
| `npm run preview`         | Serve the production build locally   |
| `npm run typecheck`       | TypeScript: the app and `functions/` |
| `npm run build:functions` | Compile the Cloud Functions          |
| `npm run lint`            | Lint with oxlint                     |
| `npm run format`          | Format with Prettier                 |
| `npm run format:check`    | Check formatting                     |
| `npm run emulators`       | Build functions, start the emulators |
| `npm test`                | Run every test suite                 |

## Testing

| Command                    | Suite                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| `npm run test:unit`        | Pure logic: money, cart, fulfilment, reports, cost history, i18n |
| `npm run test:components`  | React components in jsdom with Testing Library                   |
| `npm run test:rules`       | `firestore.rules` against the Firestore emulator                 |
| `npm run test:integration` | The app's write APIs against the Firestore and Auth emulators    |
| `npm run test:functions`   | The Cloud Functions against all three emulators                  |

All suites run on Vitest. The rules, integration and functions suites start their own emulators
with `firebase emulators:exec`, so stop `npm run emulators` before running them. Each suite uses
its own test project id, so none of them can reach a real project.

## Deployment

Production configuration goes in `.env.production.local` (gitignored). It has to state every
variable in `.env.example` for itself, with `VITE_USE_EMULATORS=false`: `npm run build` refuses to
run otherwise, because Vite would fill any gap from `.env.local`.

The Cloud Functions need the **Blaze (pay-as-you-go)** plan to deploy; local development and the
emulators do not. Placing an order depends on them, so the till cannot sell without them.

### Stage 1: the initial rollout

Deploy in this order, one step at a time, and let each finish before starting the next:

```bash
npx firebase deploy --only firestore:rules
npx firebase deploy --only functions
npx firebase deploy --only hosting
```

The rules go first because tills still on the previous build keep working under them. The
functions go before Hosting because the new build cannot place an order without `placeOrder`.
`firebase.json` runs `npm run build` before every Hosting deploy.

Then reload every till: an open tab keeps running the build it loaded. Direct writes to `orders`
and `counters` stay open throughout this stage, for any till that has not reloaded yet.

### Stage 2: closing direct order writes

This is a separate, later rules change, and no part of the rollout above. Apply it only once the
functions and Hosting are live and every till has reloaded the new client. From then on a till
still running the previous build cannot place an order.

## Known limitations

- `placeOrder` prices every order the app places, but Firestore still accepts a direct write to
  `orders` so that tills open on the previous build keep working. Rules cannot sum a list, so a
  modified client can bypass the function until those writes are closed.
- A till remembers an order it never heard back about for 30 minutes, as a hash and a request id,
  so ringing the same order up again after a reload returns the original. Changing anything about
  it, including a price or a name that moved in the meantime, makes it a new order.
- Estimated profit is an upper bound wherever cost coverage is incomplete.
- Till operator attribution is a record, not an authorization control — the signed-in role is
  the only real gate.
- Without a service worker, the installed app does not work offline.
