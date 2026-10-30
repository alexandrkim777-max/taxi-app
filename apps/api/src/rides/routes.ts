// Passenger and driver ride flow.
//
// Two ways to order:
//   auto   (default) — one tap. The passenger agrees to a price ceiling (the best price shown
//          in the quote); the system sends the ride to the best driver at or below it and moves
//          to the next driver on decline or timeout. Never more expensive without confirmation.
//   choose — the passenger sees nearby drivers with their own prices and picks one.
// Then: driver accepts (price locked) -> en route -> arrived -> in progress -> completed.
// After acceptance the price changes only when the passenger changes the route (see changes.ts).
// Every status change goes through the shared status machine and is written to ride_events.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { canTransition, clampToCorridor, scaledFareTiyin, type RideStatus } from '@taxi/shared';
import { requireUser } from '../auth/session.ts';
import { lineJson, type RouteProvider } from '../routing/index.ts';
import { requireConsent } from '../legal/documents.ts';
import type { PaymentService } from '../payments/service.ts';
import { uuidParams } from '../lib/geo.ts';
import { cancelTerms, ARRIVAL_RADIUS_M, waitingOf } from './cancellation.ts';
import { insertStops, learnEntrance, isBlocked, openOffers, rideFor, rideOptions, rideView, stop, UUID, type RideRow, type Role, type StopInput } from './common.ts';
import { HttpError, isUniqueViolation, withTx } from '../lib/tx.ts';
import { driverContext, pauseIfCancellingTooOften, PRESENCE_TTL_SEC, setPresenceStatus } from '../dispatch/presence.ts';
import {
  ACCEPT_WINDOW_SEC, assignNext, expireLapsed, logEvent, refreshOffers, reserveDriver, SEARCH_WINDOW_SEC,
} from '../dispatch/matching.ts';

interface Deps {
  db: pg.Pool;
  routes: RouteProvider;
  cityCode: string;
  payments: PaymentService;
  legalBaseUrl: string;
}

/** Anti-spam: rides a passenger can create per hour (each one pings drivers). */
const MAX_RIDES_PER_HOUR = 20;

interface CreateBody {
  classCode: string;
  stops: StopInput[];
  mode?: 'auto' | 'choose';
  /** Auto mode: "cheaper" or "faster" — which rule picks the driver (default: faster). */
  priority?: 'cheap' | 'fast';
  /** Auto mode: the price the passenger saw and agreed to; nobody more expensive is sent. */
  maxPriceTiyin?: number;
  paymentMethod?: 'cash' | 'card';
  cardId?: string;
  options?: Record<string, boolean>;
  comment?: string;
}


