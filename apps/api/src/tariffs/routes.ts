import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { clampToCorridor, fareTiyin, type Tariff } from '@taxi/shared';
import { requireUser } from '../auth/session.ts';
import type { RouteProvider } from '../routing/index.ts';
import { uzPoint } from '../lib/geo.ts';
import { bestOf, pickupMin, pricedDrivers } from '../dispatch/matching.ts';

const TARIFF_CHANGE_COOLDOWN_HOURS = 24;

interface Deps {
  db: pg.Pool;
  routes: RouteProvider;
  cityCode: string;
}

interface ClassRow {
  id: string;
  code: string;
  name: Record<string, string>;
  seats: number;
  rec_base_tiyin: string;
  rec_per_km_tiyin: string;
  rec_per_min_tiyin: string;
  rec_min_fare_tiyin: string;
  corridor_min_pct: number;
  corridor_max_pct: number;
}

function recommended(c: ClassRow): Tariff {
  return {
    baseTiyin: Number(c.rec_base_tiyin),
    perKmTiyin: Number(c.rec_per_km_tiyin),
    perMinTiyin: Number(c.rec_per_min_tiyin),
    minFareTiyin: Number(c.rec_min_fare_tiyin),
  };
}

/** Allowed range for one tariff component, derived from the class corridor. */
function bounds(rec: number, c: ClassRow): { min: number; max: number } {
  return {
    min: Math.ceil((rec * (100 + c.corridor_min_pct)) / 100),
    max: Math.floor((rec * (100 + c.corridor_max_pct)) / 100),
  };
}

const tariffBody = {
  type: 'object',
  required: ['baseTiyin', 'perKmTiyin', 'perMinTiyin', 'minFareTiyin'],
  additionalProperties: false,
  properties: {
    baseTiyin: { type: 'integer', minimum: 0 },
    perKmTiyin: { type: 'integer', minimum: 0 },
    perMinTiyin: { type: 'integer', minimum: 0 },
    minFareTiyin: { type: 'integer', minimum: 0 },
  },
} as const;

