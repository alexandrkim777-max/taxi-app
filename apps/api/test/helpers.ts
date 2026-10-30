// Shared helpers for API integration tests. They need a migrated database at
// DATABASE_URL; tests are skipped when it is not set.

import { after } from 'node:test';
import { randomInt } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import type { SmsSender } from '../src/sms/index.ts';
import { EstimateRouteProvider } from '../src/routing/index.ts';
import { PaymentService } from '../src/payments/service.ts';
import { FakeProvider } from '../src/payments/providers/fake.ts';
import { FakeFiscalProvider } from '../src/payments/fiscal.ts';
import { DEV_TOKEN_KEY } from '../src/payments/crypto.ts';
import { FileService, LocalFileStorage } from '../src/files/index.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentStep, totpAt } from '../src/auth/totp.ts';
import { LEGAL_VERSIONS } from '../src/legal/documents.ts';
import { CSRF_HEADER, CSRF_VALUE, STAFF_COOKIE } from '../src/auth/session.ts';

export const testFiles = new FileService({
  storage: new LocalFileStorage(mkdtempSync(join(tmpdir(), 'taxi-files-'))),
  secret: 'test-file-secret', publicApiUrl: 'http://api.test',
});

export const fakeProvider = new FakeProvider({ secret: 'test-fake-secret', baseUrl: 'http://localhost:3000' });

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

/**
 * A phone number no other test has used: +998 0XXXXXXXX (no real operator code starts with 0, so it can
 * never be someone's number). Each test file (its own process) starts at a random point of the
 * 100-million range and counts up, so files and runs never collide in practice (a few hundred numbers
 * each). Fully random numbers used to repeat now and then and hit the one-SMS-a-minute limit; a
 * clock-based start collided when CI started several files in the same second.
 */
let phoneSeq = randomInt(0, 100_000_000);
export function randomPhone(): string {
  phoneSeq = (phoneSeq + 1) % 100_000_000;
  return `+9980${String(phoneSeq).padStart(8, '0')}`;
}

let service: PaymentService | null = null;
/** The payment service the test apps use (fake provider). */
export function payments(): PaymentService {
  service ??= new PaymentService({
    db, providers: new Map([['fake', fakeProvider]]), tokenKey: DEV_TOKEN_KEY, fiscal: new FakeFiscalProvider(),
    log: { warn() {}, error() {} },
  });
  return service;
}

export async function setup(opts: { rateLimit?: boolean } = {}) {
  const sms = new CapturingSms();
  const app = await buildApp({
    db, sms, payments: payments(), files: testFiles, devRoutes: true, authSecret: 'test-secret', routes: new EstimateRouteProvider(),
    fileBaseUrl: 'https://files.example/', cityCode: 'tashkent', rateLimit: opts.rateLimit ?? false,
  });
  /** Signs in by SMS without accepting any legal text (a brand-new user). */
  async function loginOnly(phone: string): Promise<string> {
    const req = await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'ru' } });
    assert.equal(req.statusCode, 204);
    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code: sms.last.get(phone) } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().token;
  }
  /** Signs in and accepts the current offer, driver agreement and privacy policy, as the apps do. */
  async function login(phone: string): Promise<string> {
    const token = await loginOnly(phone);
    const accept = Object.entries(LEGAL_VERSIONS).map(([code, version]) => ({ code, version }));
    const res = await app.inject({ method: 'POST', url: '/me/consents', headers: { authorization: `Bearer ${token}` }, payload: { accept } });
    assert.equal(res.statusCode, 204, res.body);
    return token;
  }
  return { app, sms, login, loginOnly };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * A staff member signed in to the panel the real way: SMS code, authenticator set up on the first
 * sign-in, session cookie. Returns the headers the panel sends (cookie + CSRF header).
 */
export async function staffLogin(s: Setup, role: 'admin' | 'support' = 'admin', phone = randomPhone()) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (phone, roles) VALUES ($1, ARRAY['passenger', $2])
     ON CONFLICT (phone) DO UPDATE SET roles = array(SELECT DISTINCT unnest(users.roles || ARRAY[$2]))
     RETURNING id`,
    [phone, role],
  );
  const sent = await s.app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'ru' } });
  assert.equal(sent.statusCode, 204, sent.body);
  const first = await s.app.inject({ method: 'POST', url: '/staff/auth/verify', payload: { phone, code: s.sms.last.get(phone) } });
  assert.equal(first.statusCode, 200, first.body);
  const { ticket, secret } = first.json();
  assert.ok(secret, 'first sign-in sets up the authenticator');
  const step = currentStep();
  const second = await s.app.inject({ method: 'POST', url: '/staff/auth/totp', payload: { ticket, code: totpAt(secret, step) } });
  assert.equal(second.statusCode, 200, second.body);
  const token = String(second.headers['set-cookie']).match(new RegExp(`${STAFF_COOKIE}=([^;]+)`))![1];
  const headers: Record<string, string> = { cookie: `${STAFF_COOKIE}=${token}`, [CSRF_HEADER]: CSRF_VALUE };
  return { headers, userId: rows[0]!.id, phone, secret: secret as string, step };
}

/** A verified economy driver with documents, a vehicle and the free trial. Returns auth headers. */
export async function verifiedDriver(s: Setup): Promise<Record<string, string>> {
  const { app, login } = s;
  const auth = { authorization: `Bearer ${await login(randomPhone())}` };
  const driver = await app.inject({ method: 'POST', url: '/drivers/apply', headers: auth, payload: { name: 'Aziz' } });
  const vehicle = await app.inject({
    method: 'POST', url: '/drivers/me/vehicles', headers: auth,
    payload: { makeModel: 'Chevrolet Cobalt', year: 2022, color: 'white', plate: '01A123BC' },
  });
  for (const type of ['passport', 'license', 'vehicle_registration', 'selfie', 'self_employed']) {
    await app.inject({ method: 'POST', url: '/drivers/me/documents', headers: auth, payload: { type, fileUrl: `https://files.example/${type}.jpg` } });
  }
  const adminAuth = (await staffLogin(s, 'admin')).headers;
  const ok = await app.inject({
    method: 'POST', url: `/admin/drivers/${driver.json().id}/approve`, headers: adminAuth,
    payload: { vehicleId: vehicle.json().id, classCode: 'economy' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  return auth;
}
