-- 011_language_prepay.sql
--
-- Language: chosen on the very first screen (uz / ru / en) and sent with the login request;
-- the user's language is then used for SMS, labels and notifications.
ALTER TABLE auth_codes ADD COLUMN language text NOT NULL DEFAULT 'uz' CHECK (language IN ('uz', 'ru', 'en'));

-- Card rides are charged at 60% of the trip, so a declined card can still be switched to cash
-- or another card before the passenger gets out.
ALTER TABLE rides
  ADD COLUMN trip_distance_m integer NOT NULL DEFAULT 0,   -- driven during the trip, from GPS pings
  ADD COLUMN paid_tiyin      bigint  NOT NULL DEFAULT 0;   -- charged so far for the fare
