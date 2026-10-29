// Development / test provider. Behaves like a real one (checkout, card tokens, charges, signed
// webhooks) without moving money. Refused in production by config.ts.
//
// Test cards (tokens the app's dev build sends):
//   fake_tok_<anything>         a valid card, charges succeed
//   fake_tok_decline_<anything> a valid card, charges are declined (insufficient funds)

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CardInfo, ChargeRequest, ChargeResult, CheckoutRequest, CheckoutResult, PaymentLookup, PaymentProvider,
  WebhookOutcome, WebhookRequest,
} from '../types.ts';

export class FakeProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  private readonly secret: string;
  private readonly baseUrl: string;

  constructor(opts: { secret: string; baseUrl: string }) {
    this.secret = opts.secret;
    this.baseUrl = opts.baseUrl;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    return { checkoutUrl: `${this.baseUrl}/dev/payments/${req.paymentId}` };
  }

  async verifyCardToken(token: string): Promise<CardInfo> {
    if (!/^fake_tok_[A-Za-z0-9_]{1,64}$/.test(token)) throw new Error('invalid card token');
    const last4 = String([...token].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 10_000, 7)).padStart(4, '0');
    return { panMasked: `8600 **** **** ${last4}`, expiry: '12/29' };
  }

  async chargeCard(req: ChargeRequest): Promise<ChargeResult> {
    if (req.cardToken.startsWith('fake_tok_decline')) {
      return { status: 'failed', reason: 'insufficient_funds', providerRef: `fake_${req.paymentId}` };
    }
    return { status: 'succeeded', providerRef: `fake_${req.paymentId}` };
  }

  async removeCard(): Promise<void> {}

  /** Signs a webhook body the way this provider expects (used by the dev page and tests). */
  sign(body: unknown): string {
    return createHmac('sha256', this.secret).update(JSON.stringify(body)).digest('hex');
  }

  async handleWebhook(req: WebhookRequest, lookup: PaymentLookup): Promise<WebhookOutcome & { signatureOk: boolean }> {
    const given = String(req.headers['x-fake-signature'] ?? '');
    const expected = this.sign(req.body);
    const signatureOk = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!signatureOk) return { signatureOk, httpStatus: 401, response: { error: 'bad_signature' } };

    const b = req.body as { paymentId?: string; amountTiyin?: number; result?: string; ref?: string };
    const payment = b.paymentId ? await lookup.find(b.paymentId) : null;
    if (!payment) return { signatureOk, httpStatus: 404, response: { error: 'unknown_payment' } };
    return {
      signatureOk,
      httpStatus: 200,
      response: { ok: true },
      settled: {
        paymentId: payment.id,
        providerRef: b.ref ?? `fake_${payment.id}`,
        amountTiyin: Number(b.amountTiyin),
        status: b.result === 'success' ? 'succeeded' : 'failed',
        reason: b.result === 'success' ? undefined : 'declined',
      },
    };
  }
}
