// Staff: price coefficient (raise / lower all prices), class tariffs and fees, subscription plans.
// Admin only. Every change is audited; the coefficient has hard database bounds (0.70–1.50) and
// only affects new orders.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAdmin, requireStaff } from '../auth/session.ts';
import { uuidParams } from '../lib/geo.ts';
import { HttpError } from '../lib/tx.ts';
import { audit } from './audit.ts';

interface Deps {
  db: pg.Pool;
  cityCode: string;
}

const CLASS_CODE = { type: 'string', pattern: '^[a-z_]{2,32}$' } as const;

export async function adminPricingRoutes(app: FastifyInstance, { db, cityCode }: Deps): Promise<void> {
  // Current state: the effective coefficient per class, tariffs, fees, and active coefficient rules.
  app.get('/admin/pricing', { preHandler: requireStaff }, async () => {
    const classes = await db.query(
      `SELECT vc.code, vc.name, current_price_coefficient(vc.id)::float AS coefficient,
              vc.rec_base_tiyin::int AS "baseTiyin", vc.rec_per_km_tiyin::int AS "perKmTiyin",
              vc.rec_per_min_tiyin::int AS "perMinTiyin", vc.rec_min_fare_tiyin::int AS "minFareTiyin",
              vc.corridor_min_pct AS "corridorMinPct", vc.corridor_max_pct AS "corridorMaxPct",
              vc.cancel_fee_tiyin::int AS "cancelFeeTiyin", vc.free_wait_min AS "freeWaitMin",
              vc.wait_per_min_tiyin::int AS "waitPerMinTiyin"
         FROM vehicle_classes vc JOIN cities c ON c.id = vc.city_id
        WHERE c.code = $1 AND vc.deleted_at IS NULL ORDER BY vc.rec_base_tiyin`,
      [cityCode],
    );
    const rules = await db.query(
      `SELECT pc.id, vc.code AS "classCode", pc.value::float AS value, pc.reason, pc.valid_from AS "validFrom",
              pc.valid_until AS "validUntil", u.name AS "setBy", pc.created_at AS "createdAt",
              pc.cancelled_at AS "cancelledAt",
              (pc.cancelled_at IS NULL AND pc.valid_from <= now() AND (pc.valid_until IS NULL OR pc.valid_until > now())) AS active
         FROM price_coefficients pc
         JOIN cities c ON c.id = pc.city_id
         LEFT JOIN vehicle_classes vc ON vc.id = pc.class_id
         JOIN users u ON u.id = pc.set_by
        WHERE c.code = $1 AND (pc.valid_until IS NULL OR pc.valid_until > now() - interval '7 days')
        ORDER BY pc.created_at DESC LIMIT 100`,
      [cityCode],
    );
    const plans = await db.query(
      `SELECT sp.code, sp.name, sp.price_tiyin::int AS "priceTiyin", sp.period_days AS "periodDays", sp.is_active AS "isActive"
         FROM subscription_plans sp JOIN cities c ON c.id = sp.city_id WHERE c.code = $1 ORDER BY sp.period_days`,
      [cityCode],
    );
    return { classes: classes.rows, coefficientRules: rules.rows, plans: plans.rows };
  });

  // Raise or lower prices: whole city (no classCode) or one class; optionally only for a time window.
  app.post<{ Body: { value: number; reason: string; classCode?: string; validFrom?: string; validUntil?: string } }>(
    '/admin/pricing/coefficients',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object', required: ['value', 'reason'], additionalProperties: false,
          properties: {
            // Stored with two decimals (e.g. 1.15).
            value: { type: 'number', minimum: 0.7, maximum: 1.5 },
            reason: { type: 'string', minLength: 3, maxLength: 300 },
            classCode: CLASS_CODE,
            validFrom: { type: 'string', format: 'date-time' },
            validUntil: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      if (b.validUntil && new Date(b.validUntil) <= new Date(b.validFrom ?? Date.now())) {
        throw new HttpError(400, 'invalid_window');
      }
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO price_coefficients (city_id, class_id, value, reason, valid_from, valid_until, set_by)
         SELECT c.id, vc.id, $3, $4, coalesce($5::timestamptz, now()), $6::timestamptz, $7
           FROM cities c LEFT JOIN vehicle_classes vc ON vc.city_id = c.id AND vc.code = $2
          WHERE c.code = $1 AND ($2::text IS NULL OR vc.id IS NOT NULL)
         RETURNING id`,
        [cityCode, b.classCode ?? null, Math.round(b.value * 100) / 100, b.reason.trim(), b.validFrom ?? null, b.validUntil ?? null, request.user!.id],
      );
      if (!rows[0]) throw new HttpError(400, 'unknown_class');
      await audit(db, request, 'price_coefficient_set', { type: 'price_coefficient', id: rows[0].id }, { ...b });
      return reply.code(201).send({ id: rows[0].id });
    },
  );

  // End a coefficient rule now, or cancel a scheduled one (back to the previous / normal level).
  app.post<{ Params: { id: string } }>(
    '/admin/pricing/coefficients/:id/end',
    { preHandler: requireAdmin, schema: { params: uuidParams } },
    async (request) => {
      // Works for active and for scheduled (future) rules; history is kept.
      const { rowCount } = await db.query(
        `UPDATE price_coefficients SET cancelled_at = now()
          WHERE id = $1 AND cancelled_at IS NULL AND (valid_until IS NULL OR valid_until > now())`,
        [request.params.id],
      );
      if (!rowCount) throw new HttpError(409, 'not_active');
      await audit(db, request, 'price_coefficient_ended', { type: 'price_coefficient', id: request.params.id });
      return { status: 'ended' };
    },
  );

  // Recommended tariff, fees and waiting for a class. Database checks keep fees and rates in bounds.
  app.put<{
    Params: { code: string };
    Body: Partial<Record<'baseTiyin' | 'perKmTiyin' | 'perMinTiyin' | 'minFareTiyin' | 'cancelFeeTiyin' | 'waitPerMinTiyin' | 'freeWaitMin', number>> & { reason: string };
  }>(
    '/admin/pricing/classes/:code',
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: 'object', required: ['code'], properties: { code: CLASS_CODE } },
        body: {
          type: 'object', required: ['reason'], additionalProperties: false, minProperties: 2,
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 300 },
            baseTiyin: { type: 'integer', minimum: 0, maximum: 100_000_000 },
            perKmTiyin: { type: 'integer', minimum: 0, maximum: 10_000_000 },
            perMinTiyin: { type: 'integer', minimum: 0, maximum: 10_000_000 },
            minFareTiyin: { type: 'integer', minimum: 0, maximum: 100_000_000 },
            cancelFeeTiyin: { type: 'integer', minimum: 500_000, maximum: 1_000_000 },
            waitPerMinTiyin: { type: 'integer', minimum: 0, maximum: 200_000 },
            freeWaitMin: { type: 'integer', minimum: 0, maximum: 10 },
          },
        },
      },
    },
    async (request) => {
      const b = request.body;
      const before = await db.query(
        `SELECT vc.* FROM vehicle_classes vc JOIN cities c ON c.id = vc.city_id WHERE c.code = $1 AND vc.code = $2`,
        [cityCode, request.params.code],
      );
      if (!before.rows[0]) throw new HttpError(404, 'not_found');
      await db.query(
        `UPDATE vehicle_classes SET
           rec_base_tiyin = coalesce($2, rec_base_tiyin), rec_per_km_tiyin = coalesce($3, rec_per_km_tiyin),
           rec_per_min_tiyin = coalesce($4, rec_per_min_tiyin), rec_min_fare_tiyin = coalesce($5, rec_min_fare_tiyin),
           cancel_fee_tiyin = coalesce($6, cancel_fee_tiyin), wait_per_min_tiyin = coalesce($7, wait_per_min_tiyin),
           free_wait_min = coalesce($8, free_wait_min)
         WHERE id = $1`,
        [before.rows[0].id, b.baseTiyin ?? null, b.perKmTiyin ?? null, b.perMinTiyin ?? null, b.minFareTiyin ?? null,
          b.cancelFeeTiyin ?? null, b.waitPerMinTiyin ?? null, b.freeWaitMin ?? null],
      );
      const { reason, ...changes } = b;
      await audit(db, request, 'class_pricing_changed', { type: 'vehicle_class', id: before.rows[0].id }, {
        code: request.params.code, reason, changes,
        before: {
          baseTiyin: Number(before.rows[0].rec_base_tiyin), perKmTiyin: Number(before.rows[0].rec_per_km_tiyin),
          perMinTiyin: Number(before.rows[0].rec_per_min_tiyin), minFareTiyin: Number(before.rows[0].rec_min_fare_tiyin),
          cancelFeeTiyin: Number(before.rows[0].cancel_fee_tiyin), waitPerMinTiyin: Number(before.rows[0].wait_per_min_tiyin),
          freeWaitMin: before.rows[0].free_wait_min,
        },
      });
      return { status: 'updated' };
    },
  );

  // Subscription plan price / availability. Already paid periods keep the price they were paid at.
  app.put<{ Params: { code: string }; Body: { priceTiyin?: number; isActive?: boolean; reason: string } }>(
    '/admin/pricing/plans/:code',
    {
      preHandler: requireAdmin,
      schema: {
        params: { type: 'object', required: ['code'], properties: { code: CLASS_CODE } },
        body: {
          type: 'object', required: ['reason'], additionalProperties: false, minProperties: 2,
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 300 },
            priceTiyin: { type: 'integer', minimum: 100_000, maximum: 1_000_000_000 },
            isActive: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      if (request.params.code === 'trial') throw new HttpError(409, 'trial_is_free');
      const { rows } = await db.query(
        `UPDATE subscription_plans sp SET price_tiyin = coalesce($3, sp.price_tiyin), is_active = coalesce($4, sp.is_active)
           FROM cities c WHERE c.id = sp.city_id AND c.code = $1 AND sp.code = $2
         RETURNING sp.id`,
        [cityCode, request.params.code, request.body.priceTiyin ?? null, request.body.isActive ?? null],
      );
      if (!rows[0]) throw new HttpError(404, 'not_found');
      await audit(db, request, 'plan_changed', { type: 'subscription_plan', id: rows[0].id }, { ...request.body, code: request.params.code });
      return { status: 'updated' };
    },
  );
}
