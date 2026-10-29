// Shared pieces of the ride API: access checks, schemas and the ride view.

import type pg from 'pg';
import type { RideStatus } from '@taxi/shared';
import { UZ_LAT, UZ_LNG } from '../lib/geo.ts';
import { HttpError } from '../lib/tx.ts';
import { pickupMin } from '../dispatch/matching.ts';
import { waitingOf } from './cancellation.ts';
import { driverHighlights } from '../ratings/highlights.ts';

export type Q = pg.Pool | pg.PoolClient;

export const ACTIVE = ['accepted', 'driver_en_route', 'arrived', 'in_progress'];
export const UUID = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } as const;

export const stop = {
  type: 'object',
  required: ['lat', 'lng'],
  additionalProperties: false,
  properties: {
    lat: UZ_LAT,
    lng: UZ_LNG,
    address: { type: 'string', maxLength: 200 },
    // Pickup only: a known entrance from /geo/entrances, or the number the passenger typed ("3", "2A").
    entranceId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
    entranceLabel: { type: 'string', pattern: '^[0-9A-Za-zА-Яа-я]{1,8}$' },
  },
} as const;

export const rideOptions = {
  type: 'object',
  additionalProperties: false,
  properties: {
    childSeat: { type: 'boolean' },
    pet: { type: 'boolean' },
    quiet: { type: 'boolean' },
    luggage: { type: 'boolean' },
  },
} as const;

export interface RideRow {
  id: string;
  status: RideStatus;
  passenger_id: string;
  driver_id: string | null;
  class_id: string;
  dispatch_mode: 'auto' | 'choose';
  price_proposal_tiyin: string | null;
}

export type Role = 'passenger' | 'driver';

