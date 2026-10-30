// Demo mode only: a pretend server so the whole passenger journey can be tried in a browser —
// sign-in, "where to", entrance, "cheaper" or "faster", the car coming, the trip,
// the 60% card charge, rating, complaints and disputes. Names, cars and addresses are made up;
// coordinates of the places are approximate. Never included in real builds (see metro.config.js).

import { RATING_TAGS } from '../../../packages/shared/src/ratingTags.ts';

type Res = { status: number; body: unknown };
type Row = Record<string, any>;
type L = { uz: string; ru: string; en: string };

const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
const ok = (body: unknown, status = 200): Res => ({ status, body });
const fail = (status: number, error: string, extra: Row = {}): Res => ({ status, body: { error, ...extra } });

const PLACES: { name: L; district: L; lat: number; lng: number }[] = [
  { name: { uz: 'Amir Temur xiyoboni', ru: 'Сквер Амира Темура', en: 'Amir Temur Square' }, district: { uz: 'Yunusobod', ru: 'Юнусабад', en: 'Yunusabad' }, lat: 41.3111, lng: 69.2797 },
  { name: { uz: 'Toshkent City Mall', ru: 'Ташкент Сити Молл', en: 'Tashkent City Mall' }, district: { uz: 'Shayxontohur', ru: 'Шайхантахур', en: 'Shaykhantakhur' }, lat: 41.3166, lng: 69.2484 },
  { name: { uz: 'Chorsu bozori', ru: 'Базар Чорсу', en: 'Chorsu Bazaar' }, district: { uz: 'Shayxontohur', ru: 'Шайхантахур', en: 'Shaykhantakhur' }, lat: 41.3266, lng: 69.235 },
  { name: { uz: 'Toshkent xalqaro aeroporti', ru: 'Международный аэропорт Ташкент', en: 'Tashkent International Airport' }, district: { uz: 'Sergeli', ru: 'Сергели', en: 'Sergeli' }, lat: 41.2579, lng: 69.2812 },
  { name: { uz: 'Toshkent temir yoʻl vokzali', ru: 'Ташкентский ж/д вокзал', en: 'Tashkent railway station' }, district: { uz: 'Mirobod', ru: 'Мирабад', en: 'Mirabad' }, lat: 41.2917, lng: 69.2867 },
  { name: { uz: 'Mega Planet', ru: 'Мега Планет', en: 'Mega Planet' }, district: { uz: 'Yunusobod', ru: 'Юнусабад', en: 'Yunusabad' }, lat: 41.3676, lng: 69.2896 },
  { name: { uz: 'Samarqand Darvoza', ru: 'Самарканд Дарвоза', en: 'Samarkand Darvoza' }, district: { uz: 'Shayxontohur', ru: 'Шайхантахур', en: 'Shaykhantakhur' }, lat: 41.3158, lng: 69.2135 },
  { name: { uz: 'Magic City', ru: 'Мэджик Сити', en: 'Magic City' }, district: { uz: 'Chilonzor', ru: 'Чиланзар', en: 'Chilanzar' }, lat: 41.303, lng: 69.247 },
  { name: { uz: 'Mustaqillik maydoni', ru: 'Площадь Независимости', en: 'Independence Square' }, district: { uz: 'Mirobod', ru: 'Мирабад', en: 'Mirabad' }, lat: 41.3146, lng: 69.2705 },
  { name: { uz: 'Oloy bozori', ru: 'Алайский базар', en: 'Alay Bazaar' }, district: { uz: 'Yunusobod', ru: 'Юнусабад', en: 'Yunusabad' }, lat: 41.324, lng: 69.2845 },
  { name: { uz: 'Chilonzor metro bekati', ru: 'Метро Чиланзар', en: 'Chilanzar metro' }, district: { uz: 'Chilonzor', ru: 'Чиланзар', en: 'Chilanzar' }, lat: 41.2771, lng: 69.2045 },
  { name: { uz: 'Toshkent teleminorasi', ru: 'Ташкентская телебашня', en: 'Tashkent TV Tower' }, district: { uz: 'Yunusobod', ru: 'Юнусабад', en: 'Yunusabad' }, lat: 41.346, lng: 69.2856 },
  { name: { uz: 'Botanika bogʻi', ru: 'Ботанический сад', en: 'Botanical Garden' }, district: { uz: 'Mirzo Ulugʻbek', ru: 'Мирзо-Улугбек', en: 'Mirzo Ulugbek' }, lat: 41.342, lng: 69.324 },
];
const HOME_ADDR: L = { uz: 'Chilonzor, 9-kvartal, 14-uy', ru: 'Чиланзар, 9-й квартал, дом 14', en: 'Chilanzar, block 9, building 14' };
const HOME_POINT = { lat: 41.2856, lng: 69.2034 };

