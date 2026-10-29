-- 003_seed_tashkent.sql — the first city, its vehicle classes and subscription plans.
-- Recommended tariffs are PLACEHOLDERS to be calibrated against the market before launch.
-- Amounts in tiyin (1 sum = 100 tiyin).

INSERT INTO cities (code, name, timezone, currency)
VALUES ('tashkent', '{"uz": "Toshkent", "ru": "Ташкент", "en": "Tashkent"}', 'Asia/Tashkent', 'UZS');

INSERT INTO vehicle_classes
  (city_id, code, name, seats, rec_base_tiyin, rec_per_km_tiyin, rec_per_min_tiyin, rec_min_fare_tiyin,
   corridor_min_pct, corridor_max_pct)
SELECT c.id, v.code, v.name::jsonb, v.seats, v.base, v.per_km, v.per_min, v.min_fare, -20, 0
FROM cities c
CROSS JOIN (VALUES
  ('economy',  '{"uz": "Ekonom",  "ru": "Эконом",  "en": "Economy"}',  4,  500000, 180000, 25000, 1200000),
  ('comfort',  '{"uz": "Komfort", "ru": "Комфорт", "en": "Comfort"}',  4,  650000, 235000, 32500, 1560000),
  ('business', '{"uz": "Biznes",  "ru": "Бизнес",  "en": "Business"}', 4,  900000, 325000, 45000, 2160000),
  ('minivan',  '{"uz": "Miniven", "ru": "Минивэн", "en": "Minivan"}',  7,  750000, 270000, 37500, 1800000)
) AS v(code, name, seats, base, per_km, per_min, min_fare)
WHERE c.code = 'tashkent';

INSERT INTO subscription_plans (city_id, code, name, price_tiyin, period_days)
SELECT c.id, p.code, p.name::jsonb, p.price, p.days
FROM cities c
CROSS JOIN (VALUES
  ('trial', '{"uz": "Sinov oyi", "ru": "Пробный месяц", "en": "Trial month"}', 0, 30),
  ('day',   '{"uz": "Kun",       "ru": "День",          "en": "Day"}',         1500000, 1),
  ('week',  '{"uz": "Hafta",     "ru": "Неделя",        "en": "Week"}',        5000000, 7),
  ('month', '{"uz": "Oy",        "ru": "Месяц",         "en": "Month"}',       15000000, 30)
) AS p(code, name, price, days)
WHERE c.code = 'tashkent';
