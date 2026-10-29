// Cancellation terms.
//
// - Before the driver is at the pickup: free for everyone.
// - Driver at the pickup ('arrived'):
//     passenger cancels                       -> fixed class fee to the driver (5 000–10 000 sum);
//     driver cancels as a no-show after 5 min  -> the same fee;
//     driver cancels for any other reason      -> free for the passenger.
// - The passenger always sees the fee before cancelling and must confirm that exact amount.
// - Drivers cannot farm fees: 'arrived' is accepted only when their live position is at the pickup.

import type { RideStatus } from '@taxi/shared';
import type { Q, Role } from './common.ts';

/** How close to the pickup the driver must be to mark 'arrived'. */
export const ARRIVAL_RADIUS_M = 150;
/** How long the driver waits at the pickup before a no-show is accepted. */
export const NO_SHOW_WAIT_MIN = 5;

export interface CancelTerms {
  allowed: boolean;
  feeTiyin: number;
  /** For a driver's no-show: when it becomes possible. */
  noShowFrom?: string;
}

export async function cancelTerms(
  q: Q, rideId: string, status: RideStatus, role: Role, noShow: boolean,
): Promise<CancelTerms> {
  if (status === 'in_progress' || status === 'completed' || status === 'cancelled') {
    return { allowed: false, feeTiyin: 0 };
  }
  if (status !== 'arrived') return { allowed: true, feeTiyin: 0 };

  const { rows } = await q.query<{ fee: string; arrived_at: string; no_show_from: string; can_no_show: boolean }>(
    `SELECT vc.cancel_fee_tiyin AS fee, a.at AS arrived_at,
            a.at + make_interval(mins => $2) AS no_show_from,
            a.at + make_interval(mins => $2) <= now() AS can_no_show
       FROM rides r
       JOIN vehicle_classes vc ON vc.id = r.class_id
       JOIN LATERAL (SELECT max(at) AS at FROM ride_events e
                      WHERE e.ride_id = r.id AND e.type = 'status:arrived') a ON true
      WHERE r.id = $1`,
    [rideId, NO_SHOW_WAIT_MIN],
  );
  const r = rows[0]!;
  const fee = Number(r.fee);
  if (role === 'passenger') return { allowed: true, feeTiyin: fee };
  if (!noShow) return { allowed: true, feeTiyin: 0 };
  return r.can_no_show
    ? { allowed: true, feeTiyin: fee }
    : { allowed: false, feeTiyin: fee, noShowFrom: r.no_show_from };
}
