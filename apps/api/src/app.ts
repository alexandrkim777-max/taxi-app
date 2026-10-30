import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import type { SmsSender } from './sms/index.ts';
import type { RouteProvider } from './routing/index.ts';
import { loadUser } from './auth/session.ts';
import { HttpError } from './lib/tx.ts';
import { authRoutes } from './auth/routes.ts';
import { staffAuthRoutes } from './auth/staff.ts';
import { driverRoutes } from './drivers/routes.ts';
import { tariffRoutes } from './tariffs/routes.ts';
import { dispatchRoutes } from './dispatch/routes.ts';
import { rideRoutes } from './rides/routes.ts';
import { routeChangeRoutes } from './rides/changes.ts';
import { disputeRoutes } from './disputes/routes.ts';
import { ratingRoutes } from './ratings/routes.ts';
import { paymentRoutes } from './payments/routes.ts';
import { accountRoutes } from './account/routes.ts';
import { pushRoutes } from './push/routes.ts';
import { complaintRoutes } from './complaints/routes.ts';
import { adminPeopleRoutes } from './admin/people.ts';
import { adminPricingRoutes } from './admin/pricing.ts';
import { adminOpsRoutes } from './admin/ops.ts';
import type { PaymentService } from './payments/service.ts';
import type { ProviderName } from './payments/types.ts';
import { setFileService, type FileService } from './files/index.ts';
import { fileRoutes } from './files/routes.ts';
import { geoRoutes } from './geo/routes.ts';
import { DevGeoProvider, type GeoProvider } from './geo/provider.ts';

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
  payments: PaymentService;
  /** Deep link the provider's payment page returns to. */
  paymentReturnUrl?: string;
  paymentWebhookIps?: Partial<Record<ProviderName, string[]>>;
  /** Development helper pages for the fake payment provider; never in production. */
  devRoutes?: boolean;
  /** Private document storage with signed links. */
  files: FileService;
  /** Address search; defaults to the built-in development list. */
  geo?: GeoProvider;
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
    if (error instanceof HttpError) return reply.code(status).send({ error: error.code, ...error.extra });
    return reply.code(status).send({ error: error.code ?? 'bad_request', message: error.message });
  });

  if (deps.rateLimit !== false) {
    await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  }

  setFileService(deps.files);
  app.decorateRequest('user', null);
  app.decorateRequest('staffSession', false);
  app.addHook('preHandler', async (request) => {
    await loadUser(deps.db, request);
  });

  app.get('/health', async () => {
    const { rows } = await deps.db.query('SELECT 1 AS ok');
    return { status: 'ok', db: rows[0]?.ok === 1 };
  });

  await app.register(authRoutes, { db: deps.db, sms: deps.sms, authSecret: deps.authSecret });
  await app.register(staffAuthRoutes, { db: deps.db, authSecret: deps.authSecret });
  await app.register(driverRoutes, { db: deps.db, fileBaseUrl: deps.fileBaseUrl, cityCode: deps.cityCode });
  await app.register(tariffRoutes, { db: deps.db, routes: deps.routes, cityCode: deps.cityCode });
  await app.register(dispatchRoutes, { db: deps.db });
  await app.register(rideRoutes, { db: deps.db, routes: deps.routes, cityCode: deps.cityCode, payments: deps.payments });
  await app.register(routeChangeRoutes, { db: deps.db, routes: deps.routes });
  await app.register(disputeRoutes, { db: deps.db });
  await app.register(ratingRoutes, { db: deps.db });
  await app.register(fileRoutes);
  await app.register(geoRoutes, { db: deps.db, geo: deps.geo ?? new DevGeoProvider() });
  await app.register(complaintRoutes, { db: deps.db });
  await app.register(accountRoutes, { db: deps.db, payments: deps.payments });
  await app.register(pushRoutes, { db: deps.db });
  await app.register(adminPeopleRoutes, { db: deps.db, cityCode: deps.cityCode });
  await app.register(adminPricingRoutes, { db: deps.db, cityCode: deps.cityCode });
  await app.register(adminOpsRoutes, { db: deps.db, cityCode: deps.cityCode });
  await app.register(paymentRoutes, {
    payments: deps.payments,
    cityCode: deps.cityCode,
    returnUrl: deps.paymentReturnUrl ?? 'taxiapp://payment-result',
    webhookIps: deps.paymentWebhookIps ?? {},
    devRoutes: deps.devRoutes ?? false,
  });
  return app;
}
