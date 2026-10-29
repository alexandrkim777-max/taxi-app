import Fastify from 'fastify';
import { config } from './config.ts';
import { pool } from './db.ts';

const app = Fastify({ logger: true });

app.get('/health', async () => {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return { status: 'ok', db: rows[0]?.ok === 1 };
});

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
