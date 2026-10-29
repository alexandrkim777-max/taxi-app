import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { SmsSender } from '../sms/index.ts';
import { normalizeUzPhone } from '../lib/phone.ts';
import { generateCode, generateToken, hashCode, hashToken, safeEqualHex } from '../lib/secrets.ts';
import { requireUser } from './session.ts';

const CODE_TTL_MIN = 5;
const RESEND_COOLDOWN_SEC = 60;
const MAX_ATTEMPTS = 5;
const SESSION_DAYS = 90;
const MAX_CODES_PER_HOUR = 5;
/** Stricter per-IP limits for the login endpoints (on top of the global limit). */
const AUTH_IP_LIMIT = { rateLimit: { max: 5, timeWindow: '1 minute' } };

const SMS_TEXT: Record<string, (code: string) => string> = {
  uz: (c) => `Kirish kodi: ${c}. Hech kimga aytmang.`,
  ru: (c) => `Код для входа: ${c}. Никому не сообщайте.`,
  en: (c) => `Your login code: ${c}. Do not share it.`,
};

interface Deps {
  db: pg.Pool;
  sms: SmsSender;
  authSecret: string;
}

export async function authRoutes(app: FastifyInstance, { db, sms, authSecret }: Deps): Promise<void> {
  app.post<{ Body: { phone: string; language?: 'uz' | 'ru' | 'en' } }>(
    '/auth/request-code',
    {
      config: AUTH_IP_LIMIT,
      schema: {
        body: {
          type: 'object',
          required: ['phone'],
          properties: {
            phone: { type: 'string', maxLength: 32 },
            language: { type: 'string', enum: ['uz', 'ru', 'en'] },
          },
        },
      },
    },
    async (request, reply) => {
      const phone = normalizeUzPhone(request.body.phone);
      if (!phone) return reply.code(400).send({ error: 'invalid_phone' });

      // Per-phone limits: one code per minute and a cap per hour. Together with the
      // per-IP limit this blocks code brute force and SMS-pumping fraud.
      const recent = await db.query<{ last_minute: number; last_hour: number }>(
        `SELECT count(*) FILTER (WHERE created_at > now() - make_interval(secs => $2))::int AS last_minute,
                count(*)::int AS last_hour
           FROM auth_codes WHERE phone = $1 AND created_at > now() - interval '1 hour'`,
        [phone, RESEND_COOLDOWN_SEC],
      );
      if (recent.rows[0].last_minute > 0) {
        return reply.code(429).send({ error: 'too_soon', retryAfterSec: RESEND_COOLDOWN_SEC });
      }
      if (recent.rows[0].last_hour >= MAX_CODES_PER_HOUR) {
        return reply.code(429).send({ error: 'too_many_codes' });
      }

      const code = generateCode();
      await db.query(
        `INSERT INTO auth_codes (phone, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [phone, hashCode(authSecret, phone, code), CODE_TTL_MIN],
      );
      const text = (SMS_TEXT[request.body.language ?? 'uz'] ?? SMS_TEXT.uz)(code);
      await sms.send(phone, text);
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { phone: string; code: string; language?: 'uz' | 'ru' | 'en' } }>(
    '/auth/verify',
    {
      config: AUTH_IP_LIMIT,
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'code'],
          properties: {
            phone: { type: 'string', maxLength: 32 },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
            language: { type: 'string', enum: ['uz', 'ru', 'en'] },
          },
        },
      },
    },
    async (request, reply) => {
      const phone = normalizeUzPhone(request.body.phone);
      if (!phone) return reply.code(400).send({ error: 'invalid_phone' });

      // Count the attempt atomically BEFORE comparing, so parallel requests
      // cannot get more than MAX_ATTEMPTS guesses at one code.
      const { rows } = await db.query<{ id: string; code_hash: string }>(
        `UPDATE auth_codes SET attempts = attempts + 1
          WHERE id = (SELECT id FROM auth_codes
                       WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
                       ORDER BY created_at DESC LIMIT 1)
            AND attempts < $2
          RETURNING id, code_hash`,
        [phone, MAX_ATTEMPTS],
      );
      const entry = rows[0];
      if (!entry) return reply.code(400).send({ error: 'code_invalid_or_expired' });

      if (!safeEqualHex(entry.code_hash, hashCode(authSecret, phone, request.body.code))) {
        return reply.code(400).send({ error: 'wrong_code' });
      }

      // Single use: only one request can consume the code.
      const consumed = await db.query(
        'UPDATE auth_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL',
        [entry.id],
      );
      if (!consumed.rowCount) return reply.code(400).send({ error: 'code_invalid_or_expired' });
      const user = await db.query<{ id: string; phone: string; roles: string[]; language: string; name: string | null }>(
        `INSERT INTO users (phone, language) VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
         RETURNING id, phone, roles, language, name`,
        [phone, request.body.language ?? 'uz'],
      );

      const token = generateToken();
      await db.query(
        `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
        [user.rows[0].id, hashToken(token), request.headers['user-agent'] ?? null, SESSION_DAYS],
      );
      return { token, user: user.rows[0] };
    },
  );

  app.post('/auth/logout', { preHandler: requireUser }, async (request, reply) => {
    const token = request.headers.authorization!.slice('Bearer '.length).trim();
    await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)]);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: requireUser }, async (request) => {
    const { rows } = await db.query(
      'SELECT id, phone, name, gender, language, roles FROM users WHERE id = $1',
      [request.user!.id],
    );
    return rows[0];
  });
}
