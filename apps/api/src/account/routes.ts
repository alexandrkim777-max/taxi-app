// The passenger's own account: deleting it (required by the App Store and Google Play) and the list
// of drivers they never want to be matched with again.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUser } from '../auth/session.ts';
import { uuidParams } from '../lib/geo.ts';
import { HttpError, withTx } from '../lib/tx.ts';
import type { PaymentService } from '../payments/service.ts';
import { rideFor } from '../rides/common.ts';

interface Deps { db: pg.Pool; payments: PaymentService }

/** Enough for real use, small enough that nobody can block the whole city. */
export const MAX_BLOCKED_DRIVERS = 50;

export async function accountRoutes(app: FastifyInstance, { db, payments }: Deps): Promise<void> {
  /**
   * Deletes the account. Personal data is erased (name, phone, saved places, card tokens, sessions);
   * rides stay for accounting and disputes, but no longer point to a person. Refused while a ride is
   * active or money is owed, so an account cannot be deleted to walk away from a debt.
   */
  app.delete<{ Body: { confirm: true } }>(
    '/me',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
      schema: {
        body: { type: 'object', required: ['confirm'], additionalProperties: false, properties: { confirm: { const: true } } },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const cards = await withTx(db, async (tx) => {
        const { rows: [user] } = await tx.query<{ phone: string }>(`SELECT phone FROM users WHERE id = $1 FOR UPDATE`, [userId]);
        const active = await tx.query(
          `SELECT 1 FROM rides r LEFT JOIN drivers d ON d.id = r.driver_id
            WHERE (r.passenger_id = $1 OR d.user_id = $1)
              AND r.status IN ('created', 'accepted', 'driver_en_route', 'arrived', 'in_progress')`,
          [userId],
        );
        if (active.rows[0]) throw new HttpError(409, 'active_ride');
        const debts = await payments.debts(tx, userId);
        if (debts.length) throw new HttpError(402, 'unpaid_debt', { totalTiyin: debts.reduce((a, d) => a + d.amountTiyin, 0) });

        const { rows: cardRows } = await tx.query<{ provider: string; token_enc: string }>(
          `UPDATE payment_cards SET deleted_at = now(), is_default = false
            WHERE user_id = $1 AND deleted_at IS NULL RETURNING provider, token_enc`,
          [userId],
        );
        await tx.query(`UPDATE payment_cards SET token_enc = '' WHERE user_id = $1`, [userId]);
        await tx.query(`DELETE FROM saved_places WHERE user_id = $1`, [userId]);
        await tx.query(`DELETE FROM passenger_blocked_drivers WHERE user_id = $1`, [userId]);
        await tx.query(`DELETE FROM auth_codes WHERE phone = $1`, [user!.phone]);
        await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
        // A driver account goes with it: off the map at once.
        await tx.query(`DELETE FROM driver_presence p USING drivers d WHERE d.id = p.driver_id AND d.user_id = $1`, [userId]);
        await tx.query(`UPDATE drivers SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL`, [userId]);
        // The phone number is freed: signing up again later starts a new, empty account.
        await tx.query(
          `UPDATE users SET phone = 'deleted:' || id, name = NULL, gender = NULL, deleted_at = now() WHERE id = $1`,
          [userId],
        );
        return cardRows;
      });
      // Best effort: ask the providers to forget the card tokens too (after the commit, outside the lock).
      for (const card of cards) {
        try {
          await payments.provider(card.provider).removeCard(payments.cipher.decrypt(card.token_enc));
        } catch (err) {
          request.log.warn({ err }, 'provider card removal failed during account deletion');
        }
      }
      request.log.info({ userId }, 'account deleted');
      return reply.code(204).send();
    },
  );

  // --- Drivers I never want again -------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/rides/:id/block-driver',
    { preHandler: requireUser, schema: { params: uuidParams }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = request.user!.id;
      const { ride, role } = await rideFor(db, request.params.id, userId, false);
      if (role !== 'passenger') throw new HttpError(404, 'not_found');
      if (!ride.driver_id) throw new HttpError(409, 'no_driver_assigned');
      const { rows: [n] } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM passenger_blocked_drivers WHERE user_id = $1`, [userId]);
      if (n!.n >= MAX_BLOCKED_DRIVERS) throw new HttpError(409, 'too_many_blocked');
      await db.query(
        `INSERT INTO passenger_blocked_drivers (user_id, driver_id, ride_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, ride.driver_id, ride.id],
      );
      return reply.code(204).send();
    },
  );

  app.get('/me/blocked-drivers', { preHandler: requireUser }, async (request) => {
    // Only what the passenger saw on that ride: first name and the car.
    const { rows } = await db.query(
      `SELECT b.driver_id AS id, u.name AS "driverName", v.make_model AS "makeModel", v.plate, b.created_at AS "createdAt"
         FROM passenger_blocked_drivers b
         JOIN drivers d ON d.id = b.driver_id
         JOIN users u ON u.id = d.user_id
         LEFT JOIN rides r ON r.id = b.ride_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
        WHERE b.user_id = $1
        ORDER BY b.created_at DESC`,
      [request.user!.id],
    );
    return rows;
  });

  app.delete<{ Params: { id: string } }>(
    '/me/blocked-drivers/:id',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request, reply) => {
      const { rowCount } = await db.query(`DELETE FROM passenger_blocked_drivers WHERE user_id = $1 AND driver_id = $2`, [request.user!.id, request.params.id]);
      if (!rowCount) throw new HttpError(404, 'not_found');
      return reply.code(204).send();
    },
  );
}
