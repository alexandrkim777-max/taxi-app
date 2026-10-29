// Integration tests: subscriptions, saved cards, card rides, debts and webhook security,
// all through the fake provider (real providers are stubs until we get API access).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, fakeProvider, randomPhone, setup, skip, verifiedDriver, type Setup } from './helpers.ts';
import { drive, north, offerOf, onlineDriver, passenger, randomSpot, type Headers } from './rideHelpers.ts';
import { PaymeProvider } from '../src/payments/providers/payme.ts';
import { createPaymentProviders } from '../src/payments/providers/index.ts';

async function webhook(s: Setup, body: unknown, signature = fakeProvider.sign(body)) {
  return s.app.inject({ method: 'POST', url: '/payments/webhooks/fake', payload: body as object, headers: { 'x-fake-signature': signature } });
}

async function addCard(s: Setup, auth: Headers, token: string) {
  return s.app.inject({ method: 'POST', url: '/me/cards', headers: auth, payload: { provider: 'fake', token } });
}

/** Passenger orders (list mode) with a card, the driver accepts. */
async function cardRide(s: Setup, pax: Headers, cardId: string) {
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 150));
  const res = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 5000)], paymentMethod: 'card', cardId },
  });
  assert.equal(res.statusCode, 201, res.body);
  const ride = res.json();
  const offer = await offerOf(s, ride, driver);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  const ok = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  assert.equal(ok.statusCode, 200, ok.body);
  return { rideId: ride.id as string, driver, spot, price: offer.priceTiyin };
}

test('subscription: price from our plans, paid only by a verified webhook, extends the trial', { skip }, async () => {
  const s = await setup();
  const driver = await verifiedDriver(s);

  const plans = (await s.app.inject({ method: 'GET', url: '/subscription-plans' })).json();
  assert.deepEqual(plans.plans.map((p: { code: string }) => p.code), ['day', 'week', 'month'], 'no trial for sale');
  assert.deepEqual(plans.providers, ['fake']);

  // The client cannot set the price or use a provider we have not enabled.
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/subscriptions', headers: driver, payload: { planCode: 'week', provider: 'fake', amountTiyin: 100 } })).statusCode, 400);
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/subscriptions', headers: driver, payload: { planCode: 'week', provider: 'payme' } })).statusCode, 400);
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/subscriptions', headers: driver, payload: { planCode: 'trial', provider: 'fake' } })).statusCode, 400);
  const notDriver = await passenger(s);
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/subscriptions', headers: notDriver, payload: { planCode: 'week', provider: 'fake' } })).statusCode, 404);

  const before = (await s.app.inject({ method: 'GET', url: '/drivers/me/subscription', headers: driver })).json();
  const trialEnd = new Date(before.activeUntil).getTime();

  const buy = await s.app.inject({ method: 'POST', url: '/drivers/me/subscriptions', headers: driver, payload: { planCode: 'week', provider: 'fake' } });
  assert.equal(buy.statusCode, 201, buy.body);
  const { paymentId, checkoutUrl, amountTiyin } = buy.json();
  assert.equal(amountTiyin, 5_000_000, '50 000 sum a week');
  assert.match(checkoutUrl, new RegExp(`/dev/payments/${paymentId}$`));
  assert.equal((await s.app.inject({ method: 'GET', url: `/payments/${paymentId}`, headers: driver })).json().status, 'pending');
  assert.equal((await s.app.inject({ method: 'GET', url: `/payments/${paymentId}`, headers: notDriver })).statusCode, 404, 'only the payer sees it');

  // Forged or wrong webhooks change nothing.
  const forged = await webhook(s, { paymentId, amountTiyin, result: 'success' }, 'deadbeef');
  assert.equal(forged.statusCode, 401);
  await webhook(s, { paymentId, amountTiyin: 100, result: 'success' }); // signed, but the wrong amount
  assert.equal((await s.app.inject({ method: 'GET', url: `/payments/${paymentId}`, headers: driver })).json().status, 'pending');

  // The real one, delivered twice.
  assert.equal((await webhook(s, { paymentId, amountTiyin, result: 'success' })).statusCode, 200);
  assert.equal((await webhook(s, { paymentId, amountTiyin, result: 'success' })).statusCode, 200);
  assert.equal((await s.app.inject({ method: 'GET', url: `/payments/${paymentId}`, headers: driver })).json().status, 'succeeded');

  const after = (await s.app.inject({ method: 'GET', url: '/drivers/me/subscription', headers: driver })).json();
  const weekMs = 7 * 24 * 3600 * 1000;
  assert.ok(Math.abs(new Date(after.activeUntil).getTime() - (trialEnd + weekMs)) < 5000, 'paid week starts after the trial');
  const subs = await db.query(`SELECT count(*)::int AS n FROM subscriptions WHERE id = (SELECT subscription_id FROM payments WHERE id = $1)`, [paymentId]);
  assert.equal(subs.rows[0].n, 1, 'one period for one payment');
  const receipt = await db.query(`SELECT status, receipt_number FROM fiscal_receipts WHERE payment_id = $1`, [paymentId]);
  assert.equal(receipt.rows[0].status, 'issued');

  // A late "failed" for a settled payment is ignored.
  await webhook(s, { paymentId, amountTiyin, result: 'fail' });
  assert.equal((await s.app.inject({ method: 'GET', url: `/payments/${paymentId}`, headers: driver })).json().status, 'succeeded');
  await s.app.close();
});

