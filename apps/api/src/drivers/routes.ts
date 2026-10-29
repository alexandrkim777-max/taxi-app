import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireRole, requireUser } from '../auth/session.ts';

export const REQUIRED_DOCUMENTS = ['passport', 'license', 'vehicle_registration', 'selfie', 'self_employed'] as const;

interface Deps {
  db: pg.Pool;
}

async function driverIdFor(db: pg.Pool, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM drivers WHERE user_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  return rows[0]?.id ?? null;
}

/** Driver profile with vehicles, current documents and the document types still missing. */
async function driverProfile(db: pg.Pool, driverId: string) {
  const driver = await db.query(
    `SELECT d.id, d.status, d.rating, d.languages, d.pickup_radius_m, d.verified_at, u.name, u.phone
       FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
    [driverId],
  );
  const vehicles = await db.query(
    `SELECT v.id, v.make_model, v.year, v.color, v.plate, vc.code AS class_code
       FROM vehicles v LEFT JOIN vehicle_classes vc ON vc.id = v.class_id
      WHERE v.driver_id = $1 AND v.deleted_at IS NULL ORDER BY v.created_at`,
    [driverId],
  );
  const documents = await db.query<{ type: string }>(
    `SELECT id, type, status, note, created_at FROM driver_documents
      WHERE driver_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [driverId],
  );
  const present = new Set(documents.rows.map((d) => d.type));
  return {
    ...driver.rows[0],
    vehicles: vehicles.rows,
    documents: documents.rows,
    missingDocuments: REQUIRED_DOCUMENTS.filter((t) => !present.has(t)),
  };
}

