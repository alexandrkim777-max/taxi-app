// Staff: live dashboard, ride lookup with the full event log, finance overview, audit log.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAdmin, requireStaff } from '../auth/session.ts';
import { uuidParams } from '../lib/geo.ts';
import { HttpError } from '../lib/tx.ts';
import { normalizeUzPhone } from '../lib/phone.ts';
import { PRESENCE_TTL_SEC } from '../dispatch/presence.ts';
import { audit } from './audit.ts';

interface Deps {
  db: pg.Pool;
  cityCode: string;
}

export async function adminOpsRoutes(app: FastifyInstance, { db, cityCode }: Deps): Promise<void> {
  // One screen with what matters right now and today (Tashkent time).
  app.get('/admin/dashboard', { preHandler: requireStaff }, async () => {
    const { rows: [live] } = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'online')::int AS "driversOnline",
              count(*) FILTER (WHERE status = 'busy')::int AS "driversOnRide"
         FROM driver_presence WHERE updated_at > now() - make_interval(secs => $1)`,
      [PRESENCE_TTL_SEC],
    );
    const { rows: [active] } = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'created')::int AS searching,
              count(*) FILTER (WHERE status IN ('accepted', 'driver_en_route', 'arrived'))::int AS pickup,
              count(*) FILTER (WHERE status = 'in_progress')::int AS "inTrip"
         FROM rides WHERE status IN ('created', 'accepted', 'driver_en_route', 'arrived', 'in_progress')`,
    );
    const { rows: [today] } = await db.query(
      `WITH t AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent') AS start)
       SELECT count(*)::int AS ordered,
              count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE r.status = 'cancelled' AND r.cancelled_by = 'passenger')::int AS "cancelledByPassenger",
              count(*) FILTER (WHERE r.status = 'cancelled' AND r.cancelled_by = 'driver')::int AS "cancelledByDriver",
              count(*) FILTER (WHERE r.status = 'cancelled' AND r.cancel_reason = 'no_drivers')::int AS "noDriverFound",
              coalesce(round(avg(r.locked_price_tiyin) FILTER (WHERE r.status = 'completed')), 0)::int AS "avgPriceTiyin",
              coalesce(sum(r.locked_price_tiyin) FILTER (WHERE r.status = 'completed'), 0)::bigint AS "driversEarnedTiyin"
         FROM rides r, t WHERE r.created_at >= t.start`,
    );
    const { rows: [money] } = await db.query(
      `WITH t AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent') AS start)
       SELECT count(*) FILTER (WHERE p.type = 'subscription')::int AS "subscriptionsSold",
              coalesce(sum(p.amount_tiyin) FILTER (WHERE p.type = 'subscription'), 0)::bigint AS "subscriptionRevenueTiyin"
         FROM payments p, t WHERE p.status = 'succeeded' AND p.paid_at >= t.start`,
    );
    const { rows: [queues] } = await db.query(
      `SELECT (SELECT count(*)::int FROM drivers WHERE status = 'pending' AND deleted_at IS NULL) AS "driversToModerate",
              (SELECT count(*)::int FROM complaints WHERE status IN ('open', 'in_review') AND severity = 'safety') AS "safetyComplaints",
              (SELECT count(*)::int FROM complaints WHERE status IN ('open', 'in_review') AND severity = 'normal') AS complaints,
              (SELECT count(*)::int FROM disputes WHERE status = 'in_review'
                  OR (status = 'awaiting_response' AND respond_by <= now())) AS "disputesToDecide",
              (SELECT count(*)::int FROM payments WHERE type = 'refund' AND status = 'pending') AS "refundsPending"`,
    );
    const { rows: coefficients } = await db.query(
      `SELECT vc.code, current_price_coefficient(vc.id)::float AS coefficient
         FROM vehicle_classes vc JOIN cities c ON c.id = vc.city_id WHERE c.code = $1 AND vc.deleted_at IS NULL
        ORDER BY vc.rec_base_tiyin`,
      [cityCode],
    );
    return { live: { ...live, rides: active }, today: { ...today, ...money }, queues, coefficients };
  });

  // Find rides by passenger/driver phone and status.
  app.get<{ Querystring: { phone?: string; status?: string; limit?: number } }>(
    '/admin/rides',
    {
      preHandler: requireStaff,
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            phone: { type: 'string', maxLength: 32 },
            status: { type: 'string', enum: ['created', 'accepted', 'driver_en_route', 'arrived', 'in_progress', 'completed', 'cancelled'] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request) => {
      const phone = request.query.phone ? normalizeUzPhone(request.query.phone) : null;
      if (request.query.phone && !phone) throw new HttpError(400, 'invalid_phone');
      const { rows } = await db.query(
        `SELECT r.id, r.status, r.locked_price_tiyin::int AS "priceTiyin", r.payment_method AS "paymentMethod",
                r.created_at AS "createdAt", pu.name AS "passengerName", du.name AS "driverName", v.plate
           FROM rides r
           JOIN users pu ON pu.id = r.passenger_id
           LEFT JOIN drivers d ON d.id = r.driver_id
           LEFT JOIN users du ON du.id = d.user_id
           LEFT JOIN vehicles v ON v.id = r.vehicle_id
          WHERE ($1::text IS NULL OR pu.phone = $1 OR du.phone = $1)
            AND ($2::text IS NULL OR r.status = $2)
          ORDER BY r.created_at DESC LIMIT $3`,
        [phone, request.query.status ?? null, request.query.limit ?? 50],
      );
      if (phone) await audit(db, request, 'rides_searched_by_phone', null, { phone });
      return rows;
    },
  );

  // Everything about one ride: who, route, price changes, payments, ratings, complaints, dispute, log.
  app.get<{ Params: { id: string } }>(
    '/admin/rides/:id',
    { preHandler: requireStaff, schema: { params: uuidParams } },
    async (request) => {
      const { rows } = await db.query(
        `SELECT r.*, pu.name AS passenger_name, pu.phone AS passenger_phone, du.name AS driver_name, du.phone AS driver_phone,
                v.plate, v.make_model, vc.code AS class_code
           FROM rides r
           JOIN users pu ON pu.id = r.passenger_id
           JOIN vehicle_classes vc ON vc.id = r.class_id
           LEFT JOIN drivers d ON d.id = r.driver_id
           LEFT JOIN users du ON du.id = d.user_id
           LEFT JOIN vehicles v ON v.id = r.vehicle_id
          WHERE r.id = $1`,
        [request.params.id],
      );
      if (!rows[0]) throw new HttpError(404, 'not_found');
      const id = request.params.id;
      const [stops, events, priceChanges, payments, ratings, complaints, dispute] = await Promise.all([
        db.query(`SELECT position, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, address FROM ride_stops WHERE ride_id = $1 ORDER BY position`, [id]),
        db.query(`SELECT type, actor, payload, at FROM ride_events WHERE ride_id = $1 ORDER BY id`, [id]),
        db.query(`SELECT reason, old_price_tiyin, new_price_tiyin, wait_paid_min, created_at FROM price_changes WHERE ride_id = $1 ORDER BY created_at`, [id]),
        db.query(`SELECT id, type, status, amount_tiyin, provider, failure_reason, paid_at, created_at FROM payments WHERE ride_id = $1 ORDER BY created_at`, [id]),
        db.query(`SELECT from_user, to_user, score, tags, reason FROM ratings WHERE ride_id = $1`, [id]),
        db.query(`SELECT id, type, severity, status FROM complaints WHERE ride_id = $1`, [id]),
        db.query(`SELECT id, status, outcome FROM disputes WHERE ride_id = $1`, [id]),
      ]);
      const ride = rows[0];
      await audit(db, request, 'ride_viewed', { type: 'ride', id });
      return {
        ride, stops: stops.rows, events: events.rows, priceChanges: priceChanges.rows, payments: payments.rows,
        ratings: ratings.rows, complaints: complaints.rows, dispute: dispute.rows[0] ?? null,
      };
    },
  );

  // Money overview: subscription revenue, card money passing through, debts, refunds to send.
  app.get<{ Querystring: { days?: number } }>(
    '/admin/finance',
    {
      preHandler: requireAdmin,
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { days: { type: 'integer', minimum: 1, maximum: 365 } },
        },
      },
    },
    async (request) => {
      const days = request.query.days ?? 30;
      const { rows: byType } = await db.query(
        `SELECT type, status, count(*)::int AS count, coalesce(sum(amount_tiyin), 0)::bigint AS "amountTiyin"
           FROM payments WHERE created_at > now() - make_interval(days => $1)
          GROUP BY type, status ORDER BY type, status`,
        [days],
      );
      const { rows: [debts] } = await db.query(
        `SELECT coalesce(sum(locked_price_tiyin - paid_tiyin) FILTER (WHERE payment_method = 'card' AND payment_status = 'failed' AND status = 'completed'), 0)::bigint AS "unpaidRidesTiyin",
                coalesce(sum(cancel_fee_tiyin) FILTER (WHERE cancel_fee_status = 'pending'), 0)::bigint AS "unpaidCancelFeesTiyin"
           FROM rides`,
      );
      const { rows: refunds } = await db.query(
        `SELECT id, ride_id AS "rideId", amount_tiyin::int AS "amountTiyin", created_at AS "createdAt"
           FROM payments WHERE type = 'refund' AND status = 'pending' ORDER BY created_at LIMIT 100`,
      );
      await audit(db, request, 'finance_viewed', null, { days });
      return { days, payments: byType, debts, refundsPending: refunds };
    },
  );

  // Who did what. Admin only.
  app.get<{ Querystring: { targetType?: string; targetId?: string; adminId?: string; limit?: number } }>(
    '/admin/audit',
    {
      preHandler: requireAdmin,
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            targetType: { type: 'string', pattern: '^[a-z_]{2,32}$' },
            targetId: { type: 'string', maxLength: 64 },
            adminId: uuidParams.properties.id,
            limit: { type: 'integer', minimum: 1, maximum: 500 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query;
      const { rows } = await db.query(
        `SELECT a.id, a.action, a.target_type AS "targetType", a.target_id AS "targetId", a.payload, a.ip, a.at,
                u.name AS "adminName", u.phone AS "adminPhone"
           FROM admin_audit_log a JOIN users u ON u.id = a.admin_id
          WHERE ($1::text IS NULL OR a.target_type = $1) AND ($2::text IS NULL OR a.target_id = $2)
            AND ($3::uuid IS NULL OR a.admin_id = $3)
          ORDER BY a.id DESC LIMIT $4`,
        [q.targetType ?? null, q.targetId ?? null, q.adminId ?? null, q.limit ?? 100],
      );
      return rows;
    },
  );
}
