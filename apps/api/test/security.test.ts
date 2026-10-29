// Security regression tests: rate limits, brute force, input boundaries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip } from './helpers.ts';

test('per-IP limit on login code requests', { skip }, async () => {
  const { app } = await setup({ rateLimit: true });
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone: randomPhone(), language: 'uz' } });
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes.slice(0, 5), [204, 204, 204, 204, 204]);
  assert.equal(codes[5], 429, 'sixth request from one IP within a minute is refused');
  await app.close();
});

test('parallel guesses cannot exceed 5 attempts per code', { skip }, async () => {
  const { app, sms } = await setup();
  const phone = randomPhone();
  await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'uz' } });
  const real = sms.last.get(phone)!;
  const wrong = real === '000000' ? '000001' : '000000';

  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code: wrong } }),
    ),
  );
  const counted = results.filter((r) => r.json().error === 'wrong_code').length;
  assert.equal(counted, 5, 'only 5 guesses are evaluated');

  const late = await app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code: real } });
  assert.equal(late.statusCode, 400, 'the code is burned after 5 wrong attempts');
  await app.close();
});

test('per-phone hourly cap on codes', { skip }, async () => {
  const { app } = await setup();
  const phone = randomPhone();
  await db.query(
    `INSERT INTO auth_codes (phone, code_hash, expires_at, created_at)
     SELECT $1, 'x', now(), now() - interval '10 minutes' FROM generate_series(1, 5)`,
    [phone],
  );
  const res = await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'uz' } });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, 'too_many_codes');
  await app.close();
});

test('a code works only once', { skip }, async () => {
  const { app, sms } = await setup();
  const phone = randomPhone();
  await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'uz' } });
  const code = sms.last.get(phone);
  const [a, b] = await Promise.all([
    app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code } }),
    app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code } }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 400]);
  await app.close();
});

test('input boundaries', { skip }, async () => {
  const { app, login } = await setup();
  const auth = { authorization: `Bearer ${await login(randomPhone())}` };

  // Protected endpoints need a valid token.
  assert.equal((await app.inject({ method: 'GET', url: '/me' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer forged' } })).statusCode, 401);

  // Unknown fields are not accepted where the schema forbids them.
  await app.inject({ method: 'POST', url: '/drivers/apply', headers: auth, payload: { name: 'Bobur' } });
  const foreignFile = await app.inject({
    method: 'POST', url: '/drivers/me/documents', headers: auth,
    payload: { type: 'passport', fileUrl: 'https://evil.example/passport.jpg' },
  });
  assert.equal(foreignFile.statusCode, 400, 'only links into our own storage');

  // A malformed id is a 400, not a database error.
  const adminPhone = randomPhone();
  const adminAuth = { authorization: `Bearer ${await login(adminPhone)}` };
  await db.query(`UPDATE users SET roles = roles || ARRAY['admin'] WHERE phone = $1`, [adminPhone]);
  const bad = await app.inject({
    method: 'POST', url: `/admin/drivers/not-a-uuid/approve`, headers: adminAuth,
    payload: { vehicleId: 'x', classCode: 'economy' },
  });
  assert.equal(bad.statusCode, 400);

  // Quotes are limited to Uzbekistan.
  const abroad = await app.inject({
    method: 'POST', url: '/quotes', headers: auth,
    payload: { stops: [{ lat: 48.85, lng: 2.35 }, { lat: 48.86, lng: 2.36 }] },
  });
  assert.equal(abroad.statusCode, 400);
  await app.close();
});
