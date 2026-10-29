// Driver side of dispatch: going on and off the line, position pings, incoming requests.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { requireUser } from '../auth/session.ts';
import { driverPosition } from '../lib/geo.ts';
import { hashToken } from '../lib/secrets.ts';
import { driverContext, goOffline, goOnline, updatePosition, type Position } from './presence.ts';

interface Deps {
  db: pg.Pool;
}

/** Rate-limit key per session token (hashed), so drivers behind one mobile NAT don't share a limit. */
function perSession(request: FastifyRequest): string {
  const auth = request.headers.authorization;
  return auth ? `s:${hashToken(auth)}` : `ip:${request.ip}`;
}

// A ping every 3–5 s is normal; anything far above that is a broken or abusive client.
const PING_LIMIT = { rateLimit: { max: 40, timeWindow: '1 minute', keyGenerator: perSession } };

export async function dispatchRoutes(app: FastifyInstance, { db }: Deps): Promise<void> {
  app.post<{ Body: Position }>(
    '/drivers/me/online',
    { preHandler: requireUser, schema: { body: driverPosition } },
    async (request, reply) => {
      const ctx = await driverContext(db, request.user!.id);
      if (!ctx) return reply.code(404).send({ error: 'no_verified_vehicle' });
      if (ctx.blocked) return reply.code(403).send({ error: 'blocked' });
      if (!ctx.subscribed) return reply.code(402).send({ error: 'subscription_required' });
      if (ctx.pausedUntil) return reply.code(423).send({ error: 'paused', pausedUntil: ctx.pausedUntil });

      // A driver who never set a price works at the recommended tariff. Store it as
      // version 0 so every offer points at a concrete tariff row.
      await db.query(
        `INSERT INTO driver_tariffs (driver_id, class_id, version, base_tiyin, per_km_tiyin, per_min_tiyin, min_fare_tiyin)
         SELECT $1, vc.id, 0, vc.rec_base_tiyin, vc.rec_per_km_tiyin, vc.rec_per_min_tiyin, vc.rec_min_fare_tiyin
           FROM vehicle_classes vc
          WHERE vc.id = $2
            AND NOT EXISTS (SELECT 1 FROM driver_tariffs t WHERE t.driver_id = $1 AND t.class_id = $2)
         ON CONFLICT DO NOTHING`,
        [ctx.driverId, ctx.classId],
      );
      const status = await goOnline(db, ctx, request.body);
      return { status };
    },
  );

  app.post<{ Body: Position }>(
    '/drivers/me/location',
    { preHandler: requireUser, schema: { body: driverPosition }, config: PING_LIMIT },
    async (request, reply) => {
      const status = await updatePosition(db, request.user!.id, request.body);
      if (!status) return reply.code(409).send({ error: 'not_online' });
      return reply.code(204).send();
    },
  );

  app.post('/drivers/me/offline', { preHandler: requireUser }, async (request, reply) => {
    const result = await goOffline(db, request.user!.id);
    if (result === 'busy') return reply.code(409).send({ error: 'on_ride' });
    return { status: 'offline' };
  });

  // The driver's home screen numbers: rides and earnings today and this week (Tashkent time), and
  // what they kept compared with a typical 20% aggregator commission.
  app.get('/drivers/me/stats', { preHandler: requireUser }, async (request, reply) => {
    const { rows } = await db.query(
      `WITH d AS (SELECT id FROM drivers WHERE user_id = $1 AND deleted_at IS NULL),
            t AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent') AS day,
                         (date_trunc('week', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent') AS week)
       SELECT (SELECT id FROM d) AS driver_id,
              count(*) FILTER (WHERE r.created_at >= t.day)::int AS rides_today,
              coalesce(sum(r.locked_price_tiyin) FILTER (WHERE r.created_at >= t.day), 0)::bigint AS earned_today,
              count(*) FILTER (WHERE r.created_at >= t.week)::int AS rides_week,
              coalesce(sum(r.locked_price_tiyin) FILTER (WHERE r.created_at >= t.week), 0)::bigint AS earned_week,
              (SELECT max(ends_at) FROM subscriptions s WHERE s.driver_id = (SELECT id FROM d) AND s.status = 'active') AS subscription_until
         FROM t LEFT JOIN rides r ON r.driver_id = (SELECT id FROM d) AND r.status = 'completed'
        GROUP BY t.day, t.week`,
      [request.user!.id],
    );
    const r = rows[0];
    if (!r?.driver_id) return reply.code(404).send({ error: 'not_a_driver' });
    const COMMISSION = 0.2;
    return {
      today: { rides: r.rides_today, earnedTiyin: Number(r.earned_today), keptVsCommissionTiyin: Math.round(Number(r.earned_today) * COMMISSION) },
      week: { rides: r.rides_week, earnedTiyin: Number(r.earned_week), keptVsCommissionTiyin: Math.round(Number(r.earned_week) * COMMISSION) },
      subscriptionUntil: r.subscription_until,
      comparedCommissionPct: COMMISSION * 100,
    };
  });

  // Rides where a passenger chose this driver and is waiting for them to accept.
  // Pickup and destination are revealed to a driver only at this point.
  app.get('/drivers/me/requests', { preHandler: requireUser }, async (request) => {
    const { rows } = await db.query(
      `SELECT r.id AS "rideId", o.id AS "offerId", o.price_tiyin::int AS "priceTiyin", o.expires_at AS "expiresAt",
              r.route_distance_m AS "distanceM", r.route_duration_s AS "durationS", r.options,
              r.driver_comment AS comment,
              CASE WHEN pu.rating_count >= 5 THEN pu.rating::float END AS "passengerRating",
              (SELECT ST_Distance(p.point, s0.point)::int FROM driver_presence p, ride_stops s0
                WHERE p.driver_id = d.id AND s0.ride_id = r.id AND s0.position = 0) AS "pickupDistanceM",
              (SELECT json_agg(json_build_object('position', s.position, 'lat', ST_Y(s.point::geometry),
                                                 'lng', ST_X(s.point::geometry), 'address', s.address,
                                                 'entrance', coalesce((SELECT e.number FROM entrances e WHERE e.id = s.entrance_id), s.entrance_label))
                               ORDER BY s.position)
                 FROM ride_stops s WHERE s.ride_id = r.id) AS stops
         FROM ride_offers o
         JOIN rides r ON r.id = o.ride_id
         JOIN users pu ON pu.id = r.passenger_id
         JOIN drivers d ON d.id = o.driver_id
        WHERE d.user_id = $1 AND o.status = 'chosen' AND o.expires_at > now() AND r.status = 'created'
        ORDER BY o.expires_at`,
      [request.user!.id],
    );
    return rows;
  });
}
