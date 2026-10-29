// Integration tests: going online, one-tap (auto) and choose-from-list ordering, drivers' own
// prices, accepting, the status machine, cancellations and the access rules around all of it.
// Tests in this file share live driver positions, so they must stay in one file (run in sequence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip, verifiedDriver, type Setup } from './helpers.ts';
import { acceptedRide, clearMap, createRide, drive, north, offerOf, onlineDriver, passenger, randomSpot, type Headers } from './rideHelpers.ts';
import { dispatchTick } from '../src/dispatch/matching.ts';

test('full ride: offer, choice, acceptance with locked price, status flow', { skip }, async () => {
  const s = await setup();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 400));
  const pax = await passenger(s);

  const created = await createRide(s, pax, spot);
  assert.equal(created.statusCode, 201, created.body);
  const ride = created.json();
  assert.equal(ride.status, 'created');
  const offer = await offerOf(s, ride, driver);
  assert.equal(offer.priceTiyin % 50_000, 0, 'rounded to 500 sum');
  assert.equal(offer.lat, undefined, 'exact driver position is hidden before acceptance');
  assert.equal(offer.plate, undefined, 'plate is shown only after acceptance');

  // The driver sees nothing until chosen.
  const before = await s.app.inject({ method: 'GET', url: '/drivers/me/requests', headers: driver });
  assert.equal(before.json().length, 0);

  const chosen = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  assert.equal(chosen.statusCode, 200, chosen.body);

  const requests = (await s.app.inject({ method: 'GET', url: '/drivers/me/requests', headers: driver })).json();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].rideId, ride.id);
  assert.equal(requests[0].priceTiyin, offer.priceTiyin);

  const accepted = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().priceTiyin, offer.priceTiyin, 'price locked from the offer');

  // Driver cheapens their tariff after accepting: the ride price must not move.
  const t = (await s.app.inject({ method: 'GET', url: '/drivers/me/tariff', headers: driver })).json();
  const cheaper = Object.fromEntries(Object.entries(t.bounds).map(([k, b]) => [k, (b as { min: number }).min]));
  const changed = await s.app.inject({ method: 'PUT', url: '/drivers/me/tariff', headers: driver, payload: cheaper });
  assert.equal(changed.statusCode, 200, changed.body);

  const ping = await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: driver, payload: { ...north(spot, 200), heading: 180 } });
  assert.equal(ping.statusCode, 204);

  const view = (await s.app.inject({ method: 'GET', url: `/rides/${ride.id}`, headers: pax })).json();
  assert.equal(view.priceTiyin, offer.priceTiyin);
  assert.equal(view.driver.vehicle.plate, '01A123BC');
  assert.equal(view.driver.location.heading, 180, 'passenger tracks the assigned driver');

  await drive(s, driver, ride.id, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  const done = (await s.app.inject({ method: 'GET', url: `/rides/${ride.id}`, headers: pax })).json();
  assert.equal(done.status, 'completed');
  assert.equal(done.priceTiyin, offer.priceTiyin);
  assert.equal(done.driver.location, null, 'no live location after the ride');

  const events = await db.query(`SELECT type FROM ride_events WHERE ride_id = $1 ORDER BY id`, [ride.id]);
  assert.deepEqual(events.rows.map((e) => e.type), [
    'status:created', 'offer_chosen', 'status:accepted',
    'status:driver_en_route', 'status:arrived', 'status:in_progress', 'status:completed',
  ]);

  // Back on the line after the ride.
  const off = await s.app.inject({ method: 'POST', url: '/drivers/me/offline', headers: driver });
  assert.equal(off.statusCode, 200);
  await s.app.close();
});

test('a cheaper driver is offered at their own lower price', { skip }, async () => {
  const s = await setup();
  const spot = randomSpot();
  const standard = await onlineDriver(s, north(spot, 200));
  const cheap = await onlineDriver(s, north(spot, 300));
  const t = (await s.app.inject({ method: 'GET', url: '/drivers/me/tariff', headers: cheap })).json();
  const floor = Object.fromEntries(Object.entries(t.bounds).map(([k, b]) => [k, (b as { min: number }).min]));
  assert.equal((await s.app.inject({ method: 'PUT', url: '/drivers/me/tariff', headers: cheap, payload: floor })).statusCode, 200);

  const pax = await passenger(s);
  const ride = (await createRide(s, pax, spot)).json();
  const quote = (await s.app.inject({
    method: 'POST', url: '/quotes', headers: pax, payload: { stops: [spot, north(spot, 6000)] },
  })).json().classes.find((c: { code: string }) => c.code === 'economy');

  const prices = ride.offers.map((o: { priceTiyin: number }) => o.priceTiyin);
  for (const p of prices) assert.ok(p >= quote.minFareTiyin && p <= quote.maxFareTiyin, 'inside the corridor');
  const cheapOffer = await offerOf(s, ride, cheap);
  const standardOffer = await offerOf(s, ride, standard);
  assert.ok(cheapOffer.priceTiyin < standardOffer.priceTiyin, 'each driver at their own price');
  assert.equal(standardOffer.priceTiyin, quote.maxFareTiyin, 'recommended tariff = reference price');
  await s.app.close();
});

