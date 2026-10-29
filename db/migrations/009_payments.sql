-- 009_payments.sql — payments behind provider adapters (Payme, Click, Uzum; 'fake' for development).
--
-- Card data never touches our servers: the app tokenises the card with the provider's own SDK/form
-- and sends us only the token, which is stored encrypted. Every payment has an idempotency key, a
-- state machine and the provider's reference (unique), so a webhook delivered twice is harmless.

ALTER TABLE payments DROP CONSTRAINT payments_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_type_check
  CHECK (type IN ('ride', 'tip', 'subscription', 'cancel_fee', 'hold', 'refund'));
ALTER TABLE payments DROP CONSTRAINT payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check
  CHECK (provider IN ('payme', 'click', 'uzum', 'fake', 'cash', 'manual'));
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled', 'refunded'));
ALTER TABLE payments
  ADD COLUMN payer_user_id    uuid REFERENCES users(id),
  ADD COLUMN driver_id        uuid REFERENCES drivers(id),     -- whose money it is (ride, fee) or who pays (subscription)
  ADD COLUMN plan_id          uuid REFERENCES subscription_plans(id),
  ADD COLUMN card_id          uuid,
  ADD COLUMN idempotency_key  text,
  ADD COLUMN checkout_url     text,
  ADD COLUMN failure_reason   text,
  ADD COLUMN paid_at          timestamptz,
  ADD CONSTRAINT payments_amount_positive CHECK (amount_tiyin > 0);
CREATE UNIQUE INDEX payments_idempotency_key ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_ref ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payments_payer_idx ON payments (payer_user_id, created_at DESC);

-- Saved cards: provider token (encrypted), never the card number.
CREATE TABLE payment_cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  provider     text NOT NULL CHECK (provider IN ('payme', 'click', 'uzum', 'fake')),
  token_enc    text NOT NULL,                       -- AES-256-GCM, key in PAYMENT_TOKEN_KEY
  token_hash   text NOT NULL,                       -- sha256 of the token, to detect duplicates
  pan_masked   text NOT NULL,                       -- e.g. '8600 **** **** 1234', as returned by the provider
  expiry       text,                                -- 'MM/YY'
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX payment_cards_one_default ON payment_cards (user_id) WHERE is_default AND deleted_at IS NULL;
CREATE UNIQUE INDEX payment_cards_token ON payment_cards (provider, token_hash) WHERE deleted_at IS NULL;
ALTER TABLE payments ADD CONSTRAINT payments_card_fk FOREIGN KEY (card_id) REFERENCES payment_cards(id);

-- Every inbound provider call, kept for audits and disputes with the provider.
CREATE TABLE payment_webhooks (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  signature_ok  boolean NOT NULL,
  payload       jsonb,
  remote_ip     text,
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- How a ride is paid. Cash goes straight to the driver; card is charged on completion.
ALTER TABLE rides
  ADD COLUMN payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card')),
  ADD COLUMN card_id        uuid REFERENCES payment_cards(id),
  -- Card rides: paid / failed (then it is a debt the passenger must settle before the next order).
  ADD COLUMN payment_status text CHECK (payment_status IN ('pending', 'paid', 'failed')),
  ADD CONSTRAINT rides_card_needs_card CHECK (payment_method = 'cash' OR card_id IS NOT NULL);

-- Fiscal receipts are issued for what WE sell (driver subscriptions), not only per ride.
ALTER TABLE fiscal_receipts ALTER COLUMN ride_id DROP NOT NULL;
ALTER TABLE fiscal_receipts ADD COLUMN payment_id uuid REFERENCES payments(id), ADD COLUMN provider text;
CREATE UNIQUE INDEX fiscal_receipts_payment ON fiscal_receipts (payment_id) WHERE payment_id IS NOT NULL;
