// Reads configuration from the environment. Fails fast on missing required values.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  defaultCityCode: process.env.DEFAULT_CITY_CODE ?? 'tashkent',
};
