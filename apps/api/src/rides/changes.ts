// Route changes during a ride — the ONLY way a ride price changes after acceptance.
//
// - Only the passenger can add, remove or change stops; the driver cannot change anything.
// - The new price is the same driver's tariff (the one locked at acceptance) applied to the new
//   route, clamped into the class corridor. A shorter route makes the ride cheaper.
// - The passenger first sees the new price (preview), then confirms exactly that amount.
// - Every change is stored in price_changes with old/new stops and prices, and in ride_events.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { clampToCorridor, fareTiyin, type RideStatus } from '@taxi/shared';
import { requireUser } from '../auth/session.ts';
import type { RouteProvider, RouteResult } from '../routing/index.ts';
import { haversineM, uuidParams } from '../lib/geo.ts';
import { HttpError, withTx } from '../lib/tx.ts';
import { logEvent } from '../dispatch/matching.ts';
import { rideFor, rideView, stop } from './common.ts';

interface Deps {
  db: pg.Pool;
  routes: RouteProvider;
}

interface Stop {
  lat: number;
  lng: number;
  address?: string;
}

/** Statuses in which the passenger may change the route. */
const CHANGEABLE: RideStatus[] = ['accepted', 'driver_en_route', 'arrived', 'in_progress'];
/** Before the driver arrives the pickup may move a little (other side of the building, a gate). */
const PICKUP_MOVE_MAX_M = 300;
/** Once the driver is at the pickup it is fixed. */
const PICKUP_FIXED_TOLERANCE_M = 15;
/** Anti-abuse: route changes per ride. */
const MAX_CHANGES_PER_RIDE = 5;

const body = {
  type: 'object',
  required: ['stops'],
  additionalProperties: false,
  properties: {
    stops: { type: 'array', minItems: 2, maxItems: 5, items: stop },
    // Confirmation only: the exact price the passenger saw in the preview.
    priceTiyin: { type: 'integer', minimum: 0 },
  },
} as const;

interface Computed {
  oldPriceTiyin: number;
  newPriceTiyin: number;
  route: RouteResult;
  reason: 'stop_added' | 'stop_removed' | 'address_changed';
  oldStops: Stop[];
}

