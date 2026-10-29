// Disputes: both sides write what happened, then a moderator decides.
//
// - Either participant of a ride with an assigned driver can open one, up to 72 h after it ended.
// - The other side has 24 h to write their account; after that it goes to review anyway.
// - One statement per side, never edited. Each side sees the other's account only after
//   writing their own (or after the decision), so nobody tailors their story.
// - The moderator sees both statements next to the ride's objective log (status times,
//   price changes) and writes a decision both sides can read.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireStaff, requireUser } from '../auth/session.ts';
import { audit } from '../admin/audit.ts';
import { uuidParams } from '../lib/geo.ts';
import { HttpError, isUniqueViolation, withTx } from '../lib/tx.ts';
import { logEvent } from '../dispatch/matching.ts';
import { rideFor, type Q, type Role } from '../rides/common.ts';

interface Deps {
  db: pg.Pool;
}

const RESPONSE_WINDOW_HOURS = 24;
const OPEN_WINDOW_HOURS = 72;
const CATEGORIES = ['price', 'route', 'behavior', 'cancellation', 'vehicle', 'lost_item', 'safety', 'other'];
const OUTCOMES = ['passenger', 'driver', 'both', 'no_fault'];

const statementText = { type: 'string', minLength: 10, maxLength: 2000 } as const;

/** Text is stored as written (trimmed); clients must render it as plain text, never as HTML. */
function clean(text: string): string {
  const t = text.trim();
  if (t.length < 10) throw new HttpError(400, 'text_too_short');
  return t;
}

/** Disputes whose response window has passed go to review without the missing statement. */
async function promoteOverdue(q: Q): Promise<void> {
  await q.query(`UPDATE disputes SET status = 'in_review' WHERE status = 'awaiting_response' AND respond_by <= now()`);
}

