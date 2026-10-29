// Shared pieces of the ride API: access checks, schemas and the ride view.

import type pg from 'pg';
import type { RideStatus } from '@taxi/shared';
import { UZ_LAT, UZ_LNG } from '../lib/geo.ts';
import { HttpError } from '../lib/tx.ts';
import { pickupMin } from '../dispatch/matching.ts';

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
            r.driver_id, pu.name AS "passengerName",
            du.name AS "driverName", d.rating::float AS "driverRating",
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
    `SELECT position, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, address
       FROM ride_stops WHERE ride_id = $1 ORDER BY position`,
    [rideId],
  );
  const view: Record<string, unknown> = {
    id: r.id, status: r.status, mode: r.mode, classCode: r.classCode, priceTiyin: r.priceTiyin,
    route: { distanceM: r.distanceM, durationS: r.durationS },
    stops: stops.rows, options: r.options, comment: r.comment,
    cancelledBy: r.cancelledBy, cancelReason: r.cancelReason,
    cancelFee: r.cancelFeeTiyin ? { amountTiyin: r.cancelFeeTiyin, status: r.cancelFeeStatus } : null,
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
      vehicle: { makeModel: r.makeModel, color: r.color, plate: r.plate },
      // Live position only while the ride is active, and only to its participants.
      location: r.driverLat != null
        ? { lat: r.driverLat, lng: r.driverLng, heading: r.driverHeading, at: r.driverSeenAt }
        : null,
    };
  }
  if (role === 'driver') view.passenger = { name: r.passengerName };
  return view;
}