const CLASSES = [
  { code: 'economy', name: { uz: 'Ekonom', ru: 'Эконом', en: 'Economy' }, seats: 4, k: 1, coefficient: 1 },
  { code: 'comfort', name: { uz: 'Komfort', ru: 'Комфорт', en: 'Comfort' }, seats: 4, k: 1.35, coefficient: 1.15 },
  { code: 'business', name: { uz: 'Biznes', ru: 'Бизнес', en: 'Business' }, seats: 4, k: 2, coefficient: 1 },
  { code: 'minivan', name: { uz: 'Miniven', ru: 'Минивэн', en: 'Minivan' }, seats: 7, k: 1.5, coefficient: 1 },
];
// Who is around in the demo: economy, comfort and business each have a cheaper car further away and a
// dearer one close by (two options); one minivan (a single "Best option").
const DRIVERS = [
  { name: 'Jasur', rating: 4.93, car: 'Chevrolet Cobalt', color: { uz: 'oq', ru: 'белый', en: 'white' }, plate: '01A123BC', share: 0.82, pickupMin: 9, cls: 'economy', highlights: [{ code: 'careful_driving', count: 41 }, { code: 'clean_car', count: 33 }] },
  { name: 'Dilshod', rating: 4.88, car: 'Chevrolet Gentra', color: { uz: 'kumush', ru: 'серебристый', en: 'silver' }, plate: '01B456CD', share: 0.9, pickupMin: 6, cls: 'economy', highlights: [{ code: 'polite', count: 27 }] },
  { name: 'Bekzod', rating: null, car: 'Chevrolet Nexia 3', color: { uz: 'oq', ru: 'белый', en: 'white' }, plate: '01D246EF', share: 0.97, pickupMin: 2, cls: 'economy', highlights: [] },
  { name: 'Rustam', rating: 4.97, car: 'Kia K5', color: { uz: 'qora', ru: 'чёрный', en: 'black' }, plate: '01C789DE', share: 0.92, pickupMin: 5, cls: 'comfort', highlights: [{ code: 'comfortable', count: 52 }, { code: 'knows_city', count: 30 }] },
  { name: 'Sardor', rating: 4.91, car: 'Chevrolet Malibu', color: { uz: 'oq', ru: 'белый', en: 'white' }, plate: '01F135GH', share: 0.83, pickupMin: 10, cls: 'comfort', highlights: [{ code: 'quiet_ride', count: 18 }] },
  { name: 'Timur', rating: 4.99, car: 'Mercedes-Benz E-Class', color: { uz: 'qora', ru: 'чёрный', en: 'black' }, plate: '01E777FA', share: 1, pickupMin: 3, cls: 'business', highlights: [{ code: 'polite', count: 64 }] },
  { name: 'Anvar', rating: 4.95, car: 'BMW 5', color: { uz: 'kulrang', ru: 'серый', en: 'grey' }, plate: '01G864HJ', share: 0.84, pickupMin: 11, cls: 'business', highlights: [{ code: 'comfortable', count: 21 }] },
  { name: 'Ulugʻbek', rating: 4.9, car: 'Kia Carnival', color: { uz: 'qora', ru: 'чёрный', en: 'black' }, plate: '01H502KL', share: 0.9, pickupMin: 6, cls: 'minivan', highlights: [{ code: 'helped_luggage', count: 15 }] },
];
type Driver = (typeof DRIVERS)[number];

/** Same rules as the server: cheaper = lowest price (pickup up to 15 min), faster = nearest; one option when nearly equal. */
function optionsFor(classCode: string, ref: number): { priority: 'cheap' | 'fast'; priceTiyin: number; pickupMin: number; driver: Driver }[] {
  const ds = DRIVERS.filter((d) => d.cls === classCode).map((d) => ({ d, price: round500(ref * d.share) }));
  if (!ds.length) return [];
  const fast = [...ds].sort((a, b) => a.price + a.d.pickupMin * 300_000 - (b.price + b.d.pickupMin * 300_000))[0]!;
  const cheap = [...ds].filter((x) => x.d.pickupMin <= 15).sort((a, b) => a.price + a.d.pickupMin * 20_000 - (b.price + b.d.pickupMin * 20_000))[0];
  const opt = (priority: 'cheap' | 'fast', x: typeof fast) => ({ priority, priceTiyin: x.price, pickupMin: x.d.pickupMin, driver: x.d });
  if (!cheap || cheap.d === fast.d || fast.price - cheap.price < 100_000) return [opt('fast', fast)];
  if (cheap.d.pickupMin - fast.d.pickupMin < 2) return [opt('cheap', cheap)];
  return [opt('cheap', cheap), opt('fast', fast)];
}

