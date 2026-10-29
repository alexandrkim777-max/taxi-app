// The contract every payment provider adapter implements. The rest of the app talks only to this,
// so adding or replacing Payme / Click / Uzum means writing one adapter file, nothing else.

export type ProviderName = 'payme' | 'click' | 'uzum' | 'fake';
export const PROVIDER_NAMES: readonly ProviderName[] = ['payme', 'click', 'uzum', 'fake'];

export interface CheckoutRequest {
  /** Our payment id; the provider sends it back so we can match the payment. */
  paymentId: string;
  amountTiyin: number;
  description: string;
  /** Where the provider's page returns the user afterwards (deep link into the app). */
  returnUrl: string;
}

export interface CheckoutResult {
  /** Provider's payment page to open in the app's browser. */
  checkoutUrl: string;
}

export interface CardInfo {
  /** As the provider shows it, e.g. '8600 **** **** 1234'. Never the full number. */
  panMasked: string;
  /** 'MM/YY' */
  expiry: string | null;
}

export interface ChargeRequest {
  paymentId: string;
  /** Decrypted card token from payment_cards. */
  cardToken: string;
  amountTiyin: number;
  description: string;
}

export type ChargeResult =
  | { status: 'succeeded'; providerRef: string }
  | { status: 'pending'; providerRef: string }
  | { status: 'failed'; reason: string; providerRef?: string };

/** What a webhook told us, normalised. */
export interface WebhookOutcome {
  /** Exactly what to answer the provider (each has its own protocol). */
  httpStatus: number;
  response: unknown;
  /** Set when the call settled one of our payments. */
  settled?: {
    paymentId: string;
    providerRef: string;
    amountTiyin: number;
    status: 'succeeded' | 'failed' | 'cancelled';
    reason?: string;
  };
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  remoteIp: string;
}

/** Read access the webhook protocols need (e.g. Payme's CheckPerformTransaction asks "can I charge X?"). */
export interface PaymentLookup {
  find(paymentId: string): Promise<{ id: string; amountTiyin: number; status: string } | null>;
}

export interface PaymentProvider {
  readonly name: ProviderName;

  /** One-off payment on the provider's page (driver subscriptions). */
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;

  /**
   * Checks a card token the app obtained from the provider's SDK (card entered and SMS-verified
   * on the provider's side) and returns its masked details. Throws if the token is not valid.
   */
  verifyCardToken(token: string): Promise<CardInfo>;

  /** Charges a saved card without the user present (ride fare, cancellation fee, debts). */
  chargeCard(req: ChargeRequest): Promise<ChargeResult>;

  /** Removes the token on the provider's side when the user deletes the card. */
  removeCard(token: string): Promise<void>;

  /**
   * Handles the provider's server-to-server call: verifies its authenticity FIRST, then parses it.
   * Must never trust amounts or statuses from an unverified request.
   */
  handleWebhook(req: WebhookRequest, lookup: PaymentLookup): Promise<WebhookOutcome & { signatureOk: boolean }>;
}

/** Thrown by adapters that are not wired to the real API yet. */
export class ProviderNotConfigured extends Error {
  constructor(provider: ProviderName, what: string) {
    super(`${provider}: ${what} is not implemented yet (waiting for API access)`);
  }
}