test('only participants can see or act on a ride', { skip }, async () => {
  const s = await setup();
  const { driver, pax, rideId } = await acceptedRide(s);
  const stranger = await passenger(s);
  const otherDriver = await onlineDriver(s, randomSpot());

  for (const headers of [stranger, otherDriver]) {
    assert.equal((await s.app.inject({ method: 'GET', url: `/rides/${rideId}`, headers })).statusCode, 404);
    assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${rideId}/cancel`, headers, payload: {} })).statusCode, 404);
    assert.equal((await s.app.inject({
      method: 'POST', url: `/rides/${rideId}/status`, headers, payload: { status: 'driver_en_route' },
    })).statusCode, 404);
    assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${rideId}/accept`, headers })).statusCode, 404);
  }
  // The passenger cannot drive the status machine.
  assert.equal((await s.app.inject({
    method: 'POST', url: `/rides/${rideId}/status`, headers: pax, payload: { status: 'completed' },
  })).statusCode, 404);
  // Skipping steps is refused.
  assert.equal((await s.app.inject({
    method: 'POST', url: `/rides/${rideId}/status`, headers: driver, payload: { status: 'completed' },
  })).statusCode, 409);
  // Not logged in.
  assert.equal((await s.app.inject({ method: 'GET', url: `/rides/${rideId}` })).statusCode, 401);
  // Malformed id never reaches the database.
  assert.equal((await s.app.inject({ method: 'GET', url: `/rides/1%20OR%201=1`, headers: pax })).statusCode, 400);
  await s.app.close();
});

test('one active ride per passenger and per driver', { skip }, async () => {
  const s = await setup();
  const { driver, pax, spot } = await acceptedRide(s);
  const again = await createRide(s, pax, spot);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'active_ride_exists');

  // A busy driver is not offered to anyone else and cannot go offline mid-ride.
  const pax2 = await passenger(s);
  const other = (await createRide(s, pax2, spot)).json();
  const busyId = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json().id;
  const busyOffered = await db.query(`SELECT 1 FROM ride_offers WHERE ride_id = $1 AND driver_id = $2`, [other.id, busyId]);
  assert.equal(busyOffered.rows.length, 0, 'a driver on a ride is not offered');
  const offline = await s.app.inject({ method: 'POST', url: '/drivers/me/offline', headers: driver });
  assert.equal(offline.statusCode, 409);
  await s.app.close();
});

test('cancellation rules', { skip }, async () => {
  const s = await setup();
  const { driver, pax, rideId } = await acceptedRide(s);
  await drive(s, driver, rideId, ['driver_en_route', 'arrived', 'in_progress']);
  const late = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/cancel`, headers: pax, payload: {} });
  assert.equal(late.statusCode, 409, 'a ride in progress cannot be cancelled');

  const second = await acceptedRide(s);
  const cancel = await s.app.inject({
    method: 'POST', url: `/rides/${second.rideId}/cancel`, headers: second.pax, payload: { reason: 'plans changed' },
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().cancelledBy, 'passenger');
  // The driver is free again.
  const off = await s.app.inject({ method: 'POST', url: '/drivers/me/offline', headers: second.driver });
  assert.equal(off.statusCode, 200);
  await s.app.close();
});

test('declined and lapsed choices', { skip }, async () => {
  const s = await setup();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 150));
  const pax = await passenger(s);
  const ride = (await createRide(s, pax, spot)).json();
  const offer = await offerOf(s, ride, driver);

  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  const twice = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  assert.equal(twice.statusCode, 409, 'cannot choose while waiting for a driver');

  const declined = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/decline`, headers: driver });
  assert.equal(declined.statusCode, 204);
  const accept = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  assert.equal(accept.statusCode, 404, 'a declined offer cannot be accepted');

  const refreshed = (await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/search`, headers: pax })).json();
  assert.equal(refreshed.some((o: { id: string }) => o.id === offer.id), false, 'a driver who declined is not offered again');

  // A choice the driver lets lapse can be replaced.
  const driver2 = await onlineDriver(s, north(spot, 250));
  const offers = (await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/search`, headers: pax })).json();
  const offer2 = await offerOf(s, { id: ride.id, offers }, driver2);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer2.id } });
  await db.query(`UPDATE ride_offers SET expires_at = now() - interval '1 second' WHERE ride_id = $1 AND status = 'chosen'`, [ride.id]);
  assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver2 })).statusCode, 404, 'too late to accept');
  assert.ok(driver2);
  await s.app.close();
});

