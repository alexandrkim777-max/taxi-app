-- 005_auto_dispatch.sql — one-tap ordering with automatic driver assignment.
--
-- 'auto'  : the passenger agreed to a price ceiling; the system sends the ride to the best
--           driver whose own price is at or below it, then to the next one on decline/timeout.
-- 'choose': the passenger picks a driver from the list (the Empower-style mode).

ALTER TABLE rides
  ADD COLUMN dispatch_mode text NOT NULL DEFAULT 'auto' CHECK (dispatch_mode IN ('auto', 'choose')),
  -- The most the passenger agreed to pay. A driver above it is never assigned silently.
  ADD COLUMN max_price_tiyin bigint,
  -- Set when only more expensive drivers are left; the passenger must confirm it explicitly.
  ADD COLUMN price_proposal_tiyin bigint,
  -- Searching stops and the ride is cancelled by the system after this moment.
  ADD COLUMN search_deadline timestamptz;

CREATE INDEX rides_dispatch_idx ON rides (created_at) WHERE status = 'created' AND dispatch_mode = 'auto';

-- 'missed': the driver let the request lapse. Like a decline, the ride is not sent to them again.
ALTER TABLE ride_offers DROP CONSTRAINT ride_offers_status_check;
ALTER TABLE ride_offers ADD CONSTRAINT ride_offers_status_check
  CHECK (status IN ('open', 'chosen', 'declined', 'missed', 'expired'));