export async function tariffRoutes(app: FastifyInstance, { db, routes, cityCode }: Deps): Promise<void> {
  async function cityClasses(): Promise<ClassRow[]> {
    const { rows } = await db.query<ClassRow>(
      `SELECT vc.* FROM vehicle_classes vc JOIN cities c ON c.id = vc.city_id
        WHERE c.code = $1 AND vc.deleted_at IS NULL ORDER BY vc.rec_base_tiyin`,
      [cityCode],
    );
    return rows;
  }

  /** The verified driver's active vehicle class, or null. */
  async function driverClass(userId: string): Promise<{ driverId: string; cls: ClassRow } | null> {
    const { rows } = await db.query<ClassRow & { driver_id: string }>(
      `SELECT vc.*, d.id AS driver_id
         FROM drivers d
         JOIN vehicles v ON v.driver_id = d.id AND v.is_active AND v.deleted_at IS NULL
         JOIN vehicle_classes vc ON vc.id = v.class_id
        WHERE d.user_id = $1 AND d.status = 'verified' AND d.deleted_at IS NULL
        ORDER BY v.created_at DESC LIMIT 1`,
      [userId],
    );
    const row = rows[0];
    return row ? { driverId: row.driver_id, cls: row } : null;
  }

  app.get('/classes', async () => {
    const classes = await cityClasses();
    return classes.map((c) => ({
      code: c.code,
      name: c.name,
      seats: c.seats,
      recommended: recommended(c),
      corridor: { minPct: c.corridor_min_pct, maxPct: c.corridor_max_pct },
    }));
  });

  app.get('/drivers/me/tariff', { preHandler: requireUser }, async (request, reply) => {
    const found = await driverClass(request.user!.id);
    if (!found) return reply.code(404).send({ error: 'no_verified_vehicle' });
    const { rows } = await db.query(
      `SELECT version, base_tiyin, per_km_tiyin, per_min_tiyin, min_fare_tiyin, valid_from
         FROM driver_tariffs WHERE driver_id = $1 AND class_id = $2
        ORDER BY version DESC LIMIT 1`,
      [found.driverId, found.cls.id],
    );
    const rec = recommended(found.cls);
    const current = rows[0]
      ? {
          version: rows[0].version,
          baseTiyin: Number(rows[0].base_tiyin),
          perKmTiyin: Number(rows[0].per_km_tiyin),
          perMinTiyin: Number(rows[0].per_min_tiyin),
          minFareTiyin: Number(rows[0].min_fare_tiyin),
          validFrom: rows[0].valid_from,
        }
      : { version: 0, ...rec, validFrom: null };
    return {
      classCode: found.cls.code,
      current,
      recommended: rec,
      bounds: {
        baseTiyin: bounds(rec.baseTiyin, found.cls),
        perKmTiyin: bounds(rec.perKmTiyin, found.cls),
        perMinTiyin: bounds(rec.perMinTiyin, found.cls),
        minFareTiyin: bounds(rec.minFareTiyin, found.cls),
      },
    };
  });

  app.put<{ Body: Tariff }>(
    '/drivers/me/tariff',
    { preHandler: requireUser, schema: { body: tariffBody } },
    async (request, reply) => {
      const found = await driverClass(request.user!.id);
      if (!found) return reply.code(404).send({ error: 'no_verified_vehicle' });
      const rec = recommended(found.cls);

      // Every component must stay inside the corridor, so the full fare can never
      // exceed the reference price or drop below the floor.
      const keys = ['baseTiyin', 'perKmTiyin', 'perMinTiyin', 'minFareTiyin'] as const;
      for (const k of keys) {
        const b = bounds(rec[k], found.cls);
        if (request.body[k] < b.min || request.body[k] > b.max) {
          return reply.code(400).send({ error: 'outside_corridor', field: k, ...b });
        }
      }

      const last = await db.query<{ version: number; recent: boolean }>(
        // Version 0 is the recommended tariff stored automatically on first going online;
        // it does not count as the driver's own change.
        `SELECT version, version > 0 AND created_at > now() - make_interval(hours => $3) AS recent
           FROM driver_tariffs WHERE driver_id = $1 AND class_id = $2
          ORDER BY version DESC LIMIT 1`,
        [found.driverId, found.cls.id, TARIFF_CHANGE_COOLDOWN_HOURS],
      );
      if (last.rows[0]?.recent) {
        return reply.code(429).send({ error: 'tariff_changed_recently', cooldownHours: TARIFF_CHANGE_COOLDOWN_HOURS });
      }

      // New version; old versions stay so past rides keep pointing at the tariff they used.
      // The unique (driver, class, version) constraint rejects a parallel duplicate.
      try {
        const { rows } = await db.query(
          `INSERT INTO driver_tariffs (driver_id, class_id, version, base_tiyin, per_km_tiyin, per_min_tiyin, min_fare_tiyin)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING version, valid_from`,
          [
            found.driverId, found.cls.id, (last.rows[0]?.version ?? 0) + 1,
            request.body.baseTiyin, request.body.perKmTiyin, request.body.perMinTiyin, request.body.minFareTiyin,
          ],
        );
        return { ...request.body, ...rows[0] };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'concurrent_change' });
        throw err;
      }
    },
  );

  app.post<{ Body: { stops: { lat: number; lng: number }[] } }>(
    '/quotes',
    {
      preHandler: requireUser,
      schema: {
        body: {
          type: 'object',
          required: ['stops'],
          additionalProperties: false,
          properties: { stops: { type: 'array', minItems: 2, maxItems: 5, items: uzPoint } },
        },
      },
    },
    async (request, reply) => {
      let route;
      try {
        route = await routes.route(request.body.stops);
      } catch (err) {
        request.log.warn(err, 'routing failed');
        return reply.code(503).send({ error: 'routing_unavailable' });
      }
      const classes = await cityClasses();
      const pickup = request.body.stops[0]!;
      return {
        route,
        classes: await Promise.all(classes.map(async (c) => {
          const rec = fareTiyin(recommended(c), route);
          const corridor = { minPct: c.corridor_min_pct, maxPct: c.corridor_max_pct };
          // Price range drivers of this class can charge for this route.
          const floor = clampToCorridor(0, rec, corridor);
          // The one-tap price: the best nearby driver right now (price and pickup time together).
          // The app shows it on the "Order" button and sends it back as the ceiling.
          const drivers = await pricedDrivers(db, {
            lat: pickup.lat, lng: pickup.lng, route, excludeUserId: request.user!.id,
            cls: { classId: c.id, recommended: recommended(c), corridor },
          });
          const best = bestOf(drivers);
          return {
            code: c.code, name: c.name, seats: c.seats, maxFareTiyin: rec, minFareTiyin: floor,
            best: best ? { priceTiyin: best.priceTiyin, pickupMin: pickupMin(best.distanceM) } : null,
            driversNearby: drivers.length,
          };
        })),
      };
    },
  );
}
