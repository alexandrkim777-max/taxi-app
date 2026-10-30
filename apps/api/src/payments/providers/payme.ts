// Payme (Paycom) adapter — STUB until merchant access is granted.
//
// Where each method maps (check every detail against the docs we get with the merchant account):
//   createCheckout   -> hosted checkout link: https://checkout.paycom.uz/<base64("m=<merchantId>;ac.payment_id=<id>;a=<tiyin>;c=<returnUrl>")>
//   verifyCardToken  -> Subscribe API `cards.check` (token comes from the app via `cards.create` +
//                       `cards.get_verify_code` + `cards.verify`, done client-side with the merchant id only)
//   chargeCard       -> Subscribe API `receipts.create` + `receipts.pay`
//   removeCard       -> Subscribe API `cards.remove`
//   handleWebhook    -> Merchant API (JSON-RPC, Payme calls us): CheckPerformTransaction, CreateTransaction,
//                       PerformTransaction, CancelTransaction, CheckTransaction, GetStatement.
//                       Auth: HTTP Basic "Paycom:<PAYME_KEY>", plus Payme's published IP list.
//                       Amounts are in tiyin, same as ours.

import type { CardInfo, ChargeRequest, ChargeResult, CheckoutRequest, CheckoutResult, PaymentLookup, PaymentProvider, WebhookOutcome, WebhookRequest, RefundRequest, RefundResult } from '../types.ts';
import { ProviderNotConfigured } from '../types.ts';

export interface PaymeConfig {
  merchantId: string;
  /** Secret key for the Merchant API (Basic auth password). Test and production keys differ. */
  key: string;
  /** 'https://checkout.test.paycom.uz' for the sandbox. */
  checkoutBaseUrl: string;
  /** Subscribe API endpoint. */
  apiUrl: string;
}

export class PaymeProvider implements PaymentProvider {
  readonly name = 'payme' as const;
  private readonly cfg: PaymeConfig;
  constructor(cfg: PaymeConfig) {
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

  /** -> Merchant API `CancelTransaction` for card receipts (`receipts.cancel` in the Subscribe API) */
  async refund(_req: RefundRequest): Promise<RefundResult> {
    throw new ProviderNotConfigured(this.name, 'refund');
  }

  async removeCard(_token: string): Promise<void> {
    throw new ProviderNotConfigured(this.name, 'removeCard');
  }

  async handleWebhook(_req: WebhookRequest, _lookup: PaymentLookup): Promise<WebhookOutcome & { signatureOk: boolean }> {
    // Until implemented, refuse everything: never settle a payment from an unverified call.
    return { signatureOk: false, httpStatus: 501, response: { error: 'not_implemented' } };
  }
}