test('who may go online and order', { skip }, async () => {
  const s = await setup();
  const spot = randomSpot();

  // Not a driver at all.
  const pax = await passenger(s);
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: pax, payload: spot })).statusCode, 404);
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: pax, payload: spot })).statusCode, 409);

  // Subscription expired.
  const driver = await verifiedDriver(s);
  const me = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json();
  await db.query(`UPDATE subscriptions SET ends_at = now() - interval '1 minute', starts_at = now() - interval '2 days' WHERE driver_id = $1`, [me.id]);
  const res = await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: driver, payload: spot });
  assert.equal(res.statusCode, 402);

  // Outside Uzbekistan, junk headings and unknown fields are rejected.
  const d2 = await verifiedDriver(s);
  for (const payload of [{ lat: 55.75, lng: 37.61 }, { ...spot, heading: 400 }, { ...spot, speed: 999 }]) {
    assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: d2, payload })).statusCode, 400);
  }
  for (const payload of [
    { classCode: 'economy', mode: 'choose', stops: [spot, { lat: 55.75, lng: 37.61 }] },
    { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 1000)], priceTiyin: 1 },
    { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 1000)], options: { vip: true } },
    { classCode: "economy' OR 1=1 --", mode: 'choose', stops: [spot, north(spot, 1000)] },
  ]) {
    assert.equal((await s.app.inject({ method: 'POST', url: '/rides', headers: pax, payload })).statusCode, 400, JSON.stringify(payload));
  }

  // A blocked user cannot order.
  const blocked = randomPhone();
  const blockedAuth = { authorization: `Bearer ${await s.login(blocked)}` };
  await db.query(`INSERT INTO blocks (user_id, reason) SELECT id, 'test' FROM users WHERE phone = $1`, [blocked]);
  assert.equal((await createRide(s, blockedAuth, spot)).statusCode, 403);

  // A driver never gets an offer for their own order.
  const selfDriver = await onlineDriver(s, north(spot, 100));
  const own = await createRide(s, selfDriver, spot);
  assert.equal(own.statusCode, 201, own.body);
  const offeredSelf = await db.query(
    `SELECT 1 FROM ride_offers o JOIN drivers d ON d.id = o.driver_id JOIN rides r ON r.id = o.ride_id
      WHERE o.ride_id = $1 AND d.user_id = r.passenger_id`,
    [own.json().id],
  );
  assert.equal(offeredSelf.rows.length, 0);
  await s.app.close();
});

test('races: parallel orders and parallel acceptances', { skip }, async () => {
  const s = await setup();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 200));

  // The same passenger ordering twice at once gets exactly one ride.
  const pax = await passenger(s);
  const results = await Promise.all([createRide(s, pax, spot), createRide(s, pax, spot), createRide(s, pax, spot)]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409, 409]);

  // Two passengers pick the same driver: the second waits until the driver answers the first.
  const rideA = results.find((r) => r.statusCode === 201)!.json();
  const paxB = await passenger(s);
  const rideB = (await createRide(s, paxB, spot)).json();
  const offerA = await offerOf(s, rideA, driver);
  const offerB = await offerOf(s, rideB, driver);
  const choices = await Promise.all([
    s.app.inject({ method: 'POST', url: `/rides/${rideA.id}/choose`, headers: pax, payload: { offerId: offerA.id } }),
    s.app.inject({ method: 'POST', url: `/rides/${rideB.id}/choose`, headers: paxB, payload: { offerId: offerB.id } }),
  ]);
  assert.deepEqual(choices.map((r) => r.statusCode).sort(), [200, 409], choices.map((r) => r.body).join(' | '));
  const chosenRide = choices[0]!.statusCode === 200 ? rideA : rideB;

  // Accepting the same ride twice at once yields one acceptance.
  const accepts = await Promise.all([
    s.app.inject({ method: 'POST', url: `/rides/${chosenRide.id}/accept`, headers: driver }),
    s.app.inject({ method: 'POST', url: `/rides/${chosenRide.id}/accept`, headers: driver }),
  ]);
  assert.equal(accepts.filter((r) => r.statusCode === 200).length, 1, accepts.map((r) => r.body).join(' | '));
  await s.app.close();
});

