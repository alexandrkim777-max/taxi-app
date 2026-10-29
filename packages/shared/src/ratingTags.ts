// "What did you like?" tags on the end-of-ride rating screen.
// Positive tags go with 4–5 stars, negative ones with 1–3. Safety tags also alert a moderator.

export type TagSide = 'driver' | 'passenger';
export type TagTone = 'positive' | 'negative';

export interface RatingTag {
  code: string;
  /** Who is being rated. */
  about: TagSide;
  tone: TagTone;
  /** Sent to moderation automatically. */
  safety?: boolean;
  label: { uz: string; ru: string; en: string };
}

export const RATING_TAGS: readonly RatingTag[] = [
  // Passenger rates the driver — positive
  { code: 'clean_car', about: 'driver', tone: 'positive', label: { uz: 'Salon toza', ru: 'Чисто в салоне', en: 'Clean car' } },
  { code: 'careful_driving', about: 'driver', tone: 'positive', label: { uz: 'Ehtiyotkor haydaydi', ru: 'Аккуратно водит', en: 'Careful driving' } },
  { code: 'polite', about: 'driver', tone: 'positive', label: { uz: 'Xushmuomala', ru: 'Вежливый', en: 'Polite' } },
  { code: 'knows_city', about: 'driver', tone: 'positive', label: { uz: 'Shaharni yaxshi biladi', ru: 'Знает город', en: 'Knows the city' } },
  { code: 'comfortable', about: 'driver', tone: 'positive', label: { uz: 'Qulay harorat', ru: 'Комфортная температура', en: 'Comfortable temperature' } },
  { code: 'quiet_ride', about: 'driver', tone: 'positive', label: { uz: 'Tinch safar', ru: 'Тихая поездка', en: 'Quiet ride' } },
  { code: 'helped_luggage', about: 'driver', tone: 'positive', label: { uz: 'Yukka yordam berdi', ru: 'Помог с багажом', en: 'Helped with luggage' } },
  { code: 'on_time', about: 'driver', tone: 'positive', label: { uz: 'Oʻz vaqtida keldi', ru: 'Приехал вовремя', en: 'Arrived on time' } },
  // Passenger rates the driver — negative
  { code: 'dirty_car', about: 'driver', tone: 'negative', label: { uz: 'Salon iflos', ru: 'Грязно в салоне', en: 'Dirty car' } },
  { code: 'unsafe_driving', about: 'driver', tone: 'negative', safety: true, label: { uz: 'Xavfli haydash', ru: 'Опасное вождение', en: 'Unsafe driving' } },
  { code: 'phone_while_driving', about: 'driver', tone: 'negative', safety: true, label: { uz: 'Haydab telefonda gaplashdi', ru: 'Телефон за рулём', en: 'Phone while driving' } },
  { code: 'rude', about: 'driver', tone: 'negative', label: { uz: 'Qoʻpol', ru: 'Грубый', en: 'Rude' } },
  { code: 'wrong_route', about: 'driver', tone: 'negative', label: { uz: 'Notoʻgʻri yoʻl', ru: 'Ехал не тем маршрутом', en: 'Wrong route' } },
  { code: 'late', about: 'driver', tone: 'negative', label: { uz: 'Kechikdi', ru: 'Опоздал', en: 'Late' } },
  { code: 'smoking', about: 'driver', tone: 'negative', label: { uz: 'Salonda chekdi', ru: 'Курил в салоне', en: 'Smoking' } },
  { code: 'car_mismatch', about: 'driver', tone: 'negative', safety: true, label: { uz: 'Boshqa mashina', ru: 'Другая машина', en: 'Different car' } },
  { code: 'asked_extra_cash', about: 'driver', tone: 'negative', safety: true, label: { uz: 'Qoʻshimcha pul soʻradi', ru: 'Просил доплату', en: 'Asked for extra money' } },
  // Driver rates the passenger
  { code: 'p_polite', about: 'passenger', tone: 'positive', label: { uz: 'Xushmuomala', ru: 'Вежливый', en: 'Polite' } },
  { code: 'p_on_time', about: 'passenger', tone: 'positive', label: { uz: 'Oʻz vaqtida chiqdi', ru: 'Вышел вовремя', en: 'Was on time' } },
  { code: 'p_exact_address', about: 'passenger', tone: 'positive', label: { uz: 'Manzil aniq', ru: 'Точный адрес', en: 'Exact address' } },
  { code: 'p_late', about: 'passenger', tone: 'negative', label: { uz: 'Kechikdi', ru: 'Долго не выходил', en: 'Kept me waiting' } },
  { code: 'p_rude', about: 'passenger', tone: 'negative', label: { uz: 'Qoʻpol', ru: 'Грубый', en: 'Rude' } },
  { code: 'p_wrong_address', about: 'passenger', tone: 'negative', label: { uz: 'Manzil notoʻgʻri', ru: 'Неверный адрес', en: 'Wrong address' } },
  { code: 'p_dirty', about: 'passenger', tone: 'negative', label: { uz: 'Salonni ifloslatdi', ru: 'Испачкал салон', en: 'Made the car dirty' } },
  { code: 'p_smoking', about: 'passenger', tone: 'negative', label: { uz: 'Chekdi', ru: 'Курил', en: 'Smoking' } },
];

export const MAX_TAGS_PER_RATING = 5;

export function tagByCode(code: string): RatingTag | undefined {
  return RATING_TAGS.find((t) => t.code === code);
}

/** Positive tags only with 4–5 stars, negative only with 1–3, and only about the right side. */
export function tagAllowed(tag: RatingTag, about: TagSide, score: number): boolean {
  return tag.about === about && (tag.tone === 'positive' ? score >= 4 : score <= 3);
}
