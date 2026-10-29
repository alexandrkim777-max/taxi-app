import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hashToken } from '../lib/secrets.ts';

export interface AuthUser {
  id: string;
  phone: string;
  roles: string[];
  language: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

/** Resolves the bearer token to a user; leaves request.user null when absent or invalid. */
export async function loadUser(db: pg.Pool, request: FastifyRequest): Promise<void> {
  request.user = null;
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return;
  const token = header.slice('Bearer '.length).trim();
  const { rows } = await db.query<AuthUser>(
    `SELECT u.id, u.phone, u.roles, u.language
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.deleted_at IS NULL`,
    [hashToken(token)],
  );
  request.user = rows[0] ?? null;
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}

export function requireRole(role: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      await reply.code(401).send({ error: 'unauthorized' });
    } else if (!request.user.roles.includes(role)) {
      await reply.code(403).send({ error: 'forbidden' });
    }
  };
}
