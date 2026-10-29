// Payment logic that does not depend on any provider: creating payments, settling them exactly
// once, and what a settled payment unlocks (a subscription period, a paid ride, a paid fee).

import type pg from 'pg';
import { HttpError, withTx } from '../lib/tx.ts';
import { TokenCipher } from './crypto.ts';
import type { FiscalProvider } from './fiscal.ts';
import type { PaymentLookup, PaymentProvider, ProviderName } from './types.ts';

type Q = pg.Pool | pg.PoolClient;

export interface Logger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Settlement {
  paymentId: string;
  providerRef: string;
  amountTiyin: number;
  status: 'succeeded' | 'failed' | 'cancelled';
  reason?: string;
}

interface PaymentRow {
  id: string;
  type: string;
  status: string;
  amount_tiyin: string;
  provider: ProviderName;
  ride_id: string | null;
  driver_id: string | null;
  plan_id: string | null;
  payer_user_id: string | null;
}

export class PaymentService {
  readonly db: pg.Pool;
  readonly providers: Map<ProviderName, PaymentProvider>;
  readonly cipher: TokenCipher;
  readonly fiscal: FiscalProvider;
  readonly log: Logger;

  constructor(opts: {
    db: pg.Pool; providers: Map<ProviderName, PaymentProvider>; tokenKey: string; fiscal: FiscalProvider;
    log?: Logger;
  }) {
    this.db = opts.db;
    this.providers = opts.providers;
    this.cipher = new TokenCipher(opts.tokenKey);
    this.fiscal = opts.fiscal;
    this.log = opts.log ?? console;
  }

  provider(name: string): PaymentProvider {
    const p = this.providers.get(name as ProviderName);
    if (!p) throw new HttpError(400, 'provider_not_available');
    return p;
  }

  lookup(): PaymentLookup {
    return {
      find: async (id: string) => {
        if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
        const { rows } = await this.db.query<{ id: string; amount_tiyin: string; status: string }>(
          `SELECT id, amount_tiyin, status FROM payments WHERE id = $1`,
          [id],
        );
        return rows[0] ? { id: rows[0].id, amountTiyin: Number(rows[0].amount_tiyin), status: rows[0].status } : null;
      },
    };
  }

