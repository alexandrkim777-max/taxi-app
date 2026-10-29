// "Cheaper" and "faster": how the two options are chosen, shown and honoured when assigning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsOf, type PricedDriver } from '../src/dispatch/matching.ts';
import { db, setup, skip, type Setup } from './helpers.ts';
import { clearMap, north, onlineDriver, passenger, randomSpot, setFloorTariff, type Headers } from './rideHelpers.ts';

const d = (id: string, priceSum: number, distanceM: number, rating: number | null = null): PricedDriver =>
  ({ driverId: id, tariffId: 't', distanceM, lat: 0, lng: 0, rating, priceTiyin: priceSum * 100 });

test('options: two when they really differ, one when they would be the same', () => {
  // Near and a bit pricier vs far and cheaper: both shown.
  let o = optionsOf([d('near', 25_000, 300), d('far', 20_000, 2500)]);
  assert.deepEqual(o.map((x) => [x.priority, x.driver.driverId]), [['cheap', 'far'], ['fast', 'near']]);

  // Less than 1 000 sum apart: the faster one only.
  o = optionsOf([d('near', 20_500, 300), d('far', 20_000, 2500)]);
  assert.deepEqual(o.map((x) => [x.priority, x.driver.driverId]), [['fast', 'near']]);

  // The same driver wins both ways (cheaper and almost as near): one option.
  o = optionsOf([d('a', 25_000, 300), d('b', 20_000, 600)]);
  assert.deepEqual(o.map((x) => x.driver.driverId), ['b']);

  // Different drivers but less than 2 minutes apart by road: the cheaper one only.
  o = optionsOf([d('a', 25_000, 300), d('b', 24_000, 900)], (x) => (x.driverId === 'a' ? 2 : 3));
  assert.deepEqual(o.map((x) => [x.priority, x.driver.driverId]), [['cheap', 'b']]);

  // The cheapest car is too far for "cheaper" (over 15 minutes): no "cheaper" option.
  o = optionsOf([d('near', 25_000, 300), d('veryFar', 15_000, 4900)], (x) => (x.driverId === 'veryFar' ? 18 : 2));
  assert.deepEqual(o.map((x) => [x.priority, x.driver.driverId]), [['fast', 'near']]);

  // One driver, or nobody.
  assert.equal(optionsOf([d('only', 20_000, 800)]).length, 1);
  assert.deepEqual(optionsOf([]), []);

  // Rating breaks near-ties: same price and pickup, the better-rated driver.
  o = optionsOf([d('low', 20_000, 300, 3.5), d('high', 20_000, 310, 4.9)]);
  assert.equal(o[0]!.driver.driverId, 'high');
});

async function quote(s: Setup, pax: Headers, spot: { lat: number; lng: number }, cls = 'economy') {
  const res = await s.app.inject({ method: 'POST', url: '/quotes', headers: pax, payload: { stops: [spot, north(spot, 6000)] } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().classes.find((c: { code: string }) => c.code === cls);
}

async function requests(s: Setup, h: Headers) {
  return (await s.app.inject({ method: 'GET', url: '/drivers/me/requests', headers: h })).json() as unknown[];
}

async function twoDrivers(s: Setup) {
  await clearMap();
  const spot = randomSpot();
  const near = await onlineDriver(s, north(spot, 300)); // recommended price, ~2 min away
  const far = await onlineDriver(s, north(spot, 2500)); // 20% cheaper, ~10 min away
  await setFloorTariff(s, far);
  return { spot, near, far };
}

test('quotes: "cheaper" and "faster" with price and pickup minutes; all four classes', { skip }, async () => {
  const s = await setup();
  const { spot } = await twoDrivers(s);
  const pax = await passenger(s);
  const res = await s.app.inject({ method: 'POST', url: '/quotes', headers: pax, payload: { stops: [spot, north(spot, 6000)] } });
  const classes = res.json().classes as { code: string; seats: number; options: unknown[] }[];
  assert.deepEqual(classes.map((c) => c.code).sort(), ['business', 'comfort', 'economy', 'minivan']);
  assert.equal(classes.find((c) => c.code === 'minivan')!.seats, 7);

  const q = await quote(s, pax, spot);
  const [cheap, fast] = q.options;
  assert.equal(cheap.priority, 'cheap');
  assert.equal(fast.priority, 'fast');
  assert.ok(cheap.priceTiyin < fast.priceTiyin, 'cheaper is cheaper');
  assert.ok(fast.pickupMin < cheap.pickupMin, 'faster is faster');
  assert.ok(fast.priceTiyin <= q.maxFareTiyin, 'never above the recommended price');
  // A class nobody drives right now: no options, the app says so.
  assert.deepEqual((await quote(s, pax, spot, 'minivan')).options, []);
  await s.app.close();
});

test('order "cheaper": sent to the cheaper driver, price locked at what was shown', { skip }, async () => {
  const s = await setup();
  const { spot, near, far } = await twoDrivers(s);
  const pax = await passenger(s);
  const cheap = (await quote(s, pax, spot)).options[0];
  const res = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', stops: [spot, north(spot, 6000)], priority: 'cheap', maxPriceTiyin: cheap.priceTiyin },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().priority, 'cheap');
  assert.equal((await requests(s, far)).length, 1);
  assert.equal((await requests(s, near)).length, 0, 'the nearer driver is dearer than the agreed price');
  const accepted = await s.app.inject({ method: 'POST', url: `/rides/${res.json().id}/accept`, headers: far });
  assert.equal(accepted.json().priceTiyin, cheap.priceTiyin);
  await s.app.close();
});

test('order "faster": sent to the nearest driver; the cheaper one is next if they decline', { skip }, async () => {
  const s = await setup();
  const { spot, near, far } = await twoDrivers(s);
  const pax = await passenger(s);
  const fast = (await quote(s, pax, spot)).options[1];
  const res = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', stops: [spot, north(spot, 6000)], priority: 'fast', maxPriceTiyin: fast.priceTiyin },
  });
  assert.equal(res.statusCode, 201, res.body);
  const rideId = res.json().id;
  assert.equal((await requests(s, near)).length, 1);
  assert.equal((await requests(s, far)).length, 0, 'one driver at a time');
  await s.app.inject({ method: 'POST', url: `/rides/${rideId}/decline`, headers: near });
  assert.equal((await requests(s, far)).length, 1, 'the next driver is within the agreed price');
  const accepted = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/accept`, headers: far });
  assert.ok(accepted.json().priceTiyin <= fast.priceTiyin, 'never more than agreed');
  const ev = await db.query(`SELECT payload FROM ride_events WHERE ride_id = $1 AND type = 'status:created'`, [rideId]);
  assert.equal(ev.rows[0].payload.priority, 'fast');
  await s.app.close();
});

test('priority is only for one-tap orders', { skip }, async () => {
  const s = await setup();
  const pax = await passenger(s);
  const spot = randomSpot();
  const res = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', mode: 'choose', priority: 'cheap', stops: [spot, north(spot, 6000)] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'priority_is_for_auto');
  const bad = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', priority: 'cheapest', maxPriceTiyin: 2_000_000, stops: [spot, north(spot, 6000)] },
  });
  assert.equal(bad.statusCode, 400);
  await s.app.close();
});