export async function driverRoutes(app: FastifyInstance, { db }: Deps): Promise<void> {
  app.post<{ Body: { name: string; gender?: 'female' | 'male'; languages?: string[] } }>(
    '/drivers/apply',
    {
      preHandler: requireUser,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 80 },
            gender: { type: 'string', enum: ['female', 'male'] },
            languages: { type: 'array', items: { type: 'string', enum: ['uz', 'ru', 'en'] }, maxItems: 3 },
          },
        },
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const { name, gender, languages } = request.body;
      await db.query(
        `UPDATE users SET name = $2, gender = COALESCE($3, gender),
                roles = CASE WHEN 'driver' = ANY(roles) THEN roles ELSE roles || ARRAY['driver'] END
          WHERE id = $1`,
        [userId, name, gender ?? null],
      );
      let driverId = await driverIdFor(db, userId);
      if (!driverId) {
        const created = await db.query<{ id: string }>(
          'INSERT INTO drivers (user_id, languages) VALUES ($1, $2) RETURNING id',
          [userId, languages ?? ['uz']],
        );
        driverId = created.rows[0].id;
      }
      return driverProfile(db, driverId);
    },
  );

  app.get('/drivers/me', { preHandler: requireUser }, async (request, reply) => {
    const driverId = await driverIdFor(db, request.user!.id);
    if (!driverId) return reply.code(404).send({ error: 'not_a_driver' });
    return driverProfile(db, driverId);
  });

  app.post<{ Body: { makeModel: string; year: number; color: string; plate: string } }>(
    '/drivers/me/vehicles',
    {
      preHandler: requireUser,
      schema: {
        body: {
          type: 'object',
          required: ['makeModel', 'year', 'color', 'plate'],
          properties: {
            makeModel: { type: 'string', minLength: 2, maxLength: 60 },
            year: { type: 'integer', minimum: 1990, maximum: 2100 },
            color: { type: 'string', minLength: 2, maxLength: 30 },
            plate: { type: 'string', minLength: 5, maxLength: 16 },
          },
        },
      },
    },
    async (request, reply) => {
      const driverId = await driverIdFor(db, request.user!.id);
      if (!driverId) return reply.code(404).send({ error: 'not_a_driver' });
      const { makeModel, year, color, plate } = request.body;
      // The class is assigned by a moderator after checking the car, never by the driver.
      const { rows } = await db.query(
        `INSERT INTO vehicles (driver_id, make_model, year, color, plate)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, make_model, year, color, plate`,
        [driverId, makeModel, year, color, plate.toUpperCase().replace(/\s+/g, '')],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  app.post<{ Body: { type: (typeof REQUIRED_DOCUMENTS)[number]; fileUrl: string } }>(
    '/drivers/me/documents',
    {
      preHandler: requireUser,
      schema: {
        body: {
          type: 'object',
          required: ['type', 'fileUrl'],
          properties: {
            type: { type: 'string', enum: [...REQUIRED_DOCUMENTS] },
            fileUrl: { type: 'string', pattern: '^https://', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const driverId = await driverIdFor(db, request.user!.id);
      if (!driverId) return reply.code(404).send({ error: 'not_a_driver' });
      const { type, fileUrl } = request.body;
      // A new upload replaces the previous one of the same type (soft delete keeps history).
      await db.query(
        `UPDATE driver_documents SET deleted_at = now()
          WHERE driver_id = $1 AND type = $2 AND deleted_at IS NULL`,
        [driverId, type],
      );
      const { rows } = await db.query(
        `INSERT INTO driver_documents (driver_id, type, file_url) VALUES ($1, $2, $3)
         RETURNING id, type, status, created_at`,
        [driverId, type, fileUrl],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  // ---- Moderation (admin) ----

  app.get<{ Querystring: { status?: string } }>(
    '/admin/drivers',
    { preHandler: requireRole('admin') },
    async (request) => {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM drivers WHERE deleted_at IS NULL AND status = $1 ORDER BY created_at`,
        [request.query.status ?? 'pending'],
      );
      return Promise.all(rows.map((r) => driverProfile(db, r.id)));
    },
  );

  app.post<{ Params: { id: string }; Body: { vehicleId: string; classCode: string } }>(
    '/admin/drivers/:id/approve',
    {
      preHandler: requireRole('admin'),
      schema: {
      params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } },
        body: {
          type: 'object',
          required: ['vehicleId', 'classCode'],
          properties: { vehicleId: { type: 'string' }, classCode: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const driverId = request.params.id;
      const profile = await driverProfile(db, driverId);
      if (!profile.id) return reply.code(404).send({ error: 'driver_not_found' });
      if (profile.missingDocuments.length) {
        return reply.code(409).send({ error: 'documents_missing', missing: profile.missingDocuments });
      }

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const cls = await client.query<{ id: string; city_id: string }>(
          `SELECT vc.id, vc.city_id FROM vehicle_classes vc JOIN cities c ON c.id = vc.city_id
            WHERE vc.code = $1 AND c.code = 'tashkent' AND vc.deleted_at IS NULL`,
          [request.body.classCode],
        );
        if (!cls.rows[0]) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'unknown_class' });
        }
        const vehicle = await client.query(
          `UPDATE vehicles SET class_id = $3 WHERE id = $2 AND driver_id = $1 AND deleted_at IS NULL`,
          [driverId, request.body.vehicleId, cls.rows[0].id],
        );
        if (!vehicle.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'unknown_vehicle' });
        }
        await client.query(
          `UPDATE driver_documents SET status = 'approved', reviewed_by = $2, reviewed_at = now()
            WHERE driver_id = $1 AND deleted_at IS NULL AND status = 'pending'`,
          [driverId, request.user!.id],
        );
        await client.query(
          `UPDATE drivers SET status = 'verified', verified_at = now() WHERE id = $1`,
          [driverId],
        );
        // The free trial month starts when the driver is approved.
        await client.query(
          `INSERT INTO subscriptions (driver_id, plan_id, price_paid_tiyin, starts_at, ends_at)
           SELECT $1, p.id, 0, now(), now() + make_interval(days => p.period_days)
             FROM subscription_plans p
            WHERE p.city_id = $2 AND p.code = 'trial'
              AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.driver_id = $1)`,
          [driverId, cls.rows[0].city_id],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return driverProfile(db, driverId);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/admin/drivers/:id/reject',
    {
      preHandler: requireRole('admin'),
      schema: {
      params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } },
        body: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const res = await db.query(
        `UPDATE drivers SET status = 'rejected' WHERE id = $1 AND deleted_at IS NULL`,
        [request.params.id],
      );
      if (!res.rowCount) return reply.code(404).send({ error: 'driver_not_found' });
      // A rejection always carries a reason the driver can see.
      await db.query(
        `UPDATE driver_documents SET note = $2, reviewed_by = $3, reviewed_at = now()
          WHERE driver_id = $1 AND deleted_at IS NULL AND status = 'pending'`,
        [request.params.id, request.body.reason, request.user!.id],
      );
      return driverProfile(db, request.params.id);
    },
  );
}
