// The road route the apps draw: taken from OSRM's geometry (checked, never trusted blindly), kept with
// the ride, replaced on a route change, visible only to the ride's passenger and driver.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setup, skip } from './helpers.ts';
import { acceptedRide, north, passenger } from './rideHelpers.ts';
import { OsrmRouteProvider } from '../src/routing/index.ts';

async function fakeOsrm(answer: unknown): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test('OSRM geometry becomes the line; a broken geometry is dropped, the price still works', async () => {
  const good = await fakeOsrm({
    code: 'Ok', routes: [{ distance: 5234.4, duration: 701.2, geometry: { type: 'LineString', coordinates: [[69.24, 41.29], [69.2412345678, 41.3], [69.25, 41.31]] } }],
  });
  const r = await new OsrmRouteProvider(good.url).route([{ lat: 41.29, lng: 69.24 }, { lat: 41.31, lng: 69.25 }]);
  assert.deepEqual(r, { distanceM: 5234, durationS: 701, line: [[69.24, 41.29], [69.241235, 41.3], [69.25, 41.31]] });
  good.server.close();

  for (const coordinates of [[[69.24, 41.29]], [[69.24, 'x'], [1, 2]], [[200, 41], [69, 41]], 'nope', Array.from({ length: 2001 }, () => [69, 41])]) {
    const bad = await fakeOsrm({ code: 'Ok', routes: [{ distance: 1000, duration: 100, geometry: { coordinates } }] });
    const res = await new OsrmRouteProvider(bad.url).route([{ lat: 41.29, lng: 69.24 }, { lat: 41.31, lng: 69.25 }]);
    assert.deepEqual(res, { distanceM: 1000, durationS: 100 });
    bad.server.close();
  }
});

test('the ride keeps its line; a route change replaces it; strangers cannot read it', { skip }, async () => {
  const s = await setup();
  const r = await acceptedRide(s);
  const first = await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/route`, headers: r.pax });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().version, 0);
  assert.equal(first.json().line.length, 2);
  const [a, b] = first.json().line;
  assert.ok(Math.abs(a[1] - r.spot.lat) < 1e-5 && Math.abs(a[0] - r.spot.lng) < 1e-5, 'starts at the pickup, [lng, lat]');
  assert.ok(b[1] > a[1], 'goes north to the destination');
  assert.deepEqual((await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/route`, headers: r.driver })).json(), first.json());

  const stranger = await passenger(s);
  assert.equal((await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/route`, headers: stranger })).statusCode, 404);

  const withStop = [r.spot, { lat: north(r.spot, 3000).lat, lng: r.spot.lng + 0.02 }, north(r.spot, 6000)];
  const p = (await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/route/preview`, headers: r.pax, payload: { stops: withStop } })).json();
  const ok = await s.app.inject({ method: 'POST', url: `/rides/${r.rideId}/route`, headers: r.pax, payload: { stops: withStop, priceTiyin: p.newPriceTiyin } });
  assert.equal(ok.statusCode, 200, ok.body);
  const after = (await s.app.inject({ method: 'GET', url: `/rides/${r.rideId}/route`, headers: r.pax })).json();
  assert.equal(after.version, 1, 'the apps see the version change and fetch the new line');
  assert.equal(after.line.length, 3);
  await s.app.close();
});
