import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { SmsSender } from './sms/index.ts';
import { loadUser } from './auth/session.ts';
import { authRoutes } from './auth/routes.ts';
import { driverRoutes } from './drivers/routes.ts';

export interface AppDeps {
  db: pg.Pool;
  sms: SmsSender;
  authSecret: string;
  logger?: boolean;
}

/** Builds the API without starting it, so tests can call it via app.inject(). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    await loadUser(deps.db, request);
  });

  app.get('/health', async () => {
    const { rows } = await deps.db.query('SELECT 1 AS ok');
    return { status: 'ok', db: rows[0]?.ok === 1 };
  });

  await app.register(authRoutes, { db: deps.db, sms: deps.sms, authSecret: deps.authSecret });
  await app.register(driverRoutes, { db: deps.db });
  return app;
}
