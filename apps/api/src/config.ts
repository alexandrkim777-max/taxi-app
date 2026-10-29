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
};
