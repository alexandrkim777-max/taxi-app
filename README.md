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

## Principles (see the product spec)

- Ride price is copied into the ride at order time and never changes without explicit passenger confirmation.
- Driver tariffs are versioned; old versions are never deleted.
- Nothing is hard-deleted: rows carry `deleted_at`.
- Ride status changes only through allowed transitions; every change is written to `ride_events`.
- Money is stored as integer tiyin (`bigint`), never as floats.
- Time is stored in UTC (`timestamptz`), shown in the user's time zone.
- All user-facing strings go through i18n (uz, ru, en) from day one.
- A city is a first-class entity: a new city is configuration, not code.
- The map provider sits behind an adapter; the default is self-hosted OpenStreetMap.
- Personal data must be hosted in Uzbekistan in production; development uses test data only.
