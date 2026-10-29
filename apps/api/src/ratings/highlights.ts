import { RATING_TAGS } from '@taxi/shared';
import type { Q } from '../rides/common.ts';

/** A driver's top positive tags, shown to passengers ("Careful driving · 87"). Negative tags are never public. */
export async function driverHighlights(q: Q, driverId: string): Promise<{ code: string; count: number }[]> {
  const positive = RATING_TAGS.filter((t) => t.about === 'driver' && t.tone === 'positive').map((t) => t.code);
  const { rows } = await q.query<{ code: string; count: number }>(
    `SELECT t.code, count(*)::int AS count
       FROM ratings rt
       JOIN rides r ON r.id = rt.ride_id AND r.driver_id = $1
       JOIN drivers d ON d.id = r.driver_id AND d.user_id = rt.to_user
       CROSS JOIN LATERAL unnest(rt.tags) AS t(code)
      WHERE t.code = ANY($2)
      GROUP BY t.code ORDER BY count DESC LIMIT 3`,
    [driverId, positive],
  );
  return rows;
}
