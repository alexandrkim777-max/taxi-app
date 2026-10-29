// Integration tests for the honesty rules: the price changes only when the passenger changes
// the route and confirms; disputes where both sides write what happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip, type Setup } from './helpers.ts';
import { acceptedRide, createRide, drive, north, passenger, type Headers } from './rideHelpers.ts';

type Point = { lat: number; lng: number };

function east(p: Point, m: number): Point {
  return { lat: p.lat, lng: p.lng + m / 84_000 };
}

async function preview(s: Setup, auth: Headers, rideId: string, stops: Point[]) {
  return s.app.inject({ method: 'POST', url: `/rides/${rideId}/route/preview`, headers: auth, payload: { stops } });
}

async function confirm(s: Setup, auth: Headers, rideId: string, stops: Point[], priceTiyin: number) {
  return s.app.inject({ method: 'POST', url: `/rides/${rideId}/route`, headers: auth, payload: { stops, priceTiyin } });
}

async function admin(s: Setup): Promise<Headers> {
  const phone = randomPhone();
  const auth = { authorization: `Bearer ${await s.login(phone)}` };
  await db.query(`UPDATE users SET roles = roles || ARRAY['admin'] WHERE phone = $1`, [phone]);
  return auth;
}

test('adding a stop: preview, exact confirmation, new price for both sides', { skip }, async () => {
  const s = await setup();
  const { spot, driver, pax, rideId, offer } = await acceptedRide(s);
  const dest = north(spot, 6000);
  const withStop = [spot, east(north(spot, 3000), 2000), dest];

  const p = await preview(s, pax, rideId, withStop);
  assert.equal(p.statusCode, 200, p.body);
  const { oldPriceTiyin, newPriceTiyin, reason } = p.json();
  assert.equal(oldPriceTiyin, offer.priceTiyin);
  assert.ok(newPriceTiyin > oldPriceTiyin, 'a detour costs more');
  assert.equal(reason, 'stop_added');

  // Nothing changes on preview.
  assert.equal((await s.app.inject({ method: 'GET', url: `/rides/${rideId}`, headers: pax })).json().priceTiyin, oldPriceTiyin);

  // Only the exact price on the screen is accepted; confirmation is mandatory.
  assert.equal((await confirm(s, pax, rideId, withStop, newPriceTiyin - 50_000)).statusCode, 409);
  const noPrice = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/route`, headers: pax, payload: { stops: withStop } });
  assert.equal(noPrice.statusCode, 400);

  const ok = await confirm(s, pax, rideId, withStop, newPriceTiyin);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().priceTiyin, newPriceTiyin);
  assert.equal(ok.json().stops.length, 3);

  // The driver sees the new route, price and its history.
  const dv = (await s.app.inject({ method: 'GET', url: `/rides/${rideId}`, headers: driver })).json();
  assert.equal(dv.priceTiyin, newPriceTiyin);
  const history = (await s.app.inject({ method: 'GET', url: `/rides/${rideId}/price-changes`, headers: driver })).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].oldPriceTiyin, oldPriceTiyin);

  // A shorter destination makes it cheaper again.
  const shorter = [spot, north(spot, 2000)];
  const cheaper = (await preview(s, pax, rideId, shorter)).json();
  assert.ok(cheaper.newPriceTiyin < newPriceTiyin);
  assert.equal(cheaper.reason, 'stop_removed');

  // The price holds through to completion.
  await drive(s, driver, rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  assert.equal((await s.app.inject({ method: 'GET', url: `/rides/${rideId}`, headers: pax })).json().priceTiyin, newPriceTiyin);
  await s.app.close();
});

test('only the passenger changes the route, only while the ride is on', { skip }, async () => {
  const s = await setup();
  const { spot, driver, pax, rideId } = await acceptedRide(s);
  const stranger = await passenger(s);
  const stops = [spot, north(spot, 8000)];

  assert.equal((await preview(s, driver, rideId, stops)).statusCode, 404, 'the driver cannot change the route');
  assert.equal((await confirm(s, driver, rideId, stops, 1_000_000)).statusCode, 404);
  assert.equal((await preview(s, stranger, rideId, stops)).statusCode, 404);

  // Pickup: a short move is fine before arrival, a long one is not; after arrival it is fixed.
  assert.equal((await preview(s, pax, rideId, [north(spot, 100), north(spot, 6000)])).statusCode, 200);
  const far = await preview(s, pax, rideId, [north(spot, 1500), north(spot, 6000)]);
  assert.equal(far.statusCode, 409);
  assert.equal(far.json().error, 'pickup_too_far');
  await drive(s, driver, rideId, ['driver_en_route', 'arrived']);
  const fixed = await preview(s, pax, rideId, [north(spot, 100), north(spot, 6000)]);
  assert.equal(fixed.json().error, 'pickup_fixed');

  // Malformed input is rejected.
  for (const bad of [[spot], [spot, { lat: 55.75, lng: 37.61 }], [spot, { ...north(spot, 6000), priceTiyin: 1 }]]) {
    assert.equal((await preview(s, pax, rideId, bad as Point[])).statusCode, 400);
  }

  await drive(s, driver, rideId, ['in_progress', 'completed']);
  const after = await preview(s, pax, rideId, stops);
  assert.equal(after.statusCode, 409, 'no changes after the ride');

  // A ride still looking for a driver has no locked price to change.
  const pax2 = await passenger(s);
  const open = (await createRide(s, pax2, spot)).json();
  assert.equal((await preview(s, pax2, open.id, stops)).statusCode, 409);
  await s.app.close();
});

test('route changes are capped per ride', { skip }, async () => {
  const s = await setup();
  const { spot, pax, rideId } = await acceptedRide(s);
  for (let i = 1; i <= 6; i++) {
    const stops = [spot, north(spot, 4000 + i * 500)];
    const p = await preview(s, pax, rideId, stops);
    if (i <= 5) {
      assert.equal(p.statusCode, 200, p.body);
      assert.equal((await confirm(s, pax, rideId, stops, p.json().newPriceTiyin)).statusCode, 200);
    } else {
      assert.equal(p.statusCode, 429);
    }
  }
  await s.app.close();
});

test('the database refuses any other reason for a price change', { skip }, async () => {
  const { rows } = await db.query(`SELECT id FROM rides LIMIT 1`);
  await assert.rejects(
    db.query(`INSERT INTO price_changes (ride_id, reason, amount_tiyin) VALUES ($1, 'waiting', 500000)`, [rows[0].id]),
    /price_changes_reason_check/,
  );
});

test('dispute: both sides write independently, then a moderator decides', { skip }, async () => {
  const s = await setup();
  const { driver, pax, rideId } = await acceptedRide(s);
  await drive(s, driver, rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  const stranger = await passenger(s);
  const mod = await admin(s);

  const opened = await s.app.inject({
    method: 'POST', url: `/rides/${rideId}/dispute`, headers: pax,
    payload: { category: 'route', text: 'The driver took a long way round through Chilanzar.' },
  });
  assert.equal(opened.statusCode, 201, opened.body);
  assert.equal(opened.json().status, 'awaiting_response');

  // One dispute per ride; strangers see nothing.
  const dup = await s.app.inject({
    method: 'POST', url: `/rides/${rideId}/dispute`, headers: driver,
    payload: { category: 'behavior', text: 'Passenger was rude to me the whole way.' },
  });
  assert.equal(dup.statusCode, 409);
  assert.equal((await s.app.inject({ method: 'GET', url: `/rides/${rideId}/dispute`, headers: stranger })).statusCode, 404);

  // The driver must write before reading the passenger's account.
  const before = (await s.app.inject({ method: 'GET', url: `/rides/${rideId}/dispute`, headers: driver })).json();
  assert.equal(before.awaitingMe, true);
  assert.equal(before.otherHasWritten, true);
  assert.equal(before.otherStatement, null, 'the other story is hidden until you write yours');

  // A moderator cannot decide before the other side has spoken.
  const early = await s.app.inject({
    method: 'POST', url: `/admin/disputes/${opened.json().id}/resolve`, headers: mod,
    payload: { outcome: 'driver', resolution: 'Deciding too early on purpose.' },
  });
  assert.equal(early.statusCode, 409);

  const tooShort = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/dispute/statement`, headers: driver, payload: { text: '   ok      ' } });
  assert.equal(tooShort.statusCode, 400);
  const answer = await s.app.inject({
    method: 'POST', url: `/rides/${rideId}/dispute/statement`, headers: driver,
    payload: { text: 'Main road was closed, the navigator rerouted us. <b>not html</b>' },
  });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.equal(answer.json().status, 'in_review');
  assert.match(answer.json().otherStatement.text, /long way round/);
  const again = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/dispute/statement`, headers: driver, payload: { text: 'Changing my story now, sorry.' } });
  assert.equal(again.statusCode, 409, 'statements cannot be rewritten');
  const paxSecond = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/dispute/statement`, headers: pax, payload: { text: 'Adding more to my statement.' } });
  assert.equal(paxSecond.statusCode, 409);

  // Moderation is admin-only.
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/disputes', headers: pax })).statusCode, 403);
  const queue = (await s.app.inject({ method: 'GET', url: '/admin/disputes?status=in_review', headers: mod })).json();
  const item = queue.find((d: { rideId: string }) => d.rideId === rideId);
  assert.ok(item);
  const detail = (await s.app.inject({ method: 'GET', url: `/admin/disputes/${item.id}`, headers: mod })).json();
  assert.equal(detail.statements.length, 2);
  assert.ok(detail.events.some((e: { type: string }) => e.type === 'status:completed'), 'the objective ride log is attached');

  const resolved = await s.app.inject({
    method: 'POST', url: `/admin/disputes/${item.id}/resolve`, headers: mod,
    payload: { outcome: 'no_fault', resolution: 'Road closure confirmed; the detour was justified.' },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  const seen = (await s.app.inject({ method: 'GET', url: `/rides/${rideId}/dispute`, headers: pax })).json();
  assert.equal(seen.outcome, 'no_fault');
  assert.match(seen.resolution, /Road closure/);
  const twice = await s.app.inject({
    method: 'POST', url: `/admin/disputes/${item.id}/resolve`, headers: mod,
    payload: { outcome: 'driver', resolution: 'Second decision should fail.' },
  });
  assert.equal(twice.statusCode, 409);
  await s.app.close();
});

