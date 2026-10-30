// Staff panel sign-in: SMS + authenticator app, httpOnly cookie session, CSRF header, idle
// timeout, replay protection, and phone-app tokens shut out of staff endpoints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip, staffLogin, type Setup } from './helpers.ts';
import { base32Encode, currentStep, totpAt, verifyTotp } from '../src/auth/totp.ts';
import { STAFF_COOKIE } from '../src/auth/session.ts';

test('TOTP matches the RFC 6238 test vector and refuses reuse', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totpAt(secret, 1), '287082'); // T = 59 s
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  const now = 59_000;
  assert.equal(verifyTotp(secret, '287082', null, now), 1);
  assert.equal(verifyTotp(secret, '287082', 1, now), null, 'the same step twice');
  assert.equal(verifyTotp(secret, '000000', null, now), null);
  assert.equal(verifyTotp(secret, '28708', null, now), null);
});

async function smsStep(s: Setup, phone: string) {
  // Tests sign in again right away; skip the one-SMS-a-minute limit.
  await db.query(`DELETE FROM auth_codes WHERE phone = $1`, [phone]);
  await s.app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'ru' } });
  return s.app.inject({ method: 'POST', url: '/staff/auth/verify', payload: { phone, code: s.sms.last.get(phone) } });
}

test('phone-app tokens never reach staff endpoints, even for an admin', { skip }, async () => {
  const s = await setup();
  const admin = await staffLogin(s, 'admin');
  await db.query(`DELETE FROM auth_codes WHERE phone = $1`, [admin.phone]);
  const appToken = await s.login(admin.phone);
  const res = await s.app.inject({ method: 'GET', url: '/admin/dashboard', headers: { authorization: `Bearer ${appToken}` } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'staff_session_required');
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/dashboard', headers: admin.headers })).statusCode, 200);
  // The panel cookie is httpOnly, Secure, SameSite=Strict, host-only.
  const again = await smsStep(s, admin.phone);
  const fin = await s.app.inject({
    method: 'POST', url: '/staff/auth/totp',
    payload: { ticket: again.json().ticket, code: totpAt(admin.secret, currentStep() + 1) },
  });
  const cookie = String(fin.headers['set-cookie']);
  assert.match(cookie, new RegExp(`^${STAFF_COOKIE}=`));
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(attr), attr);
  assert.ok(!/Domain=/i.test(cookie));
  await s.app.close();
});

test('a staff cookie without the CSRF header cannot change anything', { skip }, async () => {
  const s = await setup();
  const admin = await staffLogin(s, 'admin');
  const target = await s.login(randomPhone());
  const me = (await s.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${target}` } })).json();
  const res = await s.app.inject({
    method: 'POST', url: `/admin/users/${me.id}/block`, headers: { cookie: admin.headers.cookie! }, payload: { reason: 'cross-site try' },
  });
  assert.equal(res.statusCode, 401);
  // Reading with the cookie alone is fine (the panel's GETs).
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/dashboard', headers: { cookie: admin.headers.cookie! } })).statusCode, 200);
  await s.app.close();
});

test('only staff get past the SMS step; a code works once; five wrong codes burn the ticket', { skip }, async () => {
  const s = await setup();
  const outsider = randomPhone();
  await db.query(`INSERT INTO users (phone) VALUES ($1)`, [outsider]);
  assert.equal((await smsStep(s, outsider)).statusCode, 403);

  const admin = await staffLogin(s, 'support');
  const step = admin.step; // the step whose code was just used (not "now": a 30 s boundary may have passed)
  // Signed in with the code of the current step: that code cannot sign in again.
  const replay = await smsStep(s, admin.phone);
  assert.equal(replay.json().next, 'totp');
  assert.equal(replay.json().secret, undefined, 'the secret is shown only at setup');
  const reused = await s.app.inject({ method: 'POST', url: '/staff/auth/totp', payload: { ticket: replay.json().ticket, code: totpAt(admin.secret, step) } });
  assert.equal(reused.statusCode, 400);

  const burn = await smsStep(s, admin.phone);
  for (let i = 0; i < 5; i++) {
    await s.app.inject({ method: 'POST', url: '/staff/auth/totp', payload: { ticket: burn.json().ticket, code: '000000' } });
  }
  const late = await s.app.inject({ method: 'POST', url: '/staff/auth/totp', payload: { ticket: burn.json().ticket, code: totpAt(admin.secret, step + 1) } });
  assert.equal(late.statusCode, 400);
  assert.equal(late.json().error, 'ticket_invalid_or_expired');
  await s.app.close();
});

test('idle for 30 minutes, logged out, demoted or reset: the panel session is gone', { skip }, async () => {
  const s = await setup();
  const admin = await staffLogin(s, 'admin');
  const idle = await staffLogin(s, 'support');
  await db.query(`UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE user_id = $1 AND kind = 'staff'`, [idle.userId]);
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/dashboard', headers: idle.headers })).statusCode, 401);

  const out = await staffLogin(s, 'support');
  assert.equal((await s.app.inject({ method: 'POST', url: '/staff/auth/logout', headers: out.headers })).statusCode, 204);
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/dashboard', headers: out.headers })).statusCode, 401);

  const demoted = await staffLogin(s, 'support');
  await s.app.inject({ method: 'PUT', url: `/admin/users/${demoted.userId}/roles`, headers: admin.headers, payload: { roles: ['passenger'] } });
  assert.equal((await s.app.inject({ method: 'GET', url: '/me', headers: demoted.headers })).statusCode, 401);

  const lost = await staffLogin(s, 'support');
  assert.equal((await s.app.inject({
    method: 'POST', url: `/admin/users/${admin.userId}/reset-2fa`, headers: admin.headers, payload: { reason: 'self' },
  })).statusCode, 409);
  const reset = await s.app.inject({
    method: 'POST', url: `/admin/users/${lost.userId}/reset-2fa`, headers: admin.headers, payload: { reason: 'Phone lost' },
  });
  assert.equal(reset.statusCode, 204);
  assert.equal((await s.app.inject({ method: 'GET', url: '/admin/dashboard', headers: lost.headers })).statusCode, 401);
  assert.equal((await smsStep(s, lost.phone)).json().next, 'totp_setup');
  const log = await db.query(`SELECT action FROM admin_audit_log WHERE target_id = $1 ORDER BY id`, [lost.userId]);
  assert.deepEqual(log.rows.map((r) => r.action), ['staff_2fa_enabled', 'staff_2fa_reset']);
  await s.app.close();
});
