// Integration tests: admin panel — price coefficient, dossiers, blocks, complaints, roles, audit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip, verifiedDriver, type Setup } from './helpers.ts';
import { acceptedRide, drive, north, passenger, randomSpot, type Headers } from './rideHelpers.ts';

async function staff(s: Setup, role: 'admin' | 'support'): Promise<Headers & { userId: string }> {
  const phone = randomPhone();
  const token = await s.login(phone);
  const { rows } = await db.query(`UPDATE users SET roles = roles || ARRAY[$2] WHERE phone = $1 RETURNING id`, [phone, role]);
  return { authorization: `Bearer ${token}`, userId: rows[0].id };
}

function hdr(h: Headers & { userId?: string }): Headers {
  return { authorization: h.authorization! };
}

async function economyQuote(s: Setup, auth: Headers, spot: { lat: number; lng: number }) {
  const res = await s.app.inject({ method: 'POST', url: '/quotes', headers: auth, payload: { stops: [spot, north(spot, 8000)] } });
  return res.json().classes.find((c: { code: string }) => c.code === 'economy');
}

test('price coefficient: raise / lower for the city or one class, new orders only, admin only', { skip }, async () => {
  const s = await setup();
  const admin = await staff(s, 'admin');
  const support = await staff(s, 'support');
  const pax = await passenger(s);
  const spot = randomSpot();
  const created: string[] = [];
  try {
    const base = await economyQuote(s, pax, spot);
    assert.equal(base.coefficient, 1);

    const set = (h: Headers, payload: object) => s.app.inject({ method: 'POST', url: '/admin/pricing/coefficients', headers: hdr(h), payload });
    assert.equal((await set(support, { value: 1.2, reason: 'rain' })).statusCode, 403, 'support cannot change prices');
    assert.equal((await set(pax, { value: 1.2, reason: 'rain' })).statusCode, 403);
    assert.equal((await set(admin, { value: 2.0, reason: 'too much' })).statusCode, 400, 'hard upper bound 1.50');
    assert.equal((await set(admin, { value: 0.5, reason: 'too low' })).statusCode, 400, 'hard lower bound 0.70');
    assert.equal((await set(admin, { value: 1.2 })).statusCode, 400, 'a reason is required');

    const city = await set(admin, { value: 1.2, reason: 'Heavy rain' });
    assert.equal(city.statusCode, 201, city.body);
    created.push(city.json().id);
    const up = await economyQuote(s, pax, spot);
    assert.equal(up.coefficient, 1.2);
    assert.ok(Math.abs(up.maxFareTiyin - base.maxFareTiyin * 1.2) <= 50_000, `${up.maxFareTiyin} vs ${base.maxFareTiyin}`);

    // A ride ordered now keeps this coefficient even after prices go back to normal.
    const ride = await acceptedRideAt(s, pax, spot);
    const cls = await set(admin, { value: 0.9, reason: 'Economy promo', classCode: 'economy' });
    created.push(cls.json().id);
    assert.equal((await economyQuote(s, pax, spot)).coefficient, 0.9, 'a class value beats the city value');
    const stored = await db.query(`SELECT price_coefficient::float AS k FROM rides WHERE id = $1`, [ride]);
    assert.equal(stored.rows[0].k, 1.2);

    // A future window is not active yet.
    const later = await set(admin, { value: 1.4, reason: 'New Year', validFrom: new Date(Date.now() + 3600_000).toISOString() });
    created.push(later.json().id);
    assert.equal((await economyQuote(s, pax, spot)).coefficient, 0.9);

    const pricing = (await s.app.inject({ method: 'GET', url: '/admin/pricing', headers: hdr(support) })).json();
    assert.equal(pricing.classes.find((c: { code: string }) => c.code === 'economy').coefficient, 0.9);

    const log = (await s.app.inject({ method: 'GET', url: `/admin/audit?targetType=price_coefficient&targetId=${city.json().id}`, headers: hdr(admin) })).json();
    assert.equal(log[0].action, 'price_coefficient_set');
  } finally {
    // Back to normal for the other tests.
    for (const id of created) {
      const res = await s.app.inject({ method: 'POST', url: `/admin/pricing/coefficients/${id}/end`, headers: hdr(admin) });
      assert.equal(res.statusCode, 200, res.body);
    }
  }
  assert.equal((await economyQuote(s, pax, spot)).coefficient, 1);
  await s.app.close();
});

/** A list-mode ride ordered by `pax` near `spot` and accepted; returns the ride id. */
async function acceptedRideAt(s: Setup, pax: Headers, spot: { lat: number; lng: number }): Promise<string> {
  const { onlineDriver, offerOf } = await import('./rideHelpers.ts');
  const driver = await onlineDriver(s, north(spot, 100));
  const ride = (await s.app.inject({
    method: 'POST', url: '/rides', headers: pax, payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 8000)] },
  })).json();
  const offer = await offerOf(s, ride, driver);
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  return ride.id;
}

