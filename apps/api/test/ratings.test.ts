// Integration tests: two-way ratings and their effect on dispatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, setup, skip, type Setup } from './helpers.ts';
import { acceptedRide, clearMap, drive, north, onlineDriver, passenger, randomSpot, type Headers } from './rideHelpers.ts';

async function completedRide(s: Setup) {
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  return r;
}

async function rate(s: Setup, auth: Headers, rideId: string, score: number, reason?: string) {
  return s.app.inject({ method: 'POST', url: `/rides/${rideId}/rating`, headers: auth, payload: reason ? { score, reason } : { score } });
}

test('both sides rate once; low scores need a reason; strangers cannot', { skip }, async () => {
  const s = await setup();
  const r = await completedRide(s);
  const stranger = await passenger(s);

  assert.equal((await rate(s, r.pax, r.rideId, 5)).statusCode, 204);
  assert.equal((await rate(s, r.pax, r.rideId, 4)).statusCode, 409, 'once per side');
  assert.equal((await rate(s, r.driver, r.rideId, 2)).statusCode, 400, 'reason required below 4');
  assert.equal((await rate(s, r.driver, r.rideId, 2, '  ')).statusCode, 400);
  assert.equal((await rate(s, r.driver, r.rideId, 2, 'Slammed the door')).statusCode, 204);
  assert.equal((await rate(s, stranger, r.rideId, 1, 'not my ride')).statusCode, 404);
  assert.equal((await rate(s, r.pax, r.rideId, 6)).statusCode, 400);

  // Not finished yet: no rating.
  const open = await acceptedRide(s);
  assert.equal((await rate(s, open.pax, open.rideId, 5)).statusCode, 409);

  // Too late.
  const old = await completedRide(s);
  await db.query(`UPDATE ride_events SET at = now() - interval '4 days' WHERE ride_id = $1 AND type = 'status:completed'`, [old.rideId]);
  assert.equal((await rate(s, old.pax, old.rideId, 5)).statusCode, 409);
  await s.app.close();
});

test('averages show only after 5 ratings and never reveal who rated', { skip }, async () => {
  const s = await setup();
  const first = await completedRide(s);
  const driver = first.driver;
  const scores = [5, 4, 5, 3, 5];
  let rideId = first.rideId;
  let pax = first.pax;
  for (const [i, score] of scores.entries()) {
    if (i > 0) {
      // Same driver, new passenger.
      const spot = randomSpot();
      await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: driver, payload: north(spot, 100) });
      pax = await passenger(s);
      const ride = (await s.app.inject({
        method: 'POST', url: '/rides', headers: pax,
        payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 5000)] },
      })).json();
      const driverId = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json().id;
      const { rows } = await db.query(`SELECT id FROM ride_offers WHERE ride_id = $1 AND driver_id = $2`, [ride.id, driverId]);
      assert.ok(rows[0], JSON.stringify(ride));
      const ch = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: rows[0].id } });
      assert.equal(ch.statusCode, 200, ch.body);
      const ac = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
      assert.equal(ac.statusCode, 200, ac.body);
      await drive(s, driver, ride.id, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
      rideId = ride.id;
    }
    if (i === 3) {
      const me = (await s.app.inject({ method: 'GET', url: '/me/ratings', headers: driver })).json();
      assert.equal(me.asDriver.rating, null, 'hidden until 5 ratings');
      assert.equal(me.asDriver.count, 3);
    }
    assert.equal((await rate(s, pax, rideId, score, score < 4 ? 'Was late' : undefined)).statusCode, 204);
  }
  const me = (await s.app.inject({ method: 'GET', url: '/me/ratings', headers: driver })).json();
  assert.equal(me.asDriver.rating, 4.4);
  assert.equal(me.asDriver.count, 5);
  assert.equal(JSON.stringify(me).includes('Was late'), false, 'reasons and authors stay private');
  await s.app.close();
});

