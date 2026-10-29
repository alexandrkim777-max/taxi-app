// Account deletion, "never this driver again", and the approximate cars on the passenger's map.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, setup, skip, type Setup } from './helpers.ts';
import { acceptedRide, clearMap, drive, north, onlineDriver, passenger, randomSpot, type Headers } from './rideHelpers.ts';

async function completedRide(s: Setup) {
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  return r;
}

test('delete account: refused during a ride; then personal data gone, token dead, phone free', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  const del = (h: Headers) => s.app.inject({ method: 'DELETE', url: '/me', headers: h, payload: { confirm: true } });

  // Must be confirmed explicitly.
  assert.equal((await s.app.inject({ method: 'DELETE', url: '/me', headers: r.pax, payload: {} })).statusCode, 400);
  // Not in the middle of a ride.
  const busy = await del(r.pax);
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().error, 'active_ride');

  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  await s.app.inject({ method: 'PUT', url: '/me/places/home', headers: r.pax, payload: { address: 'Chilonzor 9', lat: 41.29, lng: 69.2 } });
  const me = (await s.app.inject({ method: 'GET', url: '/me', headers: r.pax })).json();

  assert.equal((await del(r.pax)).statusCode, 204);
  // The old session no longer works.
  assert.equal((await s.app.inject({ method: 'GET', url: '/me', headers: r.pax })).statusCode, 401);
  const { rows: [u] } = await db.query(`SELECT phone, name, deleted_at FROM users WHERE id = $1`, [me.id]);
  assert.ok(u.deleted_at);
  assert.equal(u.name, null);
  assert.ok(!u.phone.startsWith('+998'), 'the phone number is erased');
  assert.equal((await db.query(`SELECT 1 FROM saved_places WHERE user_id = $1`, [me.id])).rows.length, 0);
  // The ride stays for accounting and disputes.
  assert.equal((await db.query(`SELECT 1 FROM rides WHERE id = $1`, [r.rideId])).rows.length, 1);

  // Signing up again with the same number gives a new, empty account.
  const again = { authorization: `Bearer ${await s.login(me.phone)}` };
  const fresh = (await s.app.inject({ method: 'GET', url: '/me', headers: again })).json();
  assert.notEqual(fresh.id, me.id);
  assert.deepEqual((await s.app.inject({ method: 'GET', url: '/me/rides', headers: again })).json(), []);
  await s.app.close();
});

test('delete account: refused while money is owed', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  const me = (await s.app.inject({ method: 'GET', url: '/me', headers: pax })).json();
  const r = await acceptedRide(s);
  // A cancellation fee left unpaid (cash ride) is a debt; move it to this passenger.
  await db.query(`UPDATE rides SET passenger_id = $2, status = 'cancelled', cancelled_by = 'passenger',
                    cancel_fee_tiyin = 500000, cancel_fee_status = 'pending' WHERE id = $1`, [r.rideId, me.id]);
  const res = await s.app.inject({ method: 'DELETE', url: '/me', headers: pax, payload: { confirm: true } });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(res.json().error, 'unpaid_debt');
  await s.app.close();
});

test('never this driver again: not offered, not quoted; can be undone; only for own rides', { skip }, async () => {
  const s = await setup();
  const r = await completedRide(s);
  const stranger = await passenger(s);
  assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/block-driver`, headers: stranger })).statusCode, 404);
  assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/block-driver`, headers: r.driver })).statusCode, 404);
  assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/block-driver`, headers: r.pax })).statusCode, 204);
  assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/block-driver`, headers: r.pax })).statusCode, 204, 'idempotent');

  const list = (await s.app.inject({ method: 'GET', url: '/me/blocked-drivers', headers: r.pax })).json();
  assert.equal(list.length, 1);
  assert.ok(list[0].driverName !== undefined && list[0].plate);
  assert.equal(JSON.stringify(list).includes('+998'), false, 'no phone numbers');

  // The driver is right there, but the passenger is never matched with them.
  await clearMap();
  const spot = randomSpot();
  await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: r.driver, payload: north(spot, 200) });
  const quote = async () => (await s.app.inject({ method: 'POST', url: '/quotes', headers: r.pax, payload: { stops: [spot, north(spot, 5000)] } }))
    .json().classes.find((c: { code: string }) => c.code === 'economy');
  assert.equal((await quote()).driversNearby, 0);
  const other = await passenger(s);
  const q2 = (await s.app.inject({ method: 'POST', url: '/quotes', headers: other, payload: { stops: [spot, north(spot, 5000)] } }))
    .json().classes.find((c: { code: string }) => c.code === 'economy');
  assert.equal(q2.driversNearby, 1, 'other passengers still get this driver');

  assert.equal((await s.app.inject({ method: 'DELETE', url: `/me/blocked-drivers/${list[0].id}`, headers: r.pax })).statusCode, 204);
  assert.equal((await quote()).driversNearby, 1);
  await s.app.close();
});

test('cars on the map: approximate, anonymous, signed-in only', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  const exact = north(spot, 437);
  await onlineDriver(s, exact);
  const pax = await passenger(s);
  assert.equal((await s.app.inject({ method: 'GET', url: `/geo/cars?lat=${spot.lat}&lng=${spot.lng}` })).statusCode, 401);
  const { cars } = (await s.app.inject({ method: 'GET', url: `/geo/cars?lat=${spot.lat}&lng=${spot.lng}`, headers: pax })).json();
  assert.equal(cars.length, 1);
  assert.deepEqual(Object.keys(cars[0]).sort(), ['heading', 'lat', 'lng'], 'no ids, names or plates');
  // Snapped to the grid: close to the real spot, but not the real spot.
  const offM = Math.hypot((cars[0].lat - exact.lat) * 111_000, (cars[0].lng - exact.lng) * 84_000);
  assert.ok(offM < 200, `within the grid cell (${offM} m)`);
  assert.ok(Math.abs(cars[0].lat / 0.0015 - Math.round(cars[0].lat / 0.0015)) < 1e-6, 'on the grid');
  await s.app.close();
});