test('class tariffs and fees: admin only, bounded, audited with the old values', { skip }, async () => {
  const s = await setup();
  const admin = await staff(s, 'admin');
  const before = (await s.app.inject({ method: 'GET', url: '/admin/pricing', headers: hdr(admin) })).json()
    .classes.find((c: { code: string }) => c.code === 'comfort');
  const put = (payload: object) => s.app.inject({ method: 'PUT', url: '/admin/pricing/classes/comfort', headers: hdr(admin), payload });
  assert.equal((await put({ reason: 'test', cancelFeeTiyin: 5_000_000 })).statusCode, 400, 'fees stay within 5 000–10 000 sum');
  assert.equal((await put({ reason: 'test' })).statusCode, 400, 'nothing to change');
  assert.equal((await put({ reason: 'calibration', waitPerMinTiyin: 60_000 })).statusCode, 200);
  const log = (await s.app.inject({ method: 'GET', url: '/admin/audit?targetType=vehicle_class', headers: hdr(admin) })).json();
  assert.equal(log[0].payload.before.waitPerMinTiyin, before.waitPerMinTiyin);
  await put({ reason: 'restore', waitPerMinTiyin: before.waitPerMinTiyin });
  await s.app.close();
});

test('driver dossier: phone, car, documents, numbers — staff only, and every view is logged', { skip }, async () => {
  const s = await setup();
  const support = await staff(s, 'support');
  const admin = await staff(s, 'admin');
  const driver = await verifiedDriver(s);
  const me = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json();

  assert.equal((await s.app.inject({ method: 'GET', url: `/admin/drivers/${me.id}/dossier`, headers: driver })).statusCode, 403);
  const dossier = (await s.app.inject({ method: 'GET', url: `/admin/drivers/${me.id}/dossier`, headers: hdr(support) })).json();
  assert.match(dossier.phone, /^\+998/);
  assert.equal(dossier.vehicles[0].plate, '01A123BC');
  assert.equal(dossier.documents.length, 5);
  assert.ok(dossier.subscriptionUntil, 'trial month');
  assert.equal(dossier.stats.completed, 0);

  // Search by plate (spaces and case do not matter).
  const plate = `01X${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}${'ABCDEFGH'[Math.floor(Math.random() * 8)]}Z`;
  await db.query(`UPDATE vehicles SET plate = $2 WHERE driver_id = $1`, [me.id, plate]);
  const found = (await s.app.inject({ method: 'GET', url: `/admin/search?q=${encodeURIComponent(plate.toLowerCase().replace(/^(..)/, '$1 '))}`, headers: hdr(support) })).json();
  assert.ok(found.some((f: { driverId: string }) => f.driverId === me.id));

  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/audit', headers: hdr(support) })).statusCode, 403, 'audit log is admin only');
  const log = (await s.app.inject({ method: 'GET', url: `/admin/audit?targetType=driver&targetId=${me.id}`, headers: hdr(admin) })).json();
  assert.equal(log[0].action, 'driver_dossier_viewed');

  // A bad document photo: rejected, the driver must upload it again.
  const doc = dossier.documents.find((d: { type: string }) => d.type === 'license');
  const rej = await s.app.inject({ method: 'POST', url: `/admin/drivers/${me.id}/documents/${doc.id}/reject`, headers: hdr(support), payload: { note: 'Photo is blurry' } });
  assert.equal(rej.statusCode, 200);
  assert.deepEqual(rej.json().missingDocuments, ['license']);
  const own = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json();
  assert.deepEqual(own.rejections, [{ type: 'license', note: 'Photo is blurry' }], 'the driver sees why');

  // The audit log cannot be edited, not even directly in the database.
  await assert.rejects(db.query(`UPDATE admin_audit_log SET action = 'nothing' WHERE id = $1`, [log[0].id]), /append-only/);
  await assert.rejects(db.query(`DELETE FROM admin_audit_log WHERE id = $1`, [log[0].id]), /append-only/);
  await s.app.close();
});

test('block and unblock: a blocked driver is off the map and cannot go online', { skip }, async () => {
  const s = await setup();
  const support = await staff(s, 'support');
  const driver = await verifiedDriver(s);
  const spot = randomSpot();
  await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: driver, payload: spot });
  const userId = (await s.app.inject({ method: 'GET', url: '/me', headers: driver })).json().id;

  assert.equal((await s.app.inject({ method: 'POST', url: `/admin/users/${support.userId}/block`, headers: hdr(support), payload: { reason: 'oops' } })).statusCode, 409, 'not yourself');
  const block = await s.app.inject({ method: 'POST', url: `/admin/users/${userId}/block`, headers: hdr(support), payload: { reason: 'Fake documents', days: 7 } });
  assert.equal(block.statusCode, 204);
  const presence = await db.query(`SELECT 1 FROM driver_presence p JOIN drivers d ON d.id = p.driver_id WHERE d.user_id = $1`, [userId]);
  assert.equal(presence.rows.length, 0);
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: driver, payload: spot })).statusCode, 403);

  assert.equal((await s.app.inject({ method: 'POST', url: `/admin/users/${userId}/unblock`, headers: hdr(support), payload: { reason: 'Documents verified again' } })).statusCode, 204);
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: driver, payload: spot })).statusCode, 200);
  await s.app.close();
});

