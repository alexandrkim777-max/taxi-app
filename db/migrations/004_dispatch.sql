-- 004_dispatch.sql — live driver presence, offers with expiry, one active ride per person.

-- Live positions change every few seconds. UNLOGGED skips the write-ahead log: fast writes,
-- and the contents are lost on a crash, which is fine because drivers re-send every few seconds.
-- Accessed only through apps/api/src/dispatch/presence.ts so it can move to Redis later.
CREATE UNLOGGED TABLE driver_presence (
  driver_id    uuid PRIMARY KEY REFERENCES drivers(id),
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id),
  class_id     uuid NOT NULL REFERENCES vehicle_classes(id),
  status       text NOT NULL CHECK (status IN ('online', 'busy')),
  point        geography(Point, 4326) NOT NULL,
  heading      smallint CHECK (heading BETWEEN 0 AND 359),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_presence_point_idx ON driver_presence USING gist (point);

-- Offer lifecycle: 'open' (driver available at this price) -> 'chosen' by the passenger
-- (driver has a short window to accept) -> ride accepted, or 'declined' / 'expired'.
ALTER TABLE ride_offers ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now() + interval '90 seconds';
CREATE UNIQUE INDEX ride_offers_one_chosen ON ride_offers (ride_id) WHERE status = 'chosen';
CREATE INDEX ride_offers_driver_idx ON ride_offers (driver_id, status);

-- At most one active ride per passenger and per driver, enforced by the database
-- so parallel requests cannot create duplicates.
CREATE UNIQUE INDEX rides_one_active_per_passenger ON rides (passenger_id)
  WHERE status IN ('created', 'accepted', 'driver_en_route', 'arrived', 'in_progress') AND deleted_at IS NULL;
CREATE UNIQUE INDEX rides_one_active_per_driver ON rides (driver_id)
  WHERE status IN ('accepted', 'driver_en_route', 'arrived', 'in_progress') AND deleted_at IS NULL;
