-- 007_cancel_fee.sql — paid cancellation once the driver is at the pickup.
--
-- Free until the driver arrives. After arrival a fixed fee per class, 5 000–10 000 sum,
-- goes to the driver when the passenger cancels, or when the driver cancels as a no-show
-- after waiting long enough. It is not a change of the ride price.

ALTER TABLE vehicle_classes
  ADD COLUMN cancel_fee_tiyin bigint NOT NULL DEFAULT 500000
  CHECK (cancel_fee_tiyin BETWEEN 500000 AND 1000000);

UPDATE vehicle_classes SET cancel_fee_tiyin = CASE code
  WHEN 'economy'  THEN 500000    --  5 000 sum
  WHEN 'comfort'  THEN 700000    --  7 000 sum
  WHEN 'business' THEN 1000000   -- 10 000 sum
  WHEN 'minivan'  THEN 1000000   -- 10 000 sum
  ELSE cancel_fee_tiyin END;

ALTER TABLE rides
  ADD COLUMN cancel_fee_tiyin  bigint CHECK (cancel_fee_tiyin > 0),
  -- pending: owed by the passenger (collected by the payments module); waived: lifted by a moderator.
  ADD COLUMN cancel_fee_status text CHECK (cancel_fee_status IN ('pending', 'paid', 'waived')),
  ADD CONSTRAINT rides_cancel_fee_consistent
    CHECK ((cancel_fee_tiyin IS NULL) = (cancel_fee_status IS NULL));
