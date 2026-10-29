import type pg from 'pg';

/** Runs fn inside a transaction on one pooled connection; rolls back on any error. */
export async function withTx<T>(db: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && (!constraint || e.constraint === constraint);
}

/**
 * Thrown inside a handler or transaction to roll back and answer with a 4xx error.
 * The app's error handler turns it into { error: code }.
 */
export class HttpError extends Error {
  statusCode: number;
  code: string;
  /** Extra fields for the client (e.g. the fee to confirm); never put internals here. */
  extra: Record<string, unknown>;
  constructor(statusCode: number, code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}