// ---------------------------------------------------------------------------
// One-tap ordering (auto mode)

async function setFloorTariff(s: Setup, driver: Headers): Promise<void> {
  const t = (await s.app.inject({ method: 'GET', url: '/drivers/me/tariff', headers: driver })).json();
  const floor = Object.fromEntries(Object.entries(t.bounds).map(([k, b]) => [k, (b as { min: number }).min]));
  const res = await s.app.inject({ method: 'PUT', url: '/drivers/me/tariff', headers: driver, payload: floor });
  assert.equal(res.statusCode, 200, res.body);
}

async function quote(s: Setup, auth: Headers, spot: { lat: number; lng: number }) {
  const res = await s.app.inject({ method: 'POST', url: '/quotes', headers: auth, payload: { stops: [spot, north(spot, 6000)] } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().classes.find((c: { code: string }) => c.code === 'economy');
}

async function orderAuto(s: Setup, auth: Headers, spot: { lat: number; lng: number }, maxPriceTiyin: number) {
  return s.app.inject({
    method: 'POST', url: '/rides', headers: auth,
    payload: { classCode: 'economy', stops: [spot, north(spot, 6000)], maxPriceTiyin },
  });
}

async function requestsOf(s: Setup, driver: Headers) {
  return (await s.app.inject({ method: 'GET', url: '/drivers/me/requests', headers: driver })).json();
}

test('one tap: best price shown, sent to that driver, price locked', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 300));
  const pax = await passenger(s);

  const q = await quote(s, pax, spot);
  assert.ok(q.best, 'a driver is around');
  assert.equal(q.best.pickupMin >= 1, true);
  assert.ok(q.best.priceTiyin <= q.maxFareTiyin);

  const res = await orderAuto(s, pax, spot, q.best.priceTiyin);
  assert.equal(res.statusCode, 201, res.body);
  const ride = res.json();
  assert.equal(ride.mode, 'auto');
  assert.equal(ride.dispatch.state, 'waiting_driver');
  assert.equal(ride.offers, undefined, 'no list in one-tap mode');

  const reqs = await requestsOf(s, driver);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].rideId, ride.id);

  const accepted = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().priceTiyin, q.best.priceTiyin, 'the price on the button is the price of the ride');
  await s.app.close();
});