let lang: keyof L = 'uz';
const state: Row = {
  user: { id: uuid(), phone: '+998901112233', name: 'Aziza', language: 'uz', roles: ['passenger'] },
  places: [{ id: uuid(), kind: 'home', label: null, ...HOME_POINT, entranceId: null, addressL: HOME_ADDR }],
  cards: [] as Row[],
  rides: new Map<string, Row>(),
  activeId: null as string | null,
  firstAuto: true,
  debts: [] as Row[],
  disputes: new Map<string, Row>(),
  complaints: new Set<string>(),
  blocked: new Map<string, Row>(),
};

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000, r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function route(stops: { lat: number; lng: number }[]) {
  let m = 0;
  for (let i = 1; i < stops.length; i++) m += haversine(stops[i - 1]!, stops[i]!) * 1.3;
  return { distanceM: Math.round(m), durationS: Math.round((m / 1000 / 24) * 3600) + 120 };
}
const round500 = (tiyin: number) => Math.round(tiyin / 50_000) * 50_000;
/** Recommended fare in tiyin: 5 000 + 1 800/km + 250/min, at least 12 000 sum. */
function reference(r: { distanceM: number; durationS: number }, cls: (typeof CLASSES)[number]) {
  const sum = Math.max(12_000, 5_000 + 1_800 * (r.distanceM / 1000) + 250 * (r.durationS / 60));
  return round500(sum * 100 * cls.k * cls.coefficient);
}
const CITY: L = { uz: 'Toshkent', ru: 'Ташкент', en: 'Tashkent' };
const placeName = (p: (typeof PLACES)[number]) => ({ name: p.name[lang], address: `${p.district[lang]}, ${CITY[lang]}`, lat: p.lat, lng: p.lng });
const cls = (code: string) => CLASSES.find((c) => c.code === code) ?? CLASSES[0]!;

/** Moves the ride along in time: assignment, the car driving to the pickup, the trip, the 60% charge. */
function tick(r: Row) {
  const t = now();
  if (r.status === 'created' && !r.assignAt && !r.proposal && !r.proposeAt && t >= r.searchDeadline) {
    r.cancelledBy = 'system'; r.cancelReason = 'no_drivers'; finish(r, 'cancelled'); return;
  }
  if (r.status === 'created' && r.assignAt && t >= r.assignAt) {
    r.status = 'driver_en_route'; r.acceptedAt = t; r.arriveAt = t + 22_000;
    const d = r.driver;
    r.carFrom = { lat: r.stops[0].lat + 0.006, lng: r.stops[0].lng + 0.005 };
    d.pickupMin = d.pickupMin ?? 4;
  }
  if (r.status === 'created' && r.proposeAt && t >= r.proposeAt && !r.proposal && !r.assignAt) {
    r.proposal = round500(reference(r.route, cls(r.classCode)) * (r.fallbackDriver?.share ?? 0.9));
  }
  if (r.status === 'driver_en_route' && t >= r.arriveAt) { r.status = 'arrived'; r.arrivedAt = r.arriveAt; r.startAt = r.arrivedAt + 30_000; }
  if (r.status === 'arrived' && t >= r.startAt) { r.status = 'in_progress'; r.tripStart = r.startAt; r.tripMs = 45_000; }
  if (r.status === 'in_progress') {
    const pct = Math.min(100, Math.round(((t - r.tripStart) / r.tripMs) * 100));
    r.progress = pct;
    // At 60% of the trip the fare is charged to the card (as on the real server).
    if (pct >= 60 && r.paymentMethod === 'card' && !r.prepayTried) {
      r.prepayTried = true;
      const card = state.cards.find((c: Row) => c.id === r.cardId);
      if (card?.decline) r.paymentStatus = 'failed';
      else { r.paidTiyin = r.priceTiyin; r.paymentStatus = 'paid'; }
    }
    if (pct >= 100) finish(r, 'completed');
  }
}

function finish(r: Row, status: 'completed' | 'cancelled') {
  r.status = status; r.endedAt = now();
  if (status === 'completed' && r.paymentMethod === 'card' && r.paymentStatus !== 'paid') {
    r.paymentStatus = 'debt';
    state.debts.push({ rideId: r.id, kind: 'ride', amountTiyin: r.priceTiyin - r.paidTiyin, driverId: null });
  }
  if (state.activeId === r.id) state.activeId = null;
}

