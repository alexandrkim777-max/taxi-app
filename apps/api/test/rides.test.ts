// Integration tests: going online, nearby drivers with their own prices, choosing, accepting,
// the status machine, cancellations and the access rules around all of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip, verifiedDriver, type Setup } from './helpers.ts';

type Headers = Record<string, string>;

/** A random spot in Tashkent, so parallel test runs don't see each other's drivers. */
function randomSpot(): { lat: number; lng: number } {
  return { lat: 41.25 + Math.random() * 0.1, lng: 69.18 + Math.random() * 0.15 };
}

/** About `m` metres north of a point. */
function north(p: { lat: number; lng: number }, m: number) {
  return { lat: p.lat + m / 111_000, lng: p.lng };
}

async function passenger(s: Setup): Promise<Headers> {
  return { authorization: `Bearer ${await s.login(randomPhone())}` };
}

async function onlineDriver(s: Setup, at: { lat: number; lng: number }): Promise<Headers> {
  const auth = await verifiedDriver(s);
  const res = await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: auth, payload: at });
  assert.equal(res.statusCode, 200, res.body);
  return auth;
}

async function createRide(s: Setup, auth: Headers, pickup: { lat: number; lng: number }) {
  return s.app.inject({
    method: 'POST', url: '/rides', headers: auth,
    payload: { classCode: 'economy', stops: [pickup, north(pickup, 6000)], options: { quiet: true } },
  });
}

/**
 * The offer from a given driver. Drivers left online by earlier tests may also be nearby,
 * so tests pick their own driver's offer explicitly.
 */
async function offerOf(s: Setup, ride: { id: string; offers: { id: string }[] }, driver: Headers) {
  const driverId = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json().id;
  const { rows } = await db.query(`SELECT id FROM ride_offers WHERE ride_id = $1 AND driver_id = $2`, [ride.id, driverId]);
  const offer = ride.offers.find((o) => o.id === rows[0]?.id);
  assert.ok(offer, 'the driver is offered');
  return offer as { id: string; priceTiyin: number; [k: string]: unknown };
}

/** Ride created, driver chosen and accepted. */
async function acceptedRide(s: Setup) {
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 300));
  const pax = await passenger(s);
  const ride = (await createRide(s, pax, spot)).json();
  const offer = await offerOf(s, ride, driver);
  const chosen = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  assert.equal(chosen.statusCode, 200, chosen.body);
  const accepted = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  assert.equal(accepted.statusCode, 200, accepted.body);
  return { spot, driver, pax, rideId: ride.id as string, offer };
}

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

  for (const status of ['driver_en_route', 'arrived', 'in_progress', 'completed']) {
    const res = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/status`, headers: driver, payload: { status } });
    assert.equal(res.statusCode, 200, `${status}: ${res.body}`);
  }
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
  for (const status of ['driver_en_route', 'arrived', 'in_progress']) {
    await s.app.inject({ method: 'POST', url: `/rides/${rideId}/status`, headers: driver, payload: { status } });
  }
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
    { classCode: 'economy', stops: [spot, { lat: 55.75, lng: 37.61 }] },
    { classCode: 'economy', stops: [spot, north(spot, 1000)], priceTiyin: 1 },
    { classCode: 'economy', stops: [spot, north(spot, 1000)], options: { vip: true } },
    { classCode: "economy' OR 1=1 --", stops: [spot, north(spot, 1000)] },
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

  // Two passengers choose the same driver; accepting both at once yields one ride.
  const rideA = results.find((r) => r.statusCode === 201)!.json();
  const paxB = await passenger(s);
  const rideB = (await createRide(s, paxB, spot)).json();
  for (const [ride, auth] of [[rideA, pax], [rideB, paxB]] as const) {
    const offer = await offerOf(s, ride, driver);
    const res = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: auth, payload: { offerId: offer.id } });
    assert.equal(res.statusCode, 200, res.body);
  }
  const accepts = await Promise.all([
    s.app.inject({ method: 'POST', url: `/rides/${rideA.id}/accept`, headers: driver }),
    s.app.inject({ method: 'POST', url: `/rides/${rideB.id}/accept`, headers: driver }),
  ]);
  assert.equal(accepts.filter((r) => r.statusCode === 200).length, 1, accepts.map((r) => r.body).join(' | '));
  await s.app.close();
});
