// Append-only log of every staff action, including looking at personal data. The table refuses
// updates and deletes (database trigger), so nobody can quietly clean up after themselves.

import type { FastifyRequest } from 'fastify';
import type pg from 'pg';

type Q = pg.Pool | pg.PoolClient;

export async function audit(
  q: Q, request: FastifyRequest, action: string, target: { type: string; id: string } | null, payload: Record<string, unknown> = {},
): Promise<void> {
  await q.query(
    `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
    [request.user!.id, action, target?.type ?? null, target?.id ?? null, JSON.stringify(payload), request.ip],
  );
}
