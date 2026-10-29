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

  // Rides where a passenger chose this driver and is waiting for them to accept.
  // Pickup and destination are revealed to a driver only at this point.
  app.get('/drivers/me/requests', { preHandler: requireUser }, async (request) => {
    const { rows } = await db.query(
      `SELECT r.id AS "rideId", o.id AS "offerId", o.price_tiyin::int AS "priceTiyin", o.expires_at AS "expiresAt",
              r.route_distance_m AS "distanceM", r.route_duration_s AS "durationS", r.options,
              r.driver_comment AS comment,
              (SELECT json_agg(json_build_object('position', s.position, 'lat', ST_Y(s.point::geometry),
                                                 'lng', ST_X(s.point::geometry), 'address', s.address)
                               ORDER BY s.position)
                 FROM ride_stops s WHERE s.ride_id = r.id) AS stops
         FROM ride_offers o
         JOIN rides r ON r.id = o.ride_id
         JOIN drivers d ON d.id = o.driver_id
        WHERE d.user_id = $1 AND o.status = 'chosen' AND o.expires_at > now() AND r.status = 'created'
        ORDER BY o.expires_at`,
      [request.user!.id],
    );
    return rows;
  });
}