function rideView(r: Row) {
  tick(r);
  const v: Row = {
    id: r.id, status: r.status, mode: r.mode, priority: r.priority ?? null, classCode: r.classCode, priceTiyin: r.status === 'created' ? null : r.priceTiyin,
    route: r.route, stops: r.stops.map((s: Row, i: number) => ({ position: i, lat: s.lat, lng: s.lng, address: s.address ?? null, entrance: i === 0 ? s.entrance ?? null : null })),
    options: r.options, comment: r.comment, cancelledBy: r.cancelledBy ?? null, cancelReason: r.cancelReason ?? null,
    cancelFee: r.cancelFee ? { amountTiyin: r.cancelFee, status: 'pending' } : null,
    payment: {
      method: r.paymentMethod, status: r.paymentStatus ?? null, paidTiyin: r.paidTiyin,
      dueTiyin: r.priceTiyin == null ? null : Math.max(0, r.priceTiyin - r.paidTiyin),
      actionRequired: r.paymentStatus === 'failed' && ['accepted', 'driver_en_route', 'arrived', 'in_progress'].includes(r.status),
    },
    createdAt: iso(r.createdAt),
  };
  if (r.status === 'created') {
    {
      v.maxPriceTiyin = r.maxPriceTiyin; v.searchDeadline = iso(r.searchDeadline);
      v.dispatch = r.proposal ? { state: 'needs_confirmation', priceTiyin: r.proposal } : { state: r.assignAt ? 'waiting_driver' : 'searching' };
    }
  }
  if (r.driver && r.status !== 'created') {
    const d = r.driver;
    let location = null;
    if (['driver_en_route', 'arrived', 'in_progress'].includes(r.status)) {
      const p0 = r.stops[0];
      let pos = p0;
      if (r.status === 'driver_en_route') {
        const f = Math.min(1, (now() - r.acceptedAt) / (r.arriveAt - r.acceptedAt));
        pos = { lat: r.carFrom.lat + (p0.lat - r.carFrom.lat) * f, lng: r.carFrom.lng + (p0.lng - r.carFrom.lng) * f };
      } else if (r.status === 'in_progress') {
        // Along the stops by progress.
        const pts = r.stops, n = pts.length - 1, x = Math.min(0.999, (r.progress ?? 0) / 100) * n, i = Math.floor(x), f = x - i;
        pos = { lat: pts[i].lat + (pts[i + 1].lat - pts[i].lat) * f, lng: pts[i].lng + (pts[i + 1].lng - pts[i].lng) * f };
      }
      // Heading: towards the pickup while coming, along the route during the trip.
      const to = r.status === 'driver_en_route' ? p0 : r.stops[r.stops.length - 1];
      const heading = (Math.atan2((to.lng - pos.lng) * 0.75, to.lat - pos.lat) * 180) / Math.PI;
      location = { ...pos, heading: Math.round((heading + 360) % 360), at: iso(now()) };
    }
    v.driver = { name: d.name, rating: d.rating, highlights: d.highlights, vehicle: { makeModel: d.car, color: d.color[lang], plate: d.plate }, location };
  }
  if (r.status === 'arrived') {
    const freeUntil = r.arrivedAt + 120_000;
    const paid = Math.max(0, Math.floor((now() - freeUntil) / 60_000));
    v.waiting = { arrivedAt: iso(r.arrivedAt), freeUntil: iso(freeUntil), ratePerMinTiyin: 50_000, paidMinutes: paid, accruedTiyin: paid * 50_000, maxPaidMinutes: 30 };
  }
  if (r.status === 'in_progress') v.trip = { drivenM: Math.round((r.route.distanceM * (r.progress ?? 0)) / 100), progressPct: r.progress ?? 0 };
  if (r.status === 'completed') v.rating = { myScore: r.myScore ?? null, canRate: !r.myScore };
  return v;
}

function cancelTerms(r: Row) {
  if (r.status === 'created') return { allowed: true, feeTiyin: 0 };
  if (r.status === 'arrived') {
    const freeUntil = r.arrivedAt + 120_000;
    const waiting = Math.max(0, Math.floor((now() - freeUntil) / 60_000)) * 50_000;
    return { allowed: true, feeTiyin: 500_000 + waiting, breakdown: { cancelTiyin: 500_000, waitingTiyin: waiting } };
  }
  const freeUntil = r.acceptedAt + 180_000;
  if (now() < freeUntil) return { allowed: true, feeTiyin: 0, freeUntil: iso(freeUntil) };
  return { allowed: true, feeTiyin: 250_000, breakdown: { cancelTiyin: 250_000, waitingTiyin: 0 } };
}

