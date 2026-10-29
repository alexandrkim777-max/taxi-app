// Integration tests: the language chosen on the first screen is the user's language everywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomPhone, setup, skip } from './helpers.ts';

test('language is chosen at login and used for labels; can be changed later', { skip }, async () => {
  const { app, sms } = await setup();
  const phone = randomPhone();
  const missing = await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone } });
  assert.equal(missing.statusCode, 400, 'the language must be chosen first');
  const wrong = await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'de' } });
  assert.equal(wrong.statusCode, 400);

  assert.equal((await app.inject({ method: 'POST', url: '/auth/request-code', payload: { phone, language: 'ru' } })).statusCode, 204);
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { phone, code: sms.last.get(phone) } });
  assert.equal(verify.json().user.language, 'ru');
  const auth = { authorization: `Bearer ${verify.json().token}` };

  const classes = (await app.inject({ method: 'GET', url: '/classes', headers: auth })).json();
  assert.equal(classes.find((c: { code: string }) => c.code === 'economy').name, 'Эконом');
  const tags = (await app.inject({ method: 'GET', url: '/rating-tags', headers: auth })).json();
  assert.equal(tags.language, 'ru');
  assert.equal(tags.positive.find((t: { code: string }) => t.code === 'careful_driving').label, 'Аккуратно водит');

  const changed = await app.inject({ method: 'PATCH', url: '/me', headers: auth, payload: { language: 'en' } });
  assert.equal(changed.json().language, 'en');
  const plans = (await app.inject({ method: 'GET', url: '/subscription-plans', headers: auth })).json();
  assert.equal(plans.plans.find((p: { code: string }) => p.code === 'week').name, 'Week');
  assert.equal((await app.inject({ method: 'PATCH', url: '/me', headers: auth, payload: { language: 'fr' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/me', headers: auth, payload: { roles: ['admin'] } })).statusCode, 400, 'no other fields');

  // Without a logged-in user: ?lang wins, then Accept-Language, then Uzbek.
  const anon = (await app.inject({ method: 'GET', url: '/classes', headers: { 'accept-language': 'en-US' } })).json();
  assert.equal(anon.find((c: { code: string }) => c.code === 'economy').name, 'Economy');
  const def = (await app.inject({ method: 'GET', url: '/classes' })).json();
  assert.equal(def.find((c: { code: string }) => c.code === 'economy').name, 'Ekonom');
  await app.close();
});
