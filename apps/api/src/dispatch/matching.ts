// Matching rides to drivers.
//
// Offers: every nearby free driver of the class gets an offer at their own price, clamped
// into the corridor. In 'choose' mode the passenger picks one; in 'auto' mode the system
// sends the ride to the best offer at or below the passenger's ceiling, and moves on to the
// next one when a driver declines or lets the request lapse.

import type pg from 'pg';
import { clampToCorridor, fareTiyin, type RouteEstimate, type Tariff } from '@taxi/shared';
import { nearbyDrivers, PRESENCE_TTL_SEC } from './presence.ts';

type Q = pg.Pool | pg.PoolClient;

/** How long an offer stays valid without a refresh. */
export const OFFER_TTL_SEC = 90;
/** How long a driver has to accept a request: auto mode is quick, a passenger's own pick a bit longer. */
export const ACCEPT_WINDOW_SEC = { auto: 15, choose: 30 } as const;
/** How long the system keeps searching before giving up. */
export const SEARCH_WINDOW_SEC = 5 * 60;
export const MAX_OFFERS = 10;

/**
 * One minute of extra waiting for pickup is weighed like 1 000 sum of price, so a slightly
 * cheaper driver 12 minutes away does not beat a nearby one.
 */
const TIYIN_PER_PICKUP_MIN = 100_000;

/** Rough pickup time from straight-line distance (same model as the estimate router). */
export function pickupMin(distanceM: number): number {
  return Math.max(1, Math.ceil((distanceM * 1.35) / ((22_000 / 60))));
}

/**
 * Each rating point below 5.0 is weighed like 2 000 sum, so with similar prices and pickup a
 * better-rated driver gets the order first (4.5 -> +1 000 sum, 4.0 -> +2 000 sum). Drivers with
 * fewer than 5 ratings are not penalised.
 */
const TIYIN_PER_RATING_POINT = 200_000;

export function offerScore(priceTiyin: number, distanceM: number, rating: number | null = null): number {
  const ratingPenalty = rating === null ? 0 : Math.max(0, 5 - rating) * TIYIN_PER_RATING_POINT;
  return priceTiyin + pickupMin(distanceM) * TIYIN_PER_PICKUP_MIN + ratingPenalty;
}

export interface ClassPricing {
  classId: string;
  recommended: Tariff;
  corridor: { minPct: number; maxPct: number };
}

export interface PricedDriver {
  driverId: string;
  tariffId: string;
  distanceM: number;
  rating: number | null;
  priceTiyin: number;
}

/** Nearby drivers of a class, each priced by their own tariff for this route. */
export async function pricedDrivers(
  q: Q,
  opts: { lat: number; lng: number; cls: ClassPricing; route: RouteEstimate; excludeUserId: string },
): Promise<PricedDriver[]> {
  const drivers = await nearbyDrivers(q, {
    lat: opts.lat, lng: opts.lng, classId: opts.cls.classId, excludeUserId: opts.excludeUserId, limit: MAX_OFFERS,
  });
  const reference = fareTiyin(opts.cls.recommended, opts.route);
  return drivers.map((d) => ({
    driverId: d.driverId,
    tariffId: d.tariffId,
    distanceM: d.distanceM,
    rating: d.rating,
    priceTiyin: clampToCorridor(fareTiyin(d, opts.route), reference, opts.cls.corridor),
  }));
}

/** The best offer for a one-tap order, or null when no driver is around. */
export function bestOf(drivers: PricedDriver[]): PricedDriver | null {
  let best: PricedDriver | null = null;
  for (const d of drivers) {
    if (!best || offerScore(d.priceTiyin, d.distanceM, d.rating) < offerScore(best.priceTiyin, best.distanceM, best.rating)) best = d;
  }
  return best;
}

interface RideForSearch {
  passenger_id: string;
  route_distance_m: number;
  route_duration_s: number;
  class_id: string;
  lat: number;
  lng: number;
  rec_base_tiyin: string;
  rec_per_km_tiyin: string;
  rec_per_min_tiyin: string;
  rec_min_fare_tiyin: string;
  corridor_min_pct: number;
  corridor_max_pct: number;
}

/**
 * Refreshes a ride's offers: offers of drivers who left are expired, nearby drivers get an
 * offer at their current price. A driver who declined this ride is never offered it again.
 */
