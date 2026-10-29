-- 012_admin.sql — admin panel: price coefficient, audit log, complaint handling, staff roles.

-- General price coefficient, set by staff: city-wide, or per class (a class value beats the city
-- value). Optional time window for temporary changes (e.g. New Year's night). History is kept.
-- It scales new prices only; a ride's price is fixed with the coefficient at order time.
CREATE TABLE price_coefficients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id      uuid NOT NULL REFERENCES cities(id),
  class_id     uuid REFERENCES vehicle_classes(id),        -- null = whole city
  value        numeric(4,2) NOT NULL CHECK (value BETWEEN 0.70 AND 1.50),
  reason       text NOT NULL CHECK (char_length(reason) >= 3),
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_until  timestamptz,
  set_by       uuid NOT NULL REFERENCES users(id),
  -- Ended early by staff (kept for history, no longer applied).
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX price_coefficients_lookup ON price_coefficients (city_id, class_id, created_at DESC);

CREATE FUNCTION current_price_coefficient(p_class uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT pc.value FROM price_coefficients pc
      WHERE pc.class_id = p_class AND pc.cancelled_at IS NULL
        AND pc.valid_from <= now() AND (pc.valid_until IS NULL OR pc.valid_until > now())
      ORDER BY pc.created_at DESC LIMIT 1),
    (SELECT pc.value FROM price_coefficients pc JOIN vehicle_classes vc ON vc.city_id = pc.city_id
      WHERE vc.id = p_class AND pc.class_id IS NULL AND pc.cancelled_at IS NULL
        AND pc.valid_from <= now() AND (pc.valid_until IS NULL OR pc.valid_until > now())
      ORDER BY pc.created_at DESC LIMIT 1),
    1.00)
$$;

ALTER TABLE rides ADD COLUMN price_coefficient numeric(4,2) NOT NULL DEFAULT 1.00;

-- Every staff action, including viewing personal data (dossiers, phone numbers).
CREATE TABLE admin_audit_log (
  id           bigserial PRIMARY KEY,
  admin_id     uuid NOT NULL REFERENCES users(id),
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_target ON admin_audit_log (target_type, target_id, at DESC);
CREATE INDEX admin_audit_log_admin ON admin_audit_log (admin_id, at DESC);
-- The log is append-only: no updates, no deletes, not even by the application.
CREATE FUNCTION admin_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END $$;
CREATE TRIGGER admin_audit_log_no_change BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_append_only();

-- Complaints: who they are about, severity, who handles them.
ALTER TABLE complaints
  ADD COLUMN about_user_id uuid REFERENCES users(id),
  ADD COLUMN severity      text NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal', 'safety')),
  ADD COLUMN text          text CHECK (char_length(text) <= 2000),
  ADD COLUMN assigned_to   uuid REFERENCES users(id),
  ADD COLUMN resolved_by   uuid REFERENCES users(id),
  ADD COLUMN resolved_at   timestamptz;
UPDATE complaints c SET severity = 'safety' WHERE type LIKE 'rating_safety:%';
UPDATE complaints c SET about_user_id = rt.to_user
  FROM ratings rt WHERE rt.ride_id = c.ride_id AND rt.from_user = c.author_id AND c.about_user_id IS NULL;
CREATE INDEX complaints_queue ON complaints (status, severity, created_at);

-- Who blocked a user and when it was lifted.
ALTER TABLE blocks ADD COLUMN lifted_by uuid REFERENCES users(id), ADD COLUMN lifted_at timestamptz;
