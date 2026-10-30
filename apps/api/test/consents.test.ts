// Consent: no order, application or shift before the current offer / agreement and privacy policy are
// accepted; a new version asks again; an outdated version cannot be "accepted".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip } from './helpers.ts';
import { north, randomSpot } from './rideHelpers.ts';
import { LEGAL_VERSIONS } from '../src/legal/documents.ts';

test('a new passenger accepts the offer and policy before ordering', { skip }, async () => {
  const s = await setup();
  const auth = { authorization: `Bearer ${await s.loginOnly(randomPhone())}` };
  const spot = randomSpot();
  const order = () => s.app.inject({
    method: 'POST', url: '/rides', headers: auth, payload: { classCode: 'economy', mode: 'choose', stops: [spot, north(spot, 4000)] },
  });
  const refused = await order();
  assert.equal(refused.statusCode, 428);
  assert.deepEqual(refused.json().documents.map((d: { code: string }) => d.code), ['passenger_offer', 'privacy']);
  assert.match(refused.json().documents[0].url, /\/legal\/passenger_offer\.html$/);

  const needed = (await s.app.inject({ method: 'GET', url: '/me/consents?app=passenger', headers: auth })).json().needed;
  assert.equal(needed.length, 2);
  const stale = await s.app.inject({ method: 'POST', url: '/me/consents', headers: auth, payload: { accept: [{ code: 'privacy', version: '2020-01-01' }] } });
  assert.equal(stale.statusCode, 409, 'nobody accepts a text they were not shown');
  const ok = await s.app.inject({ method: 'POST', url: '/me/consents', headers: auth, payload: { accept: needed.map((d: { code: string; version: string }) => ({ code: d.code, version: d.version })) } });
  assert.equal(ok.statusCode, 204);
  assert.deepEqual((await s.app.inject({ method: 'GET', url: '/me/consents?app=passenger', headers: auth })).json().needed, []);
  assert.equal((await order()).statusCode, 201);

  const me = (await s.app.inject({ method: 'GET', url: '/me', headers: auth })).json();
  const rows = await db.query(`SELECT document, version, ip IS NOT NULL AS has_ip FROM user_consents WHERE user_id = $1 ORDER BY document`, [me.id]);
  assert.deepEqual(rows.rows, [
    { document: 'passenger_offer', version: LEGAL_VERSIONS.passenger_offer, has_ip: true },
    { document: 'privacy', version: LEGAL_VERSIONS.privacy, has_ip: true },
  ]);
  await s.app.close();
});

test('drivers accept the agreement before applying; a new version is asked before the next shift', { skip }, async () => {
  const s = await setup();
  const auth = { authorization: `Bearer ${await s.loginOnly(randomPhone())}` };
  const apply = await s.app.inject({ method: 'POST', url: '/drivers/apply', headers: auth, payload: { name: 'Aziz' } });
  assert.equal(apply.statusCode, 428);
  assert.deepEqual(apply.json().documents.map((d: { code: string }) => d.code), ['driver_agreement', 'privacy']);

  // A driver who accepted an older version: going online asks again.
  const me = (await s.app.inject({ method: 'GET', url: '/me', headers: auth })).json();
  await db.query(`INSERT INTO user_consents (user_id, document, version) VALUES ($1, 'driver_agreement', 'old'), ($1, 'privacy', $2)`, [me.id, LEGAL_VERSIONS.privacy]);
  const online = await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: auth, payload: randomSpot() });
  assert.equal(online.statusCode, 428);
  assert.deepEqual(online.json().documents.map((d: { code: string }) => d.code), ['driver_agreement']);
  assert.equal((await s.app.inject({ method: 'GET', url: '/legal' })).json().documents.length, 3);
  await s.app.close();
});