test('complaints: filed by participants, safety first in the queue, resolved with a block', { skip }, async () => {
  const s = await setup();
  const support = await staff(s, 'support');
  const r = await acceptedRide(s);
  await drive(s, r.driver, r.rideId, ['driver_en_route', 'arrived', 'in_progress', 'completed']);
  const stranger = await passenger(s);

  const file = (h: Headers, payload: object) => s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/complaint`, headers: h, payload });
  assert.equal((await file(stranger, { type: 'rude', text: 'not even my ride' })).statusCode, 404);
  const filed = await file(r.pax, { type: 'asked_extra_cash', text: 'Asked for 10 000 more in cash at the end' });
  assert.equal(filed.statusCode, 201, filed.body);
  assert.equal((await file(r.pax, { type: 'asked_extra_cash', text: 'Asked again' })).statusCode, 409);
  assert.equal((await file(r.pax, { type: 'made_up', text: 'whatever' })).statusCode, 400);

  const queue = (await s.app.inject({ method: 'GET', url: '/admin/complaints?status=open', headers: hdr(support) })).json();
  const mine = queue.find((c: { id: string }) => c.id === filed.json().id);
  assert.equal(mine.severity, 'safety');
  assert.equal(queue[0].severity, 'safety', 'safety complaints come first');
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/complaints', headers: r.pax })).statusCode, 403);

  const detail = (await s.app.inject({ method: 'GET', url: `/admin/complaints/${mine.id}`, headers: hdr(support) })).json();
  assert.ok(detail.rideEvents.some((e: { type: string }) => e.type === 'status:completed'));
  assert.equal((await s.app.inject({ method: 'POST', url: `/admin/complaints/${mine.id}/assign`, headers: hdr(support) })).statusCode, 200);
  const resolved = await s.app.inject({
    method: 'POST', url: `/admin/complaints/${mine.id}/resolve`, headers: hdr(support),
    payload: { status: 'resolved', resolution: 'Confirmed by the passenger and a second report', action: 'block', blockDays: 7 },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal((await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: r.driver, payload: r.spot })).statusCode, 403, 'driver blocked');
  const again = await s.app.inject({
    method: 'POST', url: `/admin/complaints/${mine.id}/resolve`, headers: hdr(support),
    payload: { status: 'rejected', resolution: 'Changing my mind' },
  });
  assert.equal(again.statusCode, 409);
  await s.app.close();
});

test('staff roles: only admins grant them, nobody removes their own admin', { skip }, async () => {
  const s = await setup();
  const admin = await staff(s, 'admin');
  const support = await staff(s, 'support');
  const someone = await passenger(s);
  const someoneId = (await s.app.inject({ method: 'GET', url: '/me', headers: someone })).json().id;

  const put = (h: Headers, id: string, roles: string[]) => s.app.inject({ method: 'PUT', url: `/admin/users/${id}/roles`, headers: hdr(h), payload: { roles } });
  assert.equal((await put(support, someoneId, ['support'])).statusCode, 403);
  assert.equal((await put(admin, someoneId, ['superuser'])).statusCode, 400);
  const granted = await put(admin, someoneId, ['support']);
  assert.deepEqual(granted.json().roles, ['passenger', 'support']);
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/dashboard', headers: someone })).statusCode, 200, 'new support member works at once');
  assert.equal((await put(admin, admin.userId, ['passenger'])).statusCode, 409);
  await put(admin, someoneId, ['passenger']);
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/dashboard', headers: someone })).statusCode, 403, 'and loses access at once');
  await s.app.close();
});

test('dashboard for staff, finance for admins', { skip }, async () => {
  const s = await setup();
  const admin = await staff(s, 'admin');
  const support = await staff(s, 'support');
  const dash = (await s.app.inject({ method: 'GET', url: '/admin/dashboard', headers: hdr(support) })).json();
  for (const k of ['live', 'today', 'queues', 'coefficients']) assert.ok(k in dash, k);
  assert.equal(typeof dash.queues.safetyComplaints, 'number');
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/finance', headers: hdr(support) })).statusCode, 403);
  const fin = (await s.app.inject({ method: 'GET', url: '/admin/finance?days=7', headers: hdr(admin) })).json();
  assert.ok(Array.isArray(fin.payments));
  await s.app.close();
});
