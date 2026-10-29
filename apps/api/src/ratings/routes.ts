// Two-way ratings after a completed ride.
//
// - Passenger rates the driver, driver rates the passenger: 1–5, plus "what did you like?" tags
//   (clean car, careful driving, ...). Below 4 a reason is required: a tag or a few words.
// - Safety tags (unsafe driving, phone at the wheel, asked for extra cash, different car) and
//   1–2 stars go to the moderators' complaint queue.
// - Once per side per ride, within 72 h of completion, never edited.
// - Only averages over the last 100 ratings are shown, and only after 5 ratings; nobody can see
//   who gave which score. Driver ratings weigh into dispatch (see dispatch/matching.ts).

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUser } from '../auth/session.ts';
import { uuidParams } from '../lib/geo.ts';
import { langOf, pick } from '../lib/i18n.ts';
import { HttpError, isUniqueViolation, withTx } from '../lib/tx.ts';
import { logEvent } from '../dispatch/matching.ts';
import { rideFor, type Q } from '../rides/common.ts';
import { MAX_TAGS_PER_RATING, RATING_TAGS, tagAllowed, tagByCode, type TagSide } from '@taxi/shared';

interface Deps {
  db: pg.Pool;
}

const RATE_WINDOW_HOURS = 72;
const AVERAGE_OVER = 100;
export const MIN_RATINGS_SHOWN = 5;

/** Recomputes the driver's average from ratings received as a driver. */
async function refreshDriverRating(q: Q, driverId: string): Promise<void> {
  await q.query(
    `WITH last AS (
       SELECT rt.score FROM ratings rt
         JOIN rides r ON r.id = rt.ride_id
         JOIN drivers d ON d.id = r.driver_id
        WHERE r.driver_id = $1 AND rt.to_user = d.user_id
        ORDER BY rt.created_at DESC LIMIT $2
     )
     UPDATE drivers SET rating = (SELECT round(avg(score), 2) FROM last),
                        rating_count = (SELECT count(*) FROM ratings rt JOIN rides r ON r.id = rt.ride_id
                                         JOIN drivers d ON d.id = r.driver_id
                                        WHERE r.driver_id = $1 AND rt.to_user = d.user_id)
      WHERE id = $1`,
    [driverId, AVERAGE_OVER],
  );
}

/** Recomputes the user's average from ratings received as a passenger. */
async function refreshPassengerRating(q: Q, userId: string): Promise<void> {
  await q.query(
    `WITH last AS (
       SELECT rt.score FROM ratings rt JOIN rides r ON r.id = rt.ride_id
        WHERE rt.to_user = $1 AND r.passenger_id = $1
        ORDER BY rt.created_at DESC LIMIT $2
     )
     UPDATE users SET rating = (SELECT round(avg(score), 2) FROM last),
                      rating_count = (SELECT count(*) FROM ratings rt JOIN rides r ON r.id = rt.ride_id
                                       WHERE rt.to_user = $1 AND r.passenger_id = $1)
      WHERE id = $1`,
    [userId, AVERAGE_OVER],
  );
}

function shown(rating: string | null, count: number) {
  return { rating: count >= MIN_RATINGS_SHOWN && rating !== null ? Number(rating) : null, count };
}

