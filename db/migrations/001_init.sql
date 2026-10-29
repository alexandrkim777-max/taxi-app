-- 001_init.sql — initial schema.
-- Conventions: UUID primary keys, timestamptz in UTC, money in integer tiyin (bigint),
-- soft delete via deleted_at, closed sets as text + CHECK (easy to extend).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

-- updated_at helper
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- System
-- ---------------------------------------------------------------------------

CREATE TABLE cities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                 -- 'tashkent'
  name        jsonb NOT NULL,                       -- {"uz": "...", "ru": "...", "en": "..."}
  timezone    text NOT NULL DEFAULT 'Asia/Tashkent',
  currency    text NOT NULL DEFAULT 'UZS',
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL UNIQUE,                 -- E.164, e.g. +998901234567
  name        text,
  gender      text CHECK (gender IN ('female', 'male')),
  language    text NOT NULL DEFAULT 'uz' CHECK (language IN ('uz', 'ru', 'en')),
  roles       text[] NOT NULL DEFAULT ARRAY['passenger'],
  city_id     uuid REFERENCES cities(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE drivers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL UNIQUE REFERENCES users(id),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'verified', 'rejected', 'blocked')),
  rating            numeric(3,2),
  languages         text[] NOT NULL DEFAULT ARRAY['uz'],
  pickup_radius_m   integer NOT NULL DEFAULT 3000,
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TABLE driver_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id    uuid NOT NULL REFERENCES drivers(id),
  type         text NOT NULL CHECK (type IN ('passport', 'license', 'vehicle_registration', 'selfie', 'self_employed')),
  file_url     text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by  uuid REFERENCES users(id),
  reviewed_at  timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

-- ---------------------------------------------------------------------------
-- Vehicles and classes
-- ---------------------------------------------------------------------------

CREATE TABLE vehicle_classes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id             uuid NOT NULL REFERENCES cities(id),
  code                text NOT NULL,                -- 'economy', 'comfort', 'business', 'minivan'
  name                jsonb NOT NULL,
  seats               smallint NOT NULL,
  -- Recommended tariff for the class, in tiyin.
  rec_base_tiyin      bigint NOT NULL,
  rec_per_km_tiyin    bigint NOT NULL,
  rec_per_min_tiyin   bigint NOT NULL,
  rec_min_fare_tiyin  bigint NOT NULL,
  -- Price corridor relative to the recommended tariff, in percent (e.g. -20 .. 0).
  corridor_min_pct    smallint NOT NULL DEFAULT -20,
  corridor_max_pct    smallint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  UNIQUE (city_id, code)
);

CREATE TABLE vehicles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   uuid NOT NULL REFERENCES drivers(id),
  class_id    uuid REFERENCES vehicle_classes(id),  -- set by a moderator, not the driver
  make_model  text NOT NULL,
  year        smallint NOT NULL,
  color       text NOT NULL,
  plate       text NOT NULL,
  photos      text[] NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- Tariffs (versioned: a change inserts a new row, old rows stay)
-- ---------------------------------------------------------------------------

CREATE TABLE driver_tariffs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id        uuid NOT NULL REFERENCES drivers(id),
  class_id         uuid NOT NULL REFERENCES vehicle_classes(id),
  version          integer NOT NULL,
  base_tiyin       bigint NOT NULL,
  per_km_tiyin     bigint NOT NULL,
  per_min_tiyin    bigint NOT NULL,
  min_fare_tiyin   bigint NOT NULL,
  valid_from       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, class_id, version)
);

-- ---------------------------------------------------------------------------
-- Entrances (our own database, kept separate from OSM data)
-- ---------------------------------------------------------------------------