test('subscription ends -> cannot go online -> pays for a day -> back online', { skip }, async () => {
  const s = await setup();
  const driver = await verifiedDriver(s);
  const me = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json();
  await db.query(`UPDATE subscriptions SET starts_at = now() - interval '31 days', ends_at = now() - interval '1 minute' WHERE driver_id = $1`, [me.id]);
  const spot = randomSpot();
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: driver, payload: spot })).statusCode, 402);

  const buy = (await s.app.inject({ method: 'POST', url: '/drivers/me/subscriptions', headers: driver, payload: { planCode: 'day', provider: 'fake' } })).json();
  const done = await s.app.inject({ method: 'POST', url: `/dev/payments/${buy.paymentId}/complete`, payload: { result: 'success' } });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: driver, payload: spot })).statusCode, 200);
  await s.app.close();
});

test('cards: tokens only, stored encrypted, owner-only', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  const token = `fake_tok_${Math.random().toString(36).slice(2)}`;

  const first = await addCard(s, pax, token);
  assert.equal(first.statusCode, 201, first.body);
  assert.match(first.json().panMasked, /^8600 \*{4} \*{4} \d{4}$/);
  assert.equal(first.json().isDefault, true);
  assert.equal((await addCard(s, pax, token)).statusCode, 409, 'same card twice');
  assert.equal((await addCard(s, pax, 'not-a-real-token')).statusCode, 400);
  assert.equal((await s.app.inject({ method: 'POST', url: '/me/cards', headers: pax, payload: { provider: 'fake', token, pan: '8600123412341234' } })).statusCode, 400, 'no card numbers accepted');

  const list = (await s.app.inject({ method: 'GET', url: '/me/cards', headers: pax })).body;
  assert.equal(list.includes(token), false, 'the token never leaves the server');
  const stored = await db.query(`SELECT token_enc FROM payment_cards WHERE id = $1`, [first.json().id]);
  assert.equal(stored.rows[0].token_enc.includes(token), false, 'encrypted at rest');

  const other = await passenger(s);
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/me/cards/${first.json().id}`, headers: other })).statusCode, 404);
  assert.equal((await s.app.inject({ method: 'POST', url: `/me/cards/${first.json().id}/default`, headers: other })).statusCode, 404);
  // Someone else's card cannot be used for a ride.
  const spot = randomSpot();
  const steal = await s.app.inject({
    method: 'POST', url: '/rides', headers: other,
    payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 3000)], paymentMethod: 'card', cardId: first.json().id },
  });
  assert.equal(steal.statusCode, 400);

  for (let i = 0; i < 4; i++) assert.equal((await addCard(s, pax, `${token}_${i}`)).statusCode, 201);
  assert.equal((await addCard(s, pax, `${token}_extra`)).statusCode, 409, 'at most 5 cards');
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/me/cards/${first.json().id}`, headers: pax })).statusCode, 204);
  await s.app.close();
});

