// Integration tests: document photo upload, type checks, private signed links.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, randomPhone, setup, skip } from './helpers.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(2000, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.alloc(500, 1)]);

test('document photos: images only, private, served by short-lived signed links', { skip }, async () => {
  const s = await setup();
  const auth = { authorization: `Bearer ${await s.login(randomPhone())}` };
  const upload = (type: string, body: Buffer, contentType = 'image/jpeg', headers = auth) =>
    s.app.inject({ method: 'POST', url: `/drivers/me/documents/${type}/photo`, headers: { ...headers, 'content-type': contentType }, payload: body });

  assert.equal((await upload('passport', JPEG)).statusCode, 404, 'apply as a driver first');
  await s.app.inject({ method: 'POST', url: '/drivers/apply', headers: auth, payload: { name: 'Jasur' } });

  assert.equal((await upload('passport', JPEG)).statusCode, 201);
  assert.equal((await upload('license', PNG, 'image/png')).statusCode, 201);
  // A script or a PDF renamed to .jpg is refused by its bytes.
  assert.equal((await upload('selfie', Buffer.from('<script>alert(1)</script>'.padEnd(100, ' ')))).statusCode, 415);
  assert.equal((await upload('selfie', Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(100)]))).statusCode, 415);
  assert.equal((await upload('selfie', JPEG, 'text/html')).statusCode, 415, 'other content types are not accepted at all');
  assert.equal((await upload('diploma', JPEG)).statusCode, 400, 'unknown document type');
  assert.equal((await upload('selfie', Buffer.concat([JPEG, Buffer.alloc(9 * 1024 * 1024)]))).statusCode, 413, 'max 8 MB');
  assert.equal((await upload('selfie', JPEG, 'image/jpeg', {} as typeof auth)).statusCode, 401);

  const me = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: auth })).json();
  const passport = me.documents.find((d: { type: string }) => d.type === 'passport');
  assert.match(passport.fileUrl, /^http:\/\/api\.test\/files\/docs\/[a-f0-9]+\/[a-f0-9]{32}\.jpg\?exp=\d+&sig=/);
  const stored = await db.query(`SELECT file_url FROM driver_documents WHERE id = $1`, [passport.id]);
  assert.match(stored.rows[0].file_url, /^store:/, 'the database keeps only a storage reference');

  const path = passport.fileUrl.replace('http://api.test', '');
  const ok = await s.app.inject({ method: 'GET', url: path });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'image/jpeg');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal(ok.rawPayload.length, JPEG.length);

  const [base, query] = path.split('?');
  const params = new URLSearchParams(query);
  // Without the signature, with a forged one, or after expiry: refused.
  assert.equal((await s.app.inject({ method: 'GET', url: base })).statusCode, 403);
  assert.equal((await s.app.inject({ method: 'GET', url: `${base}?exp=${params.get('exp')}&sig=AAAA${params.get('sig')!.slice(4)}` })).statusCode, 403);
  assert.equal((await s.app.inject({ method: 'GET', url: `${base}?exp=${Number(params.get('exp')) + 1000}&sig=${params.get('sig')}` })).statusCode, 403, 'cannot extend the expiry');
  const traversal = await s.app.inject({ method: 'GET', url: `/files/docs/../../etc/passwd.jpg?exp=${params.get('exp')}&sig=${params.get('sig')}` });
  assert.ok([403, 404].includes(traversal.statusCode), 'path traversal never reaches the disk');
  const encoded = await s.app.inject({ method: 'GET', url: `/files/docs%2F..%2F..%2Fetc%2Fpasswd.jpg?exp=${params.get('exp')}&sig=${params.get('sig')}` });
  assert.ok([403, 404].includes(encoded.statusCode));
  // A link for one file does not open another.
  const license = me.documents.find((d: { type: string }) => d.type === 'license').fileUrl.replace('http://api.test', '');
  assert.equal((await s.app.inject({ method: 'GET', url: `${license.split('?')[0]}?${query}` })).statusCode, 403);
  await s.app.close();
});
