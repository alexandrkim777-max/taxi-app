-- 016_idempotency_push.sql — safe retries of "order a taxi", and push notifications.

-- The app sends a fresh key with each order; a retry after a lost answer returns the same ride
-- instead of creating a second one.
ALTER TABLE rides ADD COLUMN idempotency_key uuid;
CREATE UNIQUE INDEX rides_idempotency ON rides (passenger_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Device push tokens (Expo push service). One device belongs to one signed-in account at a time.
CREATE TABLE push_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  token        text NOT NULL UNIQUE CHECK (char_length(token) BETWEEN 10 AND 200),
  app          text NOT NULL CHECK (app IN ('driver', 'passenger')),
  platform     text NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX push_tokens_user_idx ON push_tokens (user_id, app) WHERE revoked_at IS NULL;

-- Outbox: written in the same transaction as the ride event, sent by a background loop, so a
-- notification is never lost on a crash and never sent for a change that was rolled back.
CREATE TABLE push_outbox (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  app         text NOT NULL CHECK (app IN ('driver', 'passenger')),
  kind        text NOT NULL,
  ride_id     uuid REFERENCES rides(id),
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A new-order alert is useless once the 15-second window is over.
  expires_at  timestamptz NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0,
  sent_at     timestamptz,
  last_error  text
);
CREATE INDEX push_outbox_pending_idx ON push_outbox (created_at) WHERE sent_at IS NULL;
