// Staff panel sign-in: SMS code, then a code from an authenticator app (set up on the first
// sign-in). The session lives in an httpOnly cookie, ends after 30 minutes idle or 12 hours, and
// only works for the panel: phone-app tokens are refused on staff endpoints.
//
//   1. POST /auth/request-code            (same SMS as the apps)
//   2. POST /staff/auth/verify {phone, code}
//        -> { next: 'totp', ticket }                       authenticator already set up
//        -> { next: 'totp_setup', ticket, secret, otpauthUrl } first sign-in: add it to the app
//   3. POST /staff/auth/totp {ticket, code} -> Set-Cookie, { user }

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { normalizeUzPhone } from '../lib/phone.ts';
import { generateToken, hashToken } from '../lib/secrets.ts';
import { TokenCipher } from '../payments/crypto.ts';
import { AUTH_IP_LIMIT, consumeLoginCode } from './routes.ts';
import { readCookie, requireUser, STAFF_COOKIE, STAFF_ROLES, STAFF_SESSION_HOURS, staffCookie } from './session.ts';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp.ts';

const TICKET_MIN = 5;
const TICKET_ATTEMPTS = 5;
const ISSUER = 'Taxi staff';

interface Deps {
  db: pg.Pool;
  authSecret: string;
}

/** Authenticator secrets are encrypted with a key derived from AUTH_SECRET (rotating it resets 2FA). */
export function totpCipher(authSecret: string): TokenCipher {
  return new TokenCipher(createHash('sha256').update(`${authSecret}:totp`).digest('base64'));
}

export async function staffAuthRoutes(app: FastifyInstance, { db, authSecret }: Deps): Promise<void> {
  const cipher = totpCipher(authSecret);

  app.post<{ Body: { phone: string; code: string } }>(
    '/staff/auth/verify',
    {
      config: AUTH_IP_LIMIT,
      schema: {
        body: {
          type: 'object', required: ['phone', 'code'], additionalProperties: false,
          properties: { phone: { type: 'string', maxLength: 32 }, code: { type: 'string', pattern: '^[0-9]{6}$' } },
        },
      },
    },
    async (request, reply) => {
      const phone = normalizeUzPhone(request.body.phone);
      if (!phone) return reply.code(400).send({ error: 'invalid_phone' });
      const checked = await consumeLoginCode(db, authSecret, phone, request.body.code);
      if ('error' in checked) return reply.code(400).send({ error: checked.error });

      const { rows } = await db.query<{ id: string; totp_enabled_at: string | null }>(
        `SELECT id, totp_enabled_at FROM users
          WHERE phone = $1 AND deleted_at IS NULL AND roles && $2::text[]`,
        [phone, STAFF_ROLES],
      );
      const user = rows[0];
      if (!user) return reply.code(403).send({ error: 'not_staff' });

      const ticket = generateToken();
      const setup = user.totp_enabled_at ? null : newTotpSecret();
      await db.query(
        `INSERT INTO staff_login_tickets (user_id, ticket_hash, pending_secret_enc, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
        [user.id, hashToken(ticket), setup ? cipher.encrypt(setup) : null, TICKET_MIN],
      );
      if (!setup) return { next: 'totp', ticket };
      return { next: 'totp_setup', ticket, secret: setup, otpauthUrl: otpauthUrl(ISSUER, phone, setup) };
    },
  );

  app.post<{ Body: { ticket: string; code: string } }>(
    '/staff/auth/totp',
    {
      config: AUTH_IP_LIMIT,
      schema: {
        body: {
          type: 'object', required: ['ticket', 'code'], additionalProperties: false,
          properties: { ticket: { type: 'string', minLength: 16, maxLength: 128 }, code: { type: 'string', pattern: '^[0-9]{6}$' } },
        },
      },
    },
    async (request, reply) => {
      // Count the try before checking, like SMS codes: at most TICKET_ATTEMPTS guesses per ticket.
      const { rows } = await db.query<{
        id: string; user_id: string; pending_secret_enc: string | null; totp_secret_enc: string | null; totp_last_step: string | null;
      }>(
        `UPDATE staff_login_tickets t SET attempts = attempts + 1
           FROM users u
          WHERE u.id = t.user_id AND t.ticket_hash = $1 AND t.used_at IS NULL
            AND t.expires_at > now() AND t.attempts < $2
          RETURNING t.id, t.user_id, t.pending_secret_enc, u.totp_secret_enc, u.totp_last_step`,
        [hashToken(request.body.ticket), TICKET_ATTEMPTS],
      );
      const t = rows[0];
      if (!t) return reply.code(400).send({ error: 'ticket_invalid_or_expired' });
      const enc = t.pending_secret_enc ?? t.totp_secret_enc;
      if (!enc) return reply.code(400).send({ error: 'ticket_invalid_or_expired' });
      const lastStep = t.pending_secret_enc || t.totp_last_step === null ? null : Number(t.totp_last_step);
      const step = verifyTotp(cipher.decrypt(enc), request.body.code, lastStep);
      if (step === null) return reply.code(400).send({ error: 'wrong_code' });

      const token = generateToken();
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const used = await client.query(`UPDATE staff_login_tickets SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [t.id]);
        // The same code cannot be used twice, even by two requests racing each other.
        const user = await client.query<{ id: string; phone: string; roles: string[]; language: string; name: string | null }>(
          `UPDATE users
              SET totp_last_step = $2,
                  totp_secret_enc = coalesce($3, totp_secret_enc),
                  totp_enabled_at = CASE WHEN $3::text IS NOT NULL THEN now() ELSE totp_enabled_at END
            WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2 OR $3::text IS NOT NULL)
              AND deleted_at IS NULL AND roles && $4::text[]
            RETURNING id, phone, roles, language, name`,
          [t.user_id, step, t.pending_secret_enc, STAFF_ROLES],
        );
        if (!used.rowCount || !user.rows[0]) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'wrong_code' });
        }
        await client.query(
          `INSERT INTO sessions (user_id, token_hash, user_agent, kind, expires_at)
           VALUES ($1, $2, $3, 'staff', now() + make_interval(hours => $4))`,
          [t.user_id, hashToken(token), request.headers['user-agent'] ?? null, STAFF_SESSION_HOURS],
        );
        await client.query(
          `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload, ip)
           VALUES ($1, $2, 'user', $4, '{}', $3)`,
          [t.user_id, t.pending_secret_enc ? 'staff_2fa_enabled' : 'staff_signed_in', request.ip, t.user_id],
        );
        await client.query('COMMIT');
        reply.header('set-cookie', staffCookie(token));
        return { user: user.rows[0] };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );

  app.post('/staff/auth/logout', { preHandler: requireUser }, async (request, reply) => {
    const cookie = readCookie(request, STAFF_COOKIE);
    if (request.staffSession && cookie) {
      await db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND kind = 'staff'`, [hashToken(cookie)]);
    }
    reply.header('set-cookie', staffCookie(null));
    return reply.code(204).send();
  });
}
