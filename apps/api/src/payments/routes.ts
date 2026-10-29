// Payment endpoints: driver subscriptions, saved cards, debts, provider webhooks.

import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/session.ts';
import { uuidParams } from '../lib/geo.ts';
import { langOf, pick } from '../lib/i18n.ts';
import { HttpError, isUniqueViolation } from '../lib/tx.ts';
import { tokenHash } from './crypto.ts';
import type { PaymentService } from './service.ts';
import { FakeProvider } from './providers/fake.ts';
import { PROVIDER_NAMES, type ProviderName } from './types.ts';

interface Deps {
  payments: PaymentService;
  cityCode: string;
  /** Deep link the provider's page returns to. */
  returnUrl: string;
  /** Per provider: if set, webhooks are accepted only from these IPs (providers publish theirs). */
  webhookIps: Partial<Record<ProviderName, string[]>>;
  /** Development-only helper pages for the fake provider. */
  devRoutes: boolean;
}

const MAX_CARDS = 5;

export async function paymentRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { payments, cityCode } = deps;
  const db = payments.db;

  async function driverIdOf(userId: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM drivers WHERE user_id = $1 AND status = 'verified' AND deleted_at IS NULL`,
      [userId],
    );
    if (!rows[0]) throw new HttpError(404, 'not_a_verified_driver');
    return rows[0].id;
  }

  // --- Driver subscriptions --------------------------------------------------------------

  app.get('/subscription-plans', async (request) => {
    const lang = langOf(request);
    const { rows } = await db.query(
      `SELECT sp.code, sp.name, sp.price_tiyin::int AS "priceTiyin", sp.period_days AS "periodDays"
         FROM subscription_plans sp JOIN cities c ON c.id = sp.city_id
        WHERE c.code = $1 AND sp.is_active AND sp.code <> 'trial'
        ORDER BY sp.period_days`,
      [cityCode],
    );
    return { plans: rows.map((p) => ({ ...p, name: pick(p.name, lang) })), providers: [...payments.providers.keys()] };
  });

  app.get('/drivers/me/subscription', { preHandler: requireUser }, async (request) => {
    const driverId = await driverIdOf(request.user!.id);
    const { rows } = await db.query(
      `SELECT sp.code AS "planCode", s.price_paid_tiyin::int AS "pricePaidTiyin", s.starts_at AS "startsAt",
              s.ends_at AS "endsAt", s.status, (s.starts_at <= now() AND s.ends_at > now()) AS current
         FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id
        WHERE s.driver_id = $1 AND s.status = 'active'
        ORDER BY s.ends_at DESC LIMIT 20`,
      [driverId],
    );
    const activeUntil = rows.filter((r) => new Date(r.endsAt) > new Date()).map((r) => r.endsAt)[0] ?? null;
    return { active: activeUntil !== null, activeUntil, periods: rows };
  });

  app.post<{ Body: { planCode: string; provider: string } }>(
    '/drivers/me/subscriptions',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object', required: ['planCode', 'provider'], additionalProperties: false,
          properties: {
            planCode: { type: 'string', pattern: '^[a-z_]{2,32}$' },
            provider: { type: 'string', enum: [...PROVIDER_NAMES] },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const driverId = await driverIdOf(userId);
      const provider = payments.provider(request.body.provider);
      // The price always comes from our plan table, never from the client.
      const { rows: plans } = await db.query<{ id: string; price_tiyin: string; period_days: number }>(
        `SELECT sp.id, sp.price_tiyin, sp.period_days FROM subscription_plans sp JOIN cities c ON c.id = sp.city_id
          WHERE c.code = $1 AND sp.code = $2 AND sp.is_active AND sp.code <> 'trial' AND sp.price_tiyin > 0`,
        [cityCode, request.body.planCode],
      );
      const plan = plans[0];
      if (!plan) return reply.code(400).send({ error: 'unknown_plan' });

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO payments (type, amount_tiyin, provider, status, payer_user_id, driver_id, plan_id)
         VALUES ('subscription', $1, $2, 'pending', $3, $4, $5) RETURNING id`,
        [plan.price_tiyin, provider.name, userId, driverId, plan.id],
      );
      const paymentId = rows[0]!.id;
      const checkout = await provider.createCheckout({
        paymentId, amountTiyin: Number(plan.price_tiyin),
        description: `Subscription ${request.body.planCode}, ${plan.period_days} days`,
        returnUrl: `${deps.returnUrl}?payment=${paymentId}`,
      });
      await db.query(`UPDATE payments SET checkout_url = $2 WHERE id = $1`, [paymentId, checkout.checkoutUrl]);
      return reply.code(201).send({ paymentId, checkoutUrl: checkout.checkoutUrl, amountTiyin: Number(plan.price_tiyin) });
    },
  );

  // Status of one's own payment (the app polls it after returning from the provider's page).
  app.get<{ Params: { id: string } }>(
    '/payments/:id',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request) => {
      const { rows } = await db.query(
        `SELECT id, type, status, amount_tiyin::int AS "amountTiyin", provider, failure_reason AS "failureReason",
                paid_at AS "paidAt", created_at AS "createdAt"
           FROM payments WHERE id = $1 AND payer_user_id = $2`,
        [request.params.id, request.user!.id],
      );
      if (!rows[0]) throw new HttpError(404, 'not_found');
      return rows[0];
    },
  );

  // --- Saved cards -------------------------------------------------------------------------

  app.get('/me/cards', { preHandler: requireUser }, async (request) => {
    const { rows } = await db.query(
      `SELECT id, provider, pan_masked AS "panMasked", expiry, is_default AS "isDefault", created_at AS "createdAt"
         FROM payment_cards WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [request.user!.id],
    );
    return rows;
  });

  // The app tokenises the card with the provider's SDK (number and SMS code go to the provider,
  // never to us) and sends only the token.
  app.post<{ Body: { provider: string; token: string } }>(
    '/me/cards',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object', required: ['provider', 'token'], additionalProperties: false,
          properties: {
            provider: { type: 'string', enum: [...PROVIDER_NAMES] },
            token: { type: 'string', minLength: 8, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const provider = payments.provider(request.body.provider);
      const count = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment_cards WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      if (count.rows[0]!.n >= MAX_CARDS) return reply.code(409).send({ error: 'too_many_cards' });
      let info;
      try {
        info = await provider.verifyCardToken(request.body.token);
      } catch (err) {
        request.log.warn({ err }, 'card token rejected');
        return reply.code(400).send({ error: 'invalid_card_token' });
      }
      try {
        const { rows } = await db.query(
          `INSERT INTO payment_cards (user_id, provider, token_enc, token_hash, pan_masked, expiry, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, provider, pan_masked AS "panMasked", expiry, is_default AS "isDefault"`,
          [
            userId, provider.name, payments.cipher.encrypt(request.body.token), tokenHash(request.body.token),
            info.panMasked, info.expiry, count.rows[0]!.n === 0,
          ],
        );
        return reply.code(201).send(rows[0]);
      } catch (err) {
        if (isUniqueViolation(err, 'payment_cards_token')) return reply.code(409).send({ error: 'card_already_added' });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/me/cards/:id/default',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request, reply) => {
      const userId = request.user!.id;
      const { rows } = await db.query(`SELECT 1 FROM payment_cards WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [request.params.id, userId]);
      if (!rows[0]) throw new HttpError(404, 'card_not_found');
      await db.query(`UPDATE payment_cards SET is_default = false WHERE user_id = $1 AND is_default`, [userId]);
      await db.query(`UPDATE payment_cards SET is_default = true WHERE id = $1`, [request.params.id]);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/me/cards/:id',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request, reply) => {
      const userId = request.user!.id;
      // A card that an active ride will be charged to cannot be removed mid-ride.
      const busy = await db.query(
        `SELECT 1 FROM rides WHERE card_id = $1 AND status IN ('created', 'accepted', 'driver_en_route', 'arrived', 'in_progress')`,
        [request.params.id],
      );
      if (busy.rows[0]) return reply.code(409).send({ error: 'card_in_use' });
      const { rows } = await db.query<{ provider: string; token_enc: string }>(
        `UPDATE payment_cards SET deleted_at = now(), is_default = false
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING provider, token_enc`,
        [request.params.id, userId],
      );
      if (!rows[0]) throw new HttpError(404, 'card_not_found');
      try {
        await payments.provider(rows[0].provider).removeCard(payments.cipher.decrypt(rows[0].token_enc));
      } catch (err) {
        request.log.warn({ err }, 'provider card removal failed; card is removed on our side');
      }
      return reply.code(204).send();
    },
  );

  // --- Debts -------------------------------------------------------------------------------

  app.get('/me/debts', { preHandler: requireUser }, async (request) => {
    const debts = await payments.debts(db, request.user!.id);
    return { totalTiyin: debts.reduce((a, d) => a + d.amountTiyin, 0), items: debts };
  });

  app.post<{ Body: { cardId: string } }>(
    '/me/debts/pay',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object', required: ['cardId'], additionalProperties: false,
          properties: { cardId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } },
        },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const debts = await payments.debts(db, userId);
      const results = [];
      // The card must be the payer's own (checked inside cardToken).
      await payments.cardToken(db, userId, request.body.cardId);
      for (const d of debts) {
        const status = d.kind === 'ride'
          ? await payments.chargeRideBalance(d.rideId, request.body.cardId)
          : await payments.chargeSavedCard({
            type: 'cancel_fee', rideId: d.rideId, userId, cardId: request.body.cardId, driverId: d.driverId,
            amountTiyin: d.amountTiyin, description: 'Cancellation fee',
          });
        results.push({ rideId: d.rideId, kind: d.kind, status });
      }
      const left = await payments.debts(db, userId);
      return { results, remainingTiyin: left.reduce((a, d) => a + d.amountTiyin, 0) };
    },
  );

  // --- Provider webhooks --------------------------------------------------------------------

  app.post<{ Params: { provider: string } }>(
    '/payments/webhooks/:provider',
    {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: {
        params: { type: 'object', properties: { provider: { type: 'string', enum: [...PROVIDER_NAMES] } } },
      },
    },
    async (request, reply) => {
      const name = request.params.provider as ProviderName;
      const provider = payments.providers.get(name);
      if (!provider) return reply.code(404).send({ error: 'not_found' });
      const allowed = deps.webhookIps[name];
      if (allowed && !allowed.includes(request.ip)) {
        request.log.warn({ ip: request.ip, provider: name }, 'webhook from unexpected IP');
        await db.query(`INSERT INTO payment_webhooks (provider, signature_ok, remote_ip) VALUES ($1, false, $2)`, [name, request.ip]);
        return reply.code(403).send({ error: 'forbidden' });
      }
      const outcome = await provider.handleWebhook(
        { headers: request.headers, body: request.body, remoteIp: request.ip },
        payments.lookup(),
      );
      // Unverified bodies are not stored: they may be junk or attacks.
      await db.query(
        `INSERT INTO payment_webhooks (provider, signature_ok, payload, remote_ip) VALUES ($1, $2, $3, $4)`,
        [name, outcome.signatureOk, outcome.signatureOk ? JSON.stringify(request.body) : null, request.ip],
      );
      if (outcome.signatureOk && outcome.settled) {
        const result = await payments.settle(outcome.settled);
        if (result === 'applied') await payments.issueReceipts();
        if (result === 'rejected') request.log.warn({ settled: outcome.settled }, 'webhook settlement rejected');
      }
      return reply.code(outcome.httpStatus).send(outcome.response);
    },
  );

  // --- Development only: a stand-in for the provider's payment page ------------------------

  if (deps.devRoutes) {
    const fake = payments.providers.get('fake');
    if (!(fake instanceof FakeProvider)) return;

    app.get<{ Params: { id: string } }>('/dev/payments/:id', { schema: { params: uuidParams } }, async (request, reply) => {
      const id = request.params.id;
      return reply.type('text/html').send(
        `<!doctype html><meta name="viewport" content="width=device-width"><title>Test payment</title>
         <h3>Test payment ${id}</h3>
         <button onclick="go('success')">Pay</button> <button onclick="go('fail')">Decline</button>
         <pre id="out"></pre>
         <script>
           async function go(result) {
             const r = await fetch('/dev/payments/${id}/complete', {
               method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result }),
             });
             document.getElementById('out').textContent = await r.text();
           }
         </script>`,
      );
    });

    // Simulates the provider's signed webhook for a payment.
    app.post<{ Params: { id: string }; Body: { result?: string } }>(
      '/dev/payments/:id/complete',
      { schema: { params: uuidParams } },
      async (request, reply) => {
        const p = await payments.lookup().find(request.params.id);
        if (!p) throw new HttpError(404, 'not_found');
        const body = { paymentId: p.id, amountTiyin: p.amountTiyin, result: request.body?.result === 'fail' ? 'fail' : 'success' };
        const res = await app.inject({
          method: 'POST', url: '/payments/webhooks/fake', payload: body,
          headers: { 'x-fake-signature': fake.sign(body) },
        });
        return reply.code(res.statusCode).send(res.json());
      },
    );
  }
}
