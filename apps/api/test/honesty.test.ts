// Integration tests for the honesty rules: the price changes only when the passenger changes
// the route and confirms; disputes where both sides write what happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip, type Setup } from './helpers.ts';
import { acceptedRide, createRide, drive, north, offerOf, passenger, type Headers } from './rideHelpers.ts';

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
      const c = await confirm(s, pax, rideId, stops, p.json().newPriceTiyin);
      assert.equal(c.statusCode, 200, c.body);
    } else {
      assert.equal(p.statusCode, 429);
    }
  }
  await s.app.close();
});

test('the database refuses any other reason for a price change', { skip }, async () => {
  const { rows } = await db.query(`SELECT id FROM rides LIMIT 1`);
  await assert.rejects(
    db.query(`INSERT INTO price_changes (ride_id, reason, amount_tiyin, confirmed_by_passenger) VALUES ($1, 'surge', 500000, true)`, [rows[0].id]),
    /price_changes_reason_check/,
  );
  // A route change is never stored without the passenger's confirmation.
  await assert.rejects(
    db.query(`INSERT INTO price_changes (ride_id, reason, amount_tiyin) VALUES ($1, 'stop_added', 500000)`, [rows[0].id]),
    /price_changes_confirmation/,
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
// Waiting and cancellation (Yandex-style)

/** Moves a logged event back in time, to simulate minutes passing. */
async function ago(rideId: string, type: string, minutes: number): Promise<void> {
  await db.query(
    `UPDATE ride_events SET at = now() - make_interval(secs => $3) WHERE ride_id = $1 AND type = $2`,
    [rideId, type, Math.round(minutes * 60)],
  );
}

test('cancel on the way: free for 3 minutes, then half the fee', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route']);
  const t0 = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/cancel-terms`, headers: r.pax })).json();
  assert.equal(t0.feeTiyin, 0);
  assert.ok(t0.freeUntil, 'the app can show "free until"');

  await ago(r.rideId, 'status:accepted', 4);
  const t1 = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/cancel-terms`, headers: r.pax })).json();
  assert.equal(t1.feeTiyin, 250_000, 'economy: half of 5 000 sum');

  const unconfirmed = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: {} });
  assert.equal(unconfirmed.statusCode, 409);
  assert.equal(unconfirmed.json().feeTiyin, 250_000);
  const ok = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: { acceptFeeTiyin: 250_000 } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json().cancelFee, { amountTiyin: 250_000, status: 'pending' });
  await s.app.close();
});

test('arrival within 200 m; cancel at the pickup = fee + paid waiting', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route']);

  // "Arrived" far from the pickup is refused, so drivers cannot farm fees; the app is told how far.
  await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: r.driver, payload: north(r.spot, 300) });
  const far = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/status`, headers: r.driver, payload: { status: 'arrived' } });
  assert.equal(far.statusCode, 409);
  assert.equal(far.json().error, 'not_at_pickup');
  assert.ok(far.json().distanceM >= 290 && far.json().distanceM <= 310, far.body);
  assert.equal(far.json().maxDistanceM, 200);
  await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: r.driver, payload: north(r.spot, 150) });
  const near = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/status`, headers: r.driver, payload: { status: 'arrived' } });
  assert.equal(near.statusCode, 200, near.body);

  // Free waiting for 2 minutes.
  let view = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: r.pax })).json();
  assert.equal(view.waiting.paidMinutes, 0);
  assert.equal(view.waiting.ratePerMinTiyin, 50_000, 'economy: 500 sum per minute');
  const t0 = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/cancel-terms`, headers: r.pax })).json();
  assert.equal(t0.feeTiyin, 500_000);

  // 4.5 minutes in: 2 paid minutes.
  await ago(r.rideId, 'status:arrived', 4.5);
  view = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: r.driver })).json();
  assert.equal(view.waiting.paidMinutes, 2);
  assert.equal(view.waiting.accruedTiyin, 100_000);
  const t1 = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/cancel-terms`, headers: r.pax })).json();
  assert.deepEqual(t1.breakdown, { cancelTiyin: 500_000, waitingTiyin: 100_000 });

  // Confirming an older, lower amount is not enough; a higher ceiling charges the actual fee.
  const stale = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: { acceptFeeTiyin: 500_000 } });
  assert.equal(stale.statusCode, 409);
  const paid = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: { acceptFeeTiyin: 650_000 } });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().cancelFee.amountTiyin, 600_000);
  assert.equal(paid.json().priceTiyin, r.offer.priceTiyin, 'the ride price itself is untouched');
  await s.app.close();
});

