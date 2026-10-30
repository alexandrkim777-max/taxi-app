// Staff: driver dossiers and passenger profiles, search, blocks, vehicle class, documents, staff roles.
// Viewing a dossier (phone numbers, documents) is itself written to the audit log.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAdmin, requireStaff } from '../auth/session.ts';
import { uuidParams } from '../lib/geo.ts';
import { HttpError, withTx } from '../lib/tx.ts';
import { normalizeUzPhone } from '../lib/phone.ts';
import { driverProfile } from '../drivers/routes.ts';
import { blockUser } from '../complaints/routes.ts';
import { audit } from './audit.ts';

interface Deps {
  db: pg.Pool;
  cityCode: string;
}

const ALLOWED_ROLES = ['passenger', 'driver', 'support', 'admin'];

export async function adminPeopleRoutes(app: FastifyInstance, { db, cityCode }: Deps): Promise<void> {
  // Search by phone, plate or name.
  app.get<{ Querystring: { q: string } }>(
    '/admin/search',
    {
      preHandler: requireStaff,
      schema: {
        querystring: {
          type: 'object', required: ['q'], additionalProperties: false,
          properties: { q: { type: 'string', minLength: 3, maxLength: 64 } },
        },
      },
    },
    async (request) => {
      const q = request.query.q.trim();
      const phone = normalizeUzPhone(q);
      const plate = q.toUpperCase().replace(/\s+/g, '');
      const { rows } = await db.query(
        `SELECT u.id AS "userId", u.name, u.phone, u.roles, d.id AS "driverId", d.status AS "driverStatus",
                (SELECT string_agg(v.plate, ', ') FROM vehicles v WHERE v.driver_id = d.id AND v.deleted_at IS NULL) AS plates
           FROM users u LEFT JOIN drivers d ON d.user_id = u.id
          WHERE u.deleted_at IS NULL AND (
                u.phone = $1
             OR EXISTS (SELECT 1 FROM vehicles v WHERE v.driver_id = d.id AND v.plate = $2)
             OR u.name ILIKE '%' || $3 || '%')
          LIMIT 50`,
        [phone ?? '', plate, q.replace(/[%_\\]/g, '')],
      );
      await audit(db, request, 'search', null, { q });
      return rows;
    },
  );

  // Full driver dossier: profile, phone, car(s), documents, subscription, numbers, complaints, blocks.
  app.get<{ Params: { id: string } }>(
    '/admin/drivers/:id/dossier',
    { preHandler: requireStaff, schema: { params: uuidParams } },
    async (request) => {
      const profile = await driverProfile(db, request.params.id);
      if (!profile.id) throw new HttpError(404, 'not_found');
      const { rows: [stats] } = await db.query(
        `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'driver')::int AS "cancelledByDriver",
                count(*) FILTER (WHERE status = 'completed' AND created_at > now() - interval '30 days')::int AS "completed30d",
                coalesce(sum(locked_price_tiyin) FILTER (WHERE status = 'completed' AND created_at > now() - interval '30 days'), 0)::bigint AS "earned30dTiyin"
           FROM rides WHERE driver_id = $1`,
        [request.params.id],
      );
      const extra = await db.query(
        `SELECT d.rating::float AS rating, d.rating_count AS "ratingCount", d.paused_until AS "pausedUntil", d.user_id AS "userId",
                (SELECT max(ends_at) FROM subscriptions s WHERE s.driver_id = d.id AND s.status = 'active') AS "subscriptionUntil",
                (SELECT json_agg(json_build_object('code', t.code, 'count', t.n) ORDER BY t.n DESC)
                   FROM (SELECT tag AS code, count(*)::int AS n FROM ratings rt
                           JOIN rides r ON r.id = rt.ride_id AND r.driver_id = d.id AND rt.to_user = d.user_id
                           CROSS JOIN LATERAL unnest(rt.tags) AS tag GROUP BY tag) t) AS tags
           FROM drivers d WHERE d.id = $1`,
        [request.params.id],
      );
      const userId = extra.rows[0].userId;
      const complaints = await db.query(
        `SELECT id, type, severity, status, created_at AS "createdAt" FROM complaints
          WHERE about_user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      );
      const blocks = await db.query(
        `SELECT id, reason, until, appeal_status AS "appealStatus", created_at AS "createdAt", lifted_at AS "liftedAt"
           FROM blocks WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      );
      const rides = await db.query(
        `SELECT id, status, locked_price_tiyin::int AS "priceTiyin", created_at AS "createdAt"
           FROM rides WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [request.params.id],
      );
      await audit(db, request, 'driver_dossier_viewed', { type: 'driver', id: request.params.id });
      return {
        ...profile, ...extra.rows[0], stats,
        complaints: complaints.rows, blocks: blocks.rows, recentRides: rides.rows,
      };
    },
  );

  // Passenger profile.
  app.get<{ Params: { id: string } }>(
    '/admin/users/:id',
    { preHandler: requireStaff, schema: { params: uuidParams } },
    async (request) => {
      const { rows } = await db.query(
        `SELECT u.id, u.name, u.phone, u.language, u.roles, u.rating::float AS rating, u.rating_count AS "ratingCount",
                u.created_at AS "createdAt",
                (SELECT count(*)::int FROM rides r WHERE r.passenger_id = u.id AND r.status = 'completed') AS completed,
                (SELECT count(*)::int FROM rides r WHERE r.passenger_id = u.id AND r.status = 'cancelled' AND r.cancelled_by = 'passenger') AS cancelled,
                (SELECT count(*)::int FROM payment_cards c WHERE c.user_id = u.id AND c.deleted_at IS NULL) AS cards
           FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
        [request.params.id],
      );
      if (!rows[0]) throw new HttpError(404, 'not_found');
      const complaints = await db.query(
        `SELECT id, type, severity, status, created_at AS "createdAt" FROM complaints WHERE about_user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [request.params.id],
      );
      const blocks = await db.query(
        `SELECT id, reason, until, appeal_status AS "appealStatus", created_at AS "createdAt" FROM blocks WHERE user_id = $1 ORDER BY created_at DESC`,
        [request.params.id],
      );
      await audit(db, request, 'user_profile_viewed', { type: 'user', id: request.params.id });
      return { ...rows[0], complaints: complaints.rows, blocks: blocks.rows };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string; days?: number } }>(
    '/admin/users/:id/block',
    {
      preHandler: requireStaff,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['reason'], additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 3, maxLength: 500 }, days: { type: 'integer', minimum: 1, maximum: 365 } },
        },
      },
    },
    async (request, reply) => {
      if (request.params.id === request.user!.id) throw new HttpError(409, 'cannot_block_yourself');
      const exists = await db.query(`SELECT 1 FROM users WHERE id = $1`, [request.params.id]);
      if (!exists.rows[0]) throw new HttpError(404, 'not_found');
      await withTx(db, (tx) => blockUser(tx, request, request.params.id, request.body.reason, request.body.days ?? null));
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/admin/users/:id/unblock',
    {
      preHandler: requireStaff,
      schema: {
        params: uuidParams,
        body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } } },
      },
    },
    async (request, reply) => {
      const { rowCount } = await db.query(
        `UPDATE blocks SET appeal_status = 'lifted', lifted_by = $2, lifted_at = now()
          WHERE user_id = $1 AND appeal_status <> 'lifted' AND (until IS NULL OR until > now())`,
        [request.params.id, request.user!.id],
      );
      if (!rowCount) throw new HttpError(409, 'not_blocked');
      await audit(db, request, 'user_unblocked', { type: 'user', id: request.params.id }, { reason: request.body.reason });
      return reply.code(204).send();
    },
  );

  // A different class for a car (e.g. after a check showed it is not Comfort).
  app.post<{ Params: { id: string; vehicleId: string }; Body: { classCode: string; reason: string } }>(
    '/admin/drivers/:id/vehicles/:vehicleId/class',
    {
      preHandler: requireStaff,
      schema: {
        params: {
          type: 'object', required: ['id', 'vehicleId'],
          properties: { id: uuidParams.properties.id, vehicleId: uuidParams.properties.id },
        },
        body: {
          type: 'object', required: ['classCode', 'reason'], additionalProperties: false,
          properties: { classCode: { type: 'string', pattern: '^[a-z_]{2,32}$' }, reason: { type: 'string', minLength: 3, maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const { rowCount } = await db.query(
        `UPDATE vehicles v SET class_id = vc.id
           FROM vehicle_classes vc JOIN cities c ON c.id = vc.city_id
          WHERE v.id = $2 AND v.driver_id = $1 AND v.deleted_at IS NULL AND vc.code = $3 AND c.code = $4`,
        [request.params.id, request.params.vehicleId, request.body.classCode, cityCode],
      );
      if (!rowCount) throw new HttpError(404, 'not_found');
      await audit(db, request, 'vehicle_class_changed', { type: 'vehicle', id: request.params.vehicleId }, {
        classCode: request.body.classCode, reason: request.body.reason,
      });
      return driverProfile(db, request.params.id);
    },
  );

  // A document is unreadable or expired: the driver must upload it again.
  app.post<{ Params: { id: string; docId: string }; Body: { note: string } }>(
    '/admin/drivers/:id/documents/:docId/reject',
    {
      preHandler: requireStaff,
      schema: {
        params: {
          type: 'object', required: ['id', 'docId'],
          properties: { id: uuidParams.properties.id, docId: uuidParams.properties.id },
        },
        body: { type: 'object', required: ['note'], additionalProperties: false, properties: { note: { type: 'string', minLength: 3, maxLength: 500 } } },
      },
    },
    async (request) => {
      const { rowCount } = await db.query(
        `UPDATE driver_documents SET status = 'rejected', note = $3, reviewed_by = $4, reviewed_at = now(), deleted_at = now()
          WHERE id = $2 AND driver_id = $1 AND deleted_at IS NULL`,
        [request.params.id, request.params.docId, request.body.note, request.user!.id],
      );
      if (!rowCount) throw new HttpError(404, 'not_found');
      await audit(db, request, 'document_rejected', { type: 'document', id: request.params.docId }, { note: request.body.note });
      return driverProfile(db, request.params.id);
    },
  );

  // Staff roles: admin only, and an admin cannot remove their own admin role (no lock-out).
  app.put<{ Params: { id: string }; Body: { roles: string[] } }>(
    '/admin/users/:id/roles',
    {
      preHandler: requireAdmin,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['roles'], additionalProperties: false,
          properties: { roles: { type: 'array', uniqueItems: true, maxItems: 4, items: { type: 'string', enum: ALLOWED_ROLES } } },
        },
      },
    },
    async (request) => {
      if (request.params.id === request.user!.id && !request.body.roles.includes('admin')) {
        throw new HttpError(409, 'cannot_remove_own_admin');
      }
      const roles = request.body.roles.includes('passenger') ? request.body.roles : ['passenger', ...request.body.roles];
      const { rows } = await db.query(
        `UPDATE users SET roles = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, roles`,
        [request.params.id, roles],
      );
      if (!rows[0]) throw new HttpError(404, 'not_found');
      // Staff who lose a role lose their open panel sessions at once.
      if (!roles.some((r) => r === 'admin' || r === 'support')) {
        await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND kind = 'staff' AND revoked_at IS NULL`, [request.params.id]);
      }
      await audit(db, request, 'roles_changed', { type: 'user', id: request.params.id }, { roles });
      return rows[0];
    },
  );

  // A staff member lost the phone with their authenticator: an admin clears it, the next sign-in
  // sets up a new one (after the SMS code). Their open panel sessions end. Not for oneself.
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/admin/users/:id/reset-2fa',
    {
      preHandler: requireAdmin,
      schema: {
        params: uuidParams,
        body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } } },
      },
    },
    async (request, reply) => {
      if (request.params.id === request.user!.id) throw new HttpError(409, 'not_yourself');
      const { rowCount } = await db.query(
        `UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1 AND deleted_at IS NULL`,
        [request.params.id],
      );
      if (!rowCount) throw new HttpError(404, 'not_found');
      await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND kind = 'staff' AND revoked_at IS NULL`, [request.params.id]);
      await audit(db, request, 'staff_2fa_reset', { type: 'user', id: request.params.id }, { reason: request.body.reason });
      return reply.code(204).send();
    },
  );
}