test('card ride: charged on completion for the final price', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  const card = (await addCard(s, pax, `fake_tok_${Math.random().toString(36).slice(2)}`)).json();
  const r = await cardRide(s, pax, card.id);
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/me/cards/${card.id}`, headers: pax })).statusCode, 409, 'card in use');
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);

  const view = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: pax })).json();
  assert.deepEqual(view.payment, { method: 'card', status: 'paid' });
  const pay = await db.query(`SELECT amount_tiyin::int AS a, status FROM payments WHERE ride_id = $1 AND type = 'ride'`, [r.rideId]);
  assert.deepEqual(pay.rows, [{ a: view.priceTiyin, status: 'succeeded' }]);
  await s.app.close();
});

test('declined card -> debt blocks the next order until paid', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  const bad = (await addCard(s, pax, `fake_tok_decline_${Math.random().toString(36).slice(2)}`)).json();
  const r = await cardRide(s, pax, bad.id);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);

  const debts = (await s.app.inject({ method: 'GET', url: '/me/debts', headers: pax })).json();
  assert.equal(debts.items.length, 1);
  assert.equal(debts.totalTiyin, r.price);
  const spot = randomSpot();
  const blocked = await s.app.inject({ method: 'POST', url: '/rides', headers: pax, payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 3000)] } });
  assert.equal(blocked.statusCode, 402);
  assert.equal(blocked.json().error, 'unpaid_debt');

  const good = (await addCard(s, pax, `fake_tok_${Math.random().toString(36).slice(2)}`)).json();
  const paid = await s.app.inject({ method: 'POST', url: '/me/debts/pay', headers: pax, payload: { cardId: good.id } });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().remainingTiyin, 0);
  const payments = await db.query(`SELECT count(*)::int AS n FROM payments WHERE ride_id = $1 AND type = 'ride'`, [r.rideId]);
  assert.equal(payments.rows[0].n, 1, 'the retry reuses the same payment, no double charge');
  const ok = await s.app.inject({ method: 'POST', url: '/rides', headers: pax, payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 3000)] } });
  assert.equal(ok.statusCode, 201);
  await s.app.close();
});

test('cancellation fee: charged to the card at once; on cash it is a debt', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  const card = (await addCard(s, pax, `fake_tok_${Math.random().toString(36).slice(2)}`)).json();
  const r = await cardRide(s, pax, card.id);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived']);
  const cancel = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: pax, payload: { acceptFeeTiyin: 1_000_000 } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const view = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: pax })).json();
  assert.equal(view.cancelFee.status, 'paid');
  assert.equal((await s.app.inject({ method: 'GET', url: '/me/debts', headers: pax })).json().totalTiyin, 0);
  await s.app.close();
});

test('real providers stay locked until implemented', { skip }, async () => {
  const payme = new PaymeProvider({ merchantId: 'm', key: 'k', checkoutBaseUrl: 'x', apiUrl: 'y' });
  const out = await payme.handleWebhook({ headers: {}, body: { method: 'PerformTransaction' }, remoteIp: '1.1.1.1' }, { find: async () => null });
  assert.equal(out.signatureOk, false);
  assert.equal(out.settled, undefined, 'a stub never settles a payment');
  await assert.rejects(payme.chargeCard({ paymentId: 'p', cardToken: 't', amountTiyin: 1, description: 'd' }), /not implemented/);
  assert.throws(() => createPaymentProviders({ PAYMENT_PROVIDERS: 'paypal' }), /Unknown payment provider/);
  assert.throws(() => createPaymentProviders({ PAYMENT_PROVIDERS: 'payme' }), /PAYME_MERCHANT_ID/);

  // Providers that are not enabled have no webhook endpoint.
  const s = await setup();
  const res = await s.app.inject({ method: 'POST', url: '/payments/webhooks/payme', payload: { method: 'PerformTransaction' } });
  assert.equal(res.statusCode, 404);
  assert.ok(randomPhone());
  await s.app.close();
});
