// Refunds: an admin gives money back from a card payment, through the provider, never more than was
// paid, once per click; automatic refunds when the route got shorter after the 60% charge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, fakeProvider, payments, setup, skip, staffLogin, type Setup } from './helpers.ts';
import { drive, north, offerOf, onlineDriver, passenger, randomSpot, type Headers } from './rideHelpers.ts';
import { PaymentService } from '../src/payments/service.ts';
import { FakeFiscalProvider } from '../src/payments/fiscal.ts';
import { DEV_TOKEN_KEY } from '../src/payments/crypto.ts';
import type { PaymentProvider, RefundRequest, RefundResult } from '../src/payments/types.ts';

async function paidCardRide(s: Setup): Promise<{ rideId: string; pax: Headers; driver: Headers; paymentId: string; price: number }> {
  const pax = await passenger(s);
  const card = (await s.app.inject({
    method: 'POST', url: '/me/cards', headers: pax, payload: { provider: 'fake', token: `fake_tok_${Math.random().toString(36).slice(2)}` },
  })).json();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 150));
  const ride = (await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 5000)], paymentMethod: 'card', cardId: card.id },
  })).json();
  const offer = await offerOf(s, ride, driver);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  await drive(s, driver, ride.id, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  const pay = (await db.query(`SELECT id FROM payments WHERE ride_id = $1 AND type = 'ride' AND status = 'succeeded'`, [ride.id])).rows[0];
  return { rideId: ride.id, pax, driver, paymentId: pay.id, price: offer.priceTiyin };
}

function refund(s: Setup, admin: Headers, paymentId: string, amountTiyin: number, reason = 'Driver took a longer route', key = randomUUID()) {
  return s.app.inject({
    method: 'POST', url: `/admin/payments/${paymentId}/refund`, headers: { ...admin, 'idempotency-key': key },
    payload: { amountTiyin, reason },
  });
}

test('an admin refunds part of a fare: through the provider, logged, shown to the passenger', { skip }, async () => {
  const s = await setup();
  const admin = await staffLogin(s, 'admin');
  const support = await staffLogin(s, 'support');
  const r = await paidCardRide(s);

  assert.equal((await refund(s, support.headers, r.paymentId, 500_000)).statusCode, 403, 'support cannot move money');
  const noKey = await s.app.inject({
    method: 'POST', url: `/admin/payments/${r.paymentId}/refund`, headers: admin.headers, payload: { amountTiyin: 500_000, reason: 'Longer route' },
  });
  assert.equal(noKey.statusCode, 400);

  const res = await refund(s, admin.headers, r.paymentId, 500_000);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'succeeded');
  const row = (await db.query(
    `SELECT amount_tiyin::int AS amount, status, provider_ref, refund_of, refund_kind, approved_by, refund_reason FROM payments WHERE id = $1`,
    [res.json().refundId],
  )).rows[0];
  assert.deepEqual(
    { ...row, provider_ref: !!row.provider_ref },
    { amount: 500_000, status: 'succeeded', provider_ref: true, refund_of: r.paymentId, refund_kind: 'moderator', approved_by: admin.userId, refund_reason: 'Driver took a longer route' },
  );
  // The original payment is untouched; the ride shows what came back; nothing is charged again.
  const orig = (await db.query(`SELECT status, amount_tiyin::int AS amount FROM payments WHERE id = $1`, [r.paymentId])).rows[0];
  assert.deepEqual(orig, { status: 'succeeded', amount: r.price });
  const hist = (await s.app.inject({ method: 'GET', url: '/me/rides', headers: r.pax })).json();
  assert.equal(hist.find((x: { id: string }) => x.id === r.rideId).refundedTiyin, 500_000);
  const log = await db.query(`SELECT action, payload FROM admin_audit_log WHERE target_id = $1 ORDER BY id`, [r.paymentId]);
  assert.deepEqual(log.rows.map((x) => x.action), ['refund_sent']);
  assert.equal(log.rows[0].payload.reason, 'Driver took a longer route');
  const detail = (await s.app.inject({ method: 'GET', url: `/admin/rides/${r.rideId}`, headers: admin.headers })).json();
  assert.equal(detail.payments.find((p: { id: string }) => p.id === r.paymentId).refundable_tiyin, r.price - 500_000);
  await s.app.close();
});

