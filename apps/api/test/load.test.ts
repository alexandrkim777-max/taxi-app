// Dispatch under load: many drivers on the line in one district, many one-tap orders at the same
// moment, two dispatcher instances, every driver polling and accepting in parallel.
// LOAD_DRIVERS / LOAD_RIDES scale it up (CI runs the default size).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip, staffLogin, type Setup } from './helpers.ts';
import { clearMap, north, type Headers } from './rideHelpers.ts';
import { dispatchTick } from '../src/dispatch/matching.ts';

const DRIVERS = Number(process.env.LOAD_DRIVERS ?? 80);
const RIDES = Number(process.env.LOAD_RIDES ?? 50);
const CENTER = { lat: 41.3111, lng: 69.2797 };

function near(i: number, spreadM: number) {
  const a = (i * 2.399963) % (2 * Math.PI); // golden-angle spiral: spread evenly, deterministic
  const r = spreadM * Math.sqrt((i + 1) / DRIVERS);
  return { lat: CENTER.lat + (r * Math.cos(a)) / 111_000, lng: CENTER.lng + (r * Math.sin(a)) / 83_000 };
}

async function driverOnline(s: Setup, admin: Headers, at: { lat: number; lng: number }): Promise<Headers> {
  const auth = { authorization: `Bearer ${await s.login(randomPhone())}` };
  const applied = await s.app.inject({ method: 'POST', url: '/drivers/apply', headers: auth, payload: { name: 'Load' } });
  const vehicle = await s.app.inject({
    method: 'POST', url: '/drivers/me/vehicles', headers: auth,
    payload: { makeModel: 'Chevrolet Cobalt', year: 2022, color: 'white', plate: '01A123BC' },
  });
  await Promise.all(['passport', 'license', 'vehicle_registration', 'selfie', 'self_employed'].map((type) =>
    s.app.inject({ method: 'POST', url: '/drivers/me/documents', headers: auth, payload: { type, fileUrl: `https://files.example/${type}.jpg` } })));
  const ok = await s.app.inject({
    method: 'POST', url: `/admin/drivers/${applied.json().id}/approve`, headers: admin,
    payload: { vehicleId: vehicle.json().id, classCode: 'economy' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const online = await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: auth, payload: at });
  assert.equal(online.statusCode, 200, online.body);
  return auth;
}

function p95(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.at(Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))) ?? 0;
}

test(`load: ${DRIVERS} drivers, ${RIDES} orders at once — every order served, nobody double-booked`, { skip, timeout: 300_000 }, async () => {
  const s = await setup();
  await clearMap();
  const admin = (await staffLogin(s, 'admin')).headers;

  const drivers: Headers[] = [];
  for (let i = 0; i < DRIVERS; i += 10) {
    drivers.push(...await Promise.all(Array.from({ length: Math.min(10, DRIVERS - i) }, (_, k) => driverOnline(s, admin, near(i + k, 2500)))));
  }
  const passengers = await Promise.all(Array.from({ length: RIDES }, async () => ({ authorization: `Bearer ${await s.login(randomPhone())}` })));

  // Everyone taps "order" at the same moment.
  const createMs: number[] = [];
  const created = await Promise.all(passengers.map(async (pax, i) => {
    const spot = near(i * 3, 1500);
    const stops = [spot, north(spot, 6000)];
    const q = (await s.app.inject({ method: 'POST', url: '/quotes', headers: pax, payload: { stops } })).json();
    const fast = q.classes.find((c: { code: string }) => c.code === 'economy').options.at(-1);
    const t0 = performance.now();
    const res = await s.app.inject({
      method: 'POST', url: '/rides', headers: pax,
      payload: { classCode: 'economy', stops, priority: 'fast', maxPriceTiyin: fast.priceTiyin },
    });
    createMs.push(performance.now() - t0);
    assert.equal(res.statusCode, 201, res.body);
    return res.json().id as string;
  }));

  const violations: string[] = [];
  async function checkInvariants(round: number) {
    const twoRequests = await db.query(
      `SELECT driver_id FROM ride_offers WHERE status = 'chosen' AND expires_at > now() GROUP BY driver_id HAVING count(*) > 1`,
    );
    const twoRides = await db.query(
      `SELECT driver_id FROM rides WHERE status IN ('accepted', 'driver_en_route', 'arrived', 'in_progress')
        GROUP BY driver_id HAVING count(*) > 1`,
    );
    const busyWithRequest = await db.query(
      `SELECT o.driver_id FROM ride_offers o JOIN rides r ON r.driver_id = o.driver_id
        WHERE o.status = 'chosen' AND o.expires_at > now() AND r.status IN ('accepted', 'driver_en_route', 'arrived', 'in_progress')`,
    );
    if (twoRequests.rowCount) violations.push(`round ${round}: a driver holds two requests`);
    if (twoRides.rowCount) violations.push(`round ${round}: a driver has two rides`);
    if (busyWithRequest.rowCount) violations.push(`round ${round}: a driver on a ride is asked again`);
  }

  // Rounds: two dispatcher instances tick at once, then every driver polls and accepts at once.
  const acceptMs: number[] = [];
  let accepted = 0;
  for (let round = 0; round < 12 && accepted < RIDES; round++) {
    await Promise.all([dispatchTick(db), dispatchTick(db)]);
    await checkInvariants(round);
    const results = await Promise.all(drivers.map(async (d) => {
      const reqs = (await s.app.inject({ method: 'GET', url: '/drivers/me/requests', headers: d })).json();
      if (!reqs.length) return 0;
      const t0 = performance.now();
      const res = await s.app.inject({ method: 'POST', url: `/rides/${reqs[0].rideId}/accept`, headers: d });
      acceptMs.push(performance.now() - t0);
      return res.statusCode === 200 ? 1 : 0;
    }));
    accepted += results.reduce<number>((a, b) => a + b, 0);
    await checkInvariants(round);
  }

  const states = await db.query(`SELECT status, count(*)::int AS n FROM rides WHERE id = ANY($1) GROUP BY status`, [created]);
  const byStatus = Object.fromEntries(states.rows.map((r) => [r.status, r.n]));
  console.log(`# load: ${DRIVERS} drivers, ${RIDES} rides; statuses ${JSON.stringify(byStatus)}; ` +
    `order p95 ${p95(createMs).toFixed(0)} ms, accept p95 ${p95(acceptMs).toFixed(0)} ms`);
  assert.deepEqual(violations, []);
  assert.equal(byStatus.accepted, RIDES, 'every order found a driver');
  const drivenBy = await db.query(`SELECT count(DISTINCT driver_id)::int AS n FROM rides WHERE id = ANY($1)`, [created]);
  assert.equal(drivenBy.rows[0].n, RIDES, 'each ride has its own driver');

  // Leave the map clean for the next tests.
  await db.query(`UPDATE rides SET status = 'cancelled', cancelled_by = 'system', cancel_reason = 'test_cleanup' WHERE id = ANY($1)`, [created]);
  await clearMap();
  await s.app.close();
});