export async function rideRoutes(app: FastifyInstance, { db, routes, cityCode, payments, legalBaseUrl }: Deps): Promise<void> {
  // A passenger orders only after accepting the current offer and privacy policy.
  const passengerConsent = requireConsent(db, 'passenger', legalBaseUrl);
  /**
   * Card rides at completion: charge whatever is still due (the whole fare if the ride ended before
   * the 60% prepayment, or the rest after a route change). A decline now becomes a debt.
   */
  async function chargeRide(rideId: string): Promise<void> {
    await payments.chargeRideBalance(rideId);
  }

  /** A cancellation fee is charged to the ride's card right away; for cash rides it stays a debt. */
  async function chargeCancelFee(rideId: string): Promise<void> {
    const { rows } = await db.query(
      `SELECT passenger_id, card_id, driver_id, cancel_fee_tiyin FROM rides
        WHERE id = $1 AND cancel_fee_status = 'pending' AND payment_method = 'card'`,
      [rideId],
    );
    const r = rows[0];
    if (!r) return;
    await payments.chargeSavedCard({
      type: 'cancel_fee', rideId, userId: r.passenger_id, cardId: r.card_id, driverId: r.driver_id,
      amountTiyin: Number(r.cancel_fee_tiyin), description: 'Cancellation fee',
    });
  }

  app.post<{ Body: CreateBody }>(
    '/rides',
    {
      preHandler: [requireUser, passengerConsent],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['classCode', 'stops'],
          additionalProperties: false,
          properties: {
            classCode: { type: 'string', pattern: '^[a-z_]{2,32}$' },
            stops: { type: 'array', minItems: 2, maxItems: 5, items: stop },
            mode: { type: 'string', enum: ['auto', 'choose'] },
            priority: { type: 'string', enum: ['cheap', 'fast'] },
            maxPriceTiyin: { type: 'integer', minimum: 0 },
            paymentMethod: { type: 'string', enum: ['cash', 'card'] },
            cardId: UUID,
            options: rideOptions,
            comment: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      // A retry of an order whose answer was lost (bad mobile network): the same ride, not a second one.
      const idemHeader = request.headers['idempotency-key'];
      const idemKey = typeof idemHeader === 'string' ? idemHeader.trim().toLowerCase() : null;
      if (idemKey !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(idemKey)) {
        return reply.code(400).send({ error: 'invalid_idempotency_key' });
      }
      const sameOrder = async () => {
        if (!idemKey) return null;
        const { rows } = await db.query<{ id: string }>(`SELECT id FROM rides WHERE passenger_id = $1 AND idempotency_key = $2`, [userId, idemKey]);
        return rows[0] ? rideView(db, rows[0].id, 'passenger') : null;
      };
      const earlier = await sameOrder();
      if (earlier) return reply.code(200).send(earlier);
      const mode = request.body.mode ?? 'auto';
      if (mode === 'auto' && request.body.maxPriceTiyin === undefined) {
        return reply.code(400).send({ error: 'max_price_required' });
      }
      if (mode === 'choose' && request.body.priority !== undefined) {
        return reply.code(400).send({ error: 'priority_is_for_auto' });
      }
      const priority = mode === 'auto' ? request.body.priority ?? 'fast' : null;
      if (await isBlocked(db, userId)) return reply.code(403).send({ error: 'blocked' });

      const recent = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM rides WHERE passenger_id = $1 AND created_at > now() - interval '1 hour'`,
        [userId],
      );
      if (recent.rows[0]!.n >= MAX_RIDES_PER_HOUR) return reply.code(429).send({ error: 'too_many_rides' });

      // Like Yandex: unpaid rides or cancellation fees must be settled before the next order.
      const debts = await payments.debts(db, userId);
      if (debts.length) {
        return reply.code(402).send({ error: 'unpaid_debt', totalTiyin: debts.reduce((a, d) => a + d.amountTiyin, 0) });
      }

      const paymentMethod = request.body.paymentMethod ?? 'cash';
      let cardId: string | null = null;
      if (paymentMethod === 'card') {
        // Only the passenger's own active card; default card if none given.
        const { rows } = await db.query<{ id: string }>(
          `SELECT id FROM payment_cards
            WHERE user_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id = $2::uuid)
              AND ($2::uuid IS NOT NULL OR is_default)`,
          [userId, request.body.cardId ?? null],
        );
        if (!rows[0]) return reply.code(400).send({ error: 'card_not_found' });
        cardId = rows[0].id;
      }

      const cls = await db.query(
        `SELECT vc.*, current_price_coefficient(vc.id) AS coefficient FROM vehicle_classes vc JOIN cities c ON c.id = vc.city_id
          WHERE c.code = $1 AND vc.code = $2 AND vc.deleted_at IS NULL`,
        [cityCode, request.body.classCode],
      );
      const c = cls.rows[0];
      if (!c) return reply.code(400).send({ error: 'unknown_class' });

      // Distance and time always come from our routing, never from the client.
      let route;
      try {
        route = await routes.route(request.body.stops);
      } catch (err) {
        request.log.warn(err, 'routing failed');
        return reply.code(503).send({ error: 'routing_unavailable' });
      }

      // The ceiling only filters drivers; it never sets anyone's price. It must still be a price
      // that can exist for this route, otherwise the ride could never be served.
      if (mode === 'auto') {
        const reference = scaledFareTiyin({
          baseTiyin: Number(c.rec_base_tiyin), perKmTiyin: Number(c.rec_per_km_tiyin),
          perMinTiyin: Number(c.rec_per_min_tiyin), minFareTiyin: Number(c.rec_min_fare_tiyin),
        }, route, Number(c.coefficient));
        const floor = clampToCorridor(0, reference, { minPct: c.corridor_min_pct, maxPct: c.corridor_max_pct });
        const max = request.body.maxPriceTiyin!;
        if (max < floor || max > reference) {
          return reply.code(400).send({ error: 'price_out_of_range', minTiyin: floor, maxTiyin: reference });
        }
      }

      let rideId: string;
      try {
        rideId = await withTx(db, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO rides (city_id, passenger_id, class_id, route_distance_m, route_duration_s, options,
                                driver_comment, dispatch_mode, max_price_tiyin, search_deadline, payment_method, card_id,
                                price_coefficient, priority, idempotency_key, route_line)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10), $11, $12, $13, $14, $15,
                     ST_SetSRID(ST_GeomFromGeoJSON($16::text), 4326)) RETURNING id`,
            [
              c.city_id, userId, c.id, route.distanceM, route.durationS,
              JSON.stringify(request.body.options ?? {}), request.body.comment ?? null,
              mode, mode === 'auto' ? request.body.maxPriceTiyin : null, SEARCH_WINDOW_SEC,
              paymentMethod, cardId, c.coefficient, priority, idemKey, lineJson(route.line),
            ],
          );
          const id = rows[0]!.id;
          await insertStops(tx, id, request.body.stops);
          await logEvent(tx, id, 'status:created', 'passenger', userId, { mode, priority });
          await refreshOffers(tx, id);
          if (mode === 'auto') await assignNext(tx, id);
          return id;
        });
      } catch (err) {
        // Two copies of the same order raced each other: answer the loser with the winner's ride.
        if (isUniqueViolation(err, 'rides_idempotency') || isUniqueViolation(err, 'rides_one_active_per_passenger')) {
          const winner = await sameOrder();
          if (winner) return reply.code(200).send(winner);
        }
        if (isUniqueViolation(err, 'rides_one_active_per_passenger')) {
          return reply.code(409).send({ error: 'active_ride_exists' });
        }
        throw err;
      }
      return reply.code(201).send(await rideView(db, rideId, 'passenger'));
    },
  );

  // The passenger's past rides: receipts, and the way to a complaint or dispute after the ride.
  app.get<{ Querystring: { before?: string } }>(
    '/me/rides',
    {
      preHandler: requireUser,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'string', format: 'date-time' } } } },
    },
    async (request) => {
      const { rows } = await db.query(
        `SELECT r.id, r.status, vc.code AS "classCode", r.locked_price_tiyin::int AS "priceTiyin",
                r.payment_method AS "paymentMethod", r.created_at AS "createdAt",
                r.cancel_fee_tiyin::int AS "cancelFeeTiyin", du.name AS "driverName",
                r.refunded_tiyin::int AS "refundedTiyin",
                v.make_model AS "makeModel", v.plate,
                (SELECT address FROM ride_stops s WHERE s.ride_id = r.id ORDER BY position LIMIT 1) AS "fromAddress",
                (SELECT json_build_object('address', address, 'lat', ST_Y(point::geometry), 'lng', ST_X(point::geometry))
                   FROM ride_stops s WHERE s.ride_id = r.id ORDER BY position DESC LIMIT 1) AS "to",
                EXISTS (SELECT 1 FROM disputes x WHERE x.ride_id = r.id) AS "hasDispute"
           FROM rides r
           JOIN vehicle_classes vc ON vc.id = r.class_id
           LEFT JOIN drivers d ON d.id = r.driver_id
           LEFT JOIN users du ON du.id = d.user_id
           LEFT JOIN vehicles v ON v.id = r.vehicle_id
          WHERE r.passenger_id = $1 AND r.deleted_at IS NULL AND r.status IN ('completed', 'cancelled')
            AND ($2::timestamptz IS NULL OR r.created_at < $2::timestamptz)
          ORDER BY r.created_at DESC LIMIT 20`,
        [request.user!.id, request.query.before ?? null],
      );
      return rows;
    },
  );

  // The passenger's or driver's current ride, so the app can restore its screen after a restart.
  app.get('/rides/active', { preHandler: requireUser }, async (request, reply) => {
    const { rows } = await db.query<{ id: string; role: Role }>(
      `SELECT r.id, CASE WHEN r.passenger_id = $1 THEN 'passenger' ELSE 'driver' END AS role
         FROM rides r LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE (r.passenger_id = $1 OR d.user_id = $1) AND r.deleted_at IS NULL
          AND r.status IN ('created', 'accepted', 'driver_en_route', 'arrived', 'in_progress')
        ORDER BY r.created_at DESC LIMIT 1`,
      [request.user!.id],
    );
    if (!rows[0]) return reply.code(204).send();
    return rideView(db, rows[0].id, rows[0].role);
  });

  app.get<{ Params: { id: string } }>(
    '/rides/:id',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request) => {
      const { role } = await rideFor(db, request.params.id, request.user!.id, false);
      return rideView(db, request.params.id, role);
    },
  );

  // The road route for drawing, fetched once per ride (and again after a route change) instead of
  // riding along with every 2.5 s status poll. Null when routing gave no geometry.
  app.get<{ Params: { id: string } }>(
    '/rides/:id/route',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request) => {
      await rideFor(db, request.params.id, request.user!.id, false);
      const { rows } = await db.query<{ line: { coordinates: [number, number][] } | null; version: number }>(
        `SELECT ST_AsGeoJSON(route_line, 6)::json AS line,
                (SELECT count(*)::int FROM price_changes pc WHERE pc.ride_id = r.id AND pc.new_stops IS NOT NULL) AS version
           FROM rides r WHERE r.id = $1`,
        [request.params.id],
      );
      return { line: rows[0]?.line?.coordinates ?? null, version: rows[0]?.version ?? 0 };
    },
  );

  // Choose mode: refresh the list of drivers.
  app.post<{ Params: { id: string } }>(
    '/rides/:id/search',
    {
      preHandler: requireUser,
      schema: { params: uuidParams },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => {
      await withTx(db, async (tx) => {
        const { ride, role } = await rideFor(tx, request.params.id, request.user!.id, true);
        if (role !== 'passenger') throw new HttpError(404, 'not_found');
        if (ride.status !== 'created') throw new HttpError(409, 'ride_not_open');
        if (ride.dispatch_mode !== 'choose') throw new HttpError(409, 'wrong_mode');
        await refreshOffers(tx, ride.id);
      });
      return openOffers(db, request.params.id);
    },
  );

  // Choose mode: the passenger picks a driver from the list.
  app.post<{ Params: { id: string }; Body: { offerId: string } }>(
    '/rides/:id/choose',
    {
      preHandler: requireUser,
      schema: {
        params: uuidParams,
        body: { type: 'object', required: ['offerId'], additionalProperties: false, properties: { offerId: UUID } },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      try {
        await withTx(db, async (tx) => {
          const { ride, role } = await rideFor(tx, request.params.id, userId, true);
          if (role !== 'passenger') throw new HttpError(404, 'not_found');
          if (ride.status !== 'created') throw new HttpError(409, 'ride_not_open');
          if (ride.dispatch_mode !== 'choose') throw new HttpError(409, 'wrong_mode');
          // A choice the driver let lapse no longer blocks choosing someone else.
          await expireLapsed(tx, ride.id);
          const { rows } = await tx.query<{ id: string; driver_id: string; price_tiyin: string }>(
            `SELECT o.id, o.driver_id, o.price_tiyin
               FROM ride_offers o JOIN driver_presence p ON p.driver_id = o.driver_id
              WHERE o.id = $2 AND o.ride_id = $1 AND o.status = 'open' AND o.expires_at > now()
                AND p.status = 'online' AND p.updated_at > now() - make_interval(secs => $3)
              FOR UPDATE OF o`,
            [ride.id, request.body.offerId, PRESENCE_TTL_SEC],
          );
          const offer = rows[0];
          // The driver may meanwhile be answering someone else's request.
          if (!offer || !(await reserveDriver(tx, offer.driver_id))) throw new HttpError(409, 'offer_unavailable');
          await tx.query(
            `UPDATE ride_offers SET status = 'chosen', expires_at = now() + make_interval(secs => $2) WHERE id = $1`,
            [offer.id, ACCEPT_WINDOW_SEC.choose],
          );
          await logEvent(tx, ride.id, 'offer_chosen', 'passenger', userId, {
            offerId: offer.id, driverId: offer.driver_id, priceTiyin: Number(offer.price_tiyin),
          });
        });
      } catch (err) {
        if (isUniqueViolation(err, 'ride_offers_one_chosen')) throw new HttpError(409, 'already_chosen');
        throw err;
      }
      return rideView(db, request.params.id, 'passenger');
    },
  );

  // Auto mode: only more expensive drivers are left; the passenger explicitly accepts the new price.
  app.post<{ Params: { id: string }; Body: { priceTiyin: number } }>(
    '/rides/:id/confirm-price',
    {
      preHandler: requireUser,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['priceTiyin'], additionalProperties: false,
          properties: { priceTiyin: { type: 'integer', minimum: 0 } },
        },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      await withTx(db, async (tx) => {
        const { ride, role } = await rideFor(tx, request.params.id, userId, true);
        if (role !== 'passenger') throw new HttpError(404, 'not_found');
        if (ride.status !== 'created' || ride.dispatch_mode !== 'auto') throw new HttpError(409, 'ride_not_open');
        // The passenger confirms exactly the price on their screen; a stale or invented number is refused.
        if (ride.price_proposal_tiyin === null || Number(ride.price_proposal_tiyin) !== request.body.priceTiyin) {
          throw new HttpError(409, 'price_changed');
        }
        await tx.query(
          `UPDATE rides SET max_price_tiyin = price_proposal_tiyin, price_proposal_tiyin = NULL,
                  search_deadline = now() + make_interval(secs => $2)
            WHERE id = $1`,
          [ride.id, SEARCH_WINDOW_SEC],
        );
        await logEvent(tx, ride.id, 'price_confirmed', 'passenger', userId, { priceTiyin: request.body.priceTiyin });
        await assignNext(tx, ride.id);
      });
      return rideView(db, request.params.id, 'passenger');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/rides/:id/accept',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request) => {
      const userId = request.user!.id;
      try {
        await withTx(db, async (tx) => {
          const ctx = await driverContext(tx, userId);
          if (!ctx) throw new HttpError(404, 'not_found');
          if (ctx.blocked) throw new HttpError(403, 'blocked');
          if (!ctx.subscribed) throw new HttpError(402, 'subscription_required');
          if (ctx.pausedUntil) throw new HttpError(423, 'paused', { pausedUntil: ctx.pausedUntil });

          const { rows: rides } = await tx.query<RideRow>(
            `SELECT id, status, driver_id FROM rides WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
            [request.params.id],
          );
          // A retry after a lost answer: this driver already has the ride.
          if (rides[0] && rides[0].status !== 'created' && rides[0].driver_id === ctx.driverId) return;
          const { rows: offers } = await tx.query<{ id: string; price_tiyin: string; tariff_id: string }>(
            `SELECT id, price_tiyin, tariff_id FROM ride_offers
              WHERE ride_id = $1 AND driver_id = $2 AND status = 'chosen' AND expires_at > now()
              FOR UPDATE`,
            [request.params.id, ctx.driverId],
          );
          const ride = rides[0];
          const offer = offers[0];
          // Without a live request for this driver the ride does not exist for them.
          if (!ride || !offer) throw new HttpError(404, 'not_found');
          if (!canTransition(ride.status, 'accepted')) throw new HttpError(409, 'ride_not_open');

          // The price is copied from the offer and is locked from now on.
          await tx.query(
            `UPDATE rides SET status = 'accepted', driver_id = $2, vehicle_id = $3,
                    locked_price_tiyin = $4, tariff_id = $5, price_proposal_tiyin = NULL
              WHERE id = $1`,
            [ride.id, ctx.driverId, ctx.vehicleId, offer.price_tiyin, offer.tariff_id],
          );
          await tx.query(`UPDATE ride_offers SET status = 'accepted' WHERE id = $1`, [offer.id]);
          await tx.query(
            `UPDATE ride_offers SET status = 'expired'
              WHERE status IN ('open', 'chosen') AND id <> $3 AND (ride_id = $1 OR driver_id = $2)`,
            [ride.id, ctx.driverId, offer.id],
          );
          await setPresenceStatus(tx, ctx.driverId, 'busy');
          await logEvent(tx, ride.id, 'status:accepted', 'driver', userId, { priceTiyin: Number(offer.price_tiyin) });
        });
      } catch (err) {
        if (isUniqueViolation(err, 'rides_one_active_per_driver')) throw new HttpError(409, 'driver_busy');
        throw err;
      }
      return rideView(db, request.params.id, 'driver');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/rides/:id/decline',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request, reply) => {
      const userId = request.user!.id;
      await withTx(db, async (tx) => {
        const { rows: rides } = await tx.query<{ dispatch_mode: string; status: string }>(
          `SELECT dispatch_mode, status FROM rides WHERE id = $1 FOR UPDATE`,
          [request.params.id],
        );
        const { rows } = await tx.query<{ id: string }>(
          `UPDATE ride_offers o SET status = 'declined'
             FROM drivers d
            WHERE o.ride_id = $1 AND o.driver_id = d.id AND d.user_id = $2 AND o.status IN ('open', 'chosen')
            RETURNING o.id`,
          [request.params.id, userId],
        );
        if (!rows[0]) throw new HttpError(404, 'not_found');
        await logEvent(tx, request.params.id, 'offer_declined', 'driver', userId, { offerId: rows[0].id });
        // Auto mode: go straight to the next driver instead of waiting for the dispatcher.
        if (rides[0]?.dispatch_mode === 'auto' && rides[0].status === 'created') await assignNext(tx, request.params.id);
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { status: RideStatus } }>(
    '/rides/:id/status',
    {
      preHandler: requireUser,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['status'], additionalProperties: false,
          properties: { status: { type: 'string', enum: ['driver_en_route', 'arrived', 'in_progress', 'completed'] } },
        },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const next = request.body.status;
      let repeated = false;
      await withTx(db, async (tx) => {
        const { ride, role } = await rideFor(tx, request.params.id, userId, true);
        // Only the assigned driver moves the ride forward.
        if (role !== 'driver') throw new HttpError(404, 'not_found');
        // A retry after a lost answer (the phone dropped off the network): already done, nothing to repeat.
        if (ride.status === next) { repeated = true; return; }
        if (!canTransition(ride.status, next)) throw new HttpError(409, 'invalid_transition');
        if (next === 'arrived') {
          // 'Arrived' starts the paid-cancellation clock, so it must be true: the driver's
          // fresh live position has to be at the pickup. The distance is returned so the app
          // can say "drive 70 m closer".
          const { rows } = await tx.query<{ distance_m: number }>(
            `SELECT ST_Distance(p.point, s.point)::int AS distance_m
               FROM driver_presence p JOIN ride_stops s ON s.ride_id = $1 AND s.position = 0
              WHERE p.driver_id = $2 AND p.updated_at > now() - make_interval(secs => $3)`,
            [ride.id, ride.driver_id, PRESENCE_TTL_SEC],
          );
          const distanceM = rows[0]?.distance_m;
          if (distanceM === undefined) throw new HttpError(409, 'no_fresh_position');
          if (distanceM > ARRIVAL_RADIUS_M) {
            request.log.info({ rideId: ride.id, distanceM }, 'arrival refused: too far from pickup');
            throw new HttpError(409, 'not_at_pickup', { distanceM, maxDistanceM: ARRIVAL_RADIUS_M });
          }
        }
        if (next === 'in_progress') {
          // Paid waiting (after the free minutes) is added to the price when the trip starts.
          const waiting = await waitingOf(tx, ride.id);
          if (waiting && waiting.accruedTiyin > 0) {
            const { rows } = await tx.query<{ price: string }>(
              `UPDATE rides SET locked_price_tiyin = locked_price_tiyin + $2 WHERE id = $1
               RETURNING locked_price_tiyin AS price`,
              [ride.id, waiting.accruedTiyin],
            );
            const newPrice = Number(rows[0]!.price);
            await tx.query(
              `INSERT INTO price_changes (ride_id, reason, amount_tiyin, old_price_tiyin, new_price_tiyin, wait_paid_min)
               VALUES ($1, 'waiting', $2, $3, $4, $5)`,
              [ride.id, waiting.accruedTiyin, newPrice - waiting.accruedTiyin, newPrice, waiting.paidMinutes],
            );
            await logEvent(tx, ride.id, 'waiting_charged', 'system', null, {
              paidMinutes: waiting.paidMinutes, amountTiyin: waiting.accruedTiyin,
            });
          }
        }
        if (next === 'in_progress') await learnEntrance(tx, ride.id, ride.driver_id!);
        await tx.query(`UPDATE rides SET status = $2 WHERE id = $1`, [ride.id, next]);
        if (next === 'completed') {
          await setPresenceStatus(tx, ride.driver_id!, 'online');
        }
        await logEvent(tx, ride.id, `status:${next}`, 'driver', userId, { from: ride.status });
      });
      // Charged after the ride is committed as completed; a failed charge becomes a debt.
      if (next === 'completed' && !repeated) await chargeRide(request.params.id);
      return rideView(db, request.params.id, 'driver');
    },
  );

  // The card was declined at 60% (or the passenger changed their mind): pay cash or use another card.
  app.post<{ Params: { id: string }; Body: { method: 'cash' | 'card'; cardId?: string } }>(
    '/rides/:id/payment',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['method'], additionalProperties: false,
          properties: { method: { type: 'string', enum: ['cash', 'card'] }, cardId: UUID },
        },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const rideId = request.params.id;
      let chargeNow = false;
      await withTx(db, async (tx) => {
        const { ride, role } = await rideFor(tx, rideId, userId, true);
        if (role !== 'passenger') throw new HttpError(404, 'not_found');
        if (!['created', 'accepted', 'driver_en_route', 'arrived', 'in_progress'].includes(ride.status)) {
          throw new HttpError(409, 'ride_not_active');
        }
        const { rows } = await tx.query<{ payment_status: string | null }>(`SELECT payment_status FROM rides WHERE id = $1`, [rideId]);
        // A charge already on its way to the provider cannot be switched under it.
        if (rows[0]!.payment_status === 'pending') throw new HttpError(409, 'payment_in_progress');
        if (rows[0]!.payment_status === 'paid') throw new HttpError(409, 'already_paid');
        if (request.body.method === 'cash') {
          // The rest of the fare (the whole fare unless something was already charged) goes to the driver in cash.
          await tx.query(`UPDATE rides SET payment_method = 'cash', card_id = NULL, payment_status = NULL WHERE id = $1`, [rideId]);
        } else {
          if (!request.body.cardId) throw new HttpError(400, 'card_required');
          const card = await tx.query(
            `SELECT 1 FROM payment_cards WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
            [request.body.cardId, userId],
          );
          if (!card.rows[0]) throw new HttpError(404, 'card_not_found');
          // After a decline during the trip, try the new card straight away.
          chargeNow = rows[0]!.payment_status === 'failed';
          await tx.query(
            `UPDATE rides SET payment_method = 'card', card_id = $2,
                    payment_status = CASE WHEN payment_status = 'failed' THEN 'pending' ELSE payment_status END
              WHERE id = $1`,
            [rideId, request.body.cardId],
          );
        }
        await logEvent(tx, rideId, 'payment_method_changed', 'passenger', userId, { method: request.body.method });
      });
      if (chargeNow) {
        const result = await payments.chargeRideBalance(rideId);
        await logEvent(db, rideId, result === 'failed' ? 'prepay_failed' : 'prepaid', 'system', null, { result });
      }
      return rideView(db, rideId, 'passenger');
    },
  );

  // What cancelling now would cost; the app shows this before the cancel button does anything.
  app.get<{ Params: { id: string }; Querystring: { noShow?: boolean } }>(
    '/rides/:id/cancel-terms',
    {
      preHandler: requireUser,
      schema: {
        params: uuidParams,
        querystring: { type: 'object', additionalProperties: false, properties: { noShow: { type: 'boolean' } } },
      },
    },
    async (request) => {
      const { ride, role } = await rideFor(db, request.params.id, request.user!.id, false);
      return cancelTerms(db, ride.id, ride.status, role, request.query.noShow ?? false);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string; noShow?: boolean; acceptFeeTiyin?: number } }>(
    '/rides/:id/cancel',
    {
      preHandler: requireUser,
      schema: {
        params: uuidParams,
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            reason: { type: 'string', maxLength: 300 },
            // Driver only: the passenger did not come out.
            noShow: { type: 'boolean' },
            // Passenger only: the exact fee shown by cancel-terms, confirming they agree to pay it.
            acceptFeeTiyin: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const body = request.body ?? {};
      let role: Role = 'passenger';
      let repeatedCancel = false;
      await withTx(db, async (tx) => {
        const found = await rideFor(tx, request.params.id, userId, true);
        role = found.role;
        const { ride } = found;
        if (body.noShow && role !== 'driver') throw new HttpError(400, 'no_show_is_for_drivers');
        if (ride.status === 'cancelled') {
          // A retry by the side that cancelled (the answer got lost): the same result, no second fee.
          const { rows } = await tx.query<{ cancelled_by: string }>(`SELECT cancelled_by FROM rides WHERE id = $1`, [ride.id]);
          if (rows[0]!.cancelled_by === role) { repeatedCancel = true; return; }
        }
        // A ride in progress cannot be cancelled; it ends with completion.
        if (!canTransition(ride.status, 'cancelled')) throw new HttpError(409, 'invalid_transition');

        const terms = await cancelTerms(tx, ride.id, ride.status, role, body.noShow ?? false);
        if (!terms.allowed) {
          throw new HttpError(409, 'too_early_for_no_show', { noShowFrom: terms.noShowFrom });
        }
        // The passenger is never charged more than they saw and accepted. Waiting keeps ticking
        // between the screen and the tap, so the accepted amount is a ceiling: we charge the
        // current fee if it is at or below it, otherwise ask again.
        if (role === 'passenger' && terms.feeTiyin > 0 && (body.acceptFeeTiyin ?? -1) < terms.feeTiyin) {
          throw new HttpError(409, 'fee_confirmation_required', { feeTiyin: terms.feeTiyin, breakdown: terms.breakdown });
        }
        // A no-show is accepted only from a driver still at the pickup (as Yandex requires),
        // not from one who already drove off.
        if (body.noShow) {
          const { rows } = await tx.query<{ distance_m: number }>(
            `SELECT ST_Distance(p.point, s.point)::int AS distance_m
               FROM driver_presence p JOIN ride_stops s ON s.ride_id = $1 AND s.position = 0
              WHERE p.driver_id = $2 AND p.updated_at > now() - make_interval(secs => $3)`,
            [ride.id, ride.driver_id, PRESENCE_TTL_SEC],
          );
          const distanceM = rows[0]?.distance_m;
          if (distanceM === undefined || distanceM > ARRIVAL_RADIUS_M) {
            throw new HttpError(409, 'not_at_pickup', { distanceM: distanceM ?? null, maxDistanceM: ARRIVAL_RADIUS_M });
          }
        }
        const fee = terms.feeTiyin > 0 ? terms.feeTiyin : null;
        await tx.query(
          `UPDATE rides SET status = 'cancelled', cancelled_by = $2, cancel_reason = $3,
                  cancel_fee_tiyin = $4, cancel_fee_status = CASE WHEN $4::bigint IS NULL THEN NULL ELSE 'pending' END
            WHERE id = $1`,
          [ride.id, role, body.noShow ? 'no_show' : body.reason ?? null, fee],
        );
        await tx.query(
          `UPDATE ride_offers SET status = 'expired' WHERE ride_id = $1 AND status IN ('open', 'chosen')`,
          [ride.id],
        );
        await logEvent(tx, ride.id, 'status:cancelled', role, userId, {
          from: ride.status, feeTiyin: fee ?? 0, noShow: body.noShow ?? false,
        });
        if (ride.driver_id) {
          const paused = role === 'driver' && !body.noShow && (await pauseIfCancellingTooOften(tx, ride.driver_id));
          if (!paused) await setPresenceStatus(tx, ride.driver_id, 'online');
        }
      });
      if (!repeatedCancel) await chargeCancelFee(request.params.id);
      return rideView(db, request.params.id, role);
    },
  );
}