test('never more than was paid: two admins at once, then too much', { skip }, async () => {
  const s = await setup();
  const a = await staffLogin(s, 'admin');
  const b = await staffLogin(s, 'admin');
  const r = await paidCardRide(s);
  const both = await Promise.all([refund(s, a.headers, r.paymentId, r.price), refund(s, b.headers, r.paymentId, r.price)]);
  assert.deepEqual(both.map((x) => x.statusCode).sort(), [200, 409]);
  assert.equal(both.find((x) => x.statusCode === 409)!.json().availableTiyin, 0);
  assert.equal((await refund(s, a.headers, r.paymentId, 100)).statusCode, 409);
  const sent = await db.query(`SELECT sum(amount_tiyin)::int AS n FROM payments WHERE refund_of = $1 AND status = 'succeeded'`, [r.paymentId]);
  assert.equal(sent.rows[0].n, r.price);
  const refused = await db.query(`SELECT count(*)::int AS n FROM admin_audit_log WHERE target_id = $1 AND action = 'refund_refused'`, [r.paymentId]);
  assert.equal(refused.rows[0].n, 2);
  await s.app.close();
});

test('a double click (same key) sends the money once', { skip }, async () => {
  const s = await setup();
  const admin = await staffLogin(s, 'admin');
  const r = await paidCardRide(s);
  const key = randomUUID();
  const clicks = await Promise.all([1, 2, 3].map(() => refund(s, admin.headers, r.paymentId, 300_000, 'Wrong waiting fee', key)));
  for (const c of clicks) assert.equal(c.statusCode, 200, c.body);
  assert.equal(new Set(clicks.map((c) => c.json().refundId)).size, 1);
  const rows = await db.query(`SELECT count(*)::int AS n FROM payments WHERE refund_of = $1`, [r.paymentId]);
  assert.equal(rows.rows[0].n, 1);
  // The same key for a different amount is a mistake, not a new refund.
  assert.equal((await refund(s, admin.headers, r.paymentId, 400_000, 'Wrong waiting fee', key)).statusCode, 409);
  await s.app.close();
});

test('provider down: the refund fails, nothing counts against the payment, a retry goes through', { skip }, async () => {
  const s = await setup();
  const r = await paidCardRide(s);
  let down = true;
  const flaky = Object.assign(Object.create(fakeProvider), {
    async refund(req: RefundRequest): Promise<RefundResult> {
      if (down) throw new Error('connection reset');
      return fakeProvider.refund(req);
    },
  }) as PaymentProvider;
  const service = new PaymentService({
    db, providers: new Map([['fake', flaky]]), tokenKey: DEV_TOKEN_KEY, fiscal: new FakeFiscalProvider(), log: { warn() {}, error() {} },
  });
  const admin = (await db.query(`SELECT id FROM users WHERE roles @> ARRAY['admin'] LIMIT 1`)).rows[0]?.id
    ?? (await staffLogin(s, 'admin')).userId;
  const order = { paymentId: r.paymentId, amountTiyin: r.price, kind: 'moderator' as const, reason: 'Ride never happened', approvedBy: admin, key: `refund:moderator:${randomUUID()}` };
  assert.equal((await service.refund(order)).status, 'failed');
  const failed = (await db.query(`SELECT status, failure_reason FROM payments WHERE refund_of = $1`, [r.paymentId])).rows;
  assert.deepEqual(failed, [{ status: 'failed', failure_reason: 'provider_error' }]);
  down = false;
  const again = await service.refund(order);
  assert.equal(again.status, 'succeeded');
  const rows = await db.query(`SELECT status FROM payments WHERE refund_of = $1`, [r.paymentId]);
  assert.deepEqual(rows.rows, [{ status: 'succeeded' }], 'the same refund row, retried');
  await s.app.close();
});

