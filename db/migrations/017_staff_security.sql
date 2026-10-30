-- 017_staff_security.sql — staff sign in with SMS + an authenticator app (TOTP), and get a
-- short session kept in an httpOnly cookie that only the staff panel uses.
--
-- App sessions (bearer tokens in the phone apps) can no longer reach staff endpoints: a stolen
-- phone-app token, or an SMS code intercepted alone, does not open the panel.

ALTER TABLE users
  ADD COLUMN totp_secret_enc text,          -- AES-256-GCM, key derived from AUTH_SECRET
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step  bigint;        -- last accepted 30 s step: a code works only once

ALTER TABLE sessions
  ADD COLUMN kind text NOT NULL DEFAULT 'app' CHECK (kind IN ('app', 'staff')),
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

-- Between the SMS step and the authenticator step (5 minutes, 5 tries).
CREATE TABLE staff_login_tickets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  ticket_hash        text NOT NULL UNIQUE,
  pending_secret_enc text,                  -- first sign-in: the secret being set up
  attempts           smallint NOT NULL DEFAULT 0,
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_login_tickets_user_idx ON staff_login_tickets (user_id, created_at DESC);
