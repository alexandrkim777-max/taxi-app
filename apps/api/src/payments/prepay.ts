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
  let firstError: unknown = null;
  for (const { id } of rows) {
    try {
      const result = await payments.chargeRideBalance(id);
      await logEvent(db, id, result === 'failed' ? 'prepay_failed' : 'prepaid', 'system', null, { result });
    } catch (err) {
      // The ride stays claimed ('pending'); the completion charge or reconcileTick finishes it.
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;
  return rows.length;
}

/** Completed card rides left unpaid for this long are charged again by reconcileTick. */
export const RECONCILE_AFTER_SEC = 120;

/**
 * Safety net after a crash or a restart: a card ride that was completed but never charged (the
 * process died between saving 'completed' and calling the provider) would otherwise be neither
 * paid nor a debt. Charges what is still due; a decline turns it into a debt as usual. Rides with
 * a charge already sent to the provider and awaiting its answer are left to the webhook.
 */
export async function reconcileTick(db: pg.Pool, payments: PaymentService): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT r.id FROM rides r
      WHERE r.status = 'completed' AND r.payment_method = 'card'
        AND r.locked_price_tiyin > r.paid_tiyin
        AND r.payment_status IS DISTINCT FROM 'failed'
        AND EXISTS (SELECT 1 FROM ride_events e WHERE e.ride_id = r.id AND e.type = 'status:completed'
                     AND e.at < now() - make_interval(secs => $1))
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.ride_id = r.id AND p.type = 'ride'
                         AND p.status = 'pending' AND p.provider_ref IS NOT NULL)
      ORDER BY r.created_at LIMIT 50`,
    [RECONCILE_AFTER_SEC],
  );
  let firstError: unknown = null;
  for (const { id } of rows) {
    try {
      const result = await payments.chargeRideBalance(id);
      await logEvent(db, id, 'charge_reconciled', 'system', null, { result });
    } catch (err) { firstError ??= err; }
  }
  if (firstError) throw firstError;
  return rows.length;
}