export async function routeChangeRoutes(app: FastifyInstance, { db, routes }: Deps): Promise<void> {
  /** Validates the change and prices it. Runs outside a transaction (it calls the router). */
  async function compute(rideId: string, userId: string, stops: Stop[]): Promise<Computed> {
    const { ride, role } = await rideFor(db, rideId, userId, false);
    // Only the passenger changes the route; for anyone else the ride does not exist.
    if (role !== 'passenger') throw new HttpError(404, 'not_found');
    if (!CHANGEABLE.includes(ride.status)) throw new HttpError(409, 'ride_not_changeable');

    const { rows } = await db.query(
      `SELECT r.locked_price_tiyin, t.base_tiyin, t.per_km_tiyin, t.per_min_tiyin, t.min_fare_tiyin,
              vc.rec_base_tiyin, vc.rec_per_km_tiyin, vc.rec_per_min_tiyin, vc.rec_min_fare_tiyin,
              vc.corridor_min_pct, vc.corridor_max_pct,
              (SELECT count(*)::int FROM price_changes pc WHERE pc.ride_id = r.id) AS changes,
              (SELECT json_agg(json_build_object('lat', ST_Y(s.point::geometry), 'lng', ST_X(s.point::geometry),
                                                 'address', s.address) ORDER BY s.position)
                 FROM ride_stops s WHERE s.ride_id = r.id) AS stops
         FROM rides r
         JOIN driver_tariffs t ON t.id = r.tariff_id
         JOIN vehicle_classes vc ON vc.id = r.class_id
        WHERE r.id = $1`,
      [rideId],
    );
    const r = rows[0];
    if (r.changes >= MAX_CHANGES_PER_RIDE) throw new HttpError(429, 'too_many_changes');

    const oldStops: Stop[] = r.stops;
    const moved = haversineM(oldStops[0]!, stops[0]!);
    const pickupFixed = ride.status === 'arrived' || ride.status === 'in_progress';
    if (moved > (pickupFixed ? PICKUP_FIXED_TOLERANCE_M : PICKUP_MOVE_MAX_M)) {
      throw new HttpError(409, pickupFixed ? 'pickup_fixed' : 'pickup_too_far');
    }

    let route: RouteResult;
    try {
      route = await routes.route(stops);
    } catch {
      throw new HttpError(503, 'routing_unavailable');
    }
    const driverTariff = {
      baseTiyin: Number(r.base_tiyin), perKmTiyin: Number(r.per_km_tiyin),
      perMinTiyin: Number(r.per_min_tiyin), minFareTiyin: Number(r.min_fare_tiyin),
    };
    const reference = fareTiyin({
      baseTiyin: Number(r.rec_base_tiyin), perKmTiyin: Number(r.rec_per_km_tiyin),
      perMinTiyin: Number(r.rec_per_min_tiyin), minFareTiyin: Number(r.rec_min_fare_tiyin),
    }, route);
    const newPriceTiyin = clampToCorridor(fareTiyin(driverTariff, route), reference, {
      minPct: r.corridor_min_pct, maxPct: r.corridor_max_pct,
    });
    const reason = stops.length > oldStops.length ? 'stop_added'
      : stops.length < oldStops.length ? 'stop_removed' : 'address_changed';
    return { oldPriceTiyin: Number(r.locked_price_tiyin), newPriceTiyin, route, reason, oldStops };
  }

  app.post<{ Params: { id: string }; Body: { stops: Stop[] } }>(
    '/rides/:id/route/preview',
    {
      preHandler: requireUser,
      schema: { params: uuidParams, body },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      const c = await compute(request.params.id, request.user!.id, request.body.stops);
      return {
        oldPriceTiyin: c.oldPriceTiyin,
        newPriceTiyin: c.newPriceTiyin,
        differenceTiyin: c.newPriceTiyin - c.oldPriceTiyin,
        route: c.route,
        reason: c.reason,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { stops: Stop[]; priceTiyin?: number } }>(
    '/rides/:id/route',
    {
      preHandler: requireUser,
      schema: { params: uuidParams, body },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rideId = request.params.id;
      if (request.body.priceTiyin === undefined) return reply.code(400).send({ error: 'price_confirmation_required' });
      const c = await compute(rideId, userId, request.body.stops);
      // The passenger confirms exactly the price on their screen.
      if (c.newPriceTiyin !== request.body.priceTiyin) {
        return reply.code(409).send({ error: 'price_changed', newPriceTiyin: c.newPriceTiyin });
      }

      await withTx(db, async (tx) => {
        const { ride } = await rideFor(tx, rideId, userId, true);
        const { rows } = await tx.query<{ locked_price_tiyin: string; changes: number }>(
          `SELECT locked_price_tiyin, (SELECT count(*)::int FROM price_changes WHERE ride_id = $1) AS changes
             FROM rides WHERE id = $1`,
          [rideId],
        );
        // Re-checked under the lock: the ride or its price may have moved since the preview.
        if (!CHANGEABLE.includes(ride.status)) throw new HttpError(409, 'ride_not_changeable');
        if (Number(rows[0]!.locked_price_tiyin) !== c.oldPriceTiyin) throw new HttpError(409, 'price_changed');
        if (rows[0]!.changes >= MAX_CHANGES_PER_RIDE) throw new HttpError(429, 'too_many_changes');

        await tx.query(
          `INSERT INTO price_changes (ride_id, reason, amount_tiyin, confirmed_by_passenger, confirmed_at,
                                      requested_by, old_price_tiyin, new_price_tiyin, old_stops, new_stops,
                                      route_distance_m, route_duration_s)
           VALUES ($1, $2, $3, true, now(), $4, $5, $6, $7, $8, $9, $10)`,
          [
            rideId, c.reason, c.newPriceTiyin - c.oldPriceTiyin, userId, c.oldPriceTiyin, c.newPriceTiyin,
            JSON.stringify(c.oldStops), JSON.stringify(request.body.stops), c.route.distanceM, c.route.durationS,
          ],
        );
        await tx.query(
          `UPDATE rides SET locked_price_tiyin = $2, route_distance_m = $3, route_duration_s = $4 WHERE id = $1`,
          [rideId, c.newPriceTiyin, c.route.distanceM, c.route.durationS],
        );
        await tx.query(`DELETE FROM ride_stops WHERE ride_id = $1`, [rideId]);
        for (const [i, s] of request.body.stops.entries()) {
          await tx.query(
            `INSERT INTO ride_stops (ride_id, position, point, address)
             VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5)`,
            [rideId, i, s.lat, s.lng, s.address ?? null],
          );
        }
        await logEvent(tx, rideId, 'route_changed', 'passenger', userId, {
          reason: c.reason, oldPriceTiyin: c.oldPriceTiyin, newPriceTiyin: c.newPriceTiyin,
        });
      });
      return rideView(db, rideId, 'passenger');
    },
  );

  // History of price changes, visible to both sides of the ride.
  app.get<{ Params: { id: string } }>(
    '/rides/:id/price-changes',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request) => {
      await rideFor(db, request.params.id, request.user!.id, false);
      const { rows } = await db.query(
        `SELECT reason, old_price_tiyin::int AS "oldPriceTiyin", new_price_tiyin::int AS "newPriceTiyin",
                old_stops AS "oldStops", new_stops AS "newStops", confirmed_at AS "confirmedAt"
           FROM price_changes WHERE ride_id = $1 ORDER BY created_at`,
        [request.params.id],
      );
      return rows;
    },
  );
}
