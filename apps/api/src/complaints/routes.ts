// Complaints: filed by passengers or drivers about a ride, or raised automatically from ratings
// (safety tags, 1–2 stars). Staff work through a queue, safety first, and can warn or block.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { requireStaff, requireUser } from '../auth/session.ts';
import { uuidParams } from '../lib/geo.ts';
import { HttpError, withTx } from '../lib/tx.ts';
import { logEvent } from '../dispatch/matching.ts';
import { rideFor, type Q } from '../rides/common.ts';
import { audit } from '../admin/audit.ts';

interface Deps {
  db: pg.Pool;
}

export const COMPLAINT_TYPES = [
  'rude', 'unsafe_driving', 'asked_extra_cash', 'car_mismatch', 'harassment', 'lost_item', 'price', 'other',
] as const;
const SAFETY_TYPES = new Set(['unsafe_driving', 'asked_extra_cash', 'car_mismatch', 'harassment']);

/** Blocks a user (driver or passenger) with a reason; drivers are taken off the map at once. */
export async function blockUser(
  q: Q, request: FastifyRequest, userId: string, reason: string, days: number | null,
): Promise<void> {
  await q.query(
    `INSERT INTO blocks (user_id, reason, until, created_by)
     VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3::int) END, $4)`,
    [userId, reason, days, request.user!.id],
  );
  await q.query(`DELETE FROM driver_presence p USING drivers d WHERE d.id = p.driver_id AND d.user_id = $1 AND p.status = 'online'`, [userId]);
  await audit(q, request, 'user_blocked', { type: 'user', id: userId }, { reason, days });
}