test('one tap: decline and timeout move to the next driver, never above the ceiling', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  const cheapNear = await onlineDriver(s, north(spot, 150));
  await setFloorTariff(s, cheapNear);
  const second = await onlineDriver(s, north(spot, 400));
  await setFloorTariff(s, second);
  const third = await onlineDriver(s, north(spot, 800));
  await setFloorTariff(s, third);
  const pax = await passenger(s);

  const q = await quote(s, pax, spot);
  const ride = (await orderAuto(s, pax, spot, q.best.priceTiyin)).json();
  assert.equal((await requestsOf(s, cheapNear)).length, 1, 'best driver first');
  assert.equal((await requestsOf(s, second)).length, 0, 'one driver at a time');

  // Decline: goes to the next driver immediately.
  assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/decline`, headers: cheapNear })).statusCode, 204);
  assert.equal((await requestsOf(s, second)).length, 1);

  // Timeout: the dispatcher moves on.
  await db.query(`UPDATE ride_offers SET expires_at = now() - interval '1 second' WHERE ride_id = $1 AND status = 'chosen'`, [ride.id]);
  await dispatchTick(db);
  assert.equal((await requestsOf(s, second)).length, 0, 'lapsed request is gone');
  assert.equal((await requestsOf(s, third)).length, 1, 'next driver gets it');

  const accepted = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: third });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.ok(accepted.json().priceTiyin <= q.best.priceTiyin, 'never more than agreed');

  const events = await db.query(`SELECT type FROM ride_events WHERE ride_id = $1 ORDER BY id`, [ride.id]);
  assert.deepEqual(events.rows.map((e) => e.type), [
    'status:created', 'offer_sent', 'offer_declined', 'offer_sent', 'offer_timeout', 'offer_sent', 'status:accepted',
  ]);
  await s.app.close();
});

test('one tap: a higher price needs the passenger\'s explicit confirmation', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  const cheap = await onlineDriver(s, north(spot, 200));
  await setFloorTariff(s, cheap);
  const standard = await onlineDriver(s, north(spot, 300));
  const pax = await passenger(s);

  const q = await quote(s, pax, spot);
  const ride = (await orderAuto(s, pax, spot, q.best.priceTiyin)).json();
  // The cheap driver says no; only a more expensive one is left.
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/decline`, headers: cheap });
  assert.equal((await requestsOf(s, standard)).length, 0, 'not sent above the ceiling');

  const view = (await s.app.inject({ method: 'GET', url: `/rides/${ride.id}`, headers: pax })).json();
  assert.equal(view.dispatch.state, 'needs_confirmation');
  const proposed = view.dispatch.priceTiyin;
  assert.ok(proposed > q.best.priceTiyin);

  // Only the exact price on the screen can be confirmed.
  const wrong = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/confirm-price`, headers: pax, payload: { priceTiyin: proposed - 50_000 } });
  assert.equal(wrong.statusCode, 409);
  const stranger = await passenger(s);
  const notYours = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/confirm-price`, headers: stranger, payload: { priceTiyin: proposed } });
  assert.equal(notYours.statusCode, 404);

  const ok = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/confirm-price`, headers: pax, payload: { priceTiyin: proposed } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await requestsOf(s, standard)).length, 1);
  const accepted = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: standard });
  assert.equal(accepted.json().priceTiyin, proposed);
  await s.app.close();
});

test('one tap: ceiling checks, mode separation, no drivers', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  const pax = await passenger(s);
  const q = await quote(s, pax, spot);
  assert.equal(q.best, null, 'nobody around');

  // The ceiling must be a price that can exist for this route.
  assert.equal((await orderAuto(s, pax, spot, q.maxFareTiyin + 50_000)).statusCode, 400);
  assert.equal((await orderAuto(s, pax, spot, q.minFareTiyin - 50_000)).statusCode, 400);
  const missing = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax, payload: { classCode: 'economy', stops: [spot, north(spot, 6000)] },
  });
  assert.equal(missing.statusCode, 400);

  const ride = (await orderAuto(s, pax, spot, q.maxFareTiyin)).json();
  assert.equal(ride.dispatch.state, 'searching');
  // List-mode actions do not apply to a one-tap ride.
  assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/search`, headers: pax })).statusCode, 409);

  // A driver who comes online later is picked up by the dispatcher.
  const late = await onlineDriver(s, north(spot, 200));
  await dispatchTick(db);
  assert.equal((await requestsOf(s, late)).length, 1);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/decline`, headers: late });

  // Nobody accepts within the search window: the system cancels.
  await db.query(`UPDATE rides SET search_deadline = now() - interval '1 second' WHERE id = $1`, [ride.id]);
  await dispatchTick(db);
  const view = (await s.app.inject({ method: 'GET', url: `/rides/${ride.id}`, headers: pax })).json();
  assert.equal(view.status, 'cancelled');
  assert.equal(view.cancelReason, 'no_drivers');
  await s.app.close();
});

test('one tap: a driver never holds two requests at once', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 200));
  const paxA = await passenger(s);
  const paxB = await passenger(s);
  const q = await quote(s, paxA, spot);
  const [a, b] = await Promise.all([orderAuto(s, paxA, spot, q.best.priceTiyin), orderAuto(s, paxB, spot, q.best.priceTiyin)]);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.equal((await requestsOf(s, driver)).length, 1);
  const states = [a.json().dispatch.state, b.json().dispatch.state].sort();
  assert.deepEqual(states, ['searching', 'waiting_driver']);
  await s.app.close();
});

test('driver stats: today and this week, and what was kept vs a 20% commission', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  const stats = (await s.app.inject({ method: 'GET', url: '/drivers/me/stats', headers: r.driver })).json();
  assert.equal(stats.today.rides, 1);
  assert.equal(stats.today.earnedTiyin, r.offer.priceTiyin);
  assert.equal(stats.today.keptVsCommissionTiyin, Math.round(r.offer.priceTiyin * 0.2));
  assert.ok(stats.subscriptionUntil);
  assert.equal((await s.app.inject({ method: 'GET', url: '/drivers/me/stats', headers: await passenger(s) })).statusCode, 404);
  await s.app.close();
});