export async function isBlocked(q: Q, userId: string): Promise<boolean> {
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
export async function rideFor(q: Q, rideId: string, userId: string, lock: boolean): Promise<{ ride: RideRow; role: Role }> {
  const { rows } = await q.query<RideRow & { driver_user_id: string | null }>(
    `SELECT r.id, r.status, r.passenger_id, r.driver_id, r.class_id, r.dispatch_mode, r.price_proposal_tiyin,
            d.user_id AS driver_user_id
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
export async function openOffers(q: Q, rideId: string) {
  const { rows } = await q.query(
    `SELECT o.id, o.status, o.price_tiyin::int AS "priceTiyin", o.expires_at AS "expiresAt",
            u.name AS "driverName", CASE WHEN d.rating_count >= 5 THEN d.rating::float END AS rating,
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
  return rows.map((o) => ({ ...o, pickupMin: pickupMin(o.distanceM) }));
}

export async function rideView(q: Q, rideId: string, role: Role) {
  const { rows } = await q.query(
    `SELECT r.id, r.status, vc.code AS "classCode", r.locked_price_tiyin::int AS "priceTiyin",
            r.dispatch_mode AS mode, r.max_price_tiyin::int AS "maxPriceTiyin",
            r.price_proposal_tiyin::int AS "priceProposalTiyin", r.search_deadline AS "searchDeadline",
            r.route_distance_m AS "distanceM", r.route_duration_s AS "durationS",
            r.options, r.driver_comment AS comment, r.cancelled_by AS "cancelledBy",
            r.cancel_reason AS "cancelReason", r.cancel_fee_tiyin::int AS "cancelFeeTiyin",
            r.cancel_fee_status AS "cancelFeeStatus", r.created_at AS "createdAt",
            r.payment_method AS "paymentMethod", r.payment_status AS "paymentStatus",
            r.paid_tiyin::int AS "paidTiyin", r.trip_distance_m AS "tripDistanceM",
            r.driver_id, pu.name AS "passengerName",
            du.name AS "driverName", CASE WHEN d.rating_count >= 5 THEN d.rating::float END AS "driverRating",
            CASE WHEN pu.rating_count >= 5 THEN pu.rating::float END AS "passengerRating",
            v.make_model AS "makeModel", v.color, v.plate,
            ST_Y(p.point::geometry) AS "driverLat", ST_X(p.point::geometry) AS "driverLng",
            p.heading AS "driverHeading", p.updated_at AS "driverSeenAt",
            EXISTS (SELECT 1 FROM ride_offers o
                     WHERE o.ride_id = r.id AND o.status = 'chosen' AND o.expires_at > now()) AS "waitingDriver"
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
    `SELECT position, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, address,
            coalesce((SELECT e.number FROM entrances e WHERE e.id = ride_stops.entrance_id), entrance_label) AS entrance
       FROM ride_stops WHERE ride_id = $1 ORDER BY position`,
    [rideId],
  );
  const view: Record<string, unknown> = {
    id: r.id, status: r.status, mode: r.mode, classCode: r.classCode, priceTiyin: r.priceTiyin,
    route: { distanceM: r.distanceM, durationS: r.durationS },
    stops: stops.rows, options: r.options, comment: r.comment,
    cancelledBy: r.cancelledBy, cancelReason: r.cancelReason,
    cancelFee: r.cancelFeeTiyin ? { amountTiyin: r.cancelFeeTiyin, status: r.cancelFeeStatus } : null,
    payment: {
      method: r.paymentMethod,
      status: r.paymentStatus,
      paidTiyin: r.paidTiyin,
      dueTiyin: r.priceTiyin === null ? null : Math.max(0, r.priceTiyin - r.paidTiyin),
      // Card declined during the trip: the app asks "pay cash or add another card".
      actionRequired: r.paymentStatus === 'failed' && ['accepted', 'driver_en_route', 'arrived', 'in_progress'].includes(r.status),
    },
    createdAt: r.createdAt,
  };
  if (r.status === 'created' && role === 'passenger') {
    if (r.mode === 'auto') {
      view.maxPriceTiyin = r.maxPriceTiyin;
      view.searchDeadline = r.searchDeadline;
      // What the passenger's screen shows while we look for a driver.
      view.dispatch = r.priceProposalTiyin
        ? { state: 'needs_confirmation', priceTiyin: r.priceProposalTiyin }
        : { state: r.waitingDriver ? 'waiting_driver' : 'searching' };
    } else {
      view.offers = await openOffers(q, rideId);
    }
  }
  if (r.driver_id) {
    view.driver = {
      name: r.driverName, rating: r.driverRating,
      highlights: await driverHighlights(q, r.driver_id),
      vehicle: { makeModel: r.makeModel, color: r.color, plate: r.plate },
      // Live position only while the ride is active, and only to its participants.
      location: r.driverLat != null
        ? { lat: r.driverLat, lng: r.driverLng, heading: r.driverHeading, at: r.driverSeenAt }
        : null,
    };
  }
  if (role === 'driver') {
    view.passenger = { name: r.passengerName, rating: r.passengerRating };
    // What the driver collects in cash at the end (also after a switch from a declined card).
    view.cashToCollectTiyin = r.paymentMethod === 'cash' && r.priceTiyin !== null ? Math.max(0, r.priceTiyin - r.paidTiyin) : 0;
  }
  if (r.status === 'in_progress' && r.distanceM) {
    view.trip = { drivenM: r.tripDistanceM, progressPct: Math.min(100, Math.round((100 * r.tripDistanceM) / r.distanceM)) };
  }
  // End-of-ride screen: has this side rated yet?
  if (r.status === 'completed') {
    const mine = await q.query<{ score: number }>(
      `SELECT rt.score FROM ratings rt JOIN rides ri ON ri.id = rt.ride_id
        WHERE rt.ride_id = $1
          AND rt.from_user = CASE WHEN $2 = 'passenger' THEN ri.passenger_id
                                  ELSE (SELECT user_id FROM drivers WHERE id = ri.driver_id) END`,
      [rideId, role],
    );
    view.rating = { myScore: mine.rows[0]?.score ?? null, canRate: !mine.rows[0] };
  }
  // Waiting at the pickup: a live counter while the driver waits, then what was charged.
  if (r.status === 'arrived') {
    view.waiting = await waitingOf(q, rideId);
  } else if (r.status === 'in_progress' || r.status === 'completed') {
    const w = await q.query(
      `SELECT wait_paid_min AS "paidMinutes", amount_tiyin::int AS "chargedTiyin"
         FROM price_changes WHERE ride_id = $1 AND reason = 'waiting'`,
      [rideId],
    );
    view.waiting = w.rows[0] ?? null;
  }
  return view;
}

export interface StopInput { lat: number; lng: number; address?: string; entranceId?: string; entranceLabel?: string }

/**
 * Writes a ride's stops. An entrance is kept only for the pickup and only if it really is near the pin
 * (a known entrance within 150 m); otherwise it is dropped silently rather than misleading the driver.
 */
export async function insertStops(q: Q, rideId: string, stops: StopInput[]): Promise<void> {
  for (const [i, s] of stops.entries()) {
    await q.query(
      `INSERT INTO ride_stops (ride_id, position, point, address, entrance_id, entrance_label)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5,
               (SELECT e.id FROM entrances e WHERE e.id = $6::uuid AND e.deleted_at IS NULL
                   AND ST_DWithin(e.entrance_point, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, 150)),
               $7)`,
      [rideId, i, s.lat, s.lng, s.address ?? null, i === 0 ? s.entranceId ?? null : null, i === 0 ? s.entranceLabel ?? null : null],
    );
  }
}

/**
 * Our entrance database learns from real pickups: when the passenger named an entrance ("3") that we
 * did not know yet, the driver's position at trip start is where that entrance is. A second pickup at
 * the same entrance (within 60 m) confirms it instead of adding a duplicate.
 */
export async function learnEntrance(q: Q, rideId: string, driverId: string): Promise<void> {
  const { rows } = await q.query<{ label: string; city_id: string; address: string | null; stop_lat: number; stop_lng: number; d_lat: number; d_lng: number }>(
    `SELECT s.entrance_label AS label, r.city_id, s.address,
            ST_Y(s.point::geometry) AS stop_lat, ST_X(s.point::geometry) AS stop_lng,
            ST_Y(p.point::geometry) AS d_lat, ST_X(p.point::geometry) AS d_lng
       FROM ride_stops s
       JOIN rides r ON r.id = s.ride_id
       JOIN driver_presence p ON p.driver_id = $2 AND p.updated_at > now() - interval '60 seconds'
      WHERE s.ride_id = $1 AND s.position = 0 AND s.entrance_id IS NULL AND s.entrance_label IS NOT NULL
        AND ST_DWithin(s.point, p.point, 200)`,
    [rideId, driverId],
  );
  const r = rows[0];
  if (!r) return;
  const existing = await q.query<{ id: string }>(
    `UPDATE entrances SET confirmed_pickups = confirmed_pickups + 1, updated_at = now()
      WHERE id = (SELECT id FROM entrances
                   WHERE deleted_at IS NULL AND upper(number) = upper($1)
                     AND ST_DWithin(entrance_point, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, 60)
                   ORDER BY confirmed_pickups DESC LIMIT 1)
      RETURNING id`,
    [r.label, r.d_lat, r.d_lng],
  );
  let entranceId = existing.rows[0]?.id;
  if (!entranceId) {
    const ins = await q.query<{ id: string }>(
      `INSERT INTO entrances (city_id, building_address, building_point, number, entrance_point, confirmed_pickups, source)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5, ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography, 1, 'pickups')
       RETURNING id`,
      [r.city_id, r.address ?? '', r.stop_lat, r.stop_lng, r.label.toUpperCase(), r.d_lat, r.d_lng],
    );
    entranceId = ins.rows[0]!.id;
  }
  await q.query(`UPDATE ride_stops SET entrance_id = $2 WHERE ride_id = $1 AND position = 0`, [rideId, entranceId]);
}
