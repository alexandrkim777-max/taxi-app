-- 020_consents.sql — who accepted which version of the offer, the driver agreement and the privacy
-- policy, and when. A new version of a document asks everyone again. Kept after account deletion
-- (the account is anonymised, the record of consent is evidence).
CREATE TABLE user_consents (
  user_id     uuid NOT NULL REFERENCES users(id),
  document    text NOT NULL CHECK (document IN ('passenger_offer', 'driver_agreement', 'privacy')),
  version     text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip          text,
  user_agent  text,
  PRIMARY KEY (user_id, document, version)
);