test('dispute timing: silent side, late opening, rides without a driver', { skip }, async () => {
  const s = await setup();
  const { driver, pax, rideId } = await acceptedRide(s);
  await drive(s, driver, rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  const opened = await s.app.inject({
    method: 'POST', url: `/rides/${rideId}/dispute`, headers: driver,
    payload: { category: 'lost_item', text: 'Passenger left a phone on the back seat.' },
  });
  assert.equal(opened.statusCode, 201);

  // The passenger stays silent past the window: it goes to review, and the window is closed.
  await db.query(`UPDATE disputes SET respond_by = now() - interval '1 minute' WHERE ride_id = $1`, [rideId]);
  const view = (await s.app.inject({ method: 'GET', url: `/rides/${rideId}/dispute`, headers: pax })).json();
  assert.equal(view.status, 'in_review');
  const late = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/dispute/statement`, headers: pax, payload: { text: 'Sorry, I was busy and missed this.' } });
  assert.equal(late.statusCode, 409);

  // Too long after the ride.
  const second = await acceptedRide(s);
  await drive(s, second.driver, second.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  await db.query(`UPDATE ride_events SET at = now() - interval '4 days' WHERE ride_id = $1 AND type = 'status:completed'`, [second.rideId]);
  const tooLate = await s.app.inject({
    method: 'POST', url: `/rides/${second.rideId}/dispute`, headers: second.pax,
    payload: { category: 'price', text: 'Remembered something from last week.' },
  });
  assert.equal(tooLate.statusCode, 409);

  // No driver was ever assigned: nobody to dispute with.
  const pax3 = await passenger(s);
  const lonely = (await createRide(s, pax3, second.spot)).json();
  await s.app.inject({ method: 'POST', url: `/rides/${lonely.id}/cancel`, headers: pax3, payload: {} });
  const noDriver = await s.app.inject({
    method: 'POST', url: `/rides/${lonely.id}/dispute`, headers: pax3,
    payload: { category: 'other', text: 'Nobody came to pick me up at all.' },
  });
  assert.equal(noDriver.statusCode, 409);
  await s.app.close();
});

// ---------------------------------------------------------------------------
// Paid cancellation after the driver is at the pickup

test('cancel: free before arrival, fee after, shown and confirmed first', { skip }, async () => {
  const s = await setup();

  // Before arrival: free.
  const free = await acceptedRide(s);
  await drive(s, free.driver, free.rideId, ['driver_en_route']);
  const t0 = (await s.app.inject({ method: 'GET', url: `/rides/${free.rideId}/cancel-terms`, headers: free.pax })).json();
  assert.deepEqual(t0, { allowed: true, feeTiyin: 0 });
  const c0 = await s.app.inject({ method: 'POST', url: `/rides/${free.rideId}/cancel`, headers: free.pax, payload: {} });
  assert.equal(c0.statusCode, 200);
  assert.equal(c0.json().cancelFee, null);

  // "Arrived" far from the pickup is refused, so drivers cannot farm fees.
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route']);
  await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: r.driver, payload: north(r.spot, 1000) });
  const fake = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/status`, headers: r.driver, payload: { status: 'arrived' } });
  assert.equal(fake.statusCode, 409);
  assert.equal(fake.json().error, 'not_at_pickup');
  // 80 m away is still too far (limit 50 m); the app is told how far.
  await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: r.driver, payload: north(r.spot, 80) });
  const close = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/status`, headers: r.driver, payload: { status: 'arrived' } });
  assert.equal(close.statusCode, 409);
  assert.ok(close.json().distanceM >= 75 && close.json().distanceM <= 85, close.body);
  assert.equal(close.json().maxDistanceM, 50);
  // 40 m away is fine.
  await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: r.driver, payload: north(r.spot, 40) });
  const near = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/status`, headers: r.driver, payload: { status: 'arrived' } });
  assert.equal(near.statusCode, 200, near.body);

  const terms = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/cancel-terms`, headers: r.pax })).json();
  assert.equal(terms.feeTiyin, 500_000, 'economy: 5 000 sum');

  // Without confirming the exact fee nothing happens.
  const unconfirmed = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: {} });
  assert.equal(unconfirmed.statusCode, 409);
  assert.equal(unconfirmed.json().feeTiyin, 500_000);
  const wrong = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: { acceptFeeTiyin: 100 } });
  assert.equal(wrong.statusCode, 409);
  assert.equal((await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: r.pax })).json().status, 'arrived');

  const paid = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: { acceptFeeTiyin: 500_000 } });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.deepEqual(paid.json().cancelFee, { amountTiyin: 500_000, status: 'pending' });
  // The ride price itself is untouched.
  assert.equal(paid.json().priceTiyin, r.offer.priceTiyin);
  await s.app.close();
});

test('cancel: driver no-show only after waiting 5 minutes; plain driver cancel is free', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived']);

  const early = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.driver, payload: { noShow: true } });
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().error, 'too_early_for_no_show');
  assert.ok(early.json().noShowFrom);

  // A passenger cannot claim a no-show.
  const paxNoShow = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: { noShow: true } });
  assert.equal(paxNoShow.statusCode, 400);

  await db.query(`UPDATE ride_events SET at = now() - interval '6 minutes' WHERE ride_id = $1 AND type = 'status:arrived'`, [r.rideId]);
  const noShow = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.driver, payload: { noShow: true } });
  assert.equal(noShow.statusCode, 200, noShow.body);
  assert.equal(noShow.json().cancelReason, 'no_show');
  assert.equal(noShow.json().cancelFee.amountTiyin, 500_000);

  // The driver cancels at the pickup for another reason: the passenger pays nothing.
  const r2 = await acceptedRide(s);
  await drive(s, r2.driver, r2.rideId, ['driver_en_route', 'arrived']);
  const plain = await s.app.inject({ method: 'POST', url: `/rides/${r2.rideId}/cancel`, headers: r2.driver, payload: { reason: 'flat tyre' } });
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.json().cancelFee, null);
  await s.app.close();
});

test('cancel fee: class amounts stay within 5 000–10 000 sum; a moderator can waive it', { skip }, async () => {
  const fees = await db.query(`SELECT code, cancel_fee_tiyin::int AS fee FROM vehicle_classes ORDER BY fee`);
  for (const f of fees.rows) assert.ok(f.fee >= 500_000 && f.fee <= 1_000_000, f.code);
  await assert.rejects(db.query(`UPDATE vehicle_classes SET cancel_fee_tiyin = 5000000 WHERE code = 'economy'`));

  const s = await setup();
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived']);
  await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: { acceptFeeTiyin: 500_000 } });

  // The passenger says the driver was at the wrong entrance; the driver disagrees.
  const opened = await s.app.inject({
    method: 'POST', url: `/rides/${r.rideId}/dispute`, headers: r.pax,
    payload: { category: 'cancellation', text: 'Driver waited at the wrong entrance, not where I was.' },
  });
  assert.equal(opened.statusCode, 201);
  await s.app.inject({
    method: 'POST', url: `/rides/${r.rideId}/dispute/statement`, headers: r.driver,
    payload: { text: 'I was exactly at the pin, waited and called twice.' },
  });
  const mod = await admin(s);
  const res = await s.app.inject({
    method: 'POST', url: `/admin/disputes/${opened.json().id}/resolve`, headers: mod,
    payload: { outcome: 'passenger', resolution: 'Pin was on the other side of the building.', waiveCancelFee: true },
  });
  assert.equal(res.statusCode, 200, res.body);
  const view = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: r.pax })).json();
  assert.equal(view.cancelFee.status, 'waived');
  await s.app.close();
});
