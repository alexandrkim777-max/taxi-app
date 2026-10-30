// Reads configuration from the environment. Fails fast on missing or unsafe values.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const env = process.env.NODE_ENV ?? 'development';
const isProduction = env === 'production';

const authSecret = required('AUTH_SECRET');
const smsProvider = process.env.SMS_PROVIDER ?? 'console';
const routeProvider = process.env.ROUTE_PROVIDER ?? 'estimate';
const paymentProviders = (process.env.PAYMENT_PROVIDERS ?? 'fake').split(',').map((s) => s.trim()).filter(Boolean);
const paymentTokenKey = process.env.PAYMENT_TOKEN_KEY;
const geoProvider = process.env.GEO_PROVIDER ?? 'dev';
const pushProvider = process.env.PUSH_PROVIDER ?? 'log';

if (isProduction) {
  if (authSecret.length < 32 || authSecret.startsWith('dev-')) {
    throw new Error('AUTH_SECRET must be a random string of at least 32 characters in production');
  }
  if (smsProvider === 'console') {
    throw new Error('SMS_PROVIDER=console prints login codes to the log and is not allowed in production');
  }
  if (routeProvider !== 'osrm') {
    throw new Error('ROUTE_PROVIDER must be osrm in production; the estimate provider is for development only');
  }
  if (paymentProviders.includes('fake')) {
    throw new Error('PAYMENT_PROVIDERS must not include fake in production (it approves payments without money)');
  }
  if (pushProvider !== 'expo') {
    throw new Error('PUSH_PROVIDER must be expo in production; the log provider sends nothing');
  }
  if (geoProvider !== 'nominatim') {
    throw new Error('GEO_PROVIDER must be nominatim in production; the dev list is for local testing only');
  }
  if (!paymentTokenKey) {
    throw new Error('PAYMENT_TOKEN_KEY (32 random bytes, base64) is required in production to encrypt card tokens');
  }
}

/** Optional per-provider webhook IP allowlists: PAYME_WEBHOOK_IPS=1.2.3.4,5.6.7.8 */
function webhookIps(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of ['payme', 'click', 'uzum']) {
    const v = process.env[`${name.toUpperCase()}_WEBHOOK_IPS`];
    if (v) out[name] = v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

export const config = {
  env,
  isProduction,
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  defaultCityCode: process.env.DEFAULT_CITY_CODE ?? 'tashkent',
  /** Secret used to hash SMS codes. */
  authSecret,
  smsProvider,
  /** Set to true only when the API runs behind our own reverse proxy (for correct client IPs). */
  trustProxy: process.env.TRUST_PROXY === 'true',
  /** Only document links under this prefix are accepted (our own file storage). */
  fileBaseUrl: process.env.FILE_BASE_URL ?? 'https://files.example/',
  routeProvider,
  osrmUrl: process.env.OSRM_URL ?? 'http://localhost:5000',
  paymentProviders,
  paymentTokenKey,
  paymentReturnUrl: process.env.PAYMENT_RETURN_URL ?? 'taxiapp://payment-result',
  paymentWebhookIps: webhookIps(),
  /** Where private files (driver documents) are kept. */
  fileStorageDir: process.env.FILE_STORAGE_DIR ?? './var/files',
  /** Public base URL of this API, used in signed file links (e.g. https://example.uz/api). */
  publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  geoProvider,
  pushProvider,
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  nominatimUrl: process.env.NOMINATIM_URL ?? 'http://localhost:8080',
};