function seedHistory() {
  const mk = (daysAgo: number, from: L, to: (typeof PLACES)[number], price: number, d: (typeof DRIVERS)[number], status = 'completed') => {
    const id = uuid();
    state.rides.set(id, {
      id, status, mode: 'auto', classCode: 'economy', priceTiyin: price, paidTiyin: price, paymentMethod: 'cash', createdAt: now() - daysAgo * 86_400_000,
      route: { distanceM: 7000, durationS: 1200 }, options: {}, comment: null, driver: d, myScore: 5,
      stops: [{ ...HOME_POINT, addressL: from }, { lat: to.lat, lng: to.lng, addressL: to.name }], history: true,
    });
  };
  mk(1, HOME_ADDR, PLACES[1]!, 2_450_000, DRIVERS[0]!);
  mk(3, HOME_ADDR, PLACES[3]!, 4_100_000, DRIVERS[2]!);
}
seedHistory();

/** History rides keep addresses in three languages so switching language works in the demo. */
function addr(s: Row): string | null {
  return s.addressL ? s.addressL[lang] : s.address ?? null;
}

export async function mockApi(method: string, rawPath: string, body: any): Promise<Res> {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
  const [path, qs] = rawPath.split('?');
  const q = new URLSearchParams(qs ?? '');
  const m = (re: RegExp) => path!.match(re);
  let x: RegExpMatchArray | null;

  // --- Sign-in ---
  if (method === 'POST' && path === '/auth/request-code') { lang = body.language; state.user.language = lang; state.user.phone = body.phone.replace(/\s/g, ''); return ok({ sent: true }); }
  if (method === 'POST' && path === '/auth/verify') return /^\d{6}$/.test(body.code) ? ok({ token: 'demo' }) : fail(400, 'invalid_code');
  if (method === 'POST' && path === '/auth/logout') return ok({});
  if (method === 'GET' && path === '/me') return ok(state.user);
  if (method === 'PATCH' && path === '/me') { Object.assign(state.user, body); if (body.language) lang = body.language; return ok(state.user); }

  if (method === 'DELETE' && path === '/me') {
    if (state.activeId) return fail(409, 'active_ride');
    if (state.debts.length) return fail(402, 'unpaid_debt');
    Object.assign(state.user, { name: null }); state.places = []; state.cards = []; state.blocked.clear();
    return ok(null, 204);
  }
  if (method === 'GET' && path === '/me/ratings') return ok({ asPassenger: { rating: 4.96, count: 23, completedRides: 23, cancelledRides: 1 }, asDriver: null });
  if (method === 'GET' && path === '/me/blocked-drivers') return ok([...state.blocked.values()]);
  if ((x = m(/^\/me\/blocked-drivers\/([\w-]+)$/)) && method === 'DELETE') { state.blocked.delete(x[1]!); return ok(null, 204); }
  if (method === 'GET' && path === '/geo/cars') {
    // Free cars around, snapped to a grid like the real server; they drift a little between calls.
    const lat = Number(q.get('lat')), lng = Number(q.get('lng'));
    const t = Math.floor(now() / 15_000);
    const offsets = [[0.004, -0.003], [-0.003, 0.005], [0.006, 0.006], [-0.006, -0.004], [0.001, 0.009], [-0.008, 0.002]];
    return ok({ cars: offsets.map(([a, b], i) => ({
      lat: Math.round((lat + a! + ((t + i) % 3) * 0.0015) / 0.0015) * 0.0015,
      lng: Math.round((lng + b!) / 0.002) * 0.002,
      heading: ((i * 90 + t * 45) % 360),
    })) });
  }

  // --- Places ---
  if (method === 'GET' && path === '/geo/search') {
    const n = (s: string) => s.toLowerCase().replace(/[ʻʼ'`\s.-]/g, '');
    const query = n(q.get('q') ?? '');
    return ok(PLACES.filter((p) => [p.name.uz, p.name.ru, p.name.en, p.district.uz, p.district.ru].some((s) => n(s).includes(query))).slice(0, 8).map(placeName));
  }
  if (method === 'GET' && path === '/geo/reverse') {
    const pt = { lat: Number(q.get('lat')), lng: Number(q.get('lng')) };
    if (haversine(pt, HOME_POINT) < 300) return ok({ name: HOME_ADDR[lang], address: HOME_ADDR[lang], ...HOME_POINT });
    const near = PLACES.map((p) => ({ p, d: haversine(pt, p) })).sort((a, b) => a.d - b.d)[0]!;
    return ok(placeName(near.p));
  }
  if (method === 'GET' && path === '/geo/entrances') {
    const pt = { lat: Number(q.get('lat')), lng: Number(q.get('lng')) };
    if (haversine(pt, HOME_POINT) > 300) return ok([]);
    // A nine-storey block with four entrances, learnt from earlier pickups.
    return ok([1, 2, 3, 4].map((nr) => {
      const e = { lat: HOME_POINT.lat - 0.00025, lng: HOME_POINT.lng - 0.0006 + nr * 0.00028 };
      return { id: `00000000-0000-4000-9000-00000000000${nr}`, number: String(nr), ...e, buildingAddress: HOME_ADDR[lang], confirmedPickups: 3 + nr * 4, distanceM: Math.round(haversine(pt, e)) };
    }));
  }
  if (method === 'GET' && path === '/me/places') return ok(state.places.map((p: Row) => ({ ...p, address: addr(p) })));
  if ((x = m(/^\/me\/places\/(home|work)$/)) && method === 'PUT') {
    state.places = state.places.filter((p: Row) => p.kind !== x![1]);
    const id = uuid();
    state.places.push({ id, kind: x[1], label: null, lat: body.lat, lng: body.lng, address: body.address, entranceId: null });
    return ok({ id });
  }
  if (method === 'POST' && path === '/me/places') {
    const id = uuid();
    state.places.push({ id, kind: 'other', label: body.label ?? null, lat: body.lat, lng: body.lng, address: body.address, entranceId: null });
    return ok({ id }, 201);
  }
  if ((x = m(/^\/me\/places\/([\w-]+)$/)) && method === 'DELETE') { state.places = state.places.filter((p: Row) => p.id !== x![1]); return ok(null, 204); }

  // --- Prices ---
  if (method === 'POST' && path === '/quotes') {
    const r = route(body.stops);
    return ok({
      route: r,
      classes: CLASSES.map((c) => {
        const ref = reference(r, c);
        const options = optionsFor(c.code, ref);
        return { code: c.code, name: c.name[lang], seats: c.seats, maxFareTiyin: ref, minFareTiyin: round500(ref * 0.8), coefficient: c.coefficient,
          options: options.map(({ driver: _d, ...o }) => o), driversNearby: DRIVERS.filter((d) => d.cls === c.code).length };
      }),
    });
  }

  // --- Cards and debts ---
  if (method === 'GET' && path === '/me/cards') return ok(state.cards.map(({ decline, ...c }: Row) => c));
  if (method === 'POST' && path === '/me/cards') {
    const tok: string = body.token;
    if (!/^fake_tok_/.test(tok)) return fail(400, 'invalid_card_token');
    const decline = tok.startsWith('fake_tok_decline');
    const last4 = decline ? '0502' : tok.split('_')[2] ?? '0000';
    if (state.cards.some((c: Row) => c.panMasked.endsWith(last4))) return fail(409, 'card_already_added');
    const card = { id: uuid(), provider: 'payme', panMasked: `8600 **** **** ${last4}`, expiry: '12/29', isDefault: state.cards.length === 0, decline };
    state.cards.push(card);
    const { decline: _d, ...pub } = card;
    return ok(pub, 201);
  }
  if ((x = m(/^\/me\/cards\/([\w-]+)\/default$/))) { state.cards.forEach((c: Row) => { c.isDefault = c.id === x![1]; }); return ok(null, 204); }
  if ((x = m(/^\/me\/cards\/([\w-]+)$/)) && method === 'DELETE') {
    if (state.activeId && state.rides.get(state.activeId)?.cardId === x[1]) return fail(409, 'card_in_use');
    state.cards = state.cards.filter((c: Row) => c.id !== x![1]);
    return ok(null, 204);
  }
  if (method === 'GET' && path === '/me/debts') return ok({ totalTiyin: state.debts.reduce((a: number, d: Row) => a + d.amountTiyin, 0), items: state.debts });
  if (method === 'POST' && path === '/me/debts/pay') {
    const card = state.cards.find((c: Row) => c.id === body.cardId);
    if (!card) return fail(404, 'card_not_found');
    const results = state.debts.map((d: Row) => ({ rideId: d.rideId, kind: d.kind, status: card.decline ? 'failed' : 'succeeded' }));
    if (!card.decline) state.debts = [];
    return ok({ results, remainingTiyin: state.debts.reduce((a: number, d: Row) => a + d.amountTiyin, 0) });
  }

  // --- Rides ---
  if (method === 'POST' && path === '/rides') {
    if (state.debts.length) return fail(402, 'unpaid_debt', { totalTiyin: state.debts.reduce((a: number, d: Row) => a + d.amountTiyin, 0) });
    if (state.activeId) return fail(409, 'active_ride_exists');
    const r0 = route(body.stops);
    const c = cls(body.classCode);
    const card = body.paymentMethod === 'card' ? state.cards.find((x: Row) => x.id === body.cardId) : null;
    if (body.paymentMethod === 'card' && !card) return fail(400, 'card_not_found');
    const id = uuid();
    const r: Row = {
      id, status: 'created', mode: body.mode, classCode: c.code, route: r0, createdAt: now(), options: body.options ?? {}, comment: body.comment ?? null,
      stops: body.stops.map((s: Row, i: number) => ({ lat: s.lat, lng: s.lng, address: s.address, entrance: i === 0 ? (s.entranceLabel ?? (s.entranceId ? String(Number(s.entranceId.slice(-1))) : null)) : null })),
      paymentMethod: body.paymentMethod ?? 'cash', cardId: card?.id ?? null, paidTiyin: 0, searchDeadline: now() + 90_000,
    };
    r.maxPriceTiyin = body.maxPriceTiyin; r.priority = body.priority ?? 'fast';
    const pick = optionsFor(c.code, reference(r0, c)).find((o) => o.priority === r.priority) ?? optionsFor(c.code, reference(r0, c))[0];
    // The first "cheaper" order in the demo shows the honest "only a pricier driver is left" question.
    if (state.firstAuto && r.priority === 'cheap' && pick) { state.firstAuto = false; r.proposeAt = now() + 3500; r.fallbackDriver = DRIVERS.find((d) => d.name === 'Dilshod'); }
    else if (pick) { r.assignAt = now() + 4000; r.priceTiyin = Math.min(pick.priceTiyin, body.maxPriceTiyin); r.driver = { ...pick.driver }; }
    // No car of this class: the search runs out after the window (shortened for the demo).
    else r.searchDeadline = now() + 20_000;
    state.rides.set(id, r); state.activeId = id;
    return ok(rideView(r), 201);
  }
  // The demo has no road data: no line, so the map draws straight segments between the stops.
  if (method === 'GET' && /^\/rides\/[^/]+\/route$/.test(path)) return ok({ line: null, version: 0 });
  if (method === 'GET' && path === '/rides/active') {
    const r = state.activeId ? state.rides.get(state.activeId) : null;
    if (!r) return ok(null, 204);
    const v = rideView(r);
    return state.activeId ? ok(v) : ok(null, 204);
  }
  if (method === 'GET' && path === '/me/rides') {
    return ok([...state.rides.values()].filter((r) => r.status === 'completed' || r.status === 'cancelled').sort((a, b) => b.createdAt - a.createdAt).map((r) => {
      const last = r.stops[r.stops.length - 1];
      return {
        id: r.id, status: r.status, classCode: r.classCode, priceTiyin: r.priceTiyin ?? null, paymentMethod: r.paymentMethod, createdAt: iso(r.createdAt),
        cancelFeeTiyin: r.cancelFee ?? null, driverName: r.driver?.name ?? null, makeModel: r.driver?.car ?? null, plate: r.driver?.plate ?? null,
        fromAddress: addr(r.stops[0]), to: { lat: last.lat, lng: last.lng, address: addr(last) }, hasDispute: state.disputes.has(r.id),
      };
    }));
  }
  if (method === 'GET' && path === '/rating-tags') {
    const about = q.get('about') ?? 'driver';
    const list = (tone: string) => RATING_TAGS.filter((t) => t.about === about && t.tone === tone).map((t) => ({ code: t.code, label: t.label[lang] }));
    return ok({ language: lang, maxTags: 5, positive: list('positive'), negative: list('negative') });
  }

  x = m(/^\/rides\/([\w-]+)(\/.*)?$/);
  if (!x) return fail(404, 'not_found');
  const r = state.rides.get(x[1]!);
  if (!r) return fail(404, 'not_found');
  const sub = x[2] ?? '';
  tick(r);

  if (method === 'GET' && sub === '') return ok(rideView(r));
  if (method === 'POST' && sub === '/confirm-price') {
    if (r.proposal !== body.priceTiyin) return fail(409, 'price_changed');
    r.maxPriceTiyin = r.proposal; r.priceTiyin = r.proposal; r.proposal = null; r.driver = { ...(r.fallbackDriver ?? DRIVERS[1]) }; r.assignAt = now() + 3000;
    return ok(rideView(r));
  }
  if (method === 'POST' && sub === '/payment') {
    if (body.method === 'cash') { r.paymentMethod = 'cash'; r.cardId = null; r.paymentStatus = null; }
    else {
      const card = state.cards.find((c: Row) => c.id === body.cardId);
      if (!card) return fail(404, 'card_not_found');
      r.paymentMethod = 'card'; r.cardId = card.id;
      if (r.paymentStatus === 'failed') { if (card.decline) r.paymentStatus = 'failed'; else { r.paymentStatus = 'paid'; r.paidTiyin = r.priceTiyin; } }
    }
    return ok(rideView(r));
  }
  if (method === 'GET' && sub === '/cancel-terms') return ok(cancelTerms(r));
  if (method === 'POST' && sub === '/cancel') {
    if (r.status === 'in_progress' || r.status === 'completed' || r.status === 'cancelled') return fail(409, 'invalid_transition');
    const terms = cancelTerms(r);
    if (terms.feeTiyin > 0 && (body.acceptFeeTiyin ?? -1) < terms.feeTiyin) return fail(409, 'fee_confirmation_required', { feeTiyin: terms.feeTiyin, breakdown: terms.breakdown });
    r.cancelledBy = 'passenger';
    if (terms.feeTiyin > 0) {
      r.cancelFee = terms.feeTiyin;
      const card = state.cards.find((c: Row) => c.id === r.cardId);
      if (!card || card.decline) state.debts.push({ rideId: r.id, kind: 'cancel_fee', amountTiyin: terms.feeTiyin, driverId: null });
    }
    finish(r, 'cancelled');
    return ok(rideView(r));
  }
  if (method === 'POST' && (sub === '/route/preview' || sub === '/route')) {
    const nr = route(body.stops);
    const newPrice = round500((r.priceTiyin * nr.distanceM) / Math.max(1, r.route.distanceM));
    if (sub === '/route/preview') return ok({ oldPriceTiyin: r.priceTiyin, newPriceTiyin: newPrice, differenceTiyin: newPrice - r.priceTiyin, route: nr, reason: 'stop_added' });
    if (body.priceTiyin !== newPrice) return fail(409, 'price_changed', { newPriceTiyin: newPrice });
    r.stops = body.stops.map((s: Row, i: number) => ({ lat: s.lat, lng: s.lng, address: s.address, entrance: i === 0 ? s.entranceLabel ?? null : null }));
    r.route = nr; r.priceTiyin = newPrice;
    return ok(rideView(r));
  }
  if (method === 'POST' && sub === '/block-driver') {
    if (!r.driver) return fail(409, 'no_driver_assigned');
    if (![...state.blocked.values()].some((b: Row) => b.plate === r.driver.plate)) { const id = uuid(); state.blocked.set(id, { id, driverName: r.driver.name, makeModel: r.driver.car, plate: r.driver.plate, createdAt: iso(now()) }); }
    return ok(null, 204);
  }
  if (method === 'POST' && sub === '/rating') { r.myScore = body.score; return ok({ ok: true }, 201); }
  if (method === 'POST' && sub === '/complaint') {
    const key = `${r.id}:${body.type}`;
    if (state.complaints.has(key)) return fail(409, 'already_filed');
    state.complaints.add(key);
    return ok({ id: uuid(), status: 'open' }, 201);
  }
  const disputeView = (d: Row) => ({
    id: d.id, category: d.category, openedBy: 'passenger', status: d.status, respondBy: iso(d.createdAt + 72 * 3600_000), createdAt: iso(d.createdAt),
    myStatement: { text: d.mine, createdAt: iso(d.createdAt) }, otherStatement: null, otherHasWritten: false, awaitingMe: false, outcome: null, resolution: null, resolvedAt: null,
  });
  if (method === 'GET' && sub === '/dispute') { const d = state.disputes.get(r.id); return d ? ok(disputeView(d)) : fail(404, 'no_dispute'); }
  if (method === 'POST' && sub === '/dispute') {
    if (state.disputes.has(r.id)) return fail(409, 'dispute_exists');
    const d = { id: uuid(), category: body.category, status: 'awaiting_response', mine: body.text, createdAt: now() };
    state.disputes.set(r.id, d);
    return ok(disputeView(d), 201);
  }
  return fail(404, 'not_found');
}
