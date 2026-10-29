// Waiting and cancellation terms, modelled on Yandex Go's published rules for Tashkent.
//
// Waiting at the pickup:
//   the first 2 minutes after 'arrived' are free, then the class rate per started-and-finished
//   minute (economy 500 sum), at most 30 paid minutes. Shown live to both sides; added to the
//   price when the trip starts.
//
// Cancellation by the passenger:
//   - within 3 minutes of the driver accepting:         free;
//   - later, while the driver is on the way:            half the class fee (2 500–5 000 sum);
//   - driver at the pickup:                             full class fee (5 000–10 000) + paid waiting.
// Cancellation by the driver:
//   - "passenger did not come out" after 5 minutes at the pickup, still within 200 m of it:
//                                                       the passenger pays the full fee + waiting;
//   - any other reason:                                 free for the passenger, counts against the driver.
// The passenger always sees the amount first and confirms it.

import type { RideStatus } from '@taxi/shared';
import type { Q, Role } from './common.ts';

/**
 * How close to the pickup the driver must be to mark 'arrived' or claim a no-show. Phone GPS
 * in dense blocks can be off by 20–40 m and drivers stop at the nearest legal spot.
 */
export const ARRIVAL_RADIUS_M = 200;
/** How long the driver waits at the pickup before a no-show is accepted. */
export const NO_SHOW_WAIT_MIN = 5;
/** Free cancellation window after the driver accepts. */
export const FREE_CANCEL_MIN = 3;

export interface Waiting {
  arrivedAt: string;
  freeUntil: string;
  ratePerMinTiyin: number;
  paidMinutes: number;
  accruedTiyin: number;
  maxPaidMinutes: number;
}

/** Waiting so far (or up to the trip start, once started). Null before the driver arrives. */
export async function waitingOf(q: Q, rideId: string): Promise<Waiting | null> {
  const { rows } = await q.query(
    `WITH ev AS (
       SELECT max(at) FILTER (WHERE type = 'status:arrived') AS arrived_at,
              max(at) FILTER (WHERE type = 'status:in_progress') AS started_at
         FROM ride_events WHERE ride_id = $1
     )
     SELECT ev.arrived_at, ev.arrived_at + make_interval(mins => vc.free_wait_min) AS free_until,
            vc.wait_per_min_tiyin AS rate, vc.max_paid_wait_min AS max_paid,
            LEAST(vc.max_paid_wait_min, GREATEST(0,
              floor(extract(epoch FROM coalesce(ev.started_at, now()) - ev.arrived_at) / 60)::int - vc.free_wait_min
            )) AS paid_min
       FROM rides r JOIN vehicle_classes vc ON vc.id = r.class_id, ev
      WHERE r.id = $1 AND ev.arrived_at IS NOT NULL`,
    [rideId],
  );
  const r = rows[0];
  if (!r) return null;
  const paid = Number(r.paid_min);
  return {
    arrivedAt: r.arrived_at,
    freeUntil: r.free_until,
    ratePerMinTiyin: Number(r.rate),
    paidMinutes: paid,
    accruedTiyin: paid * Number(r.rate),
    maxPaidMinutes: Number(r.max_paid),
  };
}

export interface CancelTerms {
  allowed: boolean;
  feeTiyin: number;
  /** Parts of the fee, for the confirmation screen. */
  breakdown?: { cancelTiyin: number; waitingTiyin: number };
  /** Passenger: until when cancelling is still free. */
  freeUntil?: string;
  /** Driver's no-show: when it becomes possible. */
  noShowFrom?: string;
}

export async function cancelTerms(
  q: Q, rideId: string, status: RideStatus, role: Role, noShow: boolean,
): Promise<CancelTerms> {
  if (status === 'in_progress' || status === 'completed' || status === 'cancelled') {
    return { allowed: false, feeTiyin: 0 };
  }
  if (status === 'created' || status === 'scheduled') return { allowed: true, feeTiyin: 0 };

  const { rows } = await q.query<{ fee: string; free_until: string | null; past_free: boolean; no_show_from: string | null; can_no_show: boolean }>(
    `WITH ev AS (
       SELECT max(at) FILTER (WHERE type = 'status:accepted') AS accepted_at,
              max(at) FILTER (WHERE type = 'status:arrived') AS arrived_at
         FROM ride_events WHERE ride_id = $1
     )
     SELECT vc.cancel_fee_tiyin AS fee,
            ev.accepted_at + make_interval(mins => $2) AS free_until,
            coalesce(ev.accepted_at + make_interval(mins => $2) <= now(), false) AS past_free,
            ev.arrived_at + make_interval(mins => $3) AS no_show_from,
            coalesce(ev.arrived_at + make_interval(mins => $3) <= now(), false) AS can_no_show
       FROM rides r JOIN vehicle_classes vc ON vc.id = r.class_id, ev
      WHERE r.id = $1`,
    [rideId, FREE_CANCEL_MIN, NO_SHOW_WAIT_MIN],
  );
  const r = rows[0]!;
  const fullFee = Number(r.fee);

  // Driver still on the way.
  if (status === 'accepted' || status === 'driver_en_route') {
    if (role === 'driver') return { allowed: true, feeTiyin: 0 };
    if (!r.past_free) return { allowed: true, feeTiyin: 0, freeUntil: r.free_until ?? undefined };
    const half = Math.round(fullFee / 2 / 50_000) * 50_000; // whole 500 sum
    return { allowed: true, feeTiyin: half, breakdown: { cancelTiyin: half, waitingTiyin: 0 } };
  }

  // Driver at the pickup.
  const waiting = (await waitingOf(q, rideId))?.accruedTiyin ?? 0;
  const charged = { allowed: true, feeTiyin: fullFee + waiting, breakdown: { cancelTiyin: fullFee, waitingTiyin: waiting } };
  if (role === 'passenger') return charged;
  if (!noShow) return { allowed: true, feeTiyin: 0 };
  return r.can_no_show ? charged : { allowed: false, feeTiyin: charged.feeTiyin, noShowFrom: r.no_show_from ?? undefined };
}
