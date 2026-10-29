// Address search, reverse geocoding, entrances near a point, saved places.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUser } from '../auth/session.ts';
import { UZ_LAT, UZ_LNG, uuidParams } from '../lib/geo.ts';
import { HttpError } from '../lib/tx.ts';
import { langOf } from '../lib/i18n.ts';
import type { GeoProvider } from './provider.ts';

interface Deps {
  db: pg.Pool;
  geo: GeoProvider;

}

const MAX_OTHER_PLACES = 10;
const ENTRANCE_RADIUS_M = 120;

const placeBody = {
  type: 'object', required: ['address', 'lat', 'lng'], additionalProperties: false,
  properties: {
    address: { type: 'string', minLength: 2, maxLength: 200 },
    label: { type: 'string', minLength: 1, maxLength: 40 },
    lat: UZ_LAT, lng: UZ_LNG,
    entranceId: uuidParams.properties.id,
  },
} as const;

export async function geoRoutes(app: FastifyInstance, { db, geo }: Deps): Promise<void> {
  // Search: only for signed-in users and rate-limited, so the API is not a free geocoder for others.
  app.get<{ Querystring: { q: string; lat?: number; lng?: number } }>(
    '/geo/search',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        querystring: {
          type: 'object', required: ['q'], additionalProperties: false,
          properties: { q: { type: 'string', minLength: 2, maxLength: 100 }, lat: UZ_LAT, lng: UZ_LNG },
        },
      },
    },
    async (request, reply) => {
      const near = request.query.lat !== undefined && request.query.lng !== undefined ? { lat: request.query.lat, lng: request.query.lng } : null;
      try {
        return await geo.search(request.query.q.trim(), near, langOf(request));
      } catch (err) {
        request.log.warn(err, 'geo search failed');
        return reply.code(503).send({ error: 'geo_unavailable' });
      }
    },
  );

  app.get<{ Querystring: { lat: number; lng: number } }>(
    '/geo/reverse',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { querystring: { type: 'object', required: ['lat', 'lng'], additionalProperties: false, properties: { lat: UZ_LAT, lng: UZ_LNG } } },
    },
    async (request, reply) => {
      try {
        return (await geo.reverse(request.query.lat, request.query.lng, langOf(request))) ?? reply.code(404).send({ error: 'not_found' });
      } catch (err) {
        request.log.warn(err, 'geo reverse failed');
        return reply.code(503).send({ error: 'geo_unavailable' });
      }
    },
  );

  // Known entrances around the pickup pin, nearest first, so the passenger can tap "entrance 3".
  app.get<{ Querystring: { lat: number; lng: number } }>(
    '/geo/entrances',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { querystring: { type: 'object', required: ['lat', 'lng'], additionalProperties: false, properties: { lat: UZ_LAT, lng: UZ_LNG } } },
    },
    async (request) => {
      const { rows } = await db.query(
        `WITH p AS (SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS g)
         SELECT e.id, e.number, ST_Y(e.entrance_point::geometry) AS lat, ST_X(e.entrance_point::geometry) AS lng,
                e.building_address AS "buildingAddress", e.confirmed_pickups AS "confirmedPickups",
                ST_Distance(e.entrance_point, p.g)::int AS "distanceM"
           FROM entrances e, p
          WHERE e.deleted_at IS NULL AND ST_DWithin(e.entrance_point, p.g, $3)
          ORDER BY e.entrance_point <-> p.g
          LIMIT 12`,
        [request.query.lat, request.query.lng, ENTRANCE_RADIUS_M],
      );
      return rows;
    },
  );

  // ---- Saved places ----

  app.get('/me/places', { preHandler: requireUser }, async (request) => {
    const { rows } = await db.query(
      `SELECT id, kind, label, address, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng, entrance_id AS "entranceId"
         FROM saved_places WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY CASE kind WHEN 'home' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, created_at`,
      [request.user!.id],
    );
    return rows;
  });

  // Home and work: set or replace.
  app.put<{ Params: { kind: 'home' | 'work' }; Body: { address: string; lat: number; lng: number; entranceId?: string } }>(
    '/me/places/:kind',
    {
      preHandler: requireUser,
      schema: { params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['home', 'work'] } } }, body: placeBody },
    },
    async (request) => {
      const userId = request.user!.id;
      await db.query(`UPDATE saved_places SET deleted_at = now() WHERE user_id = $1 AND kind = $2 AND deleted_at IS NULL`, [userId, request.params.kind]);
      const { rows } = await db.query(
        `INSERT INTO saved_places (user_id, kind, address, point, entrance_id)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography, $6) RETURNING id`,
        [userId, request.params.kind, request.body.address, request.body.lat, request.body.lng, request.body.entranceId ?? null],
      );
      return { id: rows[0].id };
    },
  );

  app.post<{ Body: { address: string; label?: string; lat: number; lng: number; entranceId?: string } }>(
    '/me/places',
    { preHandler: requireUser, schema: { body: placeBody } },
    async (request, reply) => {
      const userId = request.user!.id;
      const { rows: [n] } = await db.query(`SELECT count(*)::int AS n FROM saved_places WHERE user_id = $1 AND kind = 'other' AND deleted_at IS NULL`, [userId]);
      if (n.n >= MAX_OTHER_PLACES) throw new HttpError(409, 'too_many_places');
      const { rows } = await db.query(
        `INSERT INTO saved_places (user_id, kind, label, address, point, entrance_id)
         VALUES ($1, 'other', $2, $3, ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography, $6) RETURNING id`,
        [userId, request.body.label ?? null, request.body.address, request.body.lat, request.body.lng, request.body.entranceId ?? null],
      );
      return reply.code(201).send({ id: rows[0].id });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/me/places/:id',
    { preHandler: requireUser, schema: { params: uuidParams } },
    async (request, reply) => {
      const { rowCount } = await db.query(
        `UPDATE saved_places SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [request.params.id, request.user!.id],
      );
      if (!rowCount) throw new HttpError(404, 'not_found');
      return reply.code(204).send();
    },
  );

}
