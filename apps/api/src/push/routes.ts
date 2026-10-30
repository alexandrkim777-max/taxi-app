// Registering the device for push notifications. Only Expo push tokens are accepted; a device that
// signs in to another account moves to that account (one device = one account at a time).

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUser } from '../auth/session.ts';

interface Deps { db: pg.Pool }

const TOKEN = { type: 'string', pattern: '^ExponentPushToken\\[[A-Za-z0-9_-]{10,100}\\]$' } as const;
/** Old phones of the same person are dropped beyond this. */
const MAX_DEVICES = 5;

export async function pushRoutes(app: FastifyInstance, { db }: Deps): Promise<void> {
  app.post<{ Body: { token: string; app: 'driver' | 'passenger'; platform: 'ios' | 'android' } }>(
    '/me/push-token',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object', required: ['token', 'app', 'platform'], additionalProperties: false,
          properties: { token: TOKEN, app: { type: 'string', enum: ['driver', 'passenger'] }, platform: { type: 'string', enum: ['ios', 'android'] } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { token, platform } = request.body;
      await db.query(
        `INSERT INTO push_tokens (user_id, token, app, platform) VALUES ($1, $2, $3, $4)
         ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, app = EXCLUDED.app, platform = EXCLUDED.platform,
                                           revoked_at = NULL, updated_at = now()`,
        [userId, token, request.body.app, platform],
      );
      await db.query(
        `UPDATE push_tokens SET revoked_at = now()
          WHERE id IN (SELECT id FROM push_tokens WHERE user_id = $1 AND app = $2 AND revoked_at IS NULL
                        ORDER BY updated_at DESC OFFSET $3)`,
        [userId, request.body.app, MAX_DEVICES],
      );
      return reply.code(204).send();
    },
  );

  // Sign-out on this device: no more notifications here.
  app.delete<{ Body: { token: string } }>(
    '/me/push-token',
    {
      preHandler: requireUser,
      schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: TOKEN } } },
    },
    async (request, reply) => {
      await db.query(`UPDATE push_tokens SET revoked_at = now() WHERE token = $1 AND user_id = $2`, [request.body.token, request.user!.id]);
      return reply.code(204).send();
    },
  );
}
