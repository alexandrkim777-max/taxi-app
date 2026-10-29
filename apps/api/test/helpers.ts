// Shared helpers for API integration tests. They need a migrated database at
// DATABASE_URL; tests are skipped when it is not set.

import { after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import type { SmsSender } from '../src/sms/index.ts';
import { EstimateRouteProvider } from '../src/routing/index.ts';

const databaseUrl = process.env.DATABASE_URL;
export const skip = !databaseUrl && 'DATABASE_URL is not set';

export const db = new pg.Pool({ connectionString: databaseUrl });
after(() => db.end());

class CapturingSms implements SmsSender {
  last = new Map<string, string>();
  async send(phone: string, text: string): Promise<void> {
    this.last.set(phone, text.match(/\d{6}/)![0]);
  }
}

export function randomPhone(): string {
  return `+99890${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
}

export async function setup(opts: { rateLimit?: boolean } = {}) {
  const sms = new CapturingSms();
  const app = await buildApp({
    db, sms, authSecret: 'test-secret', routes: new EstimateRouteProvider(),
    fileBaseUrl: 'https://files.example/', cityCode: 'tashkent', rateLimit: opts.rateLimit ?? false,
  });
  async function login(phone: string): Promise<string> {
    const req = await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'ru' } });
    assert.equal(req.statusCode, 204);
    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code: sms.last.get(phone) } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().token;
  }
  return { app, sms, login };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

/** A verified economy driver with documents, a vehicle and the free trial. Returns auth headers. */
export async function verifiedDriver({ app, login }: Setup): Promise<Record<string, string>> {
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
