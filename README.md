# taxi-app

Subscription-based ride-hailing platform for Uzbekistan. Drivers pay a flat subscription
instead of a per-ride commission, set their own price inside a corridor, and keep 100% of the fare.
The price a passenger sees when ordering is the price they pay.

Working name — the brand name is not chosen yet.

## Repository layout

```
apps/
  api/        Backend (Node.js, TypeScript, Fastify)
  mobile/     Passenger + driver app (React Native / Expo) — not scaffolded yet
  admin/      Admin and corporate web panel (Next.js) — not scaffolded yet
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
| POST | `/auth/request-code` | anyone | Sends a 6-digit SMS code; one per phone per 60 s, valid 5 min |
| POST | `/auth/verify` | anyone | Checks the code (max 5 attempts), returns a bearer token (90 days) |
| POST | `/auth/logout` | user | Revokes the current token |
| GET | `/me` | user | Current user |
| POST | `/drivers/apply` | user | Becomes a driver (status `pending`) |
| GET | `/drivers/me` | driver | Profile, vehicles, documents, missing document types |
| POST | `/drivers/me/vehicles` | driver | Adds a car; the class is set by a moderator |
| POST | `/drivers/me/documents` | driver | Uploads a document link; replaces the previous one of that type |
| GET | `/admin/drivers?status=pending` | admin | Moderation queue |
| POST | `/admin/drivers/:id/approve` | admin | Assigns the class, approves documents, starts the free trial month |
| POST | `/admin/drivers/:id/reject` | admin | Rejects with a reason the driver sees |
| GET | `/classes` | anyone | Vehicle classes with recommended tariff and price corridor |
| GET | `/drivers/me/tariff` | verified driver | Current tariff (or recommended), allowed bounds per component |
| PUT | `/drivers/me/tariff` | verified driver | New tariff version inside the corridor, at most once per 24 h |
| POST | `/quotes` | user | Route for 2–5 stops; per class the price range and the one-tap price (best nearby driver, pickup minutes) |
| POST | `/drivers/me/online` | verified driver | Goes on the line (needs an active subscription) |
| POST | `/drivers/me/location` | driver on the line | Position ping every 3–5 s |
| POST | `/drivers/me/offline` | driver | Leaves the line (not during a ride) |
| GET | `/drivers/me/requests` | driver | Pending requests: 15 s to accept (one tap), 30 s (passenger's own pick) |
| POST | `/rides` | user | `mode: auto` (default, one tap with `maxPriceTiyin` from the quote) or `mode: choose` (list of drivers) |
| POST | `/rides/:id/search` | passenger | List mode: refreshes the offers |
| POST | `/rides/:id/choose` | passenger | List mode: chooses an offer |
| POST | `/rides/:id/confirm-price` | passenger | One tap: accepts a higher price proposed when only pricier drivers are left |
| POST | `/rides/:id/accept` | chosen driver | Accepts; the offer price is locked into the ride |
| POST | `/rides/:id/decline` | chosen driver | Declines; one-tap rides go straight to the next driver |
| POST | `/rides/:id/status` | assigned driver | `driver_en_route` → `arrived` → `in_progress` → `completed` |
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

**One tap (default, like Yandex).** The order button shows one price and pickup time: the best
nearby driver, weighing price and pickup time (1 minute of pickup = 1 000 sum). That price is the
passenger's ceiling.
1. The ride goes to the best driver at or below the ceiling; they have 15 s to accept.
2. On decline or silence it goes to the next one. A driver gets one request at a time and is
   never sent the same ride twice.
3. If only more expensive drivers are left, the passenger sees the new price and must confirm it.
   Nothing is ever charged above what the passenger agreed to.
4. No driver within 5 minutes: the system cancels with `no_drivers`.

**Choose a driver (list).** The passenger sees model, colour, rating, distance and price — not the
plate or exact position — and picks one; the driver has 30 s to accept.

On acceptance the price is copied into the ride and locked; the passenger then sees the plate and
the driver's live position until the ride ends. A dispatcher loop (every 2 s, safe on several
instances) handles timeouts and newly arrived drivers.

Live positions sit in an `UNLOGGED` PostgreSQL table behind `apps/api/src/dispatch/presence.ts`,
so they can move to Redis when load requires it without touching the ride logic.

## Payments

Every provider sits behind one interface (`apps/api/src/payments/types.ts`). Connecting Payme, Click
or Uzum means filling in its adapter in `apps/api/src/payments/providers/` and setting its keys in the
environment; nothing else changes. Until then the adapters are stubs that refuse everything, and
development uses the `fake` provider (test page at `/dev/payments/:id`; card tokens `fake_tok_*`,
`fake_tok_decline_*` for a declined card).

- Driver subscriptions: hosted checkout; the paid period starts when the current one ends.
- Rides: cash (straight to the driver) or a saved card, charged on completion.
- Cancellation fees: charged to the ride's card at once; on cash rides they become a debt.
- Debts (declined card, unpaid fee) must be settled before the next order.
- Fiscal receipts for subscriptions behind `payments/fiscal.ts` (stub until the OFD operator is connected).
- Not yet: payouts of card money to drivers, refunds.

## Principles (see the product spec)

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
- All user-facing strings go through i18n (uz, ru, en) from day one.
- A city is a first-class entity: a new city is configuration, not code.
- The map provider sits behind an adapter; the default is self-hosted OpenStreetMap.
- Personal data must be hosted in Uzbekistan in production; development uses test data only.
