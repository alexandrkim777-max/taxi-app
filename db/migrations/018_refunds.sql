-- 018_refunds.sql — refunds are their own payments, linked to the payment they return money from,
-- sent through the provider that took the money. The original payment row is never edited.
--
-- Two kinds:
--   overpaid  — automatic: the passenger paid more than the final fare (the route got shorter).
--   moderator — decided by staff (a dispute, a mistake); who approved it and why is kept.

ALTER TABLE payments
  ADD COLUMN refund_of     uuid REFERENCES payments(id),
  ADD COLUMN refund_kind   text CHECK (refund_kind IN ('overpaid', 'moderator')),
  ADD COLUMN refund_reason text,
  ADD COLUMN approved_by   uuid REFERENCES users(id);

-- Earlier automatic refunds were only recorded, never sent: link them to the ride's card payment,
-- drop the ones with nothing to refund from.
UPDATE payments r SET refund_kind = 'overpaid', refund_reason = 'route_shorter',
       refund_of = (SELECT p.id FROM payments p WHERE p.ride_id = r.ride_id AND p.type = 'ride' AND p.status = 'succeeded'
                     ORDER BY p.amount_tiyin DESC LIMIT 1)
 WHERE r.type = 'refund';
DELETE FROM payments WHERE type = 'refund' AND refund_of IS NULL AND status = 'pending';

ALTER TABLE payments ADD CONSTRAINT payments_refund_shape
  CHECK ((type = 'refund') = (refund_of IS NOT NULL AND refund_kind IS NOT NULL));
ALTER TABLE payments ADD CONSTRAINT payments_moderator_refund_approved
  CHECK (refund_kind IS DISTINCT FROM 'moderator' OR (approved_by IS NOT NULL AND refund_reason IS NOT NULL));
CREATE INDEX payments_refund_of ON payments (refund_of) WHERE refund_of IS NOT NULL;

-- Money given back to the passenger by staff for a ride (shown in their history). Automatic
-- over-payment refunds lower paid_tiyin instead, since they correct the fare itself.
ALTER TABLE rides ADD COLUMN refunded_tiyin bigint NOT NULL DEFAULT 0;
