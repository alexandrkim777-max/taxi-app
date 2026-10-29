// Passenger and driver ride flow:
//   passenger creates a ride -> sees nearby drivers with their own prices -> chooses one
//   -> the driver accepts (price locked) -> en route -> arrived -> in progress -> completed.
// Every status change goes through the shared status machine and is written to ride_events.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { canTransition, clampToCorridor, fareTiyin, type RideStatus, type Tariff } from '@taxi/shared';
import { requireUser } from '../auth/session.ts';
import type { RouteProvider } from '../routing/index.ts';
import { UZ_LAT, UZ_LNG, uuidParams } from '../lib/geo.ts';
import { HttpError, isUniqueViolation, withTx } from '../lib/tx.ts';
import {
  driverContext, nearbyDrivers, PRESENCE_TTL_SEC, setPresenceStatus,
} from '../dispatch/presence.ts';

type Q = pg.Pool | pg.PoolClient;

interface Deps {
  db: pg.Pool;
  routes: RouteProvider;
  cityCode: string;
}

/** How long an offer stays visible to the passenger. */
const OFFER_TTL_SEC = 90;
/** How long a chosen driver has to accept. */
const ACCEPT_WINDOW_SEC = 30;
const MAX_OFFERS = 10;
/** Anti-spam: rides a passenger can create per hour (each one pings drivers). */
const MAX_RIDES_PER_HOUR = 20;
const ACTIVE = ['accepted', 'driver_en_route', 'arrived', 'in_progress'];

const stop = {
  type: 'object',
  required: ['lat', 'lng'],
  additionalProperties: false,
  properties: {
    lat: UZ_LAT,
    lng: UZ_LNG,
    address: { type: 'string', maxLength: 200 },
  },
} as const;

const rideOptions = {
  type: 'object',
  additionalProperties: false,
  properties: {
    childSeat: { type: 'boolean' },
    pet: { type: 'boolean' },
    quiet: { type: 'boolean' },
    luggage: { type: 'boolean' },
  },
} as const;

interface CreateBody {
  classCode: string;
  stops: { lat: number; lng: number; address?: string }[];
  options?: Record<string, boolean>;
  comment?: string;
}

interface RideRow {
  id: string;
  status: RideStatus;
  passenger_id: string;
  driver_id: string | null;
  class_id: string;
}

type Role = 'passenger' | 'driver';

async function event(q: Q, rideId: string, type: string, actor: Role | 'system', actorId: string | null, payload = {}) {
  await q.query(
    `INSERT INTO ride_events (ride_id, type, actor, actor_id, payload) VALUES ($1, $2, $3, $4, $5)`,
    [rideId, type, actor, actorId, JSON.stringify(payload)],
  );
}

