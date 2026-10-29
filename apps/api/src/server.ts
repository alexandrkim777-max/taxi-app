import { buildApp } from './app.ts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { createSmsSender } from './sms/index.ts';
import { createRouteProvider } from './routing/index.ts';
import { dispatchTick } from './dispatch/matching.ts';

const app = await buildApp({
  db: pool,
  sms: createSmsSender(config.smsProvider),
  routes: createRouteProvider(config.routeProvider, config.osrmUrl),
  authSecret: config.authSecret,
  fileBaseUrl: config.fileBaseUrl,
  cityCode: config.defaultCityCode,
  trustProxy: config.trustProxy,
  logger: true,
});

// Dispatcher: every 2 s moves auto-mode rides on (next driver after a timeout, new drivers,
// giving up after the search window). Overlapping runs are skipped; several instances are safe.
const DISPATCH_TICK_MS = 2000;
let ticking = false;
const ticker = setInterval(() => {
  if (ticking) return;
  ticking = true;
  dispatchTick(pool)
    .catch((err) => app.log.error(err, 'dispatch tick failed'))
    .finally(() => { ticking = false; });
}, DISPATCH_TICK_MS);
app.addHook('onClose', async () => clearInterval(ticker));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