interface DisputeRow {
  id: string;
  opened_by: Role;
  category: string;
  status: string;
  respond_by: string;
  outcome: string | null;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

async function disputeOfRide(q: Q, rideId: string): Promise<DisputeRow | null> {
  const { rows } = await q.query<DisputeRow>(`SELECT * FROM disputes WHERE ride_id = $1`, [rideId]);
  return rows[0] ?? null;
}

async function statements(q: Q, disputeId: string) {
  const { rows } = await q.query<{ role: Role; text: string; createdAt: string }>(
    `SELECT role, text, created_at AS "createdAt" FROM dispute_statements WHERE dispute_id = $1 ORDER BY created_at`,
    [disputeId],
  );
  return rows;
}

/** What one side of the ride sees. */
async function partyView(q: Q, d: DisputeRow, role: Role) {
  const all = await statements(q, d.id);
  const mine = all.find((s) => s.role === role) ?? null;
  const theirs = all.find((s) => s.role !== role) ?? null;
  const canSeeTheirs = mine !== null || d.status === 'resolved';
  return {
    id: d.id, category: d.category, openedBy: d.opened_by, status: d.status,
    respondBy: d.respond_by, createdAt: d.created_at,
    myStatement: mine,
    otherStatement: canSeeTheirs ? theirs : null,
    otherHasWritten: theirs !== null,
    // Waiting for my account?
    awaitingMe: mine === null && d.status === 'awaiting_response',
    outcome: d.outcome, resolution: d.resolution, resolvedAt: d.resolved_at,
  };
}

export async function disputeRoutes(app: FastifyInstance, { db }: Deps): Promise<void> {
  app.post<{ Params: { id: string }; Body: { category: string; text: string } }>(
    '/rides/:id/dispute',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['category', 'text'], additionalProperties: false,
          properties: { category: { type: 'string', enum: CATEGORIES }, text: statementText },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rideId = request.params.id;
      const text = clean(request.body.text);
      try {
        await withTx(db, async (tx) => {
          const { ride, role } = await rideFor(tx, rideId, userId, true);
          // A dispute needs two sides: only rides that had a driver assigned.
          if (!ride.driver_id) throw new HttpError(409, 'no_driver_assigned');
          // Measured from when the ride ended (its final status event), not from the last row update.
          const { rows } = await tx.query<{ too_late: boolean }>(
            `SELECT COALESCE(max(at) < now() - make_interval(hours => $2), false) AS too_late
               FROM ride_events WHERE ride_id = $1 AND type IN ('status:completed', 'status:cancelled')`,
            [rideId, OPEN_WINDOW_HOURS],
          );
          if (rows[0]!.too_late) throw new HttpError(409, 'too_late');
          const { rows: created } = await tx.query<{ id: string }>(
            `INSERT INTO disputes (ride_id, opened_by, category, respond_by)
             VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING id`,
            [rideId, role, request.body.category, RESPONSE_WINDOW_HOURS],
          );
          await tx.query(
            `INSERT INTO dispute_statements (dispute_id, role, author_id, text) VALUES ($1, $2, $3, $4)`,
            [created[0]!.id, role, userId, text],
          );
          await logEvent(tx, rideId, 'dispute_opened', role, userId, { category: request.body.category });
        });
      } catch (err) {
        if (isUniqueViolation(err, 'disputes_ride_id_key')) throw new HttpError(409, 'dispute_exists');
        throw err;
      }
      const { role } = await rideFor(db, rideId, userId, false);
      return reply.code(201).send(await partyView(db, (await disputeOfRide(db, rideId))!, role));
    },
  );

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    '/rides/:id/dispute/statement',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        params: uuidParams,
        body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: statementText } },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const rideId = request.params.id;
      const text = clean(request.body.text);
      let role: Role = 'passenger';
      try {
        await withTx(db, async (tx) => {
          ({ role } = await rideFor(tx, rideId, userId, false));
          await promoteOverdue(tx);
          const { rows } = await tx.query<DisputeRow>(`SELECT * FROM disputes WHERE ride_id = $1 FOR UPDATE`, [rideId]);
          const d = rows[0];
          if (!d) throw new HttpError(404, 'no_dispute');
          if (d.status !== 'awaiting_response') throw new HttpError(409, 'statements_closed');
          await tx.query(
            `INSERT INTO dispute_statements (dispute_id, role, author_id, text) VALUES ($1, $2, $3, $4)`,
            [d.id, role, userId, text],
          );
          // Both sides have spoken: hand over to a moderator.
          await tx.query(`UPDATE disputes SET status = 'in_review' WHERE id = $1`, [d.id]);
          await logEvent(tx, rideId, 'dispute_statement', role, userId);
        });
      } catch (err) {
        if (isUniqueViolation(err, 'dispute_statements_dispute_id_role_key')) throw new HttpError(409, 'already_written');
        throw err;
      }
      return partyView(db, (await disputeOfRide(db, rideId))!, role);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/rides/:id/dispute',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request) => {
      const { role } = await rideFor(db, request.params.id, request.user!.id, false);
      await promoteOverdue(db);
      const d = await disputeOfRide(db, request.params.id);
      if (!d) throw new HttpError(404, 'no_dispute');
      return partyView(db, d, role);
    },
  );

  // --- Moderation -----------------------------------------------------------------------

  app.get<{ Querystring: { status?: string } }>(
    '/admin/disputes',
    {
      preHandler: requireStaff,
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { status: { type: 'string', enum: ['awaiting_response', 'in_review', 'resolved'] } },
        },
      },
    },
    async (request) => {
      await promoteOverdue(db);
      const { rows } = await db.query(
        `SELECT d.id, d.ride_id AS "rideId", d.category, d.opened_by AS "openedBy", d.status,
                d.respond_by AS "respondBy", d.created_at AS "createdAt",
                (SELECT count(*)::int FROM dispute_statements s WHERE s.dispute_id = d.id) AS statements
           FROM disputes d
          WHERE d.status = $1
          ORDER BY d.created_at
          LIMIT 200`,
        [request.query.status ?? 'in_review'],
      );
      return rows;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/admin/disputes/:id',
    { preHandler: requireStaff, schema: { params: uuidParams } },
    async (request) => {
      const { rows } = await db.query<DisputeRow & { ride_id: string }>(`SELECT * FROM disputes WHERE id = $1`, [request.params.id]);
      const d = rows[0];
      if (!d) throw new HttpError(404, 'not_found');
      await audit(db, request, 'dispute_viewed', { type: 'dispute', id: d.id });
      const ride = await db.query(
        `SELECT r.id, r.status, r.locked_price_tiyin::int AS "priceTiyin", r.route_distance_m AS "distanceM",
                r.cancelled_by AS "cancelledBy", r.cancel_reason AS "cancelReason", r.created_at AS "createdAt",
                pu.name AS "passengerName", pu.phone AS "passengerPhone",
                du.name AS "driverName", du.phone AS "driverPhone", v.plate
           FROM rides r
           JOIN users pu ON pu.id = r.passenger_id
           LEFT JOIN drivers dr ON dr.id = r.driver_id
           LEFT JOIN users du ON du.id = dr.user_id
           LEFT JOIN vehicles v ON v.id = r.vehicle_id
          WHERE r.id = $1`,
        [d.ride_id],
      );
      // The objective record: who did what and when, independent of either story.
      const events = await db.query(
        `SELECT type, actor, payload, at FROM ride_events WHERE ride_id = $1 ORDER BY id`,
        [d.ride_id],
      );
      const priceChanges = await db.query(
        `SELECT reason, old_price_tiyin::int AS "oldPriceTiyin", new_price_tiyin::int AS "newPriceTiyin",
                old_stops AS "oldStops", new_stops AS "newStops", confirmed_at AS "confirmedAt"
           FROM price_changes WHERE ride_id = $1 ORDER BY created_at`,
        [d.ride_id],
      );
      return {
        dispute: {
          id: d.id, category: d.category, openedBy: d.opened_by, status: d.status, respondBy: d.respond_by,
          outcome: d.outcome, resolution: d.resolution, createdAt: d.created_at,
        },
        statements: await statements(db, d.id),
        ride: ride.rows[0],
        events: events.rows,
        priceChanges: priceChanges.rows,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { outcome: string; resolution: string; waiveCancelFee?: boolean } }>(
    '/admin/disputes/:id/resolve',
    {
      preHandler: requireStaff,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['outcome', 'resolution'], additionalProperties: false,
          properties: {
            outcome: { type: 'string', enum: OUTCOMES },
            resolution: statementText,
            // Lifts a cancellation fee that has not been paid yet.
            waiveCancelFee: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const adminId = request.user!.id;
      await withTx(db, async (tx) => {
        await promoteOverdue(tx);
        const { rows } = await tx.query<{ ride_id: string; status: string }>(
          `SELECT ride_id, status FROM disputes WHERE id = $1 FOR UPDATE`,
          [request.params.id],
        );
        const d = rows[0];
        if (!d) throw new HttpError(404, 'not_found');
        // Never decide before the other side had its chance to speak.
        if (d.status !== 'in_review') throw new HttpError(409, d.status === 'resolved' ? 'already_resolved' : 'awaiting_response');
        await tx.query(
          `UPDATE disputes SET status = 'resolved', outcome = $2, resolution = $3, resolved_by = $4, resolved_at = now()
            WHERE id = $1`,
          [request.params.id, request.body.outcome, clean(request.body.resolution), adminId],
        );
        let waived = false;
        if (request.body.waiveCancelFee) {
          const { rowCount } = await tx.query(
            `UPDATE rides SET cancel_fee_status = 'waived' WHERE id = $1 AND cancel_fee_status = 'pending'`,
            [d.ride_id],
          );
          if (!rowCount) throw new HttpError(409, 'no_pending_fee');
          waived = true;
        }
        await logEvent(tx, d.ride_id, 'dispute_resolved', 'admin', adminId, { outcome: request.body.outcome, feeWaived: waived });
        await audit(tx, request, 'dispute_resolved', { type: 'dispute', id: request.params.id }, {
          outcome: request.body.outcome, feeWaived: waived,
        });
      });
      return { status: 'resolved' };
    },
  );
}
