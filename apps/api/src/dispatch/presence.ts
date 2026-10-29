// Live driver presence: who is on the line, where, and whether they are on a ride.
// All access goes through this module so the store can move from PostgreSQL to Redis later.

import type pg from 'pg';

type Q = pg.Pool | pg.PoolClient;

/** A position older than this is treated as offline (app closed, no signal). */
export const PRESENCE_TTL_SEC = 60;
/** Drivers are never sent further than this to a pickup, whatever their own setting. */
export const MAX_PICKUP_RADIUS_M = 5000;

export interface Position {
  lat: number;
  lng: number;
  heading?: number;
}

/** Eligibility for taking rides, checked when going online and again when accepting. */
export interface DriverContext {
  driverId: string;
  vehicleId: string;
  classId: string;
  subscribed: boolean;
  blocked: boolean;
}

export async function driverContext(q: Q, userId: string): Promise<DriverContext | null> {
  const { rows } = await q.query<DriverContext>(
    `SELECT d.id AS "driverId", v.id AS "vehicleId", v.class_id AS "classId",
            EXISTS (SELECT 1 FROM subscriptions s
                     WHERE s.driver_id = d.id AND s.status = 'active'
                       AND s.starts_at <= now() AND s.ends_at > now()) AS subscribed,
            EXISTS (SELECT 1 FROM blocks b
                     WHERE b.user_id = d.user_id AND b.appeal_status <> 'lifted'
                       AND (b.until IS NULL OR b.until > now())) AS blocked
       FROM drivers d
       JOIN vehicles v ON v.driver_id = d.id AND v.is_active AND v.deleted_at IS NULL AND v.class_id IS NOT NULL
      WHERE d.user_id = $1 AND d.status = 'verified' AND d.deleted_at IS NULL
      ORDER BY v.created_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** Puts the driver on the line; a driver already on a ride stays 'busy'. */
export async function goOnline(q: Q, ctx: DriverContext, pos: Position): Promise<'online' | 'busy'> {
  const { rows } = await q.query<{ status: 'online' | 'busy' }>(
    `INSERT INTO driver_presence (driver_id, vehicle_id, class_id, status, point, heading)
     VALUES ($1, $2, $3, 'online', ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography, $6)
     ON CONFLICT (driver_id) DO UPDATE
       SET point = EXCLUDED.point, heading = EXCLUDED.heading, updated_at = now(),
           vehicle_id = CASE WHEN driver_presence.status = 'busy' THEN driver_presence.vehicle_id ELSE EXCLUDED.vehicle_id END,
           class_id   = CASE WHEN driver_presence.status = 'busy' THEN driver_presence.class_id ELSE EXCLUDED.class_id END
     RETURNING status`,
    [ctx.driverId, ctx.vehicleId, ctx.classId, pos.lat, pos.lng, pos.heading ?? null],
  );
  return rows[0]!.status;
}

/**
 * Position ping. One query: only a verified driver who is already on the line can move
 * their marker. Returns null when the driver is not online.
 */
export async function updatePosition(q: Q, userId: string, pos: Position): Promise<string | null> {
  const { rows } = await q.query<{ status: string }>(
    `UPDATE driver_presence p
        SET point = ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, heading = $4, updated_at = now()
       FROM drivers d
      WHERE d.id = p.driver_id AND d.user_id = $1 AND d.status = 'verified' AND d.deleted_at IS NULL
      RETURNING p.status`,
    [userId, pos.lat, pos.lng, pos.heading ?? null],
  );
  return rows[0]?.status ?? null;
}

/** Leaves the line. Refused while on a ride: the ride has to be finished or cancelled first. */
export async function goOffline(q: Q, userId: string): Promise<'offline' | 'busy'> {
  const { rows } = await q.query<{ status: string }>(
    `SELECT p.status FROM driver_presence p JOIN drivers d ON d.id = p.driver_id WHERE d.user_id = $1`,
    [userId],
  );
  if (rows[0]?.status === 'busy') return 'busy';
  await q.query(
    `DELETE FROM driver_presence p USING drivers d WHERE d.id = p.driver_id AND d.user_id = $1 AND p.status = 'online'`,
    [userId],
  );
  return 'offline';
}

export async function setPresenceStatus(q: Q, driverId: string, status: 'online' | 'busy'): Promise<void> {
  await q.query(`UPDATE driver_presence SET status = $2 WHERE driver_id = $1`, [driverId, status]);
}

export interface NearbyDriver {
  driverId: string;
  distanceM: number;
  tariffId: string;
  baseTiyin: number;
  perKmTiyin: number;
  perMinTiyin: number;
  minFareTiyin: number;
}

/**
 * Nearest free drivers of a class around a point, each with their current tariff.
 * Only verified, subscribed, unblocked drivers with a fresh position are returned,
 * and never the passenger themselves.
 */
export async function nearbyDrivers(
  q: Q,
  opts: { lat: number; lng: number; classId: string; excludeUserId: string; limit: number },
): Promise<NearbyDriver[]> {
  const { rows } = await q.query<NearbyDriver>(
    `WITH pickup AS (SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS point)
     SELECT p.driver_id AS "driverId",
            ST_Distance(p.point, pickup.point)::int AS "distanceM",
            t.id AS "tariffId",
            t.base_tiyin::int AS "baseTiyin", t.per_km_tiyin::int AS "perKmTiyin",
            t.per_min_tiyin::int AS "perMinTiyin", t.min_fare_tiyin::int AS "minFareTiyin"
       FROM driver_presence p
       CROSS JOIN pickup
       JOIN drivers d ON d.id = p.driver_id
       JOIN LATERAL (
         SELECT * FROM driver_tariffs t
          WHERE t.driver_id = p.driver_id AND t.class_id = p.class_id
          ORDER BY t.version DESC LIMIT 1
       ) t ON true
      WHERE p.status = 'online'
        AND p.class_id = $3
        AND p.updated_at > now() - make_interval(secs => $6)
        AND ST_DWithin(p.point, pickup.point, LEAST(d.pickup_radius_m, $7))
        AND d.status = 'verified' AND d.deleted_at IS NULL
        AND d.user_id <> $4
        AND EXISTS (SELECT 1 FROM subscriptions s
                     WHERE s.driver_id = d.id AND s.status = 'active'
                       AND s.starts_at <= now() AND s.ends_at > now())
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE b.user_id = d.user_id AND b.appeal_status <> 'lifted'
                           AND (b.until IS NULL OR b.until > now()))
      ORDER BY p.point <-> pickup.point
      LIMIT $5`,
    [opts.lat, opts.lng, opts.classId, opts.excludeUserId, opts.limit, PRESENCE_TTL_SEC, MAX_PICKUP_RADIUS_M],
  );
  return rows;
}