export async function refreshOffers(q: Q, rideId: string): Promise<void> {
  const { rows } = await q.query<RideForSearch>(
    `SELECT r.passenger_id, r.route_distance_m, r.route_duration_s, r.class_id,
            ST_Y(s.point::geometry) AS lat, ST_X(s.point::geometry) AS lng,
            vc.rec_base_tiyin, vc.rec_per_km_tiyin, vc.rec_per_min_tiyin, vc.rec_min_fare_tiyin,
            vc.corridor_min_pct, vc.corridor_max_pct
       FROM rides r
       JOIN ride_stops s ON s.ride_id = r.id AND s.position = 0
       JOIN vehicle_classes vc ON vc.id = r.class_id
      WHERE r.id = $1`,
    [rideId],
  );
  const r = rows[0]!;
  const drivers = await pricedDrivers(q, {
    lat: r.lat, lng: r.lng, excludeUserId: r.passenger_id,
    route: { distanceM: r.route_distance_m, durationS: r.route_duration_s },
    cls: {
      classId: r.class_id,
      recommended: {
        baseTiyin: Number(r.rec_base_tiyin), perKmTiyin: Number(r.rec_per_km_tiyin),
        perMinTiyin: Number(r.rec_per_min_tiyin), minFareTiyin: Number(r.rec_min_fare_tiyin),
      },
      corridor: { minPct: r.corridor_min_pct, maxPct: r.corridor_max_pct },
    },
  });

  await q.query(`UPDATE ride_offers SET status = 'expired' WHERE ride_id = $1 AND status = 'open'`, [rideId]);
  if (drivers.length === 0) return;
  await q.query(
    `INSERT INTO ride_offers (ride_id, driver_id, price_tiyin, tariff_id, expires_at)
     SELECT $1, d, p, t, now() + make_interval(secs => $5)
       FROM unnest($2::uuid[], $3::bigint[], $4::uuid[]) AS x(d, p, t)
     ON CONFLICT (ride_id, driver_id) DO UPDATE
       SET status = 'open', price_tiyin = EXCLUDED.price_tiyin, tariff_id = EXCLUDED.tariff_id,
           expires_at = EXCLUDED.expires_at, created_at = now()
       WHERE ride_offers.status IN ('open', 'expired')`,
    [rideId, drivers.map((d) => d.driverId), drivers.map((d) => d.priceTiyin), drivers.map((d) => d.tariffId), OFFER_TTL_SEC],
  );
}

export async function logEvent(
  q: Q, rideId: string, type: string, actor: 'passenger' | 'driver' | 'system' | 'admin', actorId: string | null, payload = {},
): Promise<void> {
  await q.query(
    `INSERT INTO ride_events (ride_id, type, actor, actor_id, payload) VALUES ($1, $2, $3, $4, $5)`,
    [rideId, type, actor, actorId, JSON.stringify(payload)],
  );
}

/** Marks requests a driver let lapse as missed (never re-offered for this ride) and logs them. */
export async function expireLapsed(q: Q, rideId: string): Promise<void> {
  const { rows } = await q.query<{ id: string; driver_id: string }>(
    `UPDATE ride_offers SET status = 'missed'
      WHERE ride_id = $1 AND status = 'chosen' AND expires_at <= now()
      RETURNING id, driver_id`,
    [rideId],
  );
  for (const o of rows) await logEvent(q, rideId, 'offer_timeout', 'system', null, { offerId: o.id, driverId: o.driver_id });
}

export type AssignResult = 'sent' | 'waiting' | 'already_sent' | 'needs_confirmation' | 'searching';

/**
 * Auto mode: sends the ride to the best available driver at or below the passenger's ceiling.
 * Must run inside a transaction holding the ride's row lock.
 * - A driver who already has a pending request elsewhere is skipped, so nobody gets two at once.
 * - If only more expensive drivers are left, the cheapest of their prices is proposed to the
 *   passenger instead; nothing is sent until they confirm.
 */
