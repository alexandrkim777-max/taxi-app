// Adding a card. The card number and the SMS code go straight to the payment provider's SDK
// (Payme / Click / Uzum card binding); our server receives only the provider's token. Nothing about
// the card is kept on the phone either: the number lives in the form state until the screen closes.
//
// Real providers are stubs until their SDK access is granted; then each tokenize() is filled in:
//   payme -> cards.create + cards.get_verify_code + cards.verify (Subscribe API, merchant id only)
//   click -> card token request + SMS verify (Click Pass / card tokenisation API)
//   uzum  -> card binding API

import { DEMO } from './api';

export type CardProvider = 'payme' | 'click' | 'uzum' | 'fake';

export class ProviderSdkMissing extends Error {
  constructor() { super('provider_sdk_not_connected'); }
}

/** Luhn check: catches typos before anything is sent anywhere. */
export function luhnOk(pan: string): boolean {
  const d = pan.replace(/\D/g, '');
  if (d.length < 16 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

export function expiryOk(mmYY: string): boolean {
  const m = mmYY.match(/^(\d{2})\/(\d{2})$/);
  if (!m) return false;
  const month = Number(m[1]), year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) return false;
  const now = new Date();
  return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
}

/** Which provider binds cards in this build. */
export const CARD_PROVIDER: CardProvider = DEMO ? 'fake' : ((process.env.EXPO_PUBLIC_CARD_PROVIDER as CardProvider | undefined) ?? 'payme');

export async function tokenizeCard(provider: CardProvider, pan: string, _expiry: string): Promise<string> {
  if (provider === 'fake') {
    // Development / demo only: inert in release builds, and the API refuses the fake provider in production.
    if (!DEMO && !__DEV__) throw new ProviderSdkMissing();
    // A number ending in 0502 behaves like a card without enough money.
    const digits = pan.replace(/\D/g, '');
    const rand = Math.random().toString(36).slice(2, 10);
    return digits.endsWith('0502') ? `fake_tok_decline_${rand}` : `fake_tok_${digits.slice(-4)}_${rand}`;
  }
  throw new ProviderSdkMissing();
}
