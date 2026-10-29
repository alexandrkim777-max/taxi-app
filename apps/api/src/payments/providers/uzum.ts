// Uzum Bank adapter — STUB until merchant access is granted.
//
// Fill in from the Uzum Bank merchant documentation we receive: hosted checkout, card binding,
// recurring charges and the server-to-server notification with its signature scheme.

import type { CardInfo, ChargeRequest, ChargeResult, CheckoutRequest, CheckoutResult, PaymentLookup, PaymentProvider, WebhookOutcome, WebhookRequest } from '../types.ts';
import { ProviderNotConfigured } from '../types.ts';

export interface UzumConfig {
  merchantId: string;
  secretKey: string;
}

export class UzumProvider implements PaymentProvider {
  readonly name = 'uzum' as const;
  private readonly cfg: UzumConfig;
  constructor(cfg: UzumConfig) {
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

  async removeCard(_token: string): Promise<void> {
    throw new ProviderNotConfigured(this.name, 'removeCard');
  }

  async handleWebhook(_req: WebhookRequest, _lookup: PaymentLookup): Promise<WebhookOutcome & { signatureOk: boolean }> {
    return { signatureOk: false, httpStatus: 501, response: { error: 'not_implemented' } };
  }
}