test('only card money that went through can go back', { skip }, async () => {
  const s = await setup();
  const admin = await staffLogin(s, 'admin');
  const r = await paidCardRide(s);
  const refundId = (await refund(s, admin.headers, r.paymentId, 100_000)).json().refundId;
  assert.equal((await refund(s, admin.headers, refundId, 100)).json().error, 'not_refundable', 'not a refund of a refund');
  assert.equal((await refund(s, admin.headers, randomUUID(), 100)).statusCode, 404);
  await s.app.close();
});

test('a cancellation fee refunded in full is waived', { skip }, async () => {
  const s = await setup();
  const admin = await staffLogin(s, 'admin');
  const pax = await passenger(s);
  const card = (await s.app.inject({
    method: 'POST', url: '/me/cards', headers: pax, payload: { provider: 'fake', token: `fake_tok_${Math.random().toString(36).slice(2)}` },
  })).json();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 150));
  const ride = (await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 5000)], paymentMethod: 'card', cardId: card.id },
  })).json();
  const offer = await offerOf(s, ride, driver);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  await drive(s, driver, ride.id, ['driver_en_route']);
  // Past the free minutes after acceptance: a fee applies.
  await db.query(`UPDATE ride_events SET at = now() - interval '4 minutes' WHERE ride_id = $1 AND type = 'status:accepted'`, [ride.id]);
  const terms = (await s.app.inject({ method: 'GET', url: `/rides/${ride.id}/cancel-terms`, headers: pax })).json();
  const cancel = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/cancel`, headers: pax, payload: { acceptFeeTiyin: terms.feeTiyin } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const fee = (await db.query(`SELECT id, amount_tiyin::int AS amount FROM payments WHERE ride_id = $1 AND type = 'cancel_fee' AND status = 'succeeded'`, [ride.id])).rows[0];
  assert.ok(fee, 'the fee was charged to the card');
  assert.equal((await refund(s, admin.headers, fee.id, fee.amount, 'Driver was not moving')).statusCode, 200);
  const status = (await db.query(`SELECT cancel_fee_status FROM rides WHERE id = $1`, [ride.id])).rows[0].cancel_fee_status;
  assert.equal(status, 'waived');
  await s.app.close();
});

test('route got shorter after the 60% charge: the difference goes back to the card by itself', { skip }, async () => {
  const s = await setup();
  const r = await paidCardRide(s);
  // Simulate: charged the full fare, then the final price came out 400 000 lower.
  await db.query(`UPDATE rides SET locked_price_tiyin = locked_price_tiyin - 400000 WHERE id = $1`, [r.rideId]);
  assert.equal(await payments().chargeRideBalance(r.rideId), 'nothing_due');
  assert.equal(await payments().chargeRideBalance(r.rideId), 'nothing_due', 'again: no second refund');
  const refunds = (await db.query(
    `SELECT amount_tiyin::int AS amount, status, refund_kind, refund_of FROM payments WHERE ride_id = $1 AND type = 'refund'`, [r.rideId],
  )).rows;
  assert.deepEqual(refunds, [{ amount: 400_000, status: 'succeeded', refund_kind: 'overpaid', refund_of: r.paymentId }]);
  const ride = (await db.query(`SELECT paid_tiyin::int AS paid, locked_price_tiyin::int AS price, refunded_tiyin::int AS refunded FROM rides WHERE id = $1`, [r.rideId])).rows[0];
  assert.equal(ride.paid, ride.price, 'paid now equals the final fare');
  assert.equal(ride.refunded, 0, 'a fare correction is not a staff refund');
  await s.app.close();
});
