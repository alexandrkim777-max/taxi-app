// The apps and the staff panel report crashes here; admins see the grouped list and mark kinds fixed.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAdmin } from '../auth/session.ts';
import { HttpError } from '../lib/tx.ts';
import { audit } from '../admin/audit.ts';
import type { ErrorMonitor } from './errors.ts';

export async function monitoringRoutes(app: FastifyInstance, { db, monitor }: { db: pg.Pool; monitor: ErrorMonitor }): Promise<void> {
  // No sign-in needed: an app can crash before it. Small, strict, rate-limited; nothing is echoed back.
  app.post<{ Body: { app: 'passenger' | 'driver' | 'admin'; message: string; stack?: string; appVersion?: string; platform?: string; screen?: string } }>(
    '/client-errors',
    {
      bodyLimit: 8 * 1024,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object', required: ['app', 'message'], additionalProperties: false,
          properties: {
            app: { type: 'string', enum: ['passenger', 'driver', 'admin'] },
            message: { type: 'string', minLength: 1, maxLength: 500 },
            stack: { type: 'string', maxLength: 4000 },
            appVersion: { type: 'string', maxLength: 40, pattern: '^[0-9A-Za-z.+-]*$' },
            platform: { type: 'string', enum: ['android', 'ios', 'web'] },
            screen: { type: 'string', maxLength: 60, pattern: '^[A-Za-z0-9_-]*$' },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      await monitor.record({
        source: b.app, message: b.message, stack: b.stack ?? null, appVersion: b.appVersion ?? null,
        context: { ...(b.platform ? { platform: b.platform } : {}), ...(b.screen ? { screen: b.screen } : {}) },
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Querystring: { status?: 'open' | 'resolved' } }>(
    '/admin/errors',
    {
      preHandler: requireAdmin,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['open', 'resolved'] } } } },
    },
    async (request) => {
      const open = (request.query.status ?? 'open') === 'open';
      const { rows } = await db.query(
        `SELECT id, source, message, stack, context, app_version AS "appVersion", count,
                first_seen AS "firstSeen", last_seen AS "lastSeen", resolved_at AS "resolvedAt"
           FROM error_events WHERE (resolved_at IS NULL) = $1 ORDER BY last_seen DESC LIMIT 200`,
        [open],
      );
      return rows;
    },
  );

  // "Fixed": the kind leaves the list; if it happens again it comes back (and alerts again).
  app.post<{ Params: { id: string } }>(
    '/admin/errors/:id/resolve',
    { preHandler: requireAdmin, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9]{1,18}$' } } } } },
    async (request, reply) => {
      const { rowCount } = await db.query(`UPDATE error_events SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL`, [request.params.id]);
      if (!rowCount) throw new HttpError(404, 'not_found');
      await audit(db, request, 'error_resolved', { type: 'error_event', id: request.params.id });
      return reply.code(204).send();
    },
  );
}
