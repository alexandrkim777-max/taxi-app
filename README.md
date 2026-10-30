# taxi-app

Subscription-based ride-hailing platform for Uzbekistan. Drivers pay a flat subscription
instead of a per-ride commission, set their own price inside a corridor, and keep 100% of the fare.
The price a passenger sees when ordering is the price they pay.

Working name — the brand name is not chosen yet.

## Repository layout

```
apps/
  api/        Backend (Node.js, TypeScript, Fastify)
  driver/     Driver app (React Native / Expo SDK 51): sign-up, documents, the line, orders, rides, price, subscription
  passenger/  Passenger app — next
  admin/      Staff panel (React + Vite): moderation, complaints, disputes, rides, prices, finance
packages/
  shared/     Shared types, i18n strings (uz / ru / en), design tokens
db/
  migrations/ Plain SQL migrations, applied in file-name order
docker-compose.yml  Local PostgreSQL + PostGIS and Redis
```

## Local development

Requirements: Node.js 22+, Docker.

```bash
cp .env.example .env
docker compose up -d          # PostgreSQL + PostGIS on 5432, Redis on 6379
npm install
npm run db:migrate            # applies db/migrations/*.sql
npm run dev:api               # API on http://localhost:3000
curl localhost:3000/health
```

In development SMS codes are printed to the API log (`SMS_PROVIDER=console`).

Tests: `npm test` (the API integration tests need a migrated database at `DATABASE_URL`).

## API so far

