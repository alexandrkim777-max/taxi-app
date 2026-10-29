# Security

How the codebase protects users and drivers. Keep this list current when adding features;
every item below has a regression test in `apps/api/test/security.test.ts` or the module tests.

## Login (SMS codes)

- Codes are 6 digits, valid 5 minutes, single use (consumed atomically).
- Codes are stored only as an HMAC with `AUTH_SECRET`, never in plain text.
- Brute force: at most 5 attempts per code, counted atomically before comparison, so parallel
  requests cannot exceed the limit; the code is burned after that.
- SMS-pumping / cost abuse: one code per phone per minute, 5 per phone per hour,
  and 5 login requests per IP per minute on top of a global 120 requests per IP per minute.

## Sessions

- Opaque random bearer tokens (256 bit); only their sha256 is stored.
- 90-day expiry, revocable on logout; revoked or expired tokens are rejected.
- `Authorization` and cookie headers are redacted from logs.

## Input and data

- Every endpoint validates its body with a JSON schema; unknown fields are rejected, not ignored.
- All SQL uses parameters; no string-built queries with user input.
- Ids in URLs are validated before reaching the database.
- Request bodies are capped at 64 KB.
- Document photos are checked by their first bytes (JPEG, PNG, WebP, HEIC only), max 8 MB, stored under
  random names outside any public folder, and served only through 10-minute HMAC-signed links issued to
  the driver and to staff. Served with `nosniff`, `Content-Security-Policy: default-src 'none'`.
- Route distance and time are always computed on the server; clients cannot submit their own.
- Quote coordinates are limited to Uzbekistan.

## Business rules enforced on the server

- A vehicle class is set only by a moderator; drivers cannot choose it.
- Driver tariffs must stay inside the class corridor (never above the reference price, never below the floor)
  and can change at most once per 24 hours; every version is kept.
- Moderation endpoints require the `admin` role.

## Rides and dispatch

- Only a ride's passenger and assigned driver can see or act on it; everyone else gets 404
  (not 403), so ride ids cannot be probed.
- Only the assigned driver moves the status forward, one allowed step at a time; the passenger cannot.
- The price is never sent by the client: it comes from the chosen driver's stored tariff, clamped into the
  corridor on the server, and is copied into the ride on acceptance. Later tariff changes do not affect it.
- Before acceptance the passenger sees no plate and no exact driver position (distance rounded to 100 m);
  pickup and destination are shown to a driver only after the passenger chooses them.
- Live driver position is shown only to the ride's passenger and only while the ride is active.
- Going online and accepting require a verified driver, an approved vehicle class, an active subscription
  and no active block; blocked users cannot order. A driver is never offered their own order.
- One active ride per passenger and per driver, enforced by unique indexes, so parallel requests
  cannot create duplicates or let a driver accept two rides; covered by a race test.
- One tap: the passenger's ceiling only filters drivers, it never sets anyone's price, and must lie inside the
  route's corridor. A higher price is used only after the passenger confirms that exact amount.
- A driver holds at most one pending request; the driver row is locked while reserving, so two rides
  dispatched at the same moment cannot both reach the same driver (covered by a parallel test).
- A driver who declined or let a request lapse is never sent that ride again.
- Choices, acceptances and status changes run in transactions with row locks; every step is written to `ride_events`.
- Abuse limits: 20 rides per passenger per hour, 10 ride requests and 20 searches per IP per minute,
  40 position pings per session per minute; positions outside Uzbekistan are rejected.

## Price changes and disputes

- After acceptance only the passenger can change the route; the driver and anyone else get 404.
  The new price uses the tariff locked at acceptance, is re-checked under a row lock, and is applied only
  when the passenger confirms that exact amount. At most 5 changes per ride.
- The pickup may move at most 300 m before the driver arrives and is fixed after arrival.
- The database accepts price changes only for `stop_added`, `stop_removed`, `address_changed`.
- Disputes: participants only; one per ride; statements are immutable; each side sees the other's account
  only after writing its own; a decision is possible only after both spoke or the 24 h window passed.
  Moderation endpoints require `admin`. Statement text is stored as written — clients must render it
  as plain text, never as HTML.

## Waiting, cancellation and ratings

- 'Arrived' is accepted only when the driver's fresh live position is within 200 m of the pickup,
  so a driver cannot start the waiting meter or the cancellation fee from elsewhere. Refused attempts
  are logged with the distance.
- Waiting is computed on the server from logged event times (arrival, trip start), never from the client;
  capped at 30 paid minutes. Rates are bounded by database checks.
- No-show only by the driver, only after 5 minutes at the pickup, and only while still within 200 m of it.
- The passenger is charged a cancellation fee only after confirming an amount at or above the current fee;
  fee amounts are limited to 5 000–10 000 sum by a database check; waiving needs a moderator decision.
