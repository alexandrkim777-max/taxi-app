// Click adapter — STUB until merchant access is granted.
//
// Where each method maps (check every detail against the docs we get with the merchant account):
//   createCheckout   -> https://my.click.uz/services/pay?service_id=..&merchant_id=..&amount=<sum>&transaction_param=<paymentId>&return_url=..
//                       NOTE: Click amounts are in sum (with decimals), ours in tiyin — convert here only.
//   verifyCardToken  -> Click card-token API (token requested and SMS-verified by the app)
//   chargeCard       -> Click card-token payment
//   removeCard       -> Click card-token delete
//   handleWebhook    -> Click SHOP API: Prepare (action=0) and Complete (action=1) calls to us,
//                       authenticated by sign_string = md5(click_trans_id + service_id + SECRET_KEY +
//                       merchant_trans_id + [merchant_prepare_id] + amount + action + sign_time).

import type { CardInfo, ChargeRequest, ChargeResult, CheckoutRequest, CheckoutResult, PaymentLookup, PaymentProvider, WebhookOutcome, WebhookRequest, RefundRequest, RefundResult } from '../types.ts';
import { ProviderNotConfigured } from '../types.ts';

export interface ClickConfig {
  serviceId: string;
  merchantId: string;
  merchantUserId: string;
  secretKey: string;
}

export class ClickProvider implements PaymentProvider {
  readonly name = 'click' as const;
  private readonly cfg: ClickConfig;
  constructor(cfg: ClickConfig) {
    this.cfg = cfg;
  }

  async createCheckout(_req: CheckoutRequest): Promise<CheckoutResult> {
    throw new ProviderNotConfigured(this.name, 'createCheckout');
  }

  async verifyCardToken(_token: string): Promise<CardInfo> {
    throw new ProviderNotConfigured(this.name, 'verifyCardToken');
  }

  async chargeCard(_req: ChargeRequest): Promise<ChargeResult> {
    throw new ProviderNotConfigured(this.name, 'chargeCard');
  }

  /** -> Click `payment/reversal` (partial: check the merchant contract) */
  async refund(_req: RefundRequest): Promise<RefundResult> {
    throw new ProviderNotConfigured(this.name, 'refund');
  }

  async removeCard(_token: string): Promise<void> {
    throw new ProviderNotConfigured(this.name, 'removeCard');
  }

  async handleWebhook(_req: WebhookRequest, _lookup: PaymentLookup): Promise<WebhookOutcome & { signatureOk: boolean }> {
    return { signatureOk: false, httpStatus: 501, response: { error: 'not_implemented' } };
  }
}
