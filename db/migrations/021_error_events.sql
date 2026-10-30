-- 021_error_events.sql — crashes and server errors from the API, background jobs, both apps and the
-- staff panel, grouped by kind (fingerprint): one row per kind with a counter, so a storm of the
-- same error is one line, and a new kind (or one that comes back after being resolved) is noticed.
-- Messages are scrubbed of phone numbers, tokens and card numbers before they get here.
CREATE TABLE error_events (
  id           bigserial PRIMARY KEY,
  fingerprint  text NOT NULL UNIQUE,
  source       text NOT NULL CHECK (source IN ('api', 'job', 'passenger', 'driver', 'admin')),
  message      text NOT NULL,
  stack        text,
  context      jsonb NOT NULL DEFAULT '{}'::jsonb,
  app_version  text,
  count        integer NOT NULL DEFAULT 1,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX error_events_open ON error_events (last_seen DESC) WHERE resolved_at IS NULL;
