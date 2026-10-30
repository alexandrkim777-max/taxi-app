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
import { prepayTick } from './payments/prepay.ts';
import { FileService, LocalFileStorage } from './files/index.ts';
import { createGeoProvider } from './geo/provider.ts';
import { createPushSender } from './push/sender.ts';
import { pushTick } from './push/outbox.ts';

const payments = new PaymentService({
  db: pool,
  providers: createPaymentProviders(process.env),
  tokenKey: config.paymentTokenKey ?? DEV_TOKEN_KEY,
  // TODO: replace with the fiscal operator adapter before taking real subscription payments.
  fiscal: new FakeFiscalProvider(),
});

const app = await buildApp({
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
  cityCode: config.defaultCityCode,
  trustProxy: config.trustProxy,
  logger: true,
});

const push = createPushSender(config.pushProvider, config.expoAccessToken, (m) => app.log.info(m));

// Background loop every 2 s (push notifications: every 1 s, so a new order rings at once): dispatcher (next driver after a timeout, new drivers, giving up after
// the search window) and card prepayment at 60% of the trip. Overlapping runs are skipped; several instances are safe.
const DISPATCH_TICK_MS = 2000;
let ticking = false;
const ticker = setInterval(() => {
  if (ticking) return;
  ticking = true;
  Promise.all([dispatchTick(pool), prepayTick(pool, payments)])
    .catch((err) => app.log.error(err, 'background tick failed'))
    .finally(() => { ticking = false; });
}, DISPATCH_TICK_MS);
let pushing = false;
const pushTicker = setInterval(() => {
  if (pushing) return;
  pushing = true;
  pushTick(pool, push, app.log)
    .catch((err) => app.log.error(err, 'push tick failed'))
    .finally(() => { pushing = false; });
}, 1000);
app.addHook('onClose', async () => { clearInterval(ticker); clearInterval(pushTicker); });

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