  /**
   * Applies a provider's verdict to one of our payments, exactly once.
   * - A payment leaves 'pending' only once; repeats of the same verdict are acknowledged, others ignored.
   * - Success is accepted only for the exact amount we asked for.
   */
  async settle(s: Settlement): Promise<'applied' | 'duplicate' | 'rejected'> {
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<PaymentRow>(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [s.paymentId]);
      const p = rows[0];
      if (!p) return 'rejected';
      if (p.status !== 'pending') return p.status === s.status ? 'duplicate' : 'rejected';
      if (s.status === 'succeeded' && s.amountTiyin !== Number(p.amount_tiyin)) {
        this.log.warn({ paymentId: p.id, expected: p.amount_tiyin, got: s.amountTiyin }, 'payment amount mismatch');
        return 'rejected';
      }
      await tx.query(
        `UPDATE payments SET status = $2, provider_ref = coalesce(provider_ref, $3), failure_reason = $4,
                paid_at = CASE WHEN $2 = 'succeeded' THEN now() END, updated_at = now()
          WHERE id = $1`,
        [p.id, s.status, s.providerRef, s.reason ?? null],
      );
      await this.applyEffects(tx, p, s.status);
      return 'applied';
    });
  }

  private async applyEffects(tx: pg.PoolClient, p: PaymentRow, status: Settlement['status']): Promise<void> {
    if (p.type === 'subscription' && status === 'succeeded') {
      // The new period starts when the current one ends, so paying early never loses days.
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO subscriptions (driver_id, plan_id, price_paid_tiyin, starts_at, ends_at)
         SELECT $1, sp.id, $3, st.starts_at, st.starts_at + make_interval(days => sp.period_days)
           FROM subscription_plans sp,
                LATERAL (SELECT greatest(now(), coalesce(max(ends_at), now())) AS starts_at
                           FROM subscriptions WHERE driver_id = $1 AND status = 'active') st
          WHERE sp.id = $2
         RETURNING id`,
        [p.driver_id, p.plan_id, p.amount_tiyin],
      );
      await tx.query(`UPDATE payments SET subscription_id = $2 WHERE id = $1`, [p.id, rows[0]!.id]);
      await tx.query(
        `INSERT INTO fiscal_receipts (payment_id, provider, status) VALUES ($1, $2, 'pending')`,
        [p.id, this.fiscal.name],
      );
    }
    if (p.type === 'ride' && p.ride_id) {
      if (status === 'succeeded') {
        await tx.query(
          `UPDATE rides SET paid_tiyin = paid_tiyin + $2,
                  payment_status = CASE WHEN paid_tiyin + $2 >= locked_price_tiyin THEN 'paid' ELSE 'pending' END
            WHERE id = $1`,
          [p.ride_id, p.amount_tiyin],
        );
      } else {
        await tx.query(`UPDATE rides SET payment_status = 'failed' WHERE id = $1`, [p.ride_id]);
      }
    }
    if (p.type === 'cancel_fee' && p.ride_id && status === 'succeeded') {
      await tx.query(`UPDATE rides SET cancel_fee_status = 'paid' WHERE id = $1 AND cancel_fee_status = 'pending'`, [p.ride_id]);
    }
  }

  /** Issues pending fiscal receipts. Called after a subscription payment; safe to retry. */
  async issueReceipts(): Promise<void> {
    const { rows } = await this.db.query<{ id: string; payment_id: string; amount_tiyin: string }>(
      `SELECT f.id, f.payment_id, p.amount_tiyin FROM fiscal_receipts f JOIN payments p ON p.id = f.payment_id
        WHERE f.status = 'pending' LIMIT 50`,
    );
    for (const r of rows) {
      try {
        const res = await this.fiscal.issue({ paymentId: r.payment_id, amountTiyin: Number(r.amount_tiyin), description: 'Driver subscription' });
        await this.db.query(
          `UPDATE fiscal_receipts SET status = 'issued', receipt_number = $2, payload = $3 WHERE id = $1`,
          [r.id, res.receiptNumber, JSON.stringify(res.payload)],
        );
      } catch (err) {
        this.log.error({ err, receiptId: r.id }, 'fiscal receipt failed');
      }
    }
  }

  /** The user's active card token, decrypted, or a 4xx. */
  async cardToken(q: Q, userId: string, cardId: string): Promise<{ provider: PaymentProvider; token: string }> {
    const { rows } = await q.query<{ provider: string; token_enc: string }>(
      `SELECT provider, token_enc FROM payment_cards WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [cardId, userId],
    );
    if (!rows[0]) throw new HttpError(404, 'card_not_found');
    return { provider: this.provider(rows[0].provider), token: this.cipher.decrypt(rows[0].token_enc) };
  }

  /**
   * Charges a saved card for a ride or a fee. The idempotency key makes a retry (or a double tap)
   * reuse the same payment instead of charging twice.
   */
  async chargeSavedCard(opts: {
    type: 'ride' | 'cancel_fee'; rideId: string; userId: string; cardId: string; driverId: string | null;
    amountTiyin: number; description: string; key?: string;
  }): Promise<'succeeded' | 'failed' | 'pending'> {
    const { provider, token } = await this.cardToken(this.db, opts.userId, opts.cardId);
    const key = opts.key ?? `${opts.type}:${opts.rideId}`;
    // One charge attempt per key at a time, across all API instances (e.g. the 60% prepayment and
    // the completion charge racing each other): a second caller waits and then sees the result.
    const lock = await this.db.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      const { rows } = await this.db.query<{ id: string; status: string; provider_ref: string | null }>(
        `INSERT INTO payments (type, amount_tiyin, provider, status, ride_id, payer_user_id, driver_id, card_id, idempotency_key)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
           DO UPDATE SET updated_at = now()
         RETURNING id, status, provider_ref`,
        [opts.type, opts.amountTiyin, provider.name, opts.rideId, opts.userId, opts.driverId, opts.cardId, key],
      );
      const payment = rows[0]!;
      if (payment.status === 'succeeded') return 'succeeded';
      // Already sent to the provider and waiting for its answer: never charge again.
      if (payment.status === 'pending' && payment.provider_ref) return 'pending';
      if (payment.status === 'failed') {
        // A new attempt for the same debt (maybe with another card): reopen it with a fresh reference.
        await this.db.query(
          `UPDATE payments SET status = 'pending', provider_ref = NULL, card_id = $2, amount_tiyin = $3, provider = $4 WHERE id = $1`,
          [payment.id, opts.cardId, opts.amountTiyin, provider.name],
        );
      }
      let result;
      try {
        result = await provider.chargeCard({ paymentId: payment.id, cardToken: token, amountTiyin: opts.amountTiyin, description: opts.description });
      } catch (err) {
        this.log.error({ err, paymentId: payment.id }, 'card charge error');
        result = { status: 'failed' as const, reason: 'provider_error' };
      }
      if (result.status === 'pending') {
        await this.db.query(`UPDATE payments SET provider_ref = $2 WHERE id = $1`, [payment.id, result.providerRef]);
        return 'pending';
      }
      await this.settle({
        paymentId: payment.id,
        providerRef: result.providerRef ?? `failed:${payment.id}:${Date.now()}`,
        amountTiyin: opts.amountTiyin,
        status: result.status,
        reason: result.status === 'failed' ? result.reason : undefined,
      });
      return result.status;
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
      lock.release();
    }
  }

  /**
   * Charges what is still due for a card ride (the whole fare at 60% of the trip, or the rest after a
   * route change) to the ride's card, or to another card the passenger picked. If the passenger
   * already paid more than the final price (the route got shorter), a refund is recorded.
   */
  async chargeRideBalance(rideId: string, cardId?: string): Promise<'succeeded' | 'failed' | 'pending' | 'nothing_due'> {
    const { rows } = await this.db.query<{ passenger_id: string; card_id: string | null; driver_id: string; due: string; paid: string }>(
      `SELECT passenger_id, card_id, driver_id, locked_price_tiyin - paid_tiyin AS due, paid_tiyin AS paid
         FROM rides WHERE id = $1 AND payment_method = 'card'`,
      [rideId],
    );
    const r = rows[0];
    if (!r) return 'nothing_due';
    const due = Number(r.due);
    if (due < 0) {
      // TODO(refunds): send to the provider once refunds are implemented.
      await this.db.query(
        `INSERT INTO payments (type, amount_tiyin, provider, status, ride_id, payer_user_id, idempotency_key)
         SELECT 'refund', $2, coalesce(c.provider, 'manual'), 'pending', $1, $3, 'refund:' || $1
           FROM rides ri LEFT JOIN payment_cards c ON c.id = ri.card_id WHERE ri.id = $1
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [rideId, -due, r.passenger_id],
      );
      await this.db.query(`UPDATE rides SET payment_status = 'paid' WHERE id = $1`, [rideId]);
      return 'nothing_due';
    }
    if (due === 0) return 'nothing_due';
    const card = cardId ?? r.card_id;
    if (!card) return 'failed';
    return this.chargeSavedCard({
      type: 'ride', rideId, userId: r.passenger_id, cardId: card, driverId: r.driver_id, amountTiyin: due,
      description: 'Ride', key: Number(r.paid) > 0 ? `ride_extra:${rideId}` : `ride:${rideId}`,
    });
  }

  /** What the passenger still owes: unpaid card rides (after completion) and cancellation fees. */
  async debts(q: Q, userId: string) {
    const { rows } = await q.query<{ rideId: string; kind: 'ride' | 'cancel_fee'; amountTiyin: number; driverId: string | null }>(
      `SELECT id AS "rideId", 'ride' AS kind, (locked_price_tiyin - paid_tiyin)::int AS "amountTiyin", driver_id AS "driverId"
         FROM rides WHERE passenger_id = $1 AND payment_method = 'card' AND payment_status = 'failed'
          AND status = 'completed' AND locked_price_tiyin > paid_tiyin
       UNION ALL
       SELECT id, 'cancel_fee', cancel_fee_tiyin::int, driver_id
         FROM rides WHERE passenger_id = $1 AND cancel_fee_status = 'pending'`,
      [userId],
    );
    return rows;
  }
}
