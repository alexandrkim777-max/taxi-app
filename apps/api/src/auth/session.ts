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
    /** True when the request came with a staff panel session (cookie, SMS + authenticator). */
    staffSession: boolean;
  }
}

/**
 * Staff panel session cookie. `__Host-` makes the browser accept it only with Secure, Path=/ and
 * no Domain, so no subdomain can set or overwrite it. HttpOnly: page scripts cannot read it.
 */
export const STAFF_COOKIE = '__Host-taxi_staff';
/** A staff session ends after this long without a request, and at most after STAFF_SESSION_HOURS. */
export const STAFF_IDLE_MIN = 30;
export const STAFF_SESSION_HOURS = 12;
/**
 * Writes with the staff cookie must carry this header. Another site cannot add a custom header to
 * a request to us without a CORS preflight, which we never allow (on top of SameSite=Strict).
 */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'taxi-admin';

export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export function staffCookie(token: string | null): string {
  return token
    ? `${STAFF_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${STAFF_SESSION_HOURS * 3600}`
    : `${STAFF_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the caller. A bearer token is a phone-app session; the staff cookie is a panel session
 * (only honoured for writes when the CSRF header is present). request.user stays null otherwise.
 */
export async function loadUser(db: pg.Pool, request: FastifyRequest): Promise<void> {
  request.user = null;
  request.staffSession = false;
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    const { rows } = await db.query<AuthUser>(
      `SELECT u.id, u.phone, u.roles, u.language
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.kind = 'app' AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.deleted_at IS NULL`,
      [hashToken(token)],
    );
    request.user = rows[0] ?? null;
    return;
  }
  const cookie = readCookie(request, STAFF_COOKIE);
  if (!cookie) return;
  if (!SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] !== CSRF_VALUE) return;
  // Each request extends the idle window; a session idle for too long is dead for good.
  const { rows } = await db.query<AuthUser>(
    `UPDATE sessions s SET last_seen_at = now()
       FROM users u
      WHERE u.id = s.user_id AND s.token_hash = $1 AND s.kind = 'staff'
        AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(mins => $2)
        AND u.deleted_at IS NULL
      RETURNING u.id, u.phone, u.roles, u.language`,
    [hashToken(cookie), STAFF_IDLE_MIN],
  );
  request.user = rows[0] ?? null;
  request.staffSession = request.user !== null;
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}

/** Staff roles: 'admin' can do everything; 'support' handles moderation, complaints and disputes. */
export const STAFF_ROLES = ['admin', 'support'] as const;

/** Staff endpoints: a panel session (SMS + authenticator) AND the role. App tokens never pass. */
export function requireAnyRole(roles: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      await reply.code(401).send({ error: 'unauthorized' });
    } else if (!request.staffSession) {
      await reply.code(403).send({ error: 'staff_session_required' });
    } else if (!request.user.roles.some((r) => roles.includes(r))) {
      await reply.code(403).send({ error: 'forbidden' });
    }
  };
}

export const requireStaff = requireAnyRole(STAFF_ROLES);
export const requireAdmin = requireAnyRole(['admin']);
