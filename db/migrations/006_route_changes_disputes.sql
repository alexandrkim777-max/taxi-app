-- 006_route_changes_disputes.sql
--
-- Rule: after acceptance the ride price changes ONLY when the passenger changes the route
-- (adds, removes or changes a stop) and confirms the new price. No waiting charges, no driver
-- surcharges. The reasons allowed below make the database enforce that.

DELETE FROM price_changes WHERE reason NOT IN ('stop_added', 'stop_removed', 'address_changed');
ALTER TABLE price_changes DROP CONSTRAINT price_changes_reason_check;
ALTER TABLE price_changes ADD CONSTRAINT price_changes_reason_check
  CHECK (reason IN ('stop_added', 'stop_removed', 'address_changed'));
ALTER TABLE price_changes
  ADD COLUMN requested_by     uuid REFERENCES users(id),
  ADD COLUMN old_price_tiyin  bigint,
  ADD COLUMN new_price_tiyin  bigint,
  ADD COLUMN old_stops        jsonb,
  ADD COLUMN new_stops        jsonb,
  ADD COLUMN route_distance_m integer,
  ADD COLUMN route_duration_s integer;
CREATE INDEX price_changes_ride_idx ON price_changes (ride_id, created_at);

-- Disputes: both sides write what happened, independently, then a moderator decides.
CREATE TABLE disputes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id       uuid NOT NULL UNIQUE REFERENCES rides(id),     -- one dispute per ride
  opened_by     text NOT NULL CHECK (opened_by IN ('passenger', 'driver')),
  category      text NOT NULL CHECK (category IN ('price', 'route', 'behavior', 'cancellation',
                                                  'vehicle', 'lost_item', 'safety', 'other')),
  status        text NOT NULL DEFAULT 'awaiting_response'
                CHECK (status IN ('awaiting_response', 'in_review', 'resolved')),
  -- The other side has until then to write their account; after that it goes to review anyway.
  respond_by    timestamptz NOT NULL,
  outcome       text CHECK (outcome IN ('passenger', 'driver', 'both', 'no_fault')),
  resolution    text,                                          -- shown to both sides
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disputes_status_idx ON disputes (status, created_at);
CREATE TRIGGER disputes_updated_at BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One statement per side, never edited afterwards. Each side sees the other's account only
-- after writing their own, so nobody can tailor their story to the other's.
CREATE TABLE dispute_statements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  uuid NOT NULL REFERENCES disputes(id),
  role        text NOT NULL CHECK (role IN ('passenger', 'driver')),
  author_id   uuid NOT NULL REFERENCES users(id),
  text        text NOT NULL CHECK (char_length(text) BETWEEN 10 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispute_id, role)
);