- A driver who cancels 3 accepted rides within 2 hours (no-shows excluded) is paused for 30 minutes and
  removed from the map; paused drivers are skipped by dispatch and cannot accept.
- Ratings: participants only, completed rides only, once per side, 72 h window, reason required below 4,
  no self-rating. Only averages are exposed (after 5 ratings); authors, single scores and reasons are not.
- Rating tags come from a fixed list, must match the score's tone and the rated side. Only a driver's top
  positive tags are public; negative tags are visible to that driver and moderators only. Safety tags and
  1–2 stars open a complaint for moderators automatically.

## Payments

- Card numbers never reach our servers: the app tokenises cards with the provider's SDK; we accept only
  tokens (a field for a card number is rejected), verify them with the provider and store them encrypted
  (AES-256-GCM, key in `PAYMENT_TOKEN_KEY`, required in production). Tokens are never returned by the API.
- Prices come only from our tables (plans, locked ride price, fees), never from the client.
- A payment leaves `pending` exactly once, under a row lock; a success is accepted only for the exact
  amount; repeated webhooks are acknowledged without effect; provider references are unique.
- Card charges use idempotency keys (`ride:<id>`, `ride_extra:<id>`, `cancel_fee:<id>`) and a per-key
  database lock, so retries, the 60% prepayment and the completion charge can never charge twice.
- The trip odometer is server-side, from position pings (jumps over 500 m per ping are capped).
- Only the passenger can switch a ride's payment, only to their own card, never while a charge is in flight.
- Webhooks: the adapter verifies authenticity before reading anything; optional per-provider IP allowlists;
  every call is logged, but unverified bodies are not stored. Stub adapters refuse all webhooks.
- Cards are owner-only; a card in use by an active ride cannot be removed; at most 5 cards per user.
- Production refuses to start with the `fake` provider enabled.

## Admin panel

- Two staff roles: `admin` (everything) and `support` (moderation, complaints, disputes, lookups).
  Prices, fees, plans, finance, staff roles and the audit log are admin-only.
- Every staff action, including viewing a dossier, a ride or a phone search, is written to
  `admin_audit_log` with the staff member and IP. A database trigger makes the log append-only.
- Role changes take effect on the next request; an admin cannot remove their own admin role,
  nobody can block themselves.
- The price coefficient is bounded (0.70–1.50) by a database check, requires a reason, applies to
  new orders only and is stored on each ride, so a later change never alters an existing price.
- Blocking a driver removes them from the map at once; blocks carry a reason and are lifted with one.

## Staff panel (web)

- Served from the API's own domain; no CORS, no third-party scripts except Google Fonts.
- The session token is kept in `sessionStorage` (cleared when the tab closes), never in a cookie or URL.
- Only `admin` / `support` accounts are let in; every screen calls the same role-checked API, so hiding a
  button is never the only protection.
- The demo build answers from an in-browser mock; the real build replaces it with an empty stub, so sample
  data never ships. Pages are marked `noindex`.
- To do: move the token to an httpOnly cookie with CSRF protection and add 2FA before launch.

## Maps and places

- Address search runs on our own Nominatim; passenger searches and positions never go to a third-party map service.
- Search is signed-in only and rate-limited (60 per minute per user), queries are 2–120 characters.
- Saved places belong to one user; every query filters by the session's user id, deleted places are soft-deleted.
- A typed entrance is short text (letters and digits, up to 8); a known entrance is only accepted for the
  pickup and within 150 m of it. Entrances learnt from pickups need the driver to be within 60 m.
- Production refuses `GEO_PROVIDER=dev`.

## Errors

- Internal errors return a generic `internal_error`; details go only to the server log.

## Production guards

The API refuses to start in production if:

- `AUTH_SECRET` is shorter than 32 characters or is the development value;
- `SMS_PROVIDER=console` (it would print login codes to the log);
- `ROUTE_PROVIDER` is not `osrm`;
- `GEO_PROVIDER` is not `nominatim`.

## Dependencies

- Versions are pinned exactly; run `npm audit --omit=dev` before every release.

## Still to do before launch

- Real SMS provider adapter and its webhook signature checks.
- Payme / Click / Uzum adapters (webhook auth, checkout, card tokens), fiscal operator, driver payouts, refunds.
- Move file storage to S3-compatible storage in Uzbekistan with encryption at rest; strip photo metadata (EXIF/GPS).
- Hosting in Uzbekistan, TLS, database backups and encryption at rest.
- 2FA for staff accounts; staff panel only from allowed networks / VPN.
- Penetration test before the public launch.
- Mask phone numbers between passenger and driver (call through a proxy number) before calls are added.
- Encrypt the trip history at rest and set a retention period for raw positions.