CREATE TABLE entrances (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id            uuid NOT NULL REFERENCES cities(id),
  building_address   text NOT NULL,
  building_point     geography(Point, 4326) NOT NULL,
  number             text NOT NULL,                 -- '2', '2A'
  entrance_point     geography(Point, 4326) NOT NULL,
  confirmed_pickups  integer NOT NULL DEFAULT 0,
  updated_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX entrances_building_point_idx ON entrances USING gist (building_point);

-- ---------------------------------------------------------------------------
-- Rides
-- ---------------------------------------------------------------------------

CREATE TABLE recurring_rides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id   uuid NOT NULL REFERENCES users(id),
  driver_id      uuid REFERENCES drivers(id),       -- set for a "permanent route" agreement
  schedule       jsonb NOT NULL,                    -- {"days": [1,2,3,4,5], "time": "08:00"}
  template       jsonb NOT NULL,                    -- stops, class, options
  agreed_price_tiyin bigint,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE TABLE rides (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id              uuid NOT NULL REFERENCES cities(id),
  passenger_id         uuid NOT NULL REFERENCES users(id),
  ordered_for_name     text,                        -- ride ordered for another person
  ordered_for_phone    text,
  driver_id            uuid REFERENCES drivers(id),
  vehicle_id           uuid REFERENCES vehicles(id),
  class_id             uuid NOT NULL REFERENCES vehicle_classes(id),
  recurring_ride_id    uuid REFERENCES recurring_rides(id),
  status               text NOT NULL DEFAULT 'created'
                       CHECK (status IN ('scheduled', 'created', 'accepted', 'driver_en_route',
                                         'arrived', 'in_progress', 'completed', 'cancelled')),
  scheduled_at         timestamptz,                 -- null = ride now
  flight_number        text,
  -- Price snapshot: copied at acceptance, never changed afterwards.
  locked_price_tiyin   bigint,
  tariff_id            uuid REFERENCES driver_tariffs(id),
  route_distance_m     integer,
  route_duration_s     integer,
  options              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- child seat, pet, quiet ride
  driver_comment       text,
  cancelled_by         text CHECK (cancelled_by IN ('passenger', 'driver', 'system')),
  cancel_reason        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE INDEX rides_passenger_idx ON rides (passenger_id, created_at DESC);
CREATE INDEX rides_driver_idx ON rides (driver_id, created_at DESC);
CREATE INDEX rides_scheduled_idx ON rides (scheduled_at) WHERE status = 'scheduled';

CREATE TABLE ride_stops (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id      uuid NOT NULL REFERENCES rides(id),
  position     smallint NOT NULL,                   -- 0 = pickup, last = destination
  point        geography(Point, 4326) NOT NULL,
  address      text,
  entrance_id  uuid REFERENCES entrances(id),
  UNIQUE (ride_id, position)
);

CREATE TABLE ride_offers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id      uuid NOT NULL REFERENCES rides(id),
  driver_id    uuid NOT NULL REFERENCES drivers(id),
  price_tiyin  bigint NOT NULL,
  tariff_id    uuid NOT NULL REFERENCES driver_tariffs(id),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'chosen', 'declined', 'expired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ride_id, driver_id)
);

-- Append-only log of every status change and notable action on a ride.
CREATE TABLE ride_events (
  id          bigserial PRIMARY KEY,
  ride_id     uuid NOT NULL REFERENCES rides(id),
  type        text NOT NULL,                        -- 'status:accepted', 'stop_added', ...
  actor       text NOT NULL CHECK (actor IN ('passenger', 'driver', 'system', 'admin')),
  actor_id    uuid,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ride_events_ride_idx ON ride_events (ride_id, at);

-- Any change to the locked price needs an explicit passenger "yes".
CREATE TABLE price_changes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id                  uuid NOT NULL REFERENCES rides(id),
  reason                   text NOT NULL CHECK (reason IN ('stop_added', 'address_changed', 'waiting', 'class_downgrade')),
  amount_tiyin             bigint NOT NULL,         -- may be negative (downgrade refund)
  confirmed_by_passenger   boolean NOT NULL DEFAULT false,
  confirmed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------

CREATE TABLE subscription_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id      uuid NOT NULL REFERENCES cities(id),
  code         text NOT NULL,                       -- 'trial', 'day', 'week', 'month'
  name         jsonb NOT NULL,
  price_tiyin  bigint NOT NULL,
  period_days  smallint NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, code)
);

CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id          uuid NOT NULL REFERENCES drivers(id),
  plan_id            uuid NOT NULL REFERENCES subscription_plans(id),
  price_paid_tiyin   bigint NOT NULL,               -- fixed for the paid period
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX subscriptions_driver_idx ON subscriptions (driver_id, ends_at DESC);

CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type              text NOT NULL CHECK (type IN ('ride', 'tip', 'subscription', 'hold', 'refund')),
  amount_tiyin      bigint NOT NULL,
  provider          text NOT NULL CHECK (provider IN ('payme', 'click', 'cash', 'manual')),
  provider_ref      text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  ride_id           uuid REFERENCES rides(id),
  subscription_id   uuid REFERENCES subscriptions(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fiscal_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id         uuid NOT NULL REFERENCES rides(id),
  receipt_number  text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued', 'failed')),
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Quality
-- ---------------------------------------------------------------------------

CREATE TABLE ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     uuid NOT NULL REFERENCES rides(id),
  from_user   uuid NOT NULL REFERENCES users(id),
  to_user     uuid NOT NULL REFERENCES users(id),
  score       smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  reason      text,                                 -- required by the app when score < 4
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ride_id, from_user)
);

CREATE TABLE complaints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id      uuid REFERENCES rides(id),
  author_id    uuid NOT NULL REFERENCES users(id),
  type         text NOT NULL,                       -- 'cash_demand', 'class_mismatch', 'rude', 'sos', ...
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'rejected')),
  resolution   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE favorites (
  passenger_id  uuid NOT NULL REFERENCES users(id),
  driver_id     uuid NOT NULL REFERENCES drivers(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (passenger_id, driver_id)
);

CREATE TABLE blocks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  reason         text NOT NULL,                     -- a block always has a reason
  until          timestamptz,                       -- null = indefinite
  appeal_status  text NOT NULL DEFAULT 'none' CHECK (appeal_status IN ('none', 'pending', 'upheld', 'lifted')),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Growth
-- ---------------------------------------------------------------------------

CREATE TABLE promo_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid REFERENCES users(id),
  code          text NOT NULL UNIQUE,
  reward        jsonb NOT NULL,                     -- {"type": "ride_credit", "amount_tiyin": 1000000}
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referrals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id     uuid NOT NULL REFERENCES users(id),
  invitee_id     uuid NOT NULL UNIQUE REFERENCES users(id),
  reward_status  text NOT NULL DEFAULT 'pending' CHECK (reward_status IN ('pending', 'granted', 'void')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE corporate_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  inn         text NOT NULL UNIQUE,
  limits      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE partner_offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner     text NOT NULL,
  category    text NOT NULL,                        -- 'fuel', 'service', 'tires', 'insurance'
  discount    jsonb NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  channel     text NOT NULL CHECK (channel IN ('push', 'sms')),
  template    text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cities', 'users', 'drivers', 'driver_documents', 'vehicle_classes',
                           'vehicles', 'entrances', 'recurring_rides', 'rides', 'subscription_plans',
                           'payments', 'complaints', 'corporate_accounts']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
