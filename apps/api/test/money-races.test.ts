// Money under concurrency: the 60% prepayment, the completion charge, the crash-recovery pass and a
// second API instance all reaching for the same ride at once must reach the bank exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, fakeProvider, setup, skip, type Setup } from './helpers.ts';
import { drive, north, offerOf, onlineDriver, passenger, randomSpot, type Headers } from './rideHelpers.ts';
import { PaymentService } from '../src/payments/service.ts';
import { FakeFiscalProvider } from '../src/payments/fiscal.ts';
import { DEV_TOKEN_KEY } from '../src/payments/crypto.ts';
import { prepayTick, reconcileTick } from '../src/payments/prepay.ts';
import type { ChargeRequest, ChargeResult, PaymentProvider } from '../src/payments/types.ts';

/** The fake bank, slowed down so racing callers really overlap, counting every charge it receives. */
class CountingBank {
  readonly calls: ChargeRequest[] = [];
  /** Charges for one ride (the prepayment loop also picks up card rides other tests left mid-trip). */
  async callsFor(rideId: string): Promise<number> {
    const ids = new Set((await db.query(`SELECT id FROM payments WHERE ride_id = $1`, [rideId])).rows.map((r) => r.id));
    return this.calls.filter((c) => ids.has(c.paymentId)).length;
  }
  provider(): PaymentProvider {
    const bank = this;
    return Object.assign(Object.create(fakeProvider), {
      async chargeCard(req: ChargeRequest): Promise<ChargeResult> {
        bank.calls.push(req);
        await new Promise((r) => setTimeout(r, 60));
        return fakeProvider.chargeCard(req);
      },
    }) as PaymentProvider;
  }
}

/** Two API instances sharing the database and the bank. */
function instances(bank: CountingBank): [PaymentService, PaymentService] {
  const make = () => new PaymentService({
    db, providers: new Map([['fake', bank.provider()]]), tokenKey: DEV_TOKEN_KEY, fiscal: new FakeFiscalProvider(),
    log: { warn() {}, error() {} },
  });
  return [make(), make()];
}

async function cardRideInTrip(s: Setup): Promise<{ rideId: string; pax: Headers; price: number }> {
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
  await drive(s, driver, ride.id, ['driver_en_route', 'arrived', 'in_progress']);
  return { rideId: ride.id, pax, price: offer.priceTiyin };
}

async function ridePayments(rideId: string) {
  return (await db.query(
    `SELECT amount_tiyin::int AS amount, status FROM payments WHERE ride_id = $1 AND type = 'ride' ORDER BY created_at`, [rideId],
  )).rows as { amount: number; status: string }[];
}

test('eight callers on two instances charge one ride at once: the bank is asked once', { skip }, async () => {
  const s = await setup();
  const r = await cardRideInTrip(s);
  // Past 60% of the trip, and completed long enough ago for the recovery pass to look at it too.
  await db.query(`UPDATE rides SET trip_distance_m = route_distance_m WHERE id = $1`, [r.rideId]);
  const bank = new CountingBank();
  const [a, b] = instances(bank);

  const results = await Promise.allSettled([
    prepayTick(db, a), prepayTick(db, b),
    a.chargeRideBalance(r.rideId), b.chargeRideBalance(r.rideId),
    a.chargeRideBalance(r.rideId), b.chargeRideBalance(r.rideId),
    a.chargeRideBalance(r.rideId), b.chargeRideBalance(r.rideId),
  ]);
  assert.deepEqual(results.filter((x) => x.status === 'rejected'), [], 'no caller fails');
  assert.equal(await bank.callsFor(r.rideId), 1, 'one charge reached the bank');
  assert.deepEqual(await ridePayments(r.rideId), [{ amount: r.price, status: 'succeeded' }]);
  const ride = (await db.query(`SELECT paid_tiyin::int AS paid, payment_status FROM rides WHERE id = $1`, [r.rideId])).rows[0];
  assert.deepEqual(ride, { paid: r.price, payment_status: 'paid' });

  // Completed afterwards and swept by the recovery pass on both instances: still nothing more.
  await db.query(`UPDATE rides SET status = 'completed' WHERE id = $1`, [r.rideId]);
  await db.query(`INSERT INTO ride_events (ride_id, type, actor, at) VALUES ($1, 'status:completed', 'driver', now() - interval '10 minutes')`, [r.rideId]);
  await Promise.all([reconcileTick(db, a), reconcileTick(db, b), a.chargeRideBalance(r.rideId)]);
  assert.equal(await bank.callsFor(r.rideId), 1);
  await s.app.close();
});

test('two price rises after the prepayment are each charged once, never swallowed', { skip }, async () => {
  const s = await setup();
  const r = await cardRideInTrip(s);
  const bank = new CountingBank();
  const [a, b] = instances(bank);
  await Promise.all([a.chargeRideBalance(r.rideId), b.chargeRideBalance(r.rideId)]);

  // A stop added during the trip, then waiting time: the price goes up twice.
  for (const extra of [300_000, 200_000]) {
    await db.query(`UPDATE rides SET locked_price_tiyin = locked_price_tiyin + $2 WHERE id = $1`, [r.rideId, extra]);
    await Promise.all([a.chargeRideBalance(r.rideId), b.chargeRideBalance(r.rideId), a.chargeRideBalance(r.rideId)]);
  }
  assert.equal(await bank.callsFor(r.rideId), 3, 'fare, first rise, second rise');
  assert.deepEqual((await ridePayments(r.rideId)).map((p) => p.amount), [r.price, 300_000, 200_000]);
  const ride = (await db.query(`SELECT paid_tiyin::int AS paid, locked_price_tiyin::int AS price FROM rides WHERE id = $1`, [r.rideId])).rows[0];
  assert.equal(ride.paid, ride.price);
  await s.app.close();
});

test('paying off debts twice at once (double tap, two phones): charged once', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  const bad = (await s.app.inject({
    method: 'POST', url: '/me/cards', headers: pax, payload: { provider: 'fake', token: `fake_tok_decline_${Math.random().toString(36).slice(2)}` },
  })).json();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 150));
  const ride = (await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 5000)], paymentMethod: 'card', cardId: bad.id },
  })).json();
  const offer = await offerOf(s, ride, driver);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  await drive(s, driver, ride.id, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  assert.equal((await s.app.inject({ method: 'GET', url: '/me/debts', headers: pax })).json().items.length, 1);

  const good = (await s.app.inject({
    method: 'POST', url: '/me/cards', headers: pax, payload: { provider: 'fake', token: `fake_tok_${Math.random().toString(36).slice(2)}` },
  })).json();
  const pay = () => s.app.inject({ method: 'POST', url: '/me/debts/pay', headers: pax, payload: { cardId: good.id } });
  const answers = await Promise.all([pay(), pay(), pay()]);
  for (const res of answers) assert.ok(res.statusCode < 500, res.body);
  const succeeded = (await ridePayments(ride.id)).filter((p) => p.status === 'succeeded');
  assert.equal(succeeded.length, 1, 'one successful charge for the debt');
  assert.equal((await s.app.inject({ method: 'GET', url: '/me/debts', headers: pax })).json().items.length, 0);
  await s.app.close();
});
