// Integration test: needs a migrated database at DATABASE_URL. Skipped when it is not set.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import type { SmsSender } from '../src/sms/index.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl && 'DATABASE_URL is not set';

const db = new pg.Pool({ connectionString: databaseUrl });
after(() => db.end());

class CapturingSms implements SmsSender {
  last = new Map<string, string>();
  async send(phone: string, text: string): Promise<void> {
    this.last.set(phone, text.match(/\d{6}/)![0]);
  }
}

function randomPhone(): string {
  return `+99890${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
}

async function setup() {
  const sms = new CapturingSms();
  const app = await buildApp({ db, sms, authSecret: 'test-secret' });
  async function login(phone: string): Promise<string> {
    const req = await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'ru' } });
    assert.equal(req.statusCode, 204);
    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code: sms.last.get(phone) } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().token;
  }
  return { app, sms, login };
}

test('SMS login: wrong code, cooldown, success, /me, logout', { skip }, async () => {
  const { app, sms, login } = await setup();
  const phone = randomPhone();

  assert.equal((await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone: '12345' } })).statusCode, 400);

  await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone } });
  const again = await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone } });
  assert.equal(again.statusCode, 429, 'resend is rate limited');

  const wrong = await app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code: '000000' === sms.last.get(phone) ? '111111' : '000000' } });
  assert.equal(wrong.statusCode, 400);

  const ok = await app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code: sms.last.get(phone) } });
  assert.equal(ok.statusCode, 200);
  const token = ok.json().token;

  const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.json().phone, phone);

  await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
  const after = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.statusCode, 401, 'token is revoked');

  assert.ok(login, 'helper available');
  await app.close();
});

test('driver registration and moderation', { skip }, async () => {
  const { app, login } = await setup();
  const driverToken = await login(randomPhone());
  const auth = { authorization: `Bearer ${driverToken}` };

  const applied = await app.inject({ method: 'POST', url: '/drivers/apply', headers: auth, payload: { name: 'Aziz', languages: ['uz', 'ru'] } });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().status, 'pending');
  assert.equal(applied.json().missingDocuments.length, 5);

  const vehicle = await app.inject({
    method: 'POST', url: '/drivers/me/vehicles', headers: auth,
    payload: { makeModel: 'Chevrolet Cobalt', year: 2022, color: 'white', plate: '01 a 123 bc' },
  });
  assert.equal(vehicle.statusCode, 201);
  assert.equal(vehicle.json().plate, '01A123BC');

  // Admin cannot approve before all documents are uploaded.
  const adminPhone = randomPhone();
  const adminToken = await login(adminPhone);
  await db.query(`UPDATE users SET roles = roles || ARRAY['admin'] WHERE phone = $1`, [adminPhone]);
  const adminAuth = { authorization: `Bearer ${adminToken}` };
  const driverId = applied.json().id;

  const early = await app.inject({
    method: 'POST', url: `/admin/drivers/${driverId}/approve`, headers: adminAuth,
    payload: { vehicleId: vehicle.json().id, classCode: 'economy' },
  });
  assert.equal(early.statusCode, 409);

  for (const type of ['passport', 'license', 'vehicle_registration', 'selfie', 'self_employed']) {
    const doc = await app.inject({
      method: 'POST', url: '/drivers/me/documents', headers: auth,
      payload: { type, fileUrl: `https://files.example/${type}.jpg` },
    });
    assert.equal(doc.statusCode, 201);
  }

  // A driver cannot moderate.
  const forbidden = await app.inject({ method: 'GET', url: '/admin/drivers', headers: auth });
  assert.equal(forbidden.statusCode, 403);

  const approved = await app.inject({
    method: 'POST', url: `/admin/drivers/${driverId}/approve`, headers: adminAuth,
    payload: { vehicleId: vehicle.json().id, classCode: 'economy' },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().status, 'verified');
  assert.equal(approved.json().vehicles[0].class_code, 'economy');

  const trial = await db.query(
    `SELECT p.code FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.driver_id = $1`,
    [driverId],
  );
  assert.equal(trial.rows[0].code, 'trial', 'approval starts the free trial month');
  await app.close();
});
