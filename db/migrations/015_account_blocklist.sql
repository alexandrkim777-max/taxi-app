-- 015_account_blocklist.sql — "don't send me this driver again", and account deletion support.

CREATE TABLE passenger_blocked_drivers (
  user_id    uuid NOT NULL REFERENCES users(id),
  driver_id  uuid NOT NULL REFERENCES drivers(id),
  ride_id    uuid REFERENCES rides(id),          -- the ride it was decided on
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, driver_id)
);
CREATE INDEX passenger_blocked_drivers_driver_idx ON passenger_blocked_drivers (driver_id);

COMMENT ON TABLE passenger_blocked_drivers IS 'Drivers a passenger never wants to be matched with; the driver is not told.';
