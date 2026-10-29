-- 013_places_entrances.sql — saved places and entrances (подъезды) for exact pickups.

-- Home, work and other saved places of a passenger.
CREATE TABLE saved_places (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  kind         text NOT NULL CHECK (kind IN ('home', 'work', 'other')),
  label        text CHECK (char_length(label) <= 40),
  address      text NOT NULL CHECK (char_length(address) <= 200),
  point        geography(Point, 4326) NOT NULL,
  entrance_id  uuid REFERENCES entrances(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX saved_places_one_home_work ON saved_places (user_id, kind) WHERE kind IN ('home', 'work') AND deleted_at IS NULL;
CREATE INDEX saved_places_user ON saved_places (user_id) WHERE deleted_at IS NULL;

-- Entrances: our own database, separate from OpenStreetMap data. It grows from real pickups: when a
-- passenger names the entrance ("3") and the trip starts, the driver's position at that moment is
-- where entrance 3 of that building is.
ALTER TABLE ride_stops ADD COLUMN entrance_label text CHECK (char_length(entrance_label) <= 8);
CREATE INDEX entrances_point_idx ON entrances USING gist (entrance_point) WHERE deleted_at IS NULL;
ALTER TABLE entrances ADD COLUMN source text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'pickups'));
