// What happens when things break: a driver loses GPS or signal, the API restarts in the middle
// of a ride, the process dies between completing a card ride and charging it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, payments, setup, skip, type Setup } from './helpers.ts';
import { acceptedRide, clearMap, drive, north, offerOf, onlineDriver, passenger, randomSpot, type Headers } from './rideHelpers.ts';
import { dispatchTick } from '../src/dispatch/matching.ts';
import { PRESENCE_SWEEP_MIN, sweepStalePresence } from '../src/dispatch/presence.ts';
import { reconcileTick, RECONCILE_AFTER_SEC } from '../src/payments/prepay.ts';

async function driverId(s: Setup, driver: Headers): Promise<string> {
  return (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json().id;
}

async function silence(id: string, seconds: number): Promise<void> {
  await db.query(`UPDATE driver_presence SET updated_at = now() - make_interval(secs => $2) WHERE driver_id = $1`, [id, seconds]);
}

test('a driver silent for over 60 s gets no orders; a fresh ping brings them back', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 300));
  const id = await driverId(s, driver);
  await silence(id, 61);

  const pax = await passenger(s);
  const quiet = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 6000)] },
  });
  assert.equal(quiet.statusCode, 201, quiet.body);
  assert.ok(!(await db.query(`SELECT 1 FROM ride_offers WHERE ride_id = $1 AND driver_id = $2`, [quiet.json().id, id])).rows[0],
    'a silent driver is not offered');
  await s.app.inject({ method: 'POST', url: `/rides/${quiet.json().id}/cancel`, headers: pax, payload: {} });

  // Parked, but the app's heartbeat still gets through: visible again.
  const ping = await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: driver, payload: north(spot, 300) });
  assert.equal(ping.statusCode, 204, ping.body);
  const again = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 6000)] },
  });
  await offerOf(s, again.json(), driver);
  await s.app.inject({ method: 'POST', url: `/rides/${again.json().id}/cancel`, headers: pax, payload: {} });
  await s.app.close();
});

test('the driver who was chosen goes silent: the order moves on to the next driver', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  const near = await onlineDriver(s, north(spot, 200));
  const far = await onlineDriver(s, north(spot, 900));
  const nearId = await driverId(s, near);
  const farId = await driverId(s, far);
  const pax = await passenger(s);
  const res = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', priority: 'fast', maxPriceTiyin: 2_500_000, stops: [spot, north(spot, 6000)] },
  });
  assert.equal(res.statusCode, 201, res.body);
  const rideId = res.json().id;
  const chosen = async () => (await db.query(
    `SELECT driver_id FROM ride_offers WHERE ride_id = $1 AND status = 'chosen' AND expires_at > now()`, [rideId])).rows[0]?.driver_id;
  assert.equal(await chosen(), nearId, 'the nearest driver is asked first');

  // The near driver's phone loses signal and the 15 s window passes.
  await silence(nearId, 61);
  await db.query(`UPDATE ride_offers SET expires_at = now() - interval '1 second' WHERE ride_id = $1 AND status = 'chosen'`, [rideId]);
  // Accepting with a stale position is refused even if the request still gets through.
  const late = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/accept`, headers: near });
  assert.notEqual(late.statusCode, 200);
  await dispatchTick(db);
  assert.equal(await chosen(), farId, 'the next driver is asked');
  await s.app.inject({ method: 'POST', url: `/rides/${rideId}/cancel`, headers: pax, payload: {} });
  await s.app.close();
});

test('the sweep takes long-silent free drivers off the line, never a driver on a ride', { skip }, async () => {
  const s = await setup();
  const free = await onlineDriver(s, randomSpot());
  const freeId = await driverId(s, free);
  const r = await acceptedRide(s);
  const busyId = await driverId(s, r.driver);
  await silence(freeId, PRESENCE_SWEEP_MIN * 60 + 5);
  await silence(busyId, PRESENCE_SWEEP_MIN * 60 + 5);

  await sweepStalePresence(db);
  const left = (await db.query(`SELECT driver_id FROM driver_presence WHERE driver_id = ANY($1)`, [[freeId, busyId]])).rows.map((x) => x.driver_id);
  assert.deepEqual(left, [busyId]);

  // The free driver's app pings again: told it is off the line, and it can come straight back.
  const ping = await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: free, payload: randomSpot() });
  assert.equal(ping.statusCode, 409);
  assert.equal(ping.json().error, 'not_online');
  const back = await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: free, payload: randomSpot() });
  assert.equal(back.statusCode, 200, back.body);
  // The busy driver carries on with the ride.
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  await s.app.close();
});

test('API restart in the middle of a ride: sessions, the ride and the search carry on', { skip }, async () => {
  const first = await setup();
  const r = await acceptedRide(first);
  await drive(first, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress']);

  await clearMap();
  const spot = randomSpot();
  const waiting = await onlineDriver(first, north(spot, 300));
  const pax2 = await passenger(first);
  const searching = await first.app.inject({
    method: 'POST', url: '/rides', headers: pax2,
    payload: { classCode: 'economy', priority: 'fast', maxPriceTiyin: 2_500_000, stops: [spot, north(spot, 6000)] },
  });
  assert.equal(searching.statusCode, 201, searching.body);
  await first.app.close(); // the old process is gone

  const second = await setup();
  // Same tokens work: sessions live in the database, not in memory.
  await drive(second, r.driver, r.rideId, ['completed']);
  const seen = (await second.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: r.pax })).json();
  assert.equal(seen.status, 'completed');

  // The search started before the restart is picked up by the new process's dispatcher.
  await dispatchTick(db);
  const accept = await second.app.inject({ method: 'POST', url: `/rides/${searching.json().id}/accept`, headers: waiting });
  assert.equal(accept.statusCode, 200, accept.body);
  await second.app.inject({ method: 'POST', url: `/rides/${searching.json().id}/cancel`, headers: pax2, payload: {} });
  await second.app.close();
});

test('crash between completing a card ride and charging it: charged later, exactly once', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  const card = (await s.app.inject({
    method: 'POST', url: '/me/cards', headers: pax, payload: { provider: 'fake', token: `fake_tok_${Math.random().toString(36).slice(2)}` },
  })).json();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 150));
  const created = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 5000)], paymentMethod: 'card', cardId: card.id },
  });
  const ride = created.json();
  const offer = await offerOf(s, ride, driver);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  await drive(s, driver, ride.id, ['driver_en_route', 'arrived', 'in_progress']);

  // The process saved 'completed' and died before calling the provider.
  await db.query(`UPDATE rides SET status = 'completed' WHERE id = $1`, [ride.id]);
  await db.query(
    `INSERT INTO ride_events (ride_id, type, actor, at) VALUES ($1, 'status:completed', 'driver', now() - make_interval(secs => $2))`,
    [ride.id, RECONCILE_AFTER_SEC + 10],
  );
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payments WHERE ride_id = $1`, [ride.id])).rows[0].n, 0);

  await reconcileTick(db, payments());
  await reconcileTick(db, payments()); // a second pass (or a second instance) must not charge again
  const pay = await db.query(`SELECT amount_tiyin::int AS a, status FROM payments WHERE ride_id = $1 AND type = 'ride'`, [ride.id]);
  const view = (await s.app.inject({ method: 'GET', url: `/rides/${ride.id}`, headers: pax })).json();
  assert.deepEqual(pay.rows, [{ a: view.priceTiyin, status: 'succeeded' }]);
  assert.equal(view.payment.status, 'paid');
  await s.app.close();
});
