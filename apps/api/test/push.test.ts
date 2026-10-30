// Push notifications (outbox -> sender) and safe retries of an order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pushTick } from '../src/push/outbox.ts';
import type { PushMessage, PushResult, PushSender } from '../src/push/sender.ts';
import { db, setup, skip, type Setup } from './helpers.ts';
import { clearMap, drive, north, onlineDriver, passenger, randomSpot, type Headers } from './rideHelpers.ts';

class Capture implements PushSender {
  readonly name = 'capture';
  sent: PushMessage[] = [];
  gone = new Set<string>();
  fail = false;
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (this.fail) throw new Error('push service down');
    this.sent.push(...messages);
    return messages.map((m) => (this.gone.has(m.to) ? { ok: false, error: 'DeviceNotRegistered', deviceGone: true } : { ok: true }));
  }
  take(): PushMessage[] { const out = this.sent; this.sent = []; return out; }
}

const token = () => `ExponentPushToken[${randomUUID().replace(/-/g, '').slice(0, 22)}]`;
async function register(s: Setup, h: Headers, app: 'driver' | 'passenger', t = token()) {
  const res = await s.app.inject({ method: 'POST', url: '/me/push-token', headers: h, payload: { token: t, app, platform: 'android' } });
  assert.equal(res.statusCode, 204, res.body);
  return t;
}
/** Sends everything pending (other tests leave rows in the outbox; one tick handles 100). */
async function drain(push: PushSender) { while ((await pushTick(db, push)) > 0); }
/** Only this test's messages. */
const to = (msgs: PushMessage[], t: string) => msgs.filter((m) => m.to === t);

async function order(s: Setup, pax: Headers, spot: { lat: number; lng: number }, key?: string) {
  const q = (await s.app.inject({ method: 'POST', url: '/quotes', headers: pax, payload: { stops: [spot, north(spot, 6000)] } }))
    .json().classes.find((c: { code: string }) => c.code === 'economy');
  return s.app.inject({
    method: 'POST', url: '/rides', headers: { ...pax, ...(key ? { 'idempotency-key': key } : {}) },
    payload: { classCode: 'economy', stops: [spot, north(spot, 6000)], priority: 'fast', maxPriceTiyin: q.options[0]?.priceTiyin ?? q.maxFareTiyin },
  });
}

test('push: new order rings the driver; the passenger hears accepted and arrived, in their language', { skip }, async () => {
  const s = await setup();
  const push = new Capture();
  await clearMap();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 400));
  const pax = await passenger(s);
  await s.app.inject({ method: 'PATCH', url: '/me', headers: pax, payload: { language: 'ru' } });
  const dt = await register(s, driver, 'driver');
  const pt = await register(s, pax, 'passenger');

  const ride = (await order(s, pax, spot)).json();
  await drain(push);
  const [alert] = to(push.take(), dt);
  assert.ok(alert, 'the driver got the order');
  assert.equal(alert.channelId, 'orders', 'the loud channel');
  assert.equal(alert.data.kind, 'new_order');
  assert.equal(alert.data.rideId, ride.id);
  assert.ok(alert.ttl <= 20, 'useless after the accept window');
  assert.match(alert.body, /km|км/);
  assert.equal(JSON.stringify(alert).includes('+998'), false, 'no phone numbers on a lock screen');

  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  await drain(push);
  const [accepted] = to(push.take(), pt);
  assert.equal(accepted!.title, 'Водитель едет');
  assert.match(accepted!.body, /[0-9]{2}/, 'the car and plate');

  await drive(s, driver, ride.id, ['driver_en_route', 'arrived']);
  await drain(push);
  assert.deepEqual(to(push.take(), pt).map((m) => m.data.kind), ['driver_arrived']);

  // Sent once: another tick sends nothing new.
  await drain(push);
  assert.equal(to(push.take(), pt).length + to(push.take(), dt).length, 0);
  await s.app.close();
});

test('push: passenger cancels -> driver told; stale order alerts are dropped; retries when the service is down', { skip }, async () => {
  const s = await setup();
  const push = new Capture();
  await clearMap();
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 300));
  const pax = await passenger(s);
  const dt = await register(s, driver, 'driver');

  // The push service is down: nothing is lost, it is retried.
  await drain(push);
  push.take();
  push.fail = true;
  const ride = (await order(s, pax, spot)).json();
  await pushTick(db, push);
  push.fail = false;
  await drain(push);
  assert.equal(to(push.take(), dt).length, 1, 'delivered on the retry');

  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/cancel`, headers: pax, payload: {} });
  await drain(push);
  assert.deepEqual(to(push.take(), dt).map((m) => m.data.kind), ['ride_cancelled']);

  // An order alert older than its window is never sent.
  const pax2 = await passenger(s);
  await order(s, pax2, spot);
  await db.query(`UPDATE push_outbox SET expires_at = now() - interval '1 second' WHERE sent_at IS NULL AND kind = 'new_order'`);
  await drain(push);
  assert.equal(to(push.take(), dt).length, 0);
  await s.app.close();
});

test('push tokens: valid format only, move with sign-in, dead devices are dropped', { skip }, async () => {
  const s = await setup();
  const push = new Capture();
  const a = await passenger(s);
  const b = await passenger(s);
  const bad = await s.app.inject({ method: 'POST', url: '/me/push-token', headers: a, payload: { token: 'https://evil', app: 'passenger', platform: 'ios' } });
  assert.equal(bad.statusCode, 400);

  // The same phone signs in to another account: notifications follow the new account only.
  const t = await register(s, a, 'passenger');
  await register(s, b, 'passenger', t);
  const owner = (await db.query(`SELECT user_id FROM push_tokens WHERE token = $1`, [t])).rows[0].user_id;
  const bId = (await s.app.inject({ method: 'GET', url: '/me', headers: b })).json().id;
  assert.equal(owner, bId);

  // A device the push service no longer knows is revoked.
  push.gone.add(t);
  await db.query(`INSERT INTO push_outbox (user_id, app, kind, payload, expires_at) VALUES ($1, 'passenger', 'driver_arrived', '{}', now() + interval '1 minute')`, [bId]);
  await drain(push);
  assert.ok((await db.query(`SELECT revoked_at FROM push_tokens WHERE token = $1`, [t])).rows[0].revoked_at);

  // Sign-out on the device.
  const t2 = await register(s, a, 'passenger');
  assert.equal((await s.app.inject({ method: 'DELETE', url: '/me/push-token', headers: a, payload: { token: t2 } })).statusCode, 204);
  assert.ok((await db.query(`SELECT revoked_at FROM push_tokens WHERE token = $1`, [t2])).rows[0].revoked_at);
  await s.app.close();
});

test('order retry with the same key returns the same ride; a new key is a new order', { skip }, async () => {
  const s = await setup();
  await clearMap();
  const spot = randomSpot();
  await onlineDriver(s, north(spot, 300));
  const pax = await passenger(s);
  const key = randomUUID();
  const [a, b] = await Promise.all([order(s, pax, spot, key), order(s, pax, spot, key)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 201], `${a.body} ${b.body}`);
  assert.equal(a.json().id, b.json().id, 'one ride');
  const again = await order(s, pax, spot, key);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().id, a.json().id);
  // A different order while one is active is still refused.
  assert.equal((await order(s, pax, spot, randomUUID())).statusCode, 409);
  assert.equal((await order(s, pax, spot, 'not-a-key')).statusCode, 400);
  const n = await db.query(`SELECT count(*)::int AS n FROM rides WHERE idempotency_key = $1`, [key]);
  assert.equal(n.rows[0].n, 1);
  await s.app.close();
});
