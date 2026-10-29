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
- Document uploads accept only links into our own storage (`FILE_BASE_URL`).
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

## Cancellation fee

- 'Arrived' is accepted only when the driver's fresh live position is within 150 m of the pickup,
  so a driver cannot start the paid-cancellation clock from elsewhere.
- No-show only by the driver and only after 5 minutes at the pickup (measured from the logged arrival).
- The passenger is charged only after confirming the exact fee returned by `cancel-terms`.
- Fee amounts are limited to 5 000–10 000 sum by a database check; waiving needs a moderator decision.

## Errors

- Internal errors return a generic `internal_error`; details go only to the server log.

## Production guards

The API refuses to start in production if:

- `AUTH_SECRET` is shorter than 32 characters or is the development value;
- `SMS_PROVIDER=console` (it would print login codes to the log);
- `ROUTE_PROVIDER` is not `osrm`.

## Dependencies

- Versions are pinned exactly; run `npm audit --omit=dev` before every release.

## Still to do before launch

- Real SMS provider adapter and its webhook signature checks.
- File storage with signed upload URLs and image type checks.
- Hosting in Uzbekistan, TLS, database backups and encryption at rest.
- Admin actions audit log; 2FA for admin accounts.
- Penetration test before the public launch.
- Mask phone numbers between passenger and driver (call through a proxy number) before calls are added.
- Encrypt the trip history at rest and set a retention period for raw positions.
