import type { FastifyInstance } from 'fastify';
import { fileService } from './index.ts';

// Serves a private file only for a valid, unexpired signed link. No login needed (an <img> tag
// cannot send one); the link itself is the permission and expires in minutes.
export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { '*': string }; Querystring: { exp?: string; sig?: string } }>(
    '/files/*',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const file = await fileService().open(request.params['*'], Number(request.query.exp), String(request.query.sig ?? ''));
      if (!file) return reply.code(403).send({ error: 'link_invalid_or_expired' });
      return reply
        .header('content-type', file.contentType)
        .header('cache-control', 'private, max-age=600')
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', 'inline')
        .header('content-security-policy', "default-src 'none'")
        .send(file.data);
    },
  );
}
