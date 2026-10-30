import { buildApp } from './app.ts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { createSmsSender } from './sms/index.ts';
import { createRouteProvider } from './routing/index.ts';
import { dispatchTick } from './dispatch/matching.ts';
import { createPaymentProviders } from './payments/providers/index.ts';
import { PaymentService } from './payments/service.ts';
import { FakeFiscalProvider } from './payments/fiscal.ts';
import { DEV_TOKEN_KEY } from './payments/crypto.ts';
import { prepayTick, reconcileTick } from './payments/prepay.ts';
import { sweepStalePresence } from './dispatch/presence.ts';
import { FileService, LocalFileStorage } from './files/index.ts';
import { createGeoProvider } from './geo/provider.ts';
import { createPushSender } from './push/sender.ts';
import { pushTick } from './push/outbox.ts';
import { ErrorMonitor, TelegramAlerter } from './monitoring/errors.ts';

const payments = new PaymentService({
  db: pool,
  providers: createPaymentProviders(process.env),
  tokenKey: config.paymentTokenKey ?? DEV_TOKEN_KEY,
  // TODO: replace with the fiscal operator adapter before taking real subscription payments.
  fiscal: new FakeFiscalProvider(),
});

const monitor = new ErrorMonitor(
  pool,
  config.alertTelegramBotToken && config.alertTelegramChatId ? new TelegramAlerter(config.alertTelegramBotToken, config.alertTelegramChatId) : null,
  process.env.DOMAIN ?? 'taxi',
);

const app = await buildApp({
  monitor,
  db: pool,
  payments,
  geo: createGeoProvider(config.geoProvider, config.nominatimUrl),
  files: new FileService({
    storage: new LocalFileStorage(config.fileStorageDir),
    secret: `${config.authSecret}:files`,
    publicApiUrl: config.publicApiUrl,
  }),
  paymentReturnUrl: config.paymentReturnUrl,
  paymentWebhookIps: config.paymentWebhookIps,
  devRoutes: !config.isProduction && config.paymentProviders.includes('fake'),
  sms: createSmsSender(config.smsProvider),
  routes: createRouteProvider(config.routeProvider, config.osrmUrl),
  authSecret: config.authSecret,
  fileBaseUrl: config.fileBaseUrl,
  legalBaseUrl: config.legalBaseUrl,
  cityCode: config.defaultCityCode,
  trustProxy: config.trustProxy,
  logger: true,
});

const push = createPushSender(config.pushProvider, config.expoAccessToken, (m) => app.log.info(m));

// Background loop every 2 s (push notifications: every 1 s, so a new order rings at once): dispatcher (next driver after a timeout, new drivers, giving up after
// the search window) and card prepayment at 60% of the trip. Overlapping runs are skipped; several instances are safe.
const DISPATCH_TICK_MS = 2000;
// Every 30th tick (about once a minute): sweep silent drivers off the line and charge card rides a
// crash left unpaid. Each job reports its own failure, so one broken job never stops the others.
const SLOW_EVERY = 30;
let ticking = false;
let tickNo = 0;
const ticker = setInterval(() => {
  if (ticking) return;
  ticking = true;
  const slow = tickNo++ % SLOW_EVERY === 0;
  const jobs: [string, Promise<unknown>][] = [
    ['dispatch', dispatchTick(pool)],
    ['prepay', prepayTick(pool, payments)],
    ...(slow ? [['presence sweep', sweepStalePresence(pool)], ['reconcile', reconcileTick(pool, payments)]] as [string, Promise<unknown>][] : []),
  ];
  Promise.allSettled(jobs.map(([, p]) => p))
    .then((results) => results.forEach((r, i) => {
      if (r.status !== 'rejected') return;
      const job = jobs.at(i)?.[0] ?? 'unknown';
      app.log.error({ err: r.reason, job }, 'background job failed');
      const e = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      void monitor.record({ source: 'job', message: e.message, stack: e.stack ?? null, context: { job } });
    }))
    .finally(() => { ticking = false; });
}, DISPATCH_TICK_MS);
let pushing = false;
const pushTicker = setInterval(() => {
  if (pushing) return;
  pushing = true;
  pushTick(pool, push, app.log)
    .catch((err) => {
      app.log.error(err, 'push tick failed');
      void monitor.record({ source: 'job', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : null, context: { job: 'push' } });
    })
    .finally(() => { pushing = false; });
}, 1000);
app.addHook('onClose', async () => { clearInterval(ticker); clearInterval(pushTicker); });

// A promise nobody awaited, or an exception nothing caught: recorded, then (for the latter) a clean
// exit so Docker restarts the API rather than letting it run in an unknown state.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled rejection');
  const e = reason instanceof Error ? reason : new Error(String(reason));
  void monitor.record({ source: 'api', message: e.message, stack: e.stack ?? null, context: { route: 'unhandledRejection' } });
});
process.on('uncaughtException', (err) => {
  app.log.fatal(err, 'uncaught exception');
  monitor.record({ source: 'api', message: err.message, stack: err.stack ?? null, context: { route: 'uncaughtException' } })
    .finally(() => process.exit(1));
});

// Graceful stop (docker stop / redeploy sends SIGTERM): stop the loops, finish requests in flight,
// close the pool. Everything lives in the database, so the next start simply carries on.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err) => { app.log.error(err, 'shutdown failed'); process.exit(1); });
  });
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