test('paid waiting is added to the price when the trip starts, capped at 30 minutes', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived']);
  await ago(r.rideId, 'status:arrived', 5.2); // 3 paid minutes
  await drive(s, r.driver, r.rideId, ['in_progress']);
  const view = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}`, headers: r.pax })).json();
  assert.equal(view.priceTiyin, r.offer.priceTiyin + 150_000);
  assert.deepEqual(view.waiting, { paidMinutes: 3, chargedTiyin: 150_000 });
  const history = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/price-changes`, headers: r.pax })).json();
  assert.equal(history[0].reason, 'waiting');

  const r2 = await acceptedRide(s);
  await drive(s, r2.driver, r2.rideId, ['driver_en_route', 'arrived']);
  await ago(r2.rideId, 'status:arrived', 90);
  await drive(s, r2.driver, r2.rideId, ['in_progress']);
  const v2 = (await s.app.inject({ method: 'GET', url: `/rides/${r2.rideId}`, headers: r2.pax })).json();
  assert.equal(v2.waiting.paidMinutes, 30, 'never more than 30 paid minutes');
  await s.app.close();
});

test('no-show: after 5 minutes, still at the pickup; plain driver cancel is free', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived']);

  const early = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.driver, payload: { noShow: true } });
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().error, 'too_early_for_no_show');
  assert.ok(early.json().noShowFrom);
  const paxNoShow = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: { noShow: true } });
  assert.equal(paxNoShow.statusCode, 400, 'a passenger cannot claim a no-show');

  await ago(r.rideId, 'status:arrived', 6); // 4 paid minutes
  // Driving off and then claiming a no-show does not work.
  await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: r.driver, payload: north(r.spot, 500) });
  const gone = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.driver, payload: { noShow: true } });
  assert.equal(gone.statusCode, 409);
  assert.equal(gone.json().error, 'not_at_pickup');
  await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: r.driver, payload: r.spot });
  const noShow = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.driver, payload: { noShow: true } });
  assert.equal(noShow.statusCode, 200, noShow.body);
  assert.equal(noShow.json().cancelReason, 'no_show');
  assert.equal(noShow.json().cancelFee.amountTiyin, 500_000 + 4 * 50_000);

  const r2 = await acceptedRide(s);
  await drive(s, r2.driver, r2.rideId, ['driver_en_route', 'arrived']);
  const plain = await s.app.inject({ method: 'POST', url: `/rides/${r2.rideId}/cancel`, headers: r2.driver, payload: { reason: 'flat tyre' } });
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.json().cancelFee, null);
  await s.app.close();
});

test('a driver who cancels 3 rides within 2 hours is paused for 30 minutes', { skip }, async () => {
  const s = await setup();
  const first = await acceptedRide(s);
  const driver = first.driver;
  const driverId = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json().id;
  for (let i = 0; i < 3; i++) {
    const rideId = i === 0 ? first.rideId : await acceptRideFor(s, driver, first.spot);
    const res = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/cancel`, headers: driver, payload: { reason: 'changed my mind' } });
    assert.equal(res.statusCode, 200, res.body);
  }
  const online = await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: driver, payload: first.spot });
  assert.equal(online.statusCode, 423);
  assert.ok(online.json().pausedUntil);
  const presence = await db.query(`SELECT 1 FROM driver_presence WHERE driver_id = $1`, [driverId]);
  assert.equal(presence.rows.length, 0, 'taken off the map');
  await s.app.close();
});

/** A new passenger orders near the given spot and the given driver accepts. */
async function acceptRideFor(s: Setup, driver: Headers, spot: Point): Promise<string> {
  await s.app.inject({ method: 'POST', url: '/drivers/me/location', headers: driver, payload: north(spot, 100) });
  const pax = await passenger(s);
  const ride = (await createRide(s, pax, spot)).json();
  const offer = await offerOf(s, ride, driver);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  const res = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  assert.equal(res.statusCode, 200, res.body);
  return ride.id;
}

test('cancel fee: class amounts stay within 5 000–10 000 sum; a moderator can waive it', { skip }, async () => {
  const fees = await db.query(`SELECT code, cancel_fee_tiyin::int AS fee FROM vehicle_classes ORDER BY fee`);
  for (const f of fees.rows) assert.ok(f.fee >= 500_000 && f.fee <= 1_000_000, f.code);
  await assert.rejects(db.query(`UPDATE vehicle_classes SET cancel_fee_tiyin = 5000000 WHERE code = 'economy'`));

  const s = await setup();
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived']);
  await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: { acceptFeeTiyin: 1_000_000 } });

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
