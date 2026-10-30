// First-ride check: plays one whole cash ride through the real API on the server (two test accounts,
// order -> assignment -> arrival -> trip -> completion) and prints the reviewer's 12-point list:
// what the server proved, and what only a person with two phones can check.
//
//   docker compose exec api node --experimental-strip-types --no-warnings src/tools/first-ride-check.ts
//
// Test accounts use +998 0XXXXXXXX numbers (no real operator starts with 0) and are deleted at the
// end (the ride stays, anonymised). Sign-in skips SMS: sessions are written straight to the database,
// which is why this runs only on the server itself. Exit code 1 if any server check fails.

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashToken } from '../lib/secrets.ts';
import { LEGAL_VERSIONS } from '../legal/documents.ts';

const API = (process.env.CHECK_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
const FILE_BASE = process.env.FILE_BASE_URL ?? 'https://files.example/';
// Central Tashkent (Amir Temur square) to Yunusobod: a real route for the router.
const PICKUP = { lat: 41.3111, lng: 69.2797 };
const DROPOFF = { lat: 41.3650, lng: 69.2870 };

type Headers = Record<string, string>;
interface Step { n: number; text: string; status: 'ok' | 'fail' | 'phone'; note?: string }

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const steps: Step[] = [];
const say = (n: number, text: string, status: Step['status'], note?: string) => steps.push({ n, text, status, note });

async function call<T = any>(method: string, path: string, headers: Headers = {}, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

function testPhone(): string {
  return `+9980${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
}

/** A user with an app session (and, for staff, a panel session), without SMS. */
async function account(roles: string[], staff = false): Promise<{ id: string; headers: Headers }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (phone, roles, name, language) VALUES ($1, $2, 'First ride check', 'ru') RETURNING id`,
    [testPhone(), roles],
  );
  const id = rows[0]!.id;
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, kind, expires_at) VALUES ($1, $2, 'first-ride-check', $3, now() + interval '1 hour')`,
    [id, hashToken(token), staff ? 'staff' : 'app'],
  );
  for (const [doc, version] of Object.entries(LEGAL_VERSIONS)) {
    await db.query(`INSERT INTO user_consents (user_id, document, version, user_agent) VALUES ($1, $2, $3, 'first-ride-check')`, [id, doc, version]);
  }
  const headers: Headers = staff
    ? { cookie: `__Host-taxi_staff=${token}`, 'x-requested-with': 'taxi-admin' }
    : { authorization: `Bearer ${token}` };
  return { id, headers };
}

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

async function main(): Promise<number> {
  const health = await call('GET', '/health').catch(() => ({ status: 0, body: {} }));
  if (health.status !== 200) { console.error(`API not reachable at ${API}`); return 1; }

  const admin = await account(['passenger', 'admin'], true);
  const pax = await account(['passenger']);
  const drv = await account(['passenger']);
  let rideId: string | null = null;

  try {
    // 1. Sign-up by SMS: the code itself goes through the SMS provider; only a phone can show it arrived.
    say(1, 'Пассажир зарегистрировался по SMS', 'phone', 'код SMS проверяется на телефоне; вход по сессии работает');

    // 2. Driver signs up and goes on the line.
    const applied = await call('POST', '/drivers/apply', drv.headers, { name: 'Проверка' });
    expect(applied.status === 201 || applied.status === 200, `заявка водителя: ${applied.status} ${JSON.stringify(applied.body)}`);
    const vehicle = await call('POST', '/drivers/me/vehicles', drv.headers, { makeModel: 'Chevrolet Cobalt', year: 2022, color: 'white', plate: '01A000AA' });
    expect(vehicle.status === 201, `машина: ${vehicle.status}`);
    for (const type of ['passport', 'license', 'vehicle_registration', 'selfie', 'self_employed']) {
      const doc = await call('POST', '/drivers/me/documents', drv.headers, { type, fileUrl: `${FILE_BASE}first-ride-check/${type}.jpg` });
      expect(doc.status === 201, `документ ${type}: ${doc.status} ${JSON.stringify(doc.body)}`);
    }
    const approved = await call('POST', `/admin/drivers/${applied.body.id}/approve`, admin.headers, { vehicleId: vehicle.body.id, classCode: 'economy' });
    expect(approved.status === 200, `модерация: ${approved.status} ${JSON.stringify(approved.body)}`);
    const online = await call('POST', '/drivers/me/online', drv.headers, { lat: PICKUP.lat + 0.004, lng: PICKUP.lng });
    expect(online.status === 200, `выход на линию: ${online.status} ${JSON.stringify(online.body)}`);
    say(2, 'Водитель зарегистрировался и вышел на линию', 'ok', 'анкета → документы → модерация → на линии');

    // 3. Route and price.
    const stops = [PICKUP, DROPOFF];
    const quote = await call('POST', '/quotes', pax.headers, { stops });
    expect(quote.status === 200, `расчёт цены: ${quote.status}`);
    const economy = quote.body.classes.find((c: { code: string }) => c.code === 'economy');
    const option = economy?.options.at(-1);
    expect(!!option, 'нет вариантов в Экономе — водитель не виден диспетчеру');
    say(3, 'Пассажир построил маршрут и увидел цену', 'ok',
      `${(quote.body.route.distanceM / 1000).toFixed(1)} км, ${Math.round(quote.body.route.durationS / 60)} мин, ${option.priceTiyin / 100} сум, линия маршрута: ${quote.body.route.line ? `точек: ${quote.body.route.line.length}` : 'нет (прямые отрезки)'}`);

    // 4–5. Exactly one driver gets it, and accepts.
    const order = await call('POST', '/rides', { ...pax.headers, 'idempotency-key': crypto.randomUUID() },
      { classCode: 'economy', stops, priority: option.priority, maxPriceTiyin: option.priceTiyin, paymentMethod: 'cash' });
    expect(order.status === 201, `заказ: ${order.status} ${JSON.stringify(order.body)}`);
    rideId = order.body.id as string;
    const offered = await db.query(`SELECT count(*)::int AS n FROM ride_offers WHERE ride_id = $1 AND status = 'chosen' AND expires_at > now()`, [rideId]);
    const mine = await call<{ rideId: string }[]>('GET', '/drivers/me/requests', drv.headers);
    expect(offered.rows[0].n === 1, `запрос ушёл ${offered.rows[0].n} водителям одновременно`);
    expect(mine.body.some((r) => r.rideId === rideId), 'тестовый водитель не получил заказ (рядом есть другой водитель?)');
    say(4, 'Заказ получил именно один водитель', 'ok');
    const t0 = Date.now();
    const accepted = await call('POST', `/rides/${rideId}/accept`, drv.headers);
    expect(accepted.status === 200, `принятие: ${accepted.status} ${JSON.stringify(accepted.body)}`);
    say(5, 'Водитель принял заказ за 15 секунд', 'phone', `сервер дал 15 с и принял за ${Date.now() - t0} мс; успевает ли человек — на телефоне`);

    // 6. Push to the passenger: queued by the server; delivery needs the phones and FCM keys.
    await new Promise((r) => setTimeout(r, 1500));
    const pushes = await db.query<{ kind: string; sent: boolean; err: string | null }>(
      `SELECT kind, sent_at IS NOT NULL AS sent, last_error AS err FROM push_outbox WHERE ride_id = $1 ORDER BY id`, [rideId],
    );
    const assigned = pushes.rows.find((p) => p.kind === 'driver_assigned');
    say(6, 'Пассажир получил push-уведомление', 'phone',
      assigned ? `сервер поставил «водитель назначен» в очередь${assigned.sent ? ' и отправил' : ''}; у тестового аккаунта нет телефона` : 'уведомление не поставлено в очередь (!)');
    if (!assigned) steps.at(-1)!.status = 'fail';

    // 7. GPS with the screen locked: phone only. The server side: pings move the car.
    await call('POST', `/rides/${rideId}/status`, drv.headers, { status: 'driver_en_route' });
    // About 450 m short of the pickup: "arrived" must be refused from here (the limit is 200 m).
    const ping = await call('POST', '/drivers/me/location', drv.headers, { lat: PICKUP.lat + 0.004, lng: PICKUP.lng });
    expect(ping.status === 204, `координаты: ${ping.status}`);
    const seen = await call('GET', `/rides/${rideId}`, pax.headers);
    say(7, 'GPS водителя обновлялся при заблокированном экране', 'phone',
      `сервер принимает координаты, пассажир видит машину: ${seen.body.driver?.location ? 'да' : 'нет'}; заблокированный экран — на телефоне`);

    // 8. Arrival only at the pickup.
    const tooEarly = await call('POST', `/rides/${rideId}/status`, drv.headers, { status: 'arrived' });
    await call('POST', '/drivers/me/location', drv.headers, PICKUP);
    const arrived = await call('POST', `/rides/${rideId}/status`, drv.headers, { status: 'arrived' });
    expect(arrived.status === 200, `прибытие: ${arrived.status} ${JSON.stringify(arrived.body)}`);
    say(8, 'Водитель приехал и отметил прибытие', 'ok', `за 450 м — ${tooEarly.status === 200 ? 'принято (!)' : 'отказ'}, у точки подачи — принято`);
    if (tooEarly.status === 200) steps.at(-1)!.status = 'fail';

    // 9. Trip.
    const started = await call('POST', `/rides/${rideId}/status`, drv.headers, { status: 'in_progress' });
    await call('POST', '/drivers/me/location', drv.headers, { lat: (PICKUP.lat + DROPOFF.lat) / 2, lng: (PICKUP.lng + DROPOFF.lng) / 2 });
    await call('POST', '/drivers/me/location', drv.headers, DROPOFF);
    const done = await call('POST', `/rides/${rideId}/status`, drv.headers, { status: 'completed' });
    expect(started.status === 200 && done.status === 200, `поездка: ${started.status}/${done.status}`);
    say(9, 'Поездка началась и завершилась', 'ok');

    // 10–11. Final price equals the confirmed one; cash closes the ride.
    const final = await call('GET', `/rides/${rideId}`, pax.headers);
    const price = final.body.priceTiyin as number;
    say(10, 'Итоговая цена совпала с подтверждённой', price <= option.priceTiyin ? 'ok' : 'fail', `${price / 100} сум при подтверждённых ${option.priceTiyin / 100}`);
    const debts = await call('GET', '/me/debts', pax.headers);
    const cashOk = final.body.status === 'completed' && final.body.payment?.method === 'cash' && debts.body.items.length === 0;
    say(11, 'Оплата наличными корректно закрыла поездку', cashOk ? 'ok' : 'fail', `статус ${final.body.status}, долгов ${debts.body.items.length}`);

    // 12. Both histories.
    const paxHist = await call<{ id: string }[]>('GET', '/me/rides', pax.headers);
    const drvStats = await call('GET', '/drivers/me/stats', drv.headers);
    const inPax = paxHist.body.some((r) => r.id === rideId);
    say(12, 'Обе стороны увидели поездку в истории', inPax && drvStats.status === 200 ? 'ok' : 'fail',
      `у пассажира: ${inPax ? 'есть' : 'нет'}; у водителя в статистике дня: ${JSON.stringify(drvStats.body.today ?? drvStats.body).slice(0, 80)}`);
  } catch (err) {
    const n = (steps.at(-1)?.n ?? 0) + 1;
    say(n, 'Проверка прервана', 'fail', err instanceof Error ? err.message : String(err));
  } finally {
    // Clean up: drivers off the line, test accounts deleted (the ride stays, anonymised).
    await call('POST', '/drivers/me/offline', drv.headers, {}).catch(() => {});
    if (rideId) await db.query(`UPDATE rides SET status = 'cancelled', cancelled_by = 'system', cancel_reason = 'first_ride_check' WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`, [rideId]);
    for (const u of [pax, drv]) await call('DELETE', '/me', u.headers, { confirm: true }).catch(() => {});
    await db.query(`UPDATE users SET roles = ARRAY['passenger'], deleted_at = now(), phone = 'deleted:' || id WHERE id = $1`, [admin.id]);
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = ANY($1)`, [[admin.id, pax.id, drv.id]]);
    await db.end();
  }

  const icon = { ok: '✅', fail: '❌', phone: '📱' } as const;
  console.log(`\nПервая поездка — проверка сервера (${API})\n`);
  for (const s of steps) console.log(`${icon[s.status]} ${String(s.n).padStart(2)}. ${s.text}${s.note ? `\n      ${s.note}` : ''}`);
  const failed = steps.filter((s) => s.status === 'fail').length;
  const phone = steps.filter((s) => s.status === 'phone').length;
  console.log(`\n${failed ? `❌ Не прошло: ${failed}` : '✅ Всё, что проверяет сервер, прошло'}. 📱 На телефонах проверить: ${phone}.\n`);
  return failed ? 1 : 0;
}

process.exit(await main());