test('with equal price and pickup, the better-rated driver gets the one-tap order', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  const low = await onlineDriver(s, north(spot, 200));
  const high = await onlineDriver(s, north(spot, 210));
  const id = async (h: Headers) => (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: h })).json().id;
  await db.query(`UPDATE drivers SET rating = 3.2, rating_count = 20 WHERE id = $1`, [await id(low)]);
  await db.query(`UPDATE drivers SET rating = 4.9, rating_count = 20 WHERE id = $1`, [await id(high)]);

  const pax = await passenger(s);
  const q = (await s.app.inject({ method: 'POST', url: '/quotes', headers: pax, payload: { stops: [spot, north(spot, 6000)] } }))
    .json().classes.find((c: { code: string }) => c.code === 'economy');
  const ride = await s.app.inject({
    method: 'POST', url: '/rides', headers: pax,
    payload: { classCode: 'economy', stops: [spot, north(spot, 6000)], maxPriceTiyin: q.best.priceTiyin },
  });
  assert.equal(ride.statusCode, 201, ride.body);
  const reqs = async (h: Headers) => (await s.app.inject({ method: 'GET', url: '/drivers/me/requests', headers: h })).json();
  assert.equal((await reqs(high)).length, 1);
  assert.equal((await reqs(low)).length, 0);
  await s.app.close();
});

async function rateTags(s: Setup, auth: Headers, rideId: string, score: number, tags: string[], reason?: string) {
  return s.app.inject({
    method: 'POST', url: `/rides/${rideId}/rating`, headers: auth,
    payload: reason ? { score, tags, reason } : { score, tags },
  });
}

test('end of ride: "what did you like" tags, shown as driver highlights', { skip }, async () => {
  const s = await setup();
  const tags = (await s.app.inject({ method: 'GET', url: '/rating-tags?about=driver' })).json();
  const clean = tags.positive.find((t: { code: string }) => t.code === 'clean_car');
  assert.equal(clean.label.ru, 'Чисто в салоне');
  assert.ok(tags.negative.some((t: { code: string }) => t.code === 'unsafe_driving'));

  const r = await completedRide(s);
  const before = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: r.pax })).json();
  assert.deepEqual(before.rating, { myScore: null, canRate: true }, 'the app opens the rating screen');

  // Tags must fit the score and the side being rated.
  assert.equal((await rateTags(s, r.pax, r.rideId, 5, ['dirty_car'])).statusCode, 400);
  assert.equal((await rateTags(s, r.pax, r.rideId, 5, ['p_polite'])).statusCode, 400);
  assert.equal((await rateTags(s, r.pax, r.rideId, 5, ['made_up'])).statusCode, 400);
  assert.equal((await rateTags(s, r.pax, r.rideId, 5, ['clean_car', 'clean_car'])).statusCode, 400);
  assert.equal((await rateTags(s, r.pax, r.rideId, 5, ['clean_car', 'careful_driving', 'polite', 'knows_city', 'on_time', 'quiet_ride'])).statusCode, 400);

  assert.equal((await rateTags(s, r.pax, r.rideId, 5, ['clean_car', 'careful_driving'])).statusCode, 204);
  const after = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: r.pax })).json();
  assert.deepEqual(after.rating, { myScore: 5, canRate: false });
  const codes = after.driver.highlights.map((h: { code: string }) => h.code).sort();
  assert.deepEqual(codes, ['careful_driving', 'clean_car']);

  // The driver rates the passenger with their own tags.
  assert.equal((await rateTags(s, r.driver, r.rideId, 5, ['p_on_time'])).statusCode, 204);
  await s.app.close();
});

test('safety tags and 1–2 stars reach the moderators; negative tags stay private', { skip }, async () => {
  const s = await setup();
  const r = await completedRide(s);
  // A tag is enough of a reason for a low score.
  assert.equal((await rateTags(s, r.pax, r.rideId, 2, ['unsafe_driving', 'phone_while_driving'])).statusCode, 204);
  const complaints = await db.query(`SELECT type, status FROM complaints WHERE ride_id = $1`, [r.rideId]);
  assert.deepEqual(complaints.rows, [{ type: 'rating_safety:unsafe_driving,phone_while_driving', status: 'open' }]);

  const view = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: r.pax })).json();
  assert.equal(view.driver.highlights.length, 0, 'negative tags are never shown to passengers');
  const mine = (await s.app.inject({ method: 'GET', url: '/me/ratings', headers: r.driver })).json();
  assert.ok(mine.asDriver.tags.some((t: { code: string }) => t.code === 'unsafe_driving'), 'the driver sees what to improve');
  await s.app.close();
});
