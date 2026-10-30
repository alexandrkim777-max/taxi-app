// Refunds decided by staff: an admin sees the payment, writes why and how much, and the money goes
// back through the provider that took it. Who approved it, the reason and the result are in the
// audit log and on the refund itself. Money moves, so admins only (support can see, not send).

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAdmin } from '../auth/session.ts';
import { HttpError } from '../lib/tx.ts';
import type { PaymentService } from '../payments/service.ts';
import { uuidParams } from '../lib/geo.ts';
import { audit } from './audit.ts';

interface Deps {
  db: pg.Pool;
  payments: PaymentService;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function adminRefundRoutes(app: FastifyInstance, { db, payments }: Deps): Promise<void> {
  app.post<{ Params: { id: string }; Body: { amountTiyin: number; reason: string } }>(
    '/admin/payments/:id/refund',
    {
      preHandler: requireAdmin,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        params: uuidParams,
        body: {
          type: 'object', required: ['amountTiyin', 'reason'], additionalProperties: false,
          properties: {
            amountTiyin: { type: 'integer', minimum: 100, maximum: 100_000_000 },
            reason: { type: 'string', minLength: 5, maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      // The panel makes one key per refund form: a double click or a lost answer is the same refund.
      const key = String(request.headers['idempotency-key'] ?? '');
      if (!UUID.test(key)) throw new HttpError(400, 'idempotency_key_required');
      const reason = request.body.reason.trim();
      let result;
      try {
        result = await payments.refund({
          paymentId: request.params.id, amountTiyin: request.body.amountTiyin, kind: 'moderator', reason,
          approvedBy: request.user!.id, key: `refund:moderator:${key}`,
        });
      } catch (err) {
        if (err instanceof HttpError) {
          await audit(db, request, 'refund_refused', { type: 'payment', id: request.params.id },
            { amountTiyin: request.body.amountTiyin, reason, error: err.code });
        }
        throw err;
      }
      await audit(db, request, 'refund_sent', { type: 'payment', id: request.params.id },
        { amountTiyin: request.body.amountTiyin, reason, refundId: result.refundId, status: result.status });
      return result;
    },
  );
}
