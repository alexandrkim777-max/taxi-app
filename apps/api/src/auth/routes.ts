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

      const recent = await db.query(
        `SELECT 1 FROM auth_codes WHERE phone = $1 AND created_at > now() - make_interval(secs => $2)`,
        [phone, RESEND_COOLDOWN_SEC],
      );
      if (recent.rowCount) return reply.code(429).send({ error: 'too_soon', retryAfterSec: RESEND_COOLDOWN_SEC });

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

      const { rows } = await db.query<{ id: string; code_hash: string; attempts: number }>(
        `SELECT id, code_hash, attempts FROM auth_codes
          WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [phone],
      );
      const entry = rows[0];
      if (!entry) return reply.code(400).send({ error: 'code_expired' });
      if (entry.attempts >= MAX_ATTEMPTS) return reply.code(429).send({ error: 'too_many_attempts' });

      if (!safeEqualHex(entry.code_hash, hashCode(authSecret, phone, request.body.code))) {
        await db.query('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1', [entry.id]);
        return reply.code(400).send({ error: 'wrong_code' });
      }

      await db.query('UPDATE auth_codes SET consumed_at = now() WHERE id = $1', [entry.id]);
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
