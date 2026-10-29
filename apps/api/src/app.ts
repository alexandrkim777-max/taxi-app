import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import type { SmsSender } from './sms/index.ts';
import type { RouteProvider } from './routing/index.ts';
import { loadUser } from './auth/session.ts';
import { authRoutes } from './auth/routes.ts';
import { driverRoutes } from './drivers/routes.ts';
import { tariffRoutes } from './tariffs/routes.ts';

export interface AppDeps {
  db: pg.Pool;
  sms: SmsSender;
  routes: RouteProvider;
  authSecret: string;
  fileBaseUrl: string;
  cityCode: string;
  trustProxy?: boolean;
  logger?: boolean;
  /** Tests disable the per-IP limiter; it is always on in the server. */
  rateLimit?: boolean;
}

/** Builds the API without starting it, so tests can call it via app.inject(). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: 64 * 1024,
    // Reject unknown fields instead of silently dropping them (Fastify's default strips them).
    ajv: { customOptions: { removeAdditional: false } },
    logger: deps.logger
      ? { redact: ['req.headers.authorization', 'req.headers.cookie'] }
      : false,
  });

  // Never leak internal errors (SQL, stack traces) to clients.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal_error' });
    }
    return reply.code(status).send({ error: error.code ?? 'bad_request', message: error.message });
  });

  if (deps.rateLimit !== false) {
    await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  }

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    await loadUser(deps.db, request);
  });

  app.get('/health', async () => {
    const { rows } = await deps.db.query('SELECT 1 AS ok');
    return { status: 'ok', db: rows[0]?.ok === 1 };
  });

  await app.register(authRoutes, { db: deps.db, sms: deps.sms, authSecret: deps.authSecret });
  await app.register(driverRoutes, { db: deps.db, fileBaseUrl: deps.fileBaseUrl, cityCode: deps.cityCode });
  await app.register(tariffRoutes, { db: deps.db, routes: deps.routes, cityCode: deps.cityCode });
  return app;
}
