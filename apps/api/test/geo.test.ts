// Integration tests: address search, entrances learned from pickups, saved places.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, setup, skip, type Setup } from './helpers.ts';
import { drive, north, offerOf, onlineDriver, passenger, randomSpot, type Headers } from './rideHelpers.ts';

async function rideWithEntrance(s: Setup, spot: { lat: number; lng: number }, pickup: Record<string, unknown>) {
  const driver = await onlineDriver(s, north(spot, 100));
  const pax = await passenger(s);
  const res = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', mode: 'choose', stops: [{ ...spot, address: 'Chilonzor 9, 14-uy', ...pickup }, north(spot, 5000)] },
  });
  assert.equal(res.statusCode, 201, res.body);
  const ride = res.json();
  const offer = await offerOf(s, ride, driver);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  return { rideId: ride.id as string, driver, pax };
}

test('address search and reverse: signed-in only, in the user\'s language', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  assert.equal((await s.app.inject({ method: 'GET', url: '/geo/search?q=chorsu' })).statusCode, 401);
  assert.equal((await s.app.inject({ method: 'GET', url: '/geo/search?q=c', headers: pax })).statusCode, 400);
  await s.app.inject({ method: 'PATCH', url: '/me', headers: pax, payload: { language: 'uz' } });
  const found = (await s.app.inject({ method: 'GET', url: '/geo/search?q=chorsu&lat=41.3&lng=69.24', headers: pax })).json();
  assert.equal(found[0].name, 'Chorsu bozori');
  await s.app.inject({ method: 'PATCH', url: '/me', headers: pax, payload: { language: 'ru' } });
  const ru = (await s.app.inject({ method: 'GET', url: `/geo/search?q=${encodeURIComponent('чорсу')}`, headers: pax })).json();
  assert.equal(ru[0].name, 'Базар Чорсу');
  const rev = await s.app.inject({ method: 'GET', url: '/geo/reverse?lat=41.3266&lng=69.235', headers: pax });
  assert.equal(rev.json().name, 'Базар Чорсу');
  assert.equal((await s.app.inject({ method: 'GET', url: '/geo/reverse?lat=55.75&lng=37.6', headers: pax })).statusCode, 400, 'Uzbekistan only');
  await s.app.close();
});

test('entrances: learned from where trips really start, confirmed by later pickups', { skip }, async () => {
  const s = await setup();
  const spot = randomSpot();
  const bad = await s.app.inject({
    method: 'POST', url: '/rides', headers: await passenger(s),
    payload: { classCode: 'economy', mode: 'choose', stops: [{ ...spot, entranceLabel: '<b>3</b>' }, north(spot, 5000)] },
  });
  assert.equal(bad.statusCode, 400);

  const first = await rideWithEntrance(s, spot, { entranceLabel: '3' });
  const req = (await s.app.inject({ method: 'GET', url: `/rides/${first.rideId}`, headers: first.driver })).json();
  assert.equal(req.stops[0].entrance, '3', 'the driver sees the entrance');
  await drive(s, first.driver, first.rideId, ['driver_en_route', 'arrived', 'in_progress']);

  const near = (await s.app.inject({ method: 'GET', url: `/geo/entrances?lat=${spot.lat}&lng=${spot.lng}`, headers: first.pax })).json();
  const e = near.find((x: { number: string }) => x.number === '3');
  assert.ok(e, 'entrance 3 is now known');
  assert.equal(e.confirmedPickups, 1);

  // The next passenger names the same entrance: confirmed, not duplicated.
  const second = await rideWithEntrance(s, spot, { entranceLabel: '3' });
  await drive(s, second.driver, second.rideId, ['driver_en_route', 'arrived', 'in_progress']);
  const again = (await s.app.inject({ method: 'GET', url: `/geo/entrances?lat=${spot.lat}&lng=${spot.lng}`, headers: first.pax })).json();
  assert.equal(again.filter((x: { number: string }) => x.number === '3').length, 1);
  assert.equal(again.find((x: { number: string }) => x.number === '3').confirmedPickups, 2);

  // A known entrance far from the pin is not attached to the ride.
  const far = randomSpot();
  const third = await rideWithEntrance(s, north(far, 2000), { entranceId: e.id });
  const stop = await db.query(`SELECT entrance_id FROM ride_stops WHERE ride_id = $1 AND position = 0`, [third.rideId]);
  assert.equal(stop.rows[0].entrance_id, null);
  await s.app.close();
});

test('saved places: home / work replaced, others capped, owner only', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  const other: Headers = await passenger(s);
  const put = (kind: string, address: string) => s.app.inject({ method: 'PUT', url: `/me/places/${kind}`, headers: pax, payload: { address, lat: 41.3, lng: 69.25 } });
  assert.equal((await put('home', 'Chilonzor 9, 14-uy')).statusCode, 200);
  assert.equal((await put('home', 'Yunusobod 4, 7-uy')).statusCode, 200);
  assert.equal((await put('office', 'x')).statusCode, 400);
  const added = await s.app.inject({ method: 'POST', url: '/me/places', headers: pax, payload: { label: 'Onam', address: 'Sergeli 2', lat: 41.22, lng: 69.22 } });
  assert.equal(added.statusCode, 201);
  const list = (await s.app.inject({ method: 'GET', url: '/me/places', headers: pax })).json();
  assert.deepEqual(list.map((p: { kind: string; address: string }) => `${p.kind}:${p.address}`), ['home:Yunusobod 4, 7-uy', 'other:Sergeli 2']);
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/me/places/${added.json().id}`, headers: other })).statusCode, 404);
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/me/places/${added.json().id}`, headers: pax })).statusCode, 204);
  await s.app.close();
});
