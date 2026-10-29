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
