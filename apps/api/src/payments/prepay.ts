// Card rides are charged when 60% of the trip is done (by distance driven or by time), not at the
// end. If the card is declined the passenger still has time to switch to cash or another card
// before getting out; the driver sees the change at once.

import type pg from 'pg';
import { logEvent } from '../dispatch/matching.ts';
import type { PaymentService } from './service.ts';

export const PREPAY_AT = 0.6;

/** One pass: claims card rides that crossed 60% and charges them. Safe on several instances. */
export async function prepayTick(db: pg.Pool, payments: PaymentService): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE rides r SET payment_status = 'pending'
      WHERE r.status = 'in_progress' AND r.payment_method = 'card' AND r.payment_status IS NULL
        AND (r.trip_distance_m >= $1::float8 * r.route_distance_m
             OR EXISTS (SELECT 1 FROM ride_events e
                         WHERE e.ride_id = r.id AND e.type = 'status:in_progress'
                           AND e.at <= now() - make_interval(secs => $1::float8 * r.route_duration_s)))
      RETURNING r.id`,
    [PREPAY_AT],
  );
  for (const { id } of rows) {
    const result = await payments.chargeRideBalance(id);
    await logEvent(db, id, result === 'failed' ? 'prepay_failed' : 'prepaid', 'system', null, { result });
  }
  return rows.length;
}
