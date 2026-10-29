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
