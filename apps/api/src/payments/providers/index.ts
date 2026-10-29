// Builds the enabled payment providers from configuration.
// PAYMENT_PROVIDERS=fake (development) or e.g. payme,click (production).

import type { PaymentProvider, ProviderName } from '../types.ts';
import { PROVIDER_NAMES } from '../types.ts';
import { FakeProvider } from './fake.ts';
import { PaymeProvider } from './payme.ts';
import { ClickProvider } from './click.ts';
import { UzumProvider } from './uzum.ts';

export type Env = Record<string, string | undefined>;

function need(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export function createPaymentProviders(env: Env): Map<ProviderName, PaymentProvider> {
  const names = (env.PAYMENT_PROVIDERS ?? 'fake').split(',').map((s) => s.trim()).filter(Boolean);
  const providers = new Map<ProviderName, PaymentProvider>();
  for (const name of names) {
    if (!PROVIDER_NAMES.includes(name as ProviderName)) throw new Error(`Unknown payment provider: ${name}`);
    switch (name as ProviderName) {
      case 'fake':
        providers.set('fake', new FakeProvider({
          secret: env.FAKE_PAYMENT_SECRET ?? 'dev-fake-payment-secret',
          baseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
        }));
        break;
      case 'payme':
        providers.set('payme', new PaymeProvider({
          merchantId: need(env, 'PAYME_MERCHANT_ID'), key: need(env, 'PAYME_KEY'),
          checkoutBaseUrl: env.PAYME_CHECKOUT_URL ?? 'https://checkout.paycom.uz',
          apiUrl: env.PAYME_API_URL ?? 'https://checkout.paycom.uz/api',
        }));
        break;
      case 'click':
        providers.set('click', new ClickProvider({
          serviceId: need(env, 'CLICK_SERVICE_ID'), merchantId: need(env, 'CLICK_MERCHANT_ID'),
          merchantUserId: need(env, 'CLICK_MERCHANT_USER_ID'), secretKey: need(env, 'CLICK_SECRET_KEY'),
        }));
        break;
      case 'uzum':
        providers.set('uzum', new UzumProvider({ merchantId: need(env, 'UZUM_MERCHANT_ID'), secretKey: need(env, 'UZUM_SECRET_KEY') }));
        break;
    }
  }
  return providers;
}
