// Ride events -> push notifications, through an outbox written in the same transaction as the event.
// A background loop sends them; nothing is sent for a change that was rolled back, nothing is lost
// on a crash, and a new-order alert that is no longer useful (past its window) is dropped.

import type pg from 'pg';
import { render, type PushKind } from './messages.ts';
import type { PushMessage, PushSender } from './sender.ts';

type Q = pg.Pool | pg.PoolClient;

/** Seconds a new-order alert stays worth sending (the driver has 15 s to accept). */
const ORDER_ALERT_SEC = 20;
const DEFAULT_TTL_SEC = 10 * 60;
const MAX_ATTEMPTS = 3;
let lastCleanup = 0;

async function enqueue(q: Q, userSql: string, app: 'driver' | 'passenger', kind: PushKind, rideId: string, payload: Record<string, unknown>, ttlSec: number, params: unknown[] = []) {
  await q.query(
    `INSERT INTO push_outbox (user_id, app, kind, ride_id, payload, expires_at)
     SELECT (${userSql}), $2, $3, $1, $4, now() + make_interval(secs => $5)
      WHERE (${userSql}) IS NOT NULL`,
    [rideId, app, kind, JSON.stringify(payload), ttlSec, ...params],
  );
}

const PASSENGER = `SELECT passenger_id FROM rides WHERE id = $1`;
const RIDE_DRIVER = `SELECT d.user_id FROM rides r JOIN drivers d ON d.id = r.driver_id WHERE r.id = $1`;

/** Called for every ride event (from logEvent). Only some events become notifications. */
export async function enqueueForEvent(
  q: Q, rideId: string, type: string, actor: string, payload: Record<string, unknown>,
): Promise<void> {
  switch (type) {
    case 'offer_sent':
    case 'offer_chosen': {
      // The request goes to one driver: price and distance to the pickup, nothing about the passenger.
      const { rows: [o] } = await q.query<{ price: string; pickup_m: number }>(
        `SELECT o.price_tiyin AS price, ST_Distance(p.point, s.point)::int AS pickup_m
           FROM ride_offers o
           LEFT JOIN driver_presence p ON p.driver_id = o.driver_id
           JOIN ride_stops s ON s.ride_id = o.ride_id AND s.position = 0
          WHERE o.id = $1`,
        [payload.offerId],
      );
      await enqueue(q, `SELECT user_id FROM drivers WHERE id = $6::uuid`, 'driver', 'new_order', rideId,
        { priceTiyin: Number(o?.price ?? payload.priceTiyin), pickupM: o?.pickup_m ?? 0 }, ORDER_ALERT_SEC, [payload.driverId]);
      return;
    }
    case 'status:accepted': {
      const { rows: [v] } = await q.query(
        `SELECT v.make_model AS "makeModel", v.color, v.plate FROM rides r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = $1`,
        [rideId],
      );
      await enqueue(q, PASSENGER, 'passenger', 'driver_assigned', rideId, v ?? {}, DEFAULT_TTL_SEC);
      return;
    }
    case 'status:arrived':
      await enqueue(q, PASSENGER, 'passenger', 'driver_arrived', rideId, {}, DEFAULT_TTL_SEC);
      return;
    case 'status:cancelled':
      if (actor === 'driver') await enqueue(q, PASSENGER, 'passenger', payload.noShow ? 'no_show' : 'driver_cancelled', rideId, { feeTiyin: payload.feeTiyin ?? 0 }, DEFAULT_TTL_SEC);
      else if (actor === 'system' && payload.reason === 'no_drivers') await enqueue(q, PASSENGER, 'passenger', 'no_drivers', rideId, {}, DEFAULT_TTL_SEC);
      else if (actor === 'passenger') await enqueue(q, RIDE_DRIVER, 'driver', 'ride_cancelled', rideId, {}, DEFAULT_TTL_SEC);
      return;
    case 'price_proposal':
      await enqueue(q, PASSENGER, 'passenger', 'price_up', rideId, { priceTiyin: payload.priceTiyin }, DEFAULT_TTL_SEC);
      return;
    case 'prepay_failed':
      await enqueue(q, PASSENGER, 'passenger', 'card_declined', rideId, {}, DEFAULT_TTL_SEC);
      return;
  }
}

interface OutboxRow {
  id: string; user_id: string; app: 'driver' | 'passenger'; kind: PushKind; ride_id: string | null;
  payload: Record<string, unknown>; created_at: string; expires_at: string; language: 'uz' | 'ru' | 'en';
}

/**
 * Sends pending notifications. Safe on several instances (rows are claimed with SKIP LOCKED).
 * Returns how many rows were handled.
 */
export async function pushTick(db: pg.Pool, sender: PushSender, log: { warn: (o: object, m: string) => void } = { warn: () => {} }): Promise<number> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(
      `SELECT o.*, u.language FROM push_outbox o JOIN users u ON u.id = o.user_id
        WHERE o.sent_at IS NULL AND o.attempts < $1 AND o.expires_at > now()
        ORDER BY o.created_at
        LIMIT 100
        FOR UPDATE OF o SKIP LOCKED`,
      [MAX_ATTEMPTS],
    );
    if (rows.length === 0) {
      // Housekeeping when idle, at most every 10 minutes: the outbox is a queue, not an archive.
      if (Date.now() - lastCleanup > 10 * 60_000) {
        lastCleanup = Date.now();
        await client.query(`DELETE FROM push_outbox WHERE created_at < now() - interval '7 days'`);
      }
      await client.query('COMMIT');
      return 0;
    }

    const { rows: tokens } = await client.query<{ id: string; user_id: string; app: string; token: string }>(
      `SELECT id, user_id, app, token FROM push_tokens WHERE revoked_at IS NULL AND user_id = ANY($1::uuid[])`,
      [rows.map((r) => r.user_id)],
    );
    const messages: PushMessage[] = [];
    const owner: { rowId: string; tokenId: string }[] = [];
    for (const r of rows) {
      const { title, body } = render(r.kind, r.language, r.payload);
      const ttl = Math.max(1, Math.floor((new Date(r.expires_at).getTime() - Date.now()) / 1000));
      for (const t of tokens.filter((x) => x.user_id === r.user_id && x.app === r.app)) {
        messages.push({ to: t.token, title, body, ttl, channelId: r.app === 'driver' && r.kind === 'new_order' ? 'orders' : 'rides', data: { kind: r.kind, rideId: r.ride_id } });
        owner.push({ rowId: r.id, tokenId: t.id });
      }
    }

    let results: Awaited<ReturnType<PushSender['send']>> = [];
    let failure: string | null = null;
    try {
      results = messages.length ? await sender.send(messages) : [];
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      log.warn({ err }, 'push send failed; will retry');
    }

    if (failure) {
      await client.query(`UPDATE push_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id), failure.slice(0, 200)]);
    } else {
      const gone = owner.filter((_, i) => results[i] && !results[i]!.ok && (results[i] as { deviceGone: boolean }).deviceGone).map((o) => o.tokenId);
      if (gone.length) await client.query(`UPDATE push_tokens SET revoked_at = now() WHERE id = ANY($1::uuid[])`, [gone]);
      for (const r of rows) {
        const mine = owner.map((o, i) => ({ o, res: results[i] })).filter((x) => x.o.rowId === r.id);
        const error = mine.length === 0 ? 'no_device' : mine.every((x) => !x.res?.ok) ? 'all_failed' : null;
        await client.query(`UPDATE push_outbox SET sent_at = now(), attempts = attempts + 1, last_error = $2 WHERE id = $1`, [r.id, error]);
      }
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
