-- 014_priority.sql — the passenger chooses "cheaper" or "faster"; the system picks the driver.
-- One-tap (auto) rides remember which one, so every next driver is picked by the same rule.

ALTER TABLE rides
  ADD COLUMN priority text CHECK (priority IN ('cheap', 'fast')),
  ADD CONSTRAINT rides_priority_auto_only CHECK (priority IS NULL OR dispatch_mode = 'auto');

COMMENT ON COLUMN rides.priority IS 'cheap: lowest price within a reasonable pickup; fast: shortest pickup. Auto rides only.';
