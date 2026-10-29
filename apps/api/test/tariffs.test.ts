// Integration tests: classes, driver tariffs with corridor and cooldown, quotes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip } from './helpers.ts';

type Setup = Awaited<ReturnType<typeof setup>>;

async function verifiedDriver({ app, login }: Setup): Promise<Record<string, string>> {
  const auth = { authorization: `Bearer ${await login(randomPhone())}` };
  const driver = await app.inject({ method: 'POST', url: '/drivers/apply', headers: auth, payload: { name: 'Aziz' } });
  const vehicle = await app.inject({
    method: 'POST', url: '/drivers/me/vehicles', headers: auth,
    payload: { makeModel: 'Chevrolet Cobalt', year: 2022, color: 'white', plate: '01A123BC' },
  });
  for (const type of ['passport', 'license', 'vehicle_registration', 'selfie', 'self_employed']) {
    await app.inject({ method: 'POST', url: '/drivers/me/documents', headers: auth, payload: { type, fileUrl: `https://files.example/${type}.jpg` } });
  }
  const adminPhone = randomPhone();
  const adminAuth = { authorization: `Bearer ${await login(adminPhone)}` };
  await db.query(`UPDATE users SET roles = roles || ARRAY['admin'] WHERE phone = $1`, [adminPhone]);
  const ok = await app.inject({
    method: 'POST', url: `/admin/drivers/${driver.json().id}/approve`, headers: adminAuth,
    payload: { vehicleId: vehicle.json().id, classCode: 'economy' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  return auth;
}

test('classes are public and carry the corridor', { skip }, async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/classes' });
  const economy = res.json().find((c: { code: string }) => c.code === 'economy');
  assert.deepEqual(economy.corridor, { minPct: -20, maxPct: 0 });
  await app.close();
});

test('driver tariff: corridor, versioning, once a day', { skip }, async () => {
  const s = await setup();
  const auth = await verifiedDriver(s);

  const initial = await s.app.inject({ method: 'GET', url: '/drivers/me/tariff', headers: auth });
  assert.equal(initial.statusCode, 200, initial.body);
  const { current, bounds, recommended } = initial.json();
  assert.equal(current.version, 0, 'starts from the recommended tariff');

  const tooHigh = await s.app.inject({
    method: 'PUT', url: '/drivers/me/tariff', headers: auth,
    payload: { ...recommended, perKmTiyin: bounds.perKmTiyin.max + 1 },
  });
  assert.equal(tooHigh.statusCode, 400, 'cannot be more expensive than the reference');

  const tooLow = await s.app.inject({
    method: 'PUT', url: '/drivers/me/tariff', headers: auth,
    payload: { ...recommended, baseTiyin: bounds.baseTiyin.min - 1 },
  });
  assert.equal(tooLow.statusCode, 400, 'cannot drop below the floor');

  const cheaper = {
    baseTiyin: bounds.baseTiyin.min, perKmTiyin: bounds.perKmTiyin.min,
    perMinTiyin: bounds.perMinTiyin.min, minFareTiyin: bounds.minFareTiyin.min,
  };
  const set = await s.app.inject({ method: 'PUT', url: '/drivers/me/tariff', headers: auth, payload: cheaper });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().version, 1);

  const again = await s.app.inject({ method: 'PUT', url: '/drivers/me/tariff', headers: auth, payload: recommended });
  assert.equal(again.statusCode, 429, 'one change per 24 hours');

  const extra = await s.app.inject({ method: 'PUT', url: '/drivers/me/tariff', headers: auth, payload: { ...cheaper, version: 99 } });
  assert.equal(extra.statusCode, 400, 'unknown fields are rejected');
  await s.app.close();
});

test('unverified driver has no tariff', { skip }, async () => {
  const { app, login } = await setup();
  const auth = { authorization: `Bearer ${await login(randomPhone())}` };
  await app.inject({ method: 'POST', url: '/drivers/apply', headers: auth, payload: { name: 'Dilnoza' } });
  const res = await app.inject({ method: 'GET', url: '/drivers/me/tariff', headers: auth });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('quote: route from the server, price range per class', { skip }, async () => {
  const { app, login } = await setup();
  const auth = { authorization: `Bearer ${await login(randomPhone())}` };
  const res = await app.inject({
    method: 'POST', url: '/quotes', headers: auth,
    // Chilanzar -> Yunusabad, roughly
    payload: { stops: [{ lat: 41.2856, lng: 69.2034 }, { lat: 41.3653, lng: 69.2867 }] },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.route.distanceM > 5000);
  for (const c of body.classes) {
    assert.ok(c.minFareTiyin <= c.maxFareTiyin);
    assert.equal(c.maxFareTiyin % 50_000, 0, 'rounded to 500 sum');
  }
  await app.close();
});
