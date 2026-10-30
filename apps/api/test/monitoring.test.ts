// Error monitoring: grouped by kind, scrubbed of personal data, alerts only for new or returning kinds,
// visible to admins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import { EstimateRouteProvider } from '../src/routing/index.ts';
import { db, payments, setup, skip, staffLogin, testFiles } from './helpers.ts';
import { ErrorMonitor, fingerprintOf, scrub, type Alerter } from '../src/monitoring/errors.ts';
import type { SmsSender } from '../src/sms/index.ts';

test('scrub cuts phones, tokens, cards and emails; ids and numbers do not split a kind', () => {
  const dirty = 'Failed for +998 90 123-45-67 / 901234567 Bearer abc.DEF-123 card 8600 1234 5678 9012 mail a.b@c.uz';
  assert.equal(scrub(dirty), 'Failed for [phone] / [phone] Bearer [token] card [card] mail [email]');
  const a = fingerprintOf({ source: 'api', message: `Ride ${randomUUID()} not found after 3 tries` });
  const b = fingerprintOf({ source: 'api', message: `Ride ${randomUUID()} not found after 7 tries` });
  assert.equal(a, b);
  assert.notEqual(a, fingerprintOf({ source: 'driver', message: 'Ride x not found after 3 tries' }));
});

test('apps report crashes: one row per kind, counted, scrubbed; admins see and resolve; a return alerts again', { skip }, async () => {
  const alerts: string[] = [];
  const alerter: Alerter = { async notify(text) { alerts.push(text); } };
  const monitor = new ErrorMonitor(db, alerter, 'test');
  const sms: SmsSender = { async send() {} } as SmsSender;
  const app = await buildApp({
    db, sms, payments: payments(), files: testFiles, authSecret: 'test-secret', routes: new EstimateRouteProvider(),
    fileBaseUrl: 'https://files.example/', cityCode: 'tashkent', rateLimit: false, monitor,
  });
  const marker = randomUUID().slice(0, 8);
  const report = (message: string) => app.inject({
    method: 'POST', url: '/client-errors',
    payload: { app: 'passenger', message, stack: `Error: x\n    at Order (Order.tsx:12:3) call +998901234567`, appVersion: '0.1.0', platform: 'android', screen: `order${marker}` },
  });
  assert.equal((await report(`Cannot read property price of undefined, user +998901234567 ${marker}`)).statusCode, 204);
  assert.equal((await report(`Cannot read property price of undefined, user +998901234567 ${marker}`)).statusCode, 204);
  const bad = await app.inject({ method: 'POST', url: '/client-errors', payload: { app: 'hacker', message: 'x' } });
  assert.equal(bad.statusCode, 400);

  const rows = (await db.query(`SELECT id, count, message, stack FROM error_events WHERE context->>'screen' = $1`, [`order${marker}`])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.ok(!rows[0].message.includes('998901234567') && rows[0].message.includes('[phone]'));
  assert.ok(!rows[0].stack.includes('998901234567'));
  assert.equal(alerts.length, 1, 'alert on the first one only');

  // Staff panel: admins only.
  const s = await setup();
  const support = await staffLogin(s, 'support');
  const admin = await staffLogin(s, 'admin');
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/errors', headers: support.headers })).statusCode, 403);
  const list = (await s.app.inject({ method: 'GET', url: '/admin/errors', headers: admin.headers })).json();
  assert.ok(list.some((e: { id: string }) => String(e.id) === String(rows[0].id)));
  assert.equal((await s.app.inject({ method: 'POST', url: `/admin/errors/${rows[0].id}/resolve`, headers: admin.headers })).statusCode, 204);

  await report(`Cannot read property price of undefined, user +998901234567 ${marker}`);
  const back = (await db.query(`SELECT resolved_at, count FROM error_events WHERE id = $1`, [rows[0].id])).rows[0];
  assert.equal(back.resolved_at, null, 'it came back');
  assert.equal(alerts.length, 2);
  assert.match(alerts[1]!, /Error is back/);
  await app.close();
  await s.app.close();
});

test('a server error (500) is recorded with its route, never shown to the client', { skip }, async () => {
  const monitor = new ErrorMonitor(db);
  const app = await buildApp({
    db, sms: { async send() {} } as SmsSender, payments: payments(), files: testFiles, authSecret: 'test-secret',
    routes: new EstimateRouteProvider(), fileBaseUrl: 'https://files.example/', cityCode: 'tashkent', rateLimit: false, monitor,
  });
  const marker = randomUUID().slice(0, 8);
  app.get(`/boom-${marker}`, async () => { throw new Error(`database exploded ${marker}`); });
  const res = await app.inject({ method: 'GET', url: `/boom-${marker}` });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'internal_error' });
  await new Promise((r) => setTimeout(r, 50)); // recorded in the background
  const row = (await db.query(`SELECT source, context FROM error_events WHERE message = $1`, [`database exploded ${marker}`])).rows[0];
  assert.deepEqual(row, { source: 'api', context: { route: `GET /boom-${marker}`, status: 500 } });
  await app.close();
});