export async function assignNext(tx: pg.PoolClient, rideId: string): Promise<AssignResult> {
  const { rows: rides } = await tx.query<{ max_price_tiyin: string; price_proposal_tiyin: string | null }>(
    `SELECT max_price_tiyin, price_proposal_tiyin FROM rides WHERE id = $1`,
    [rideId],
  );
  const ride = rides[0]!;
  if (ride.price_proposal_tiyin) return 'waiting';

  await expireLapsed(tx, rideId);
  const live = await tx.query(
    `SELECT 1 FROM ride_offers WHERE ride_id = $1 AND status = 'chosen' AND expires_at > now()`,
    [rideId],
  );
  if (live.rows.length) return 'already_sent';

  const candidates = async () =>
    tx.query<{ id: string; driver_id: string; price_tiyin: string; distance_m: number; rating: number | null }>(
      `SELECT o.id, o.driver_id, o.price_tiyin, ST_Distance(p.point, s.point)::int AS distance_m,
              CASE WHEN d.rating_count >= 5 THEN d.rating::float END AS rating
         FROM ride_offers o
         JOIN drivers d ON d.id = o.driver_id AND (d.paused_until IS NULL OR d.paused_until <= now())
         JOIN driver_presence p ON p.driver_id = o.driver_id
         JOIN ride_stops s ON s.ride_id = o.ride_id AND s.position = 0
        WHERE o.ride_id = $1 AND o.status = 'open' AND o.expires_at > now()
          AND p.status = 'online' AND p.updated_at > now() - make_interval(secs => $2)
          AND NOT EXISTS (SELECT 1 FROM ride_offers x
                           WHERE x.driver_id = o.driver_id AND x.status = 'chosen' AND x.expires_at > now())`,
      [rideId, PRESENCE_TTL_SEC],
    );

  let { rows } = await candidates();
  if (!rows.some((c) => Number(c.price_tiyin) <= Number(ride.max_price_tiyin))) {
    await refreshOffers(tx, rideId);
    ({ rows } = await candidates());
  }
  const ceiling = Number(ride.max_price_tiyin);
  const affordable = rows.filter((c) => Number(c.price_tiyin) <= ceiling);

  if (affordable.length === 0) {
    if (rows.length === 0) return 'searching';
    const cheapest = Math.min(...rows.map((c) => Number(c.price_tiyin)));
    await tx.query(`UPDATE rides SET price_proposal_tiyin = $2 WHERE id = $1`, [rideId, cheapest]);
    await logEvent(tx, rideId, 'price_proposal', 'system', null, { priceTiyin: cheapest, ceilingTiyin: ceiling });
    return 'needs_confirmation';
  }

  affordable.sort((a, b) =>
    offerScore(Number(a.price_tiyin), a.distance_m, a.rating) - offerScore(Number(b.price_tiyin), b.distance_m, b.rating));
  for (const pick of affordable) {
    if (!(await reserveDriver(tx, pick.driver_id))) continue;
    await tx.query(
      `UPDATE ride_offers SET status = 'chosen', expires_at = now() + make_interval(secs => $2) WHERE id = $1`,
      [pick.id, ACCEPT_WINDOW_SEC.auto],
    );
    await logEvent(tx, rideId, 'offer_sent', 'system', null, {
      offerId: pick.id, driverId: pick.driver_id, priceTiyin: Number(pick.price_tiyin),
    });
    return 'sent';
  }
  return 'searching';
}

/**
 * Locks the driver row and checks they have no pending request on another ride. Two rides
 * dispatched at the same moment therefore cannot both send a request to the same driver.
 */
export async function reserveDriver(tx: pg.PoolClient, driverId: string): Promise<boolean> {
  // NO KEY UPDATE, not UPDATE: offer inserts hold KEY SHARE locks on the driver row (foreign key),
  // and a full UPDATE lock would deadlock two parallel orders against each other.
  await tx.query(`SELECT 1 FROM drivers WHERE id = $1 FOR NO KEY UPDATE`, [driverId]);
  const { rows } = await tx.query(
    `SELECT 1 FROM ride_offers WHERE driver_id = $1 AND status = 'chosen' AND expires_at > now()`,
    [driverId],
  );
  return rows.length === 0;
}

/**
 * One pass of the dispatcher: moves every auto ride forward (next driver after a timeout,
 * newly arrived drivers, giving up after the search window). Safe to run on several API
 * instances at once: rides are claimed with SKIP LOCKED.
 */
export async function dispatchTick(db: pg.Pool): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM rides
      WHERE status = 'created' AND dispatch_mode = 'auto' AND deleted_at IS NULL
      ORDER BY created_at LIMIT 200`,
  );
  let handled = 0;
  // One short transaction per ride, so one failure does not hold back the others.
  for (const { id } of rows) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ overdue: boolean }>(
        `SELECT search_deadline <= now() AS overdue FROM rides
          WHERE id = $1 AND status = 'created' FOR UPDATE SKIP LOCKED`,
        [id],
      );
      const ride = locked.rows[0];
      if (ride?.overdue) {
        await client.query(
          `UPDATE rides SET status = 'cancelled', cancelled_by = 'system', cancel_reason = 'no_drivers' WHERE id = $1`,
          [id],
        );
        await client.query(`UPDATE ride_offers SET status = 'expired' WHERE ride_id = $1 AND status IN ('open', 'chosen')`, [id]);
        await logEvent(client, id, 'status:cancelled', 'system', null, { reason: 'no_drivers' });
      } else if (ride) {
        await assignNext(client, id);
      }
      await client.query('COMMIT');
      if (ride) handled++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return handled;
}