export async function ratingRoutes(app: FastifyInstance, { db }: Deps): Promise<void> {
  app.get<{ Querystring: { about?: TagSide; lang?: string } }>(
    '/rating-tags',
    {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            about: { type: 'string', enum: ['driver', 'passenger'] },
            lang: { type: 'string', enum: ['uz', 'ru', 'en'] },
          },
        },
      },
    },
    async (request) => {
      const about = request.query.about ?? 'driver';
      const lang = langOf(request);
      const list = (tone: 'positive' | 'negative') => RATING_TAGS
        .filter((t) => t.about === about && t.tone === tone)
        .map(({ code, label }) => ({ code, label: pick(label, lang) }));
      return { language: lang, maxTags: MAX_TAGS_PER_RATING, positive: list('positive'), negative: list('negative') };
    },
  );

  app.post<{ Params: { id: string }; Body: { score: number; reason?: string; tags?: string[] } }>(
    '/rides/:id/rating',
    {
      preHandler: requireUser,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['score'], additionalProperties: false,
          properties: {
            score: { type: 'integer', minimum: 1, maximum: 5 },
            reason: { type: 'string', maxLength: 300 },
            tags: {
              type: 'array', maxItems: MAX_TAGS_PER_RATING, uniqueItems: true,
              items: { type: 'string', pattern: '^[a-z_]{2,32}$' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rideId = request.params.id;
      const reason = request.body.reason?.trim() || null;
      const tags = request.body.tags ?? [];
      if (request.body.score < 4 && (!reason || reason.length < 3) && tags.length === 0) {
        return reply.code(400).send({ error: 'reason_required' });
      }
      try {
        await withTx(db, async (tx) => {
          const { ride, role } = await rideFor(tx, rideId, userId, false);
          if (ride.status !== 'completed') throw new HttpError(409, 'ride_not_completed');
          const { rows } = await tx.query<{ too_late: boolean; driver_user_id: string }>(
            `SELECT coalesce(max(e.at) < now() - make_interval(hours => $2), true) AS too_late,
                    (SELECT d.user_id FROM drivers d WHERE d.id = $3) AS driver_user_id
               FROM ride_events e WHERE e.ride_id = $1 AND e.type = 'status:completed'`,
            [rideId, RATE_WINDOW_HOURS, ride.driver_id],
          );
          if (rows[0]!.too_late) throw new HttpError(409, 'too_late');
          const toUser = role === 'passenger' ? rows[0]!.driver_user_id : ride.passenger_id;
          // Tags must exist, be about the other side, and match the score's tone.
          const about: TagSide = role === 'passenger' ? 'driver' : 'passenger';
          for (const code of tags) {
            const tag = tagByCode(code);
            if (!tag || !tagAllowed(tag, about, request.body.score)) throw new HttpError(400, 'invalid_tag', { tag: code });
          }
          await tx.query(
            `INSERT INTO ratings (ride_id, from_user, to_user, score, reason, tags) VALUES ($1, $2, $3, $4, $5, $6)`,
            [rideId, userId, toUser, request.body.score, reason, tags],
          );
          const safety = tags.filter((c) => tagByCode(c)?.safety);
          if (safety.length || request.body.score <= 2) {
            await tx.query(
              `INSERT INTO complaints (ride_id, author_id, type, resolution) VALUES ($1, $2, $3, NULL)`,
              [rideId, userId, safety.length ? `rating_safety:${safety.join(',')}` : 'low_rating'],
            );
          }
          if (role === 'passenger') await refreshDriverRating(tx, ride.driver_id!);
          else await refreshPassengerRating(tx, ride.passenger_id);
          // The score itself is not logged in the ride history the other side can be shown.
          await logEvent(tx, rideId, 'rated', role, userId);
        });
      } catch (err) {
        if (isUniqueViolation(err, 'ratings_ride_id_from_user_key')) throw new HttpError(409, 'already_rated');
        throw err;
      }
      return reply.code(204).send();
    },
  );

  // Own ratings and activity, the way Yandex shows them: averages and completion share only.
  app.get('/me/ratings', { preHandler: requireUser }, async (request) => {
    const userId = request.user!.id;
    const { rows } = await db.query(
      `SELECT u.rating AS p_rating, u.rating_count AS p_count, d.rating AS d_rating, d.rating_count AS d_count,
              (SELECT count(*) FILTER (WHERE status = 'completed')::int FROM rides WHERE passenger_id = $1) AS p_completed,
              (SELECT count(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'passenger')::int
                 FROM rides WHERE passenger_id = $1) AS p_cancelled
         FROM users u LEFT JOIN drivers d ON d.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );
    const r = rows[0];
    // Drivers see all their tags, including the negative ones, to know what to improve.
    const tagCounts = r.d_count === null ? [] : (await db.query(
      `SELECT t.code, count(*)::int AS count
         FROM ratings rt
         JOIN rides ri ON ri.id = rt.ride_id
         JOIN drivers d ON d.id = ri.driver_id AND d.user_id = rt.to_user
         CROSS JOIN LATERAL unnest(rt.tags) AS t(code)
        WHERE rt.to_user = $1
        GROUP BY t.code ORDER BY count DESC`,
      [userId],
    )).rows;
    return {
      asPassenger: { ...shown(r.p_rating, r.p_count), completedRides: r.p_completed, cancelledRides: r.p_cancelled },
      asDriver: r.d_count === null ? null : { ...shown(r.d_rating, r.d_count), tags: tagCounts },
    };
  });
}

