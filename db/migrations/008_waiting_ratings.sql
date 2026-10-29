-- 008_waiting_ratings.sql — Yandex-style waiting and cancellation, two-way ratings, driver pauses.
--
-- Price after acceptance changes only through (a) the passenger's route changes, confirmed, or
-- (b) paid waiting: 2 free minutes at the pickup, then a per-minute rate published per class and
-- shown live to the passenger as a counter. Nothing else.

ALTER TABLE vehicle_classes
  ADD COLUMN free_wait_min       smallint NOT NULL DEFAULT 2  CHECK (free_wait_min BETWEEN 0 AND 10),
  ADD COLUMN wait_per_min_tiyin  bigint   NOT NULL DEFAULT 50000 CHECK (wait_per_min_tiyin BETWEEN 0 AND 200000),
  ADD COLUMN max_paid_wait_min   smallint NOT NULL DEFAULT 30 CHECK (max_paid_wait_min BETWEEN 0 AND 60);

-- PLACEHOLDER rates, kept at or below Yandex "Start" (up to 650 sum/min in Tashkent).
UPDATE vehicle_classes SET wait_per_min_tiyin = CASE code
  WHEN 'economy'  THEN 50000    --   500 sum / min
  WHEN 'comfort'  THEN 70000    --   700 sum / min
  WHEN 'business' THEN 100000   -- 1 000 sum / min
  WHEN 'minivan'  THEN 100000   -- 1 000 sum / min
  ELSE wait_per_min_tiyin END;

ALTER TABLE price_changes DROP CONSTRAINT price_changes_reason_check;
ALTER TABLE price_changes ADD CONSTRAINT price_changes_reason_check
  CHECK (reason IN ('stop_added', 'stop_removed', 'address_changed', 'waiting'));
ALTER TABLE price_changes ADD COLUMN wait_paid_min smallint;
-- Route changes need the passenger's confirmation; waiting follows the published rate instead.
ALTER TABLE price_changes ADD CONSTRAINT price_changes_confirmation
  CHECK (reason = 'waiting' OR confirmed_by_passenger);

-- Ratings both ways. Shown only as averages; who gave which score is never exposed.
ALTER TABLE users   ADD COLUMN rating numeric(3,2), ADD COLUMN rating_count integer NOT NULL DEFAULT 0;
ALTER TABLE drivers ADD COLUMN rating_count integer NOT NULL DEFAULT 0;
ALTER TABLE ratings ADD CONSTRAINT ratings_reason_for_low
  CHECK (score >= 4 OR char_length(coalesce(reason, '')) >= 3);
ALTER TABLE ratings ADD CONSTRAINT ratings_not_self CHECK (from_user <> to_user);
CREATE INDEX ratings_to_user_idx ON ratings (to_user, created_at DESC);

-- A driver who cancels too often gets a short pause from new orders.
ALTER TABLE drivers ADD COLUMN paused_until timestamptz;

-- The offer a driver accepted gets its own status, so it no longer counts as a pending request
-- (which would block that driver from new requests until it timed out).
UPDATE ride_offers o SET status = 'expired'
  FROM rides r WHERE r.id = o.ride_id AND o.status = 'chosen' AND r.status <> 'created';
ALTER TABLE ride_offers DROP CONSTRAINT ride_offers_status_check;
ALTER TABLE ride_offers ADD CONSTRAINT ride_offers_status_check
  CHECK (status IN ('open', 'chosen', 'accepted', 'declined', 'missed', 'expired'));