| Method | Path | Who | What |
| --- | --- | --- | --- |
| POST | `/auth/request-code` | anyone | Language (uz / ru / en, chosen on the first screen) + phone; sends a 6-digit SMS code; one per phone per 60 s, valid 5 min |
| POST | `/auth/verify` | anyone | Checks the code (max 5 attempts), returns a bearer token (90 days) |
| POST | `/staff/auth/verify` | staff | Panel sign-in step 1: SMS code → ticket (and a new authenticator key on the first sign-in) |
| POST | `/staff/auth/totp` | staff | Step 2: authenticator code → httpOnly session cookie (30 min idle, 12 h max) |
| POST | `/staff/auth/logout` | staff | Ends the panel session |
| POST | `/admin/users/:id/reset-2fa` | admin | Clears someone's authenticator (lost phone), ends their panel sessions |
| POST | `/auth/logout` | user | Revokes the current token |
| GET / PATCH | `/me` | user | Current user; change language or name |
| POST | `/drivers/apply` | user | Becomes a driver (status `pending`) |
| GET | `/drivers/me` | driver | Profile, vehicles, documents, missing document types |
| POST | `/drivers/me/vehicles` | driver | Adds a car; the class is set by a moderator |
| POST | `/drivers/me/documents/:type/photo` | driver | Uploads a document photo (body = the image, max 8 MB); replaces the previous one |
| GET | `/files/*?exp=&sig=` | signed link | A private file; links are issued for 10 minutes to the owner and staff only |
| GET | `/admin/drivers?status=pending` | staff | Moderation queue |
| POST | `/admin/drivers/:id/approve` | staff | Assigns the class, approves documents, starts the free trial month |
| POST | `/admin/drivers/:id/reject` | staff | Rejects with a reason the driver sees |
| GET | `/classes` | anyone | Vehicle classes with recommended tariff and price corridor |
| GET | `/drivers/me/tariff` | verified driver | Current tariff (or recommended), allowed bounds per component |
| PUT | `/drivers/me/tariff` | verified driver | New tariff version inside the corridor, at most once per 24 h |
| POST | `/quotes` | user | Route for 2–5 stops; per class the price range and up to two options, "cheaper" and "faster", each with price and ≈ pickup minutes |
| POST | `/drivers/me/online` | verified driver | Goes on the line (needs an active subscription) |
| POST | `/drivers/me/location` | driver on the line | Position ping every 3–5 s |
| POST | `/drivers/me/offline` | driver | Leaves the line (not during a ride) |
| GET | `/drivers/me/requests` | driver | Pending requests: 15 s to accept (one tap), 30 s (passenger's own pick) |
| POST | `/rides` | user | `priority: cheap \| fast` with `maxPriceTiyin` from the chosen option (the app's only way); `mode: choose` (list) remains API-only |
| POST | `/rides/:id/search` | passenger | List mode: refreshes the offers |
| POST | `/rides/:id/choose` | passenger | List mode: chooses an offer |
| POST | `/rides/:id/confirm-price` | passenger | One tap: accepts a higher price proposed when only pricier drivers are left |
| POST | `/rides/:id/accept` | chosen driver | Accepts; the offer price is locked into the ride |
| POST | `/rides/:id/decline` | chosen driver | Declines; one-tap rides go straight to the next driver |
| POST | `/rides/:id/status` | assigned driver | `driver_en_route` → `arrived` → `in_progress` → `completed` |
| POST | `/rides/:id/payment` | passenger | Switch to cash or another card (e.g. after a decline at 60% of the trip) |
| GET | `/rides/:id/cancel-terms` | participants | What cancelling now costs, with breakdown (fee + waiting) |
| POST | `/rides/:id/cancel` | passenger or driver | Before the trip starts; the passenger confirms any fee (`acceptFeeTiyin`), the driver may cancel as `noShow` after 5 min |
| GET | `/rating-tags?about=driver` | anyone | Tags for the end-of-ride screen (clean car, careful driving, …) in uz / ru / en |
| POST | `/rides/:id/rating` | participants | 1–5 + up to 5 tags after a completed ride (below 4: a tag or a reason), once, within 72 h |
| GET | `/me/ratings` | user | Own averages (shown after 5 ratings), completed and cancelled rides |
| GET | `/subscription-plans` | anyone | Plans for sale and enabled payment providers |
| GET | `/drivers/me/subscription` | verified driver | Active until, paid periods |
| POST | `/drivers/me/subscriptions` | verified driver | Buys a plan: returns the provider's checkout link |
| GET | `/payments/:id` | payer | Payment status (the app polls it after the checkout) |
| GET/POST/DELETE | `/me/cards` | user | Saved cards: the app sends the provider's token, never the card number |
| POST | `/me/cards/:id/default` | user | Default card |
| GET | `/me/debts`, POST `/me/debts/pay` | user | Unpaid card rides and cancellation fees; settle them with a card |
| POST | `/payments/webhooks/:provider` | provider | Server-to-server payment notifications (verified per provider) |
| GET | `/geo/search?q=&lat=&lng=` | user | Address and place search (our own Nominatim; 60 per minute) |
| GET | `/geo/reverse?lat=&lng=` | user | Address of a point on the map |
| GET | `/geo/entrances?lat=&lng=` | user | Known entrances (подъезды) within 120 m of a pickup |
| GET / PUT / POST / DELETE | `/me/places`, `/me/places/home`, `/me/places/work`, `/me/places/:id` | user | Saved places: home, work and up to 10 more |
| GET | `/me/rides?before=` | user | Past rides (20 per page): price, addresses, driver, car, whether a dispute is open |
| GET | `/geo/cars?lat=&lng=` | user | Free cars within 3 km for the map: positions snapped to a ~170 m grid, no ids or names |
| POST | `/rides/:id/block-driver` | passenger | Never match me with this ride's driver again (the driver is not told) |
| GET / DELETE | `/me/blocked-drivers`, `/me/blocked-drivers/:id` | user | The list; remove from it |
| DELETE | `/me` | user | Deletes the account (`{"confirm": true}`); refused during a ride or with unpaid amounts |
| POST / DELETE | `/me/push-token` | user | Register this device for push (Expo token, `app: driver \| passenger`); remove on sign-out |
| POST | `/rides/:id/complaint` | participants | Complaint about the ride (rude, unsafe driving, asked for extra cash, …) |

### Driver app

```bash
cd apps/driver && npm install           # standalone install (Expo prefers its own node_modules)
EXPO_PUBLIC_API_URL=http://<your-computer-ip>:3000 npm start   # open in Expo Go / a dev build
npm run build:demo                      # clickable web demo with a pretend server
```

- Language first (uz / ru / en), SMS login, then name and car, document photos (camera), moderation.
- The line: online switch, earnings today / this week and what was kept vs a 20% commission,
  subscription days left. While online the position is sent every few seconds, also with the screen
  off (background location with a visible notification, as the stores require).
- Incoming order with a 15-second countdown, pickup distance, trip, passenger rating; the ride with
  status buttons, free / paid waiting counter, cash to collect, Yandex / 2GIS / Google navigation,
  cancel or no-show; rating the passenger with tags.
- My price inside the corridor, subscription purchase through the payment provider's page.
- Session token in the phone's secure storage (Keychain / Keystore). Theme follows the design tokens
  and switches to night automatically after 19:00.
- Background location and the camera need a development build (`npx expo run:android`); Expo Go covers the rest.

### Passenger app

```bash
cd apps/passenger && npm install
EXPO_PUBLIC_API_URL=http://<your-computer-ip>:3000 EXPO_PUBLIC_TILES_URL=http://<map-server>:3001 npx expo run:android   # MapLibre needs a dev build
npm run build:demo                      # clickable web demo with a pretend server and a schematic map
```

- Language first (uz / ru / en), SMS login.
- Laid out the way passengers know from other taxi apps: the map over the whole screen with free cars
  around (approximate), the menu button, and a sheet with "From", "Where to?" with home / work buttons
  and a strip of saved and recent places. Drag the map to move the pickup pin.
- Side menu: profile and rating, my rides, payment, saved places, debts, about, "become a driver"
  (a link to the driver app, `EXPO_PUBLIC_DRIVER_APP_URL`).
- Profile: name, language, theme, blocked drivers, sign out, delete account (required by the stores).
- Order: entrance chips (learnt from earlier pickups) or a typed entrance number, extra stops, the class,
  then "Cheaper" or "Faster" (or one "Best option") with price and ≈ pickup time; an admin coefficient
  other than 1 is shown openly; cash or a saved card; wishes and a note behind one tap.
- Searching; "only a pricier driver is left" asks for consent; the driver card (rating, what passengers
  liked, car, plate), the car moving on the map, free / paid waiting, trip progress.
- Add a stop or change the destination: the new price is shown and applied only after confirming.
- Cancel shows the exact fee first (half while the driver is on the way after 3 min, full + waiting after
  arrival). A safety button files an unsafe-driving report and offers to call 102.
- Card declined at 60% of the trip: pay cash or pick another card. Unpaid amounts block the next order
  until paid.
- Rating with tags; ride history with complaint and dispute (both sides write their account).
- Cards are added through the payment provider's SDK (stubbed until access is granted); the card number
  never reaches our server. Requests time out (10–15 s); reads are retried once, writes never.

### Push notifications

Ride events are turned into notifications in the same database transaction (`push_outbox`) and sent
every second by a background loop through Expo's push service (`PUSH_PROVIDER=expo`). Drivers: a new
order rings on the loud `orders` channel and expires after 20 s; the passenger cancelled. Passengers:
driver on the way (car and plate), arrived, cancelled or could not wait, no driver found, confirm a
higher price, card declined. Texts are in the recipient's language. If the push service is down,
sending is retried (3 attempts); devices that no longer exist are dropped.

To turn it on in the apps: create the project in Expo (`eas init`), put its id in `EXPO_PUBLIC_EAS_PROJECT_ID`
(or `app.json` → `extra.eas.projectId`), and add the Firebase (Android) and APNs (iOS) credentials in EAS.

### Orders are safe to retry

The passenger app sends an `Idempotency-Key` with each order and retries once after a network error;
the server returns the same ride for the same key instead of creating a second one.

### CI

`.github/workflows/ci.yml` runs on every push: migrations on a fresh PostGIS database, type checks of
the API, admin, driver and passenger apps, the full API test suite, an admin build checked for demo
data, and `npm audit` for production dependencies.

### Maps

Our own maps, like Uklon: OpenStreetMap data, our style from the design tokens, our own routing (OSRM)
and address search (Nominatim), and our own entrance database. A pickup may name an entrance; when the
trip starts, the driver's position is stored as that entrance, so the next passenger at that house gets
"подъезд 3" with the exact point. Build steps are in [docs/maps.md](docs/maps.md).

## Admin panel API

Roles: **admin** (everything) and **support** (moderation, complaints, disputes, lookups).
Every action, including opening a dossier, is written to an append-only audit log.

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/admin/dashboard` | staff | Drivers online / on a ride, active rides, today's numbers, queues, coefficients |
| GET | `/admin/search?q=` | staff | By phone, plate or name |
| GET | `/admin/drivers/:id/dossier` | staff | Phone, car(s), documents, subscription, ratings and tags, rides, complaints, blocks |
| POST | `/admin/drivers/:id/documents/:docId/reject` | staff | Document must be uploaded again (with a note) |
| POST | `/admin/drivers/:id/vehicles/:vehicleId/class` | staff | Change a car's class |
| GET | `/admin/users/:id` | staff | Passenger profile |
| POST | `/admin/users/:id/block`, `/unblock` | staff | With a reason, optionally for N days; drivers leave the map at once |
| PUT | `/admin/users/:id/roles` | admin | Staff roles (an admin cannot remove their own) |
| GET | `/admin/complaints`, `/admin/complaints/:id` | staff | Queue (safety first) and details with the ride log |
| POST | `/admin/complaints/:id/assign`, `/resolve` | staff | Resolve or reject; optionally warn or block |
| GET | `/admin/rides?phone=&status=`, `/admin/rides/:id` | staff | Ride lookup with route, price changes, payments, ratings, complaints, dispute, log |
| GET | `/admin/pricing` | staff | Effective coefficient per class, tariffs, fees, plans |
| POST | `/admin/pricing/coefficients` | admin | Raise / lower prices: city or one class, 0.70–1.50, reason required, optional time window |
| POST | `/admin/pricing/coefficients/:id/end` | admin | End or cancel a coefficient rule |
| PUT | `/admin/pricing/classes/:code` | admin | Recommended tariff, cancellation fee, waiting |
| PUT | `/admin/pricing/plans/:code` | admin | Subscription price / availability |
| GET | `/admin/finance?days=` | admin | Payments by type, debts, refunds to send |
| GET | `/admin/audit` | admin | Who did what |
| GET | `/rides/:id` | participants | Ride, stops, offers or assigned driver with live position |
| GET | `/rides/active` | user | Current ride, to restore the app after a restart |
| POST | `/rides/:id/route/preview` | passenger | New price for added / removed / changed stops; nothing changes yet |
| POST | `/rides/:id/route` | passenger | Applies the change; must confirm the exact previewed price |
| GET | `/rides/:id/price-changes` | participants | History of price changes with old and new stops |
| POST | `/rides/:id/dispute` | participants | Opens a dispute with your account of what happened (up to 72 h after the ride) |
| POST | `/rides/:id/dispute/statement` | other side | Your account; 24 h to write it |
| GET | `/rides/:id/dispute` | participants | Status, your statement, the other's (after you wrote yours), decision |
| GET | `/admin/disputes?status=in_review` | admin | Dispute queue |
| GET | `/admin/disputes/:id` | admin | Both statements, the ride, its event log and price changes |
| POST | `/admin/disputes/:id/resolve` | admin | Decision and outcome, visible to both sides |

Security measures: see [SECURITY.md](SECURITY.md).

## How a ride is matched

Every nearby free driver of the class (up to 10, within their pickup radius, max 5 km) is priced
by **their own tariff**, clamped into the corridor. Then one of two modes:

**The passenger's choice (the MVP's core rule).** Four classes: Economy, Comfort, Business, Minivan.
For the chosen class the passenger sees at most two options, each with its total price and an
estimated pickup time (road time from the car's position by our OSRM, shown as "≈", never promised):

- **Cheaper** — lowest price among cars at most 15 minutes away (a pickup minute counts like 200 sum,
  so price decides).
- **Faster** — the nearest car (a pickup minute counts like 3 000 sum); the price may be a bit higher.
- Each rating point below 5.0 counts like 2 000 sum in both, so with similar price and pickup the
  better-rated driver wins.
- When the two would be the same driver, under 1 000 sum apart, or under 2 minutes apart, only one
  card is shown: **Best option**. No free car of the class: the app says so and offers to keep
  searching for up to 5 minutes at most at the recommended price.

There is no list of drivers, no bidding and no counter-offers. The price of the chosen option is the
passenger's ceiling:
1. The ride goes to the best driver by the chosen rule at or below the ceiling; they have 15 s to accept.
2. On decline or silence it goes to the next one by the same rule. A driver gets one request at a
   time and is never sent the same ride twice.
3. If only more expensive drivers are left, the passenger sees the new price and must confirm it.
   Nothing is ever charged above what the passenger agreed to; the final price can be lower.
4. No driver within 5 minutes: the system cancels with `no_drivers`.

The API still has a "choose from a list" mode (`mode: choose`), but the passenger app does not offer it.

On acceptance the price is copied into the ride and locked; the passenger then sees the plate and
the driver's live position until the ride ends. A dispatcher loop (every 2 s, safe on several
instances) handles timeouts and newly arrived drivers.

Live positions sit in an `UNLOGGED` PostgreSQL table behind `apps/api/src/dispatch/presence.ts`,
so they can move to Redis when load requires it without touching the ride logic.

## Admin panel

```bash
npm run dev:api                   # API on :3000
npm run dev:admin                 # panel on http://localhost:5173 (proxies /api to the API)
npm run build:demo -w apps/admin  # clickable demo with sample data (no API needed)
```

In production the panel and the API are served from one domain (`/admin` static files, `/api` → API),
so there is no CORS and the session never leaves the origin. Staff sign in with the same SMS login;
only accounts with the `admin` or `support` role get in.

Colors, type and spacing come from `packages/shared/design/tokens.json` (the design system):
`apps/admin/scripts/tokens-to-css.mjs` turns it into CSS variables for the day and night themes on
every build, so changing a token changes the panel without touching its code.

## Payments

Every provider sits behind one interface (`apps/api/src/payments/types.ts`). Connecting Payme, Click
or Uzum means filling in its adapter in `apps/api/src/payments/providers/` and setting its keys in the
environment; nothing else changes. Until then the adapters are stubs that refuse everything, and
development uses the `fake` provider (test page at `/dev/payments/:id`; card tokens `fake_tok_*`,
`fake_tok_decline_*` for a declined card).

- Driver subscriptions: hosted checkout; the paid period starts when the current one ends.
- Rides: cash (straight to the driver) or a saved card, charged at **60% of the trip** (by distance driven,
  from GPS pings, or by time). On a decline the app asks to pay cash or pick another card; the driver
  sees the amount to collect. Whatever is still due (e.g. a stop added later) is charged at the end.
- Cancellation fees: charged to the ride's card at once; on cash rides they become a debt.
- Debts (declined card, unpaid fee) must be settled before the next order.
- Fiscal receipts for subscriptions behind `payments/fiscal.ts` (stub until the OFD operator is connected).
- Not yet: payouts of card money to drivers, refunds.

## Principles (see the product spec)

- A general price coefficient (0.70–1.50, city or class, optional time window) is set by admins with a
  reason; it applies to new orders only, is stored on each ride, and is returned openly in quotes.
- Ride price is locked at acceptance. It changes **only** through (a) the passenger adding, removing or
  changing a stop and confirming the new price, or (b) paid waiting at the pickup: 2 free minutes, then the
  published class rate per minute (economy 500 sum), at most 30 minutes, shown live as a counter.
  No surge, no driver surcharges (enforced by the database).
- Disputes: both sides write what happened independently; a moderator decides with the ride log at hand.
- Cancellation, like Yandex: free for 3 minutes after the driver accepts; then half the class fee while the
  driver is on the way; at the pickup the full fee (5 000–10 000 sum) plus paid waiting. A driver can cancel
  as a no-show after 5 minutes at the pickup. The passenger confirms the amount first.
- Ratings both ways after every ride; better-rated drivers get one-tap orders first; drivers who cancel
  3 rides within 2 hours are paused for 30 minutes.
- Driver tariffs are versioned; old versions are never deleted.
- Nothing is hard-deleted: rows carry `deleted_at`.
- Ride status changes only through allowed transitions; every change is written to `ride_events`.
- Money is stored as integer tiyin (`bigint`), never as floats.
- Time is stored in UTC (`timestamptz`), shown in the user's time zone.
- All user-facing strings go through i18n (uz, ru, en) from day one. The user picks the language on the
  first screen; the API answers labels in that language (else `?lang=`, `Accept-Language`, Uzbek).
- A city is a first-class entity: a new city is configuration, not code.
- The map provider sits behind an adapter; the default is self-hosted OpenStreetMap.
- Personal data must be hosted in Uzbekistan in production; development uses test data only.
