// The legal texts people accept, with their current versions. Bump a version when the text changes in
// substance: everyone is asked to accept the new one before their next order or going online.
// The texts themselves are published at LEGAL_BASE_URL/<code>.html (deploy/legal on the test server).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { requireUser } from '../auth/session.ts';

export type DocCode = 'passenger_offer' | 'driver_agreement' | 'privacy';
export type AppKind = 'passenger' | 'driver';

/** Drafts until the lawyer approves them; then the date of the approved text. */
export const LEGAL_VERSIONS: Record<DocCode, string> = {
  passenger_offer: '2026-10-30-draft',
  driver_agreement: '2026-10-30-draft',
  privacy: '2026-10-30-draft',
};

export const NEEDED: Record<AppKind, DocCode[]> = {
  passenger: ['passenger_offer', 'privacy'],
  driver: ['driver_agreement', 'privacy'],
};

export interface LegalDoc { code: DocCode; version: string; url: string }

export function docsFor(app: AppKind, baseUrl: string): LegalDoc[] {
  return NEEDED[app].map((code) => ({ code, version: LEGAL_VERSIONS[code], url: `${baseUrl.replace(/\/+$/, '')}/${code}.html` }));
}

/** The documents of this app the user has not accepted in their current version. */
export async function missingConsents(db: pg.Pool | pg.PoolClient, userId: string, app: AppKind, baseUrl: string): Promise<LegalDoc[]> {
  const docs = docsFor(app, baseUrl);
  const { rows } = await db.query<{ document: string; version: string }>(
    `SELECT document, version FROM user_consents WHERE user_id = $1 AND document = ANY($2)`,
    [userId, docs.map((d) => d.code)],
  );
  return docs.filter((d) => !rows.some((r) => r.document === d.code && r.version === d.version));
}

/** preHandler: refuse with 428 and the list to accept when the user has not accepted them yet. */
export function requireConsent(db: pg.Pool, app: AppKind, baseUrl: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) return;
    const missing = await missingConsents(db, request.user.id, app, baseUrl);
    if (missing.length) await reply.code(428).send({ error: 'consent_required', documents: missing });
  };
}

export async function legalRoutes(app: FastifyInstance, { db, baseUrl }: { db: pg.Pool; baseUrl: string }): Promise<void> {
  app.get('/legal', async () => ({
    documents: (['passenger_offer', 'driver_agreement', 'privacy'] as DocCode[])
      .map((code) => ({ code, version: LEGAL_VERSIONS[code], url: `${baseUrl.replace(/\/+$/, '')}/${code}.html` })),
  }));

  app.get<{ Querystring: { app: AppKind } }>(
    '/me/consents',
    {
      preHandler: requireUser,
      schema: { querystring: { type: 'object', required: ['app'], additionalProperties: false, properties: { app: { type: 'string', enum: ['passenger', 'driver'] } } } },
    },
    async (request) => ({ needed: await missingConsents(db, request.user!.id, request.query.app, baseUrl) }),
  );

  // The app sends exactly what it showed: a version that is no longer current is refused, so nobody
  // "accepts" a text they never saw.
  app.post<{ Body: { accept: { code: DocCode; version: string }[] } }>(
    '/me/consents',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object', required: ['accept'], additionalProperties: false,
          properties: {
            accept: {
              type: 'array', minItems: 1, maxItems: 3,
              items: {
                type: 'object', required: ['code', 'version'], additionalProperties: false,
                properties: {
                  code: { type: 'string', enum: ['passenger_offer', 'driver_agreement', 'privacy'] },
                  version: { type: 'string', minLength: 1, maxLength: 40 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      for (const a of request.body.accept) {
        if (LEGAL_VERSIONS[a.code] !== a.version) {
          return reply.code(409).send({ error: 'version_outdated', code: a.code, current: LEGAL_VERSIONS[a.code] });
        }
      }
      for (const a of request.body.accept) {
        await db.query(
          `INSERT INTO user_consents (user_id, document, version, ip, user_agent) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [request.user!.id, a.code, a.version, request.ip, String(request.headers['user-agent'] ?? '').slice(0, 300) || null],
        );
      }
      return reply.code(204).send();
    },
  );
}
