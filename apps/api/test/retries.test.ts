// A phone on a bad network repeats a request whose answer got lost. The repeat must give the same
// result and never do the work twice (second fee, second charge, second event).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, setup, skip } from './helpers.ts';
import { acceptedRide, drive } from './rideHelpers.ts';

async function events(rideId: string, type: string) {
  return (await db.query(`SELECT count(*)::int AS n FROM ride_events WHERE ride_id = $1 AND type = $2`, [rideId, type])).rows[0].n as number;
}

test('retried accept, status and completion: same answer, done once', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  const again = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/accept`, headers: r.driver });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().status, 'accepted');
  assert.equal(await events(r.rideId, 'status:accepted'), 1);

  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  for (const status of ['in_progress', 'completed']) {
    const res = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/status`, headers: r.driver, payload: { status } });
    // Going back is still refused; repeating the current step is accepted.
    if (status === 'completed') assert.equal(res.statusCode, 200, res.body);
    else assert.equal(res.statusCode, 409);
  }
  assert.equal(await events(r.rideId, 'status:completed'), 1);
  await s.app.close();
});

test('retried cancel: no second fee and no second event; the other side cannot "repeat" it', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  const first = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: {} });
  assert.equal(first.statusCode, 200, first.body);
  const again = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.pax, payload: {} });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().status, 'cancelled');
  assert.equal(await events(r.rideId, 'status:cancelled'), 1);
  // The driver did not cancel it: for them it is not a repeat.
  assert.equal((await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/cancel`, headers: r.driver, payload: {} })).statusCode, 409);
  await s.app.close();
});