export async function complaintRoutes(app: FastifyInstance, { db }: Deps): Promise<void> {
  // --- Filing (passenger or driver of the ride) ---------------------------------------------

  app.post<{ Params: { id: string }; Body: { type: string; text: string } }>(
    '/rides/:id/complaint',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['type', 'text'], additionalProperties: false,
          properties: {
            type: { type: 'string', enum: [...COMPLAINT_TYPES] },
            text: { type: 'string', minLength: 5, maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { ride, role } = await rideFor(db, request.params.id, userId, false);
      if (!ride.driver_id) throw new HttpError(409, 'no_driver_assigned');
      const { rows: dup } = await db.query(
        `SELECT 1 FROM complaints WHERE ride_id = $1 AND author_id = $2 AND type = $3`,
        [ride.id, userId, request.body.type],
      );
      if (dup[0]) throw new HttpError(409, 'already_filed');
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO complaints (ride_id, author_id, about_user_id, type, text, severity)
         VALUES ($1, $2,
                 CASE WHEN $3 = 'passenger' THEN (SELECT user_id FROM drivers WHERE id = $4) ELSE $5::uuid END,
                 $6, $7, $8)
         RETURNING id`,
        [
          ride.id, userId, role, ride.driver_id, ride.passenger_id, request.body.type, request.body.text.trim(),
          SAFETY_TYPES.has(request.body.type) ? 'safety' : 'normal',
        ],
      );
      await logEvent(db, ride.id, 'complaint_filed', role, userId, { type: request.body.type });
      return reply.code(201).send({ id: rows[0]!.id, status: 'open' });
    },
  );

  // --- Staff queue ---------------------------------------------------------------------------

  app.get<{ Querystring: { status?: string; severity?: string } }>(
    '/admin/complaints',
    {
      preHandler: requireStaff,
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['open', 'in_review', 'resolved', 'rejected'] },
            severity: { type: 'string', enum: ['normal', 'safety'] },
          },
        },
      },
    },
    async (request) => {
      const { rows } = await db.query(
        `SELECT c.id, c.ride_id AS "rideId", c.type, c.severity, c.status, c.created_at AS "createdAt",
                c.assigned_to AS "assignedTo", au.name AS "authorName", ab.name AS "aboutName",
                (SELECT count(*)::int FROM complaints c2 WHERE c2.about_user_id = c.about_user_id) AS "aboutTotal"
           FROM complaints c
           JOIN users au ON au.id = c.author_id
           LEFT JOIN users ab ON ab.id = c.about_user_id
          WHERE c.status = $1 AND ($2::text IS NULL OR c.severity = $2)
          ORDER BY (c.severity = 'safety') DESC, c.created_at
          LIMIT 200`,
        [request.query.status ?? 'open', request.query.severity ?? null],
      );
      return rows;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/admin/complaints/:id',
    { preHandler: requireStaff, schema: { params: uuidParams } },
    async (request) => {
      const { rows } = await db.query(
        `SELECT c.*, au.name AS author_name, au.phone AS author_phone, ab.name AS about_name, ab.phone AS about_phone
           FROM complaints c JOIN users au ON au.id = c.author_id LEFT JOIN users ab ON ab.id = c.about_user_id
          WHERE c.id = $1`,
        [request.params.id],
      );
      const c = rows[0];
      if (!c) throw new HttpError(404, 'not_found');
      await audit(db, request, 'complaint_viewed', { type: 'complaint', id: c.id });
      const rating = await db.query(
        `SELECT score, tags, reason FROM ratings WHERE ride_id = $1 AND from_user = $2`,
        [c.ride_id, c.author_id],
      );
      const events = await db.query(`SELECT type, actor, payload, at FROM ride_events WHERE ride_id = $1 ORDER BY id`, [c.ride_id]);
      const history = await db.query(
        `SELECT id, type, severity, status, created_at AS "createdAt" FROM complaints
          WHERE about_user_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 20`,
        [c.about_user_id, c.id],
      );
      return { complaint: c, rating: rating.rows[0] ?? null, rideEvents: events.rows, previousAboutSamePerson: history.rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/complaints/:id/assign',
    { preHandler: requireStaff, schema: { params: uuidParams } },
    async (request) => {
      const { rowCount } = await db.query(
        `UPDATE complaints SET assigned_to = $2, status = 'in_review', updated_at = now()
          WHERE id = $1 AND status IN ('open', 'in_review')`,
        [request.params.id, request.user!.id],
      );
      if (!rowCount) throw new HttpError(409, 'not_open');
      await audit(db, request, 'complaint_assigned', { type: 'complaint', id: request.params.id });
      return { status: 'in_review' };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { status: 'resolved' | 'rejected'; resolution: string; action?: 'none' | 'warning' | 'block'; blockDays?: number };
  }>(
    '/admin/complaints/:id/resolve',
    {
      preHandler: requireStaff,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['status', 'resolution'], additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['resolved', 'rejected'] },
            resolution: { type: 'string', minLength: 3, maxLength: 2000 },
            action: { type: 'string', enum: ['none', 'warning', 'block'] },
            // Omitted with action=block means indefinitely.
            blockDays: { type: 'integer', minimum: 1, maximum: 365 },
          },
        },
      },
    },
    async (request) => {
      await withTx(db, async (tx) => {
        const { rows } = await tx.query<{ about_user_id: string | null; status: string; type: string }>(
          `SELECT about_user_id, status, type FROM complaints WHERE id = $1 FOR UPDATE`,
          [request.params.id],
        );
        const c = rows[0];
        if (!c) throw new HttpError(404, 'not_found');
        if (c.status === 'resolved' || c.status === 'rejected') throw new HttpError(409, 'already_closed');
        await tx.query(
          `UPDATE complaints SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now(), updated_at = now()
            WHERE id = $1`,
          [request.params.id, request.body.status, request.body.resolution.trim(), request.user!.id],
        );
        if (request.body.action === 'block') {
          if (!c.about_user_id) throw new HttpError(409, 'nobody_to_block');
          await blockUser(tx, request, c.about_user_id, `complaint ${c.type}: ${request.body.resolution.trim()}`, request.body.blockDays ?? null);
        }
        await audit(tx, request, 'complaint_resolved', { type: 'complaint', id: request.params.id }, {
          status: request.body.status, action: request.body.action ?? 'none',
        });
      });
      return { status: request.body.status };
    },
  );
}