async function isBlocked(q: Q, userId: string): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM blocks WHERE user_id = $1 AND appeal_status <> 'lifted' AND (until IS NULL OR until > now())`,
    [userId],
  );
  return rows.length > 0;
}

/**
 * Loads a ride and the caller's role in it, locking the row when inside a transaction.
 * Anyone who is neither its passenger nor its assigned driver gets 404, not 403,
 * so ride ids cannot be probed.
 */
async function rideFor(q: Q, rideId: string, userId: string, lock: boolean): Promise<{ ride: RideRow; role: Role }> {
  const { rows } = await q.query<RideRow & { driver_user_id: string | null }>(
    `SELECT r.id, r.status, r.passenger_id, r.driver_id, r.class_id, d.user_id AS driver_user_id
       FROM rides r LEFT JOIN drivers d ON d.id = r.driver_id
      WHERE r.id = $1 AND r.deleted_at IS NULL
      ${lock ? 'FOR UPDATE OF r' : ''}`,
    [rideId],
  );
  const ride = rows[0];
  if (ride?.passenger_id === userId) return { ride, role: 'passenger' };
  if (ride && ride.driver_user_id === userId) return { ride, role: 'driver' };
  throw new HttpError(404, 'not_found');
}

/** Offers the passenger can choose from. Exact driver positions stay hidden until acceptance. */
async function openOffers(q: Q, rideId: string) {
  const { rows } = await q.query(
    `SELECT o.id, o.status, o.price_tiyin::int AS "priceTiyin", o.expires_at AS "expiresAt",
            u.name AS "driverName", d.rating::float AS rating,
            v.make_model AS "makeModel", v.color,
            (round(ST_Distance(p.point, s.point) / 100) * 100)::int AS "distanceM"
       FROM ride_offers o
       JOIN drivers d ON d.id = o.driver_id
       JOIN users u ON u.id = d.user_id
       JOIN driver_presence p ON p.driver_id = o.driver_id
       JOIN vehicles v ON v.id = p.vehicle_id
       JOIN ride_stops s ON s.ride_id = o.ride_id AND s.position = 0
      WHERE o.ride_id = $1 AND o.status IN ('open', 'chosen') AND o.expires_at > now()
      ORDER BY o.price_tiyin, "distanceM"`,
    [rideId],
  );
  return rows;
}

async function rideView(q: Q, rideId: string, role: Role) {
  const { rows } = await q.query(
    `SELECT r.id, r.status, vc.code AS "classCode", r.locked_price_tiyin::int AS "priceTiyin",
            r.route_distance_m AS "distanceM", r.route_duration_s AS "durationS",
            r.options, r.driver_comment AS comment, r.cancelled_by AS "cancelledBy", r.created_at AS "createdAt",
            r.driver_id, pu.name AS "passengerName",
            du.name AS "driverName", d.rating::float AS "driverRating",
            v.make_model AS "makeModel", v.color, v.plate,
            ST_Y(p.point::geometry) AS "driverLat", ST_X(p.point::geometry) AS "driverLng",
            p.heading AS "driverHeading", p.updated_at AS "driverSeenAt"
       FROM rides r
       JOIN vehicle_classes vc ON vc.id = r.class_id
       JOIN users pu ON pu.id = r.passenger_id
       LEFT JOIN drivers d ON d.id = r.driver_id
       LEFT JOIN users du ON du.id = d.user_id
       LEFT JOIN vehicles v ON v.id = r.vehicle_id
       LEFT JOIN driver_presence p ON p.driver_id = r.driver_id AND r.status = ANY($2)
      WHERE r.id = $1`,
    [rideId, ACTIVE],
  );
  const r = rows[0];
  const stops = await q.query(
    `SELECT position, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, address
       FROM ride_stops WHERE ride_id = $1 ORDER BY position`,
    [rideId],
  );
  const view: Record<string, unknown> = {
    id: r.id, status: r.status, classCode: r.classCode, priceTiyin: r.priceTiyin,
    route: { distanceM: r.distanceM, durationS: r.durationS },
    stops: stops.rows, options: r.options, comment: r.comment,
    cancelledBy: r.cancelledBy, createdAt: r.createdAt,
  };
  if (r.driver_id) {
    view.driver = {
      name: r.driverName, rating: r.driverRating,
      vehicle: { makeModel: r.makeModel, color: r.color, plate: r.plate },
      // Live position only while the ride is active, and only to its participants.
      location: r.driverLat != null
        ? { lat: r.driverLat, lng: r.driverLng, heading: r.driverHeading, at: r.driverSeenAt }
        : null,
    };
  }
  if (role === 'driver') view.passenger = { name: r.passengerName };
  if (role === 'passenger' && r.status === 'created') view.offers = await openOffers(q, rideId);
  return view;
}

export async function rideRoutes(app: FastifyInstance, { db, routes, cityCode }: Deps): Promise<void> {
  /**
   * Finds nearby drivers and (re)creates their offers at their own price, clamped into
   * the class corridor. Offers of drivers who left are expired; a driver who declined
   * this ride is never offered again.
   */
  async function search(rideId: string, passengerId: string): Promise<void> {
    const { rows } = await db.query(
      `SELECT r.route_distance_m, r.route_duration_s, r.class_id,
              ST_Y(s.point::geometry) AS lat, ST_X(s.point::geometry) AS lng,
              vc.rec_base_tiyin, vc.rec_per_km_tiyin, vc.rec_per_min_tiyin, vc.rec_min_fare_tiyin,
              vc.corridor_min_pct, vc.corridor_max_pct
         FROM rides r
         JOIN ride_stops s ON s.ride_id = r.id AND s.position = 0
         JOIN vehicle_classes vc ON vc.id = r.class_id
        WHERE r.id = $1`,
      [rideId],
    );
    const r = rows[0];
    const route = { distanceM: r.route_distance_m, durationS: r.route_duration_s };
    const rec: Tariff = {
      baseTiyin: Number(r.rec_base_tiyin), perKmTiyin: Number(r.rec_per_km_tiyin),
      perMinTiyin: Number(r.rec_per_min_tiyin), minFareTiyin: Number(r.rec_min_fare_tiyin),
    };
    const reference = fareTiyin(rec, route);
    const corridor = { minPct: r.corridor_min_pct, maxPct: r.corridor_max_pct };

    const drivers = await nearbyDrivers(db, {
      lat: r.lat, lng: r.lng, classId: r.class_id, excludeUserId: passengerId, limit: MAX_OFFERS,
    });
    const prices = drivers.map((d) => clampToCorridor(fareTiyin(d, route), reference, corridor));

    await withTx(db, async (tx) => {
      await tx.query(`UPDATE ride_offers SET status = 'expired' WHERE ride_id = $1 AND status = 'open'`, [rideId]);
      if (drivers.length === 0) return;
      await tx.query(
        `INSERT INTO ride_offers (ride_id, driver_id, price_tiyin, tariff_id, expires_at)
         SELECT $1, d, p, t, now() + make_interval(secs => $5)
           FROM unnest($2::uuid[], $3::bigint[], $4::uuid[]) AS x(d, p, t)
         ON CONFLICT (ride_id, driver_id) DO UPDATE
           SET status = 'open', price_tiyin = EXCLUDED.price_tiyin, tariff_id = EXCLUDED.tariff_id,
               expires_at = EXCLUDED.expires_at, created_at = now()
           WHERE ride_offers.status IN ('open', 'expired')`,
        [rideId, drivers.map((d) => d.driverId), prices, drivers.map((d) => d.tariffId), OFFER_TTL_SEC],
      );
    });
  }

  app.post<{ Body: CreateBody }>(
    '/rides',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['classCode', 'stops'],
          additionalProperties: false,
          properties: {
            classCode: { type: 'string', pattern: '^[a-z_]{2,32}$' },
            stops: { type: 'array', minItems: 2, maxItems: 5, items: stop },
            options: rideOptions,
            comment: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (await isBlocked(db, userId)) return reply.code(403).send({ error: 'blocked' });

      const recent = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM rides WHERE passenger_id = $1 AND created_at > now() - interval '1 hour'`,
        [userId],
      );
      if (recent.rows[0]!.n >= MAX_RIDES_PER_HOUR) return reply.code(429).send({ error: 'too_many_rides' });

      const cls = await db.query<{ id: string; city_id: string }>(
        `SELECT vc.id, vc.city_id FROM vehicle_classes vc JOIN cities c ON c.id = vc.city_id
          WHERE c.code = $1 AND vc.code = $2 AND vc.deleted_at IS NULL`,
        [cityCode, request.body.classCode],
      );
      if (!cls.rows[0]) return reply.code(400).send({ error: 'unknown_class' });

      // Distance and time always come from our routing, never from the client.
      let route;
      try {
        route = await routes.route(request.body.stops);
      } catch (err) {
        request.log.warn(err, 'routing failed');
        return reply.code(503).send({ error: 'routing_unavailable' });
      }

      let rideId: string;
      try {
        rideId = await withTx(db, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO rides (city_id, passenger_id, class_id, route_distance_m, route_duration_s, options, driver_comment)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              cls.rows[0]!.city_id, userId, cls.rows[0]!.id, route.distanceM, route.durationS,
              JSON.stringify(request.body.options ?? {}), request.body.comment ?? null,
            ],
          );
          const id = rows[0]!.id;
          for (const [i, s] of request.body.stops.entries()) {
            await tx.query(
              `INSERT INTO ride_stops (ride_id, position, point, address)
               VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5)`,
              [id, i, s.lat, s.lng, s.address ?? null],
            );
          }
          await event(tx, id, 'status:created', 'passenger', userId);
          return id;
        });
      } catch (err) {
        if (isUniqueViolation(err, 'rides_one_active_per_passenger')) {
          return reply.code(409).send({ error: 'active_ride_exists' });
        }
        throw err;
      }

      await search(rideId, userId);
      return reply.code(201).send(await rideView(db, rideId, 'passenger'));
    },
  );

  // The passenger's or driver's current ride, so the app can restore its screen after a restart.
  app.get('/rides/active', { preHandler: requireUser }, async (request, reply) => {
    const { rows } = await db.query<{ id: string; role: Role }>(
      `SELECT r.id, CASE WHEN r.passenger_id = $1 THEN 'passenger' ELSE 'driver' END AS role
         FROM rides r LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE (r.passenger_id = $1 OR d.user_id = $1) AND r.deleted_at IS NULL
          AND r.status IN ('created', 'accepted', 'driver_en_route', 'arrived', 'in_progress')
        ORDER BY r.created_at DESC LIMIT 1`,
      [request.user!.id],
    );
    if (!rows[0]) return reply.code(204).send();
    return rideView(db, rows[0].id, rows[0].role);
  });

  app.get<{ Params: { id: string } }>(
    '/rides/:id',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request) => {
      const { role } = await rideFor(db, request.params.id, request.user!.id, false);
      return rideView(db, request.params.id, role);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/rides/:id/search',
    {
      preHandler: requireUser,
      schema: { params: uuidParams },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { ride, role } = await rideFor(db, request.params.id, request.user!.id, false);
      if (role !== 'passenger') throw new HttpError(404, 'not_found');
      if (ride.status !== 'created') throw new HttpError(409, 'ride_not_open');
      await search(ride.id, ride.passenger_id);
      return openOffers(db, ride.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { offerId: string } }>(
    '/rides/:id/choose',
    {
      preHandler: requireUser,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['offerId'], additionalProperties: false,
          properties: { offerId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } },
        },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      try {
        await withTx(db, async (tx) => {
          const { ride, role } = await rideFor(tx, request.params.id, userId, true);
          if (role !== 'passenger') throw new HttpError(404, 'not_found');
          if (ride.status !== 'created') throw new HttpError(409, 'ride_not_open');
          // A choice the driver let lapse no longer blocks choosing someone else.
          await tx.query(
            `UPDATE ride_offers SET status = 'expired' WHERE ride_id = $1 AND status = 'chosen' AND expires_at <= now()`,
            [ride.id],
          );
          const { rows } = await tx.query(
            `UPDATE ride_offers o
                SET status = 'chosen', expires_at = now() + make_interval(secs => $3)
               FROM driver_presence p
              WHERE o.id = $2 AND o.ride_id = $1 AND o.status = 'open' AND o.expires_at > now()
                AND p.driver_id = o.driver_id AND p.status = 'online'
                AND p.updated_at > now() - make_interval(secs => $4)
              RETURNING o.id, o.driver_id, o.price_tiyin`,
            [ride.id, request.body.offerId, ACCEPT_WINDOW_SEC, PRESENCE_TTL_SEC],
          );
          if (!rows[0]) throw new HttpError(409, 'offer_unavailable');
          await event(tx, ride.id, 'offer_chosen', 'passenger', userId, {
            offerId: rows[0].id, driverId: rows[0].driver_id, priceTiyin: Number(rows[0].price_tiyin),
          });
        });
      } catch (err) {
        if (isUniqueViolation(err, 'ride_offers_one_chosen')) throw new HttpError(409, 'already_chosen');
        throw err;
      }
      return rideView(db, request.params.id, 'passenger');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/rides/:id/accept',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request) => {
      const userId = request.user!.id;
      try {
        await withTx(db, async (tx) => {
          const ctx = await driverContext(tx, userId);
          if (!ctx) throw new HttpError(404, 'not_found');
          if (ctx.blocked) throw new HttpError(403, 'blocked');
          if (!ctx.subscribed) throw new HttpError(402, 'subscription_required');

          const { rows: rides } = await tx.query<RideRow>(
            `SELECT id, status, passenger_id, driver_id, class_id FROM rides
              WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
            [request.params.id],
          );
          const { rows: offers } = await tx.query<{ id: string; price_tiyin: string; tariff_id: string }>(
            `SELECT id, price_tiyin, tariff_id FROM ride_offers
              WHERE ride_id = $1 AND driver_id = $2 AND status = 'chosen' AND expires_at > now()
              FOR UPDATE`,
            [request.params.id, ctx.driverId],
          );
          const ride = rides[0];
          const offer = offers[0];
          // Without a live choice for this driver the ride does not exist for them.
          if (!ride || !offer) throw new HttpError(404, 'not_found');
          if (!canTransition(ride.status, 'accepted')) throw new HttpError(409, 'ride_not_open');

          // The price is copied from the offer the passenger saw and is locked from now on.
          await tx.query(
            `UPDATE rides SET status = 'accepted', driver_id = $2, vehicle_id = $3,
                    locked_price_tiyin = $4, tariff_id = $5
              WHERE id = $1`,
            [ride.id, ctx.driverId, ctx.vehicleId, offer.price_tiyin, offer.tariff_id],
          );
          await tx.query(
            `UPDATE ride_offers SET status = 'expired'
              WHERE status IN ('open', 'chosen') AND id <> $3 AND (ride_id = $1 OR driver_id = $2)`,
            [ride.id, ctx.driverId, offer.id],
          );
          await setPresenceStatus(tx, ctx.driverId, 'busy');
          await event(tx, ride.id, 'status:accepted', 'driver', userId, { priceTiyin: Number(offer.price_tiyin) });
        });
      } catch (err) {
        if (isUniqueViolation(err, 'rides_one_active_per_driver')) throw new HttpError(409, 'driver_busy');
        throw err;
      }
      return rideView(db, request.params.id, 'driver');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/rides/:id/decline',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request, reply) => {
      const userId = request.user!.id;
      const { rows } = await db.query(
        `UPDATE ride_offers o SET status = 'declined'
           FROM drivers d
          WHERE o.ride_id = $1 AND o.driver_id = d.id AND d.user_id = $2 AND o.status IN ('open', 'chosen')
          RETURNING o.id`,
        [request.params.id, userId],
      );
      if (!rows[0]) throw new HttpError(404, 'not_found');
      await event(db, request.params.id, 'offer_declined', 'driver', userId, { offerId: rows[0].id });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { status: RideStatus } }>(
    '/rides/:id/status',
    {
      preHandler: requireUser,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['status'], additionalProperties: false,
          properties: { status: { type: 'string', enum: ['driver_en_route', 'arrived', 'in_progress', 'completed'] } },
        },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const next = request.body.status;
      await withTx(db, async (tx) => {
        const { ride, role } = await rideFor(tx, request.params.id, userId, true);
        // Only the assigned driver moves the ride forward.
        if (role !== 'driver') throw new HttpError(404, 'not_found');
        if (!canTransition(ride.status, next)) throw new HttpError(409, 'invalid_transition');
        await tx.query(`UPDATE rides SET status = $2 WHERE id = $1`, [ride.id, next]);
        if (next === 'completed') await setPresenceStatus(tx, ride.driver_id!, 'online');
        await event(tx, ride.id, `status:${next}`, 'driver', userId, { from: ride.status });
      });
      return rideView(db, request.params.id, 'driver');
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/rides/:id/cancel',
    {
      preHandler: requireUser,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 300 } },
        },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      let role: Role = 'passenger';
      await withTx(db, async (tx) => {
        const found = await rideFor(tx, request.params.id, userId, true);
        role = found.role;
        const { ride } = found;
        // A ride in progress cannot be cancelled; it ends with completion.
        if (!canTransition(ride.status, 'cancelled')) throw new HttpError(409, 'invalid_transition');
        await tx.query(
          `UPDATE rides SET status = 'cancelled', cancelled_by = $2, cancel_reason = $3 WHERE id = $1`,
          [ride.id, role, request.body?.reason ?? null],
        );
        await tx.query(
          `UPDATE ride_offers SET status = 'expired' WHERE ride_id = $1 AND status IN ('open', 'chosen')`,
          [ride.id],
        );
        if (ride.driver_id) await setPresenceStatus(tx, ride.driver_id, 'online');
        await event(tx, ride.id, 'status:cancelled', role, userId, { from: ride.status });
      });
      return rideView(db, request.params.id, role);
    },
  );
}
