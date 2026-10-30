// Demo mode only: a pretend server so the whole driver journey can be tried in a browser —
// sign-up, documents, approval, going online, an order, the ride, rating the passenger.
// Names and addresses are made up.

import { RATING_TAGS } from '../../../packages/shared/src/ratingTags.ts';

type Res = { status: number; body: unknown };
type Row = Record<string, any>;

const DOCS = ['passport', 'license', 'vehicle_registration', 'selfie', 'self_employed'];
const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
let lang = 'uz';

const state: Row = {
  user: { id: 'u1', phone: '+998901112233', name: null, roles: ['passenger'], language: 'uz' },
  driver: null as Row | null,
  online: false,
  onlineSince: 0,
  request: null as Row | null,
  nextRequestAt: 0,
  ride: null as Row | null,
  stats: { ridesToday: 6, earnedToday: 16_350_000, ridesWeek: 38, earnedWeek: 104_200_000 },
  tariff: { version: 0, baseTiyin: 500000, perKmTiyin: 180000, perMinTiyin: 25000, minFareTiyin: 1200000 },
};

const TRIPS = [
  { entrance: '2', pickup: 'Chilonzor, 9-kvartal, 14-uy', dropoff: 'Toshkent City Mall', distanceM: 7400, durationS: 1260, priceTiyin: 2_650_000, passenger: 'Madina', rating: 4.95, pickupM: 650 },
  { pickup: 'Yunusobod, Amir Temur 107', dropoff: 'Xalqaro aeroport, 2-terminal', distanceM: 12800, durationS: 1680, priceTiyin: 3_950_000, passenger: 'Olga', rating: 4.8, pickupM: 1200 },
  { pickup: 'Mirzo Ulugʻbek, Buyuk Ipak Yoʻli 52', dropoff: 'Chorsu bozori', distanceM: 9100, durationS: 1500, priceTiyin: 2_950_000, passenger: 'Javlon', rating: null, pickupM: 900 },
];
let tripIndex = 0;

function profile() {
  const d = state.driver!;
  const present = new Set(d.documents.map((x: Row) => x.type));
  return { ...d, name: state.user.name, phone: state.user.phone, missingDocuments: DOCS.filter((t) => !present.has(t)) };
}

function rideView() {
  const r = state.ride!;
  const view: Row = {
    id: r.id, status: r.status, priceTiyin: r.priceTiyin + (r.waitingCharged ?? 0), route: { distanceM: r.distanceM, durationS: r.durationS },
    stops: [
      { position: 0, lat: 41.2856, lng: 69.2034, address: r.pickup, entrance: r.entrance ?? null },
      { position: 1, lat: 41.3111, lng: 69.2486, address: r.dropoff },
    ],
    passenger: { name: r.passenger, rating: r.rating },
    payment: { method: r.paymentMethod, status: null, paidTiyin: 0 },
    cashToCollectTiyin: r.paymentMethod === 'cash' ? r.priceTiyin + (r.waitingCharged ?? 0) : 0,
    cancelledBy: r.cancelledBy ?? null,
    cancelFee: r.cancelFee ?? null,
    rating: r.status === 'completed' ? { myScore: r.myScore ?? null, canRate: !r.myScore } : undefined,
  };
  if (r.status === 'arrived') {
    const sec = (now() - r.arrivedAt) / 1000;
    const paid = Math.max(0, Math.min(30, Math.floor(sec / 60) - 2));
    view.waiting = { arrivedAt: iso(r.arrivedAt), freeUntil: iso(r.arrivedAt + 120_000), ratePerMinTiyin: 50_000, paidMinutes: paid, accruedTiyin: paid * 50_000, maxPaidMinutes: 30 };
  }
  if (r.status === 'in_progress') {
    const progress = Math.min(1, (now() - r.startedAt) / 60_000);
    view.trip = { drivenM: Math.round(r.distanceM * progress), progressPct: Math.round(progress * 100) };
  }
  return view;
}

const ok = (body: unknown = {}): Res => ({ status: 200, body });
const err = (status: number, error: string, extra: Row = {}): Res => ({ status, body: { error, ...extra } });

export async function mockApi(method: string, fullPath: string, body: any): Promise<Res> {
  await new Promise((r) => setTimeout(r, 150));
  const [path, qs] = fullPath.split('?');
  const q = new URLSearchParams(qs ?? '');

  if (method === 'POST' && path === '/auth/request-code') { lang = body.language; state.user.language = lang; return { status: 204, body: {} }; }
  if (method === 'POST' && path === '/auth/verify') {
    if (!/^\d{6}$/.test(body.code)) return err(400, 'wrong_code');
    return ok({ token: 'demo', user: state.user });
  }
  if (path === '/me' && method === 'GET') return ok(state.user);
  // The demo has nothing to accept (the texts are published with the real service).
  if (path === '/me/consents' && method === 'GET') return ok({ needed: [] });
  if (path === '/me/consents' && method === 'POST') return ok({});
  if (path === '/me' && method === 'PATCH') { Object.assign(state.user, body); lang = state.user.language; return ok(state.user); }

  if (path === '/drivers/me' && method === 'GET') return state.driver ? ok(profile()) : err(404, 'not_a_driver');
  if (path === '/drivers/apply') {
    state.user.name = body.name;
    state.driver ??= { id: 'd1', status: 'pending', rating: null, vehicles: [], documents: [] };
    return ok(profile());
  }
  if (path === '/drivers/me/vehicles') {
    const v = { id: 'v1', make_model: body.makeModel, year: body.year, color: body.color, plate: String(body.plate).toUpperCase().replace(/\s+/g, ''), class_code: null };
    state.driver!.vehicles = [v];
    return { status: 201, body: v };
  }
  const docMatch = path!.match(/^\/drivers\/me\/documents\/([a-z_]+)\/photo$/);
  if (docMatch) {
    const d = state.driver!;
    d.documents = d.documents.filter((x: Row) => x.type !== docMatch[1]);
    d.documents.push({ id: `doc-${docMatch[1]}`, type: docMatch[1], status: 'pending', fileUrl: body?.uri || null, created_at: iso(now()) });
    return { status: 201, body: {} };
  }
  if (path === '/demo/approve') {
    const d = state.driver!;
    d.status = 'verified';
    d.vehicles[0] && (d.vehicles[0].class_code = 'economy');
    d.documents.forEach((x: Row) => (x.status = 'approved'));
    d.subscriptionUntil = iso(now() + 30 * 86_400_000);
    state.user.roles = ['passenger', 'driver'];
    return ok(profile());
  }

  if (path === '/drivers/me/stats') {
    return ok({
      today: { rides: state.stats.ridesToday, earnedTiyin: state.stats.earnedToday, keptVsCommissionTiyin: Math.round(state.stats.earnedToday * 0.2) },
      week: { rides: state.stats.ridesWeek, earnedTiyin: state.stats.earnedWeek, keptVsCommissionTiyin: Math.round(state.stats.earnedWeek * 0.2) },
      subscriptionUntil: state.driver?.subscriptionUntil ?? null, comparedCommissionPct: 20,
    });
  }
  if (path === '/subscription-plans') {
    const names: Row = { day: { uz: 'Kun', ru: 'День', en: 'Day' }, week: { uz: 'Hafta', ru: 'Неделя', en: 'Week' }, month: { uz: 'Oy', ru: 'Месяц', en: 'Month' } };
    return ok({ plans: [
      { code: 'day', name: names.day[lang], priceTiyin: 1_500_000, periodDays: 1 },
      { code: 'week', name: names.week[lang], priceTiyin: 5_000_000, periodDays: 7 },
      { code: 'month', name: names.month[lang], priceTiyin: 15_000_000, periodDays: 30 },
    ], providers: ['payme', 'click'] });
  }
  if (path === '/drivers/me/subscription') {
    const until = state.driver?.subscriptionUntil;
    return ok({ active: !!until && new Date(until).getTime() > now(), activeUntil: until ?? null, periods: [] });
  }
  if (path === '/drivers/me/subscriptions') {
    const days = { day: 1, week: 7, month: 30 }[body.planCode as 'day'] ?? 1;
    const from = Math.max(now(), new Date(state.driver!.subscriptionUntil ?? 0).getTime());
    state.driver!.subscriptionUntil = iso(from + days * 86_400_000);
    return { status: 201, body: { paymentId: 'p1', checkoutUrl: null, amountTiyin: 0 } };
  }
  if (path?.startsWith('/payments/')) return ok({ status: 'succeeded' });

  if (path === '/drivers/me/tariff' && method === 'GET') {
    const rec = { baseTiyin: 500000, perKmTiyin: 180000, perMinTiyin: 25000, minFareTiyin: 1200000 };
    const b = (v: number) => ({ min: Math.ceil(v * 0.8), max: v });
    return ok({ classCode: 'economy', current: { ...state.tariff, validFrom: null }, recommended: rec,
      bounds: { baseTiyin: b(rec.baseTiyin), perKmTiyin: b(rec.perKmTiyin), perMinTiyin: b(rec.perMinTiyin), minFareTiyin: b(rec.minFareTiyin) } });
  }
  if (path === '/drivers/me/tariff' && method === 'PUT') {
    if (state.tariff.version > 0 && state.tariff.changedAt > now() - 86_400_000) return err(429, 'tariff_changed_recently');
    state.tariff = { ...body, version: state.tariff.version + 1, changedAt: now() };
    return ok(state.tariff);
  }

  if (path === '/drivers/me/online') {
    if (!state.driver?.subscriptionUntil || new Date(state.driver.subscriptionUntil).getTime() < now()) return err(402, 'subscription_required');
    state.online = true; state.onlineSince = now(); state.nextRequestAt = now() + 4000;
    return ok({ status: state.ride ? 'busy' : 'online' });
  }
  if (path === '/drivers/me/location') return { status: 204, body: {} };
  if (path === '/drivers/me/offline') {
    if (state.ride && !['completed', 'cancelled'].includes(state.ride.status)) return err(409, 'on_ride');
    state.online = false; state.request = null; return ok({ status: 'offline' });
  }
  if (path === '/drivers/me/requests') {
    const busy = state.ride && !['completed', 'cancelled'].includes(state.ride.status);
    if (!state.online || busy) return ok([]);
    if (state.request && new Date(state.request.expiresAt).getTime() < now()) { state.request = null; state.nextRequestAt = now() + 6000; }
    if (!state.request && now() >= state.nextRequestAt) {
      const t = TRIPS[tripIndex++ % TRIPS.length]!;
      state.request = { rideId: `r${tripIndex}`, offerId: `o${tripIndex}`, priceTiyin: t.priceTiyin, expiresAt: iso(now() + 15_000),
        distanceM: t.distanceM, durationS: t.durationS, options: tripIndex % 2 ? { childSeat: true } : {}, comment: tripIndex % 2 ? '2-podyezd, domofon 45' : null,
        passengerRating: t.rating, pickupDistanceM: t.pickupM,
        stops: [{ position: 0, lat: 41.2856, lng: 69.2034, address: t.pickup, entrance: t.entrance ?? null }, { position: 1, lat: 41.3111, lng: 69.2486, address: t.dropoff }], _t: t };
    }
    return ok(state.request ? [state.request] : []);
  }

  const rideMatch = path!.match(/^\/rides\/([^/]+)(?:\/([a-z-]+))?$/);
  if (path === '/rides/active') return state.ride && !['completed', 'cancelled'].includes(state.ride.status) ? ok(rideView()) : { status: 204, body: {} };
  if (rideMatch) {
    const [, id, action] = rideMatch;
    if (action === 'accept') {
      if (!state.request || state.request.rideId !== id) return err(404, 'not_found');
      const t = state.request._t;
      state.ride = { id, status: 'accepted', ...t, paymentMethod: tripIndex % 3 === 0 ? 'card' : 'cash' };
      state.request = null;
      return ok(rideView());
    }
    if (action === 'decline') { state.request = null; state.nextRequestAt = now() + 6000; return { status: 204, body: {} }; }
    if (!state.ride || state.ride.id !== id) return err(404, 'not_found');
    const r = state.ride;
    if (!action) return ok(rideView());
    if (action === 'status') {
      r.status = body.status;
      if (body.status === 'arrived') r.arrivedAt = now();
      if (body.status === 'in_progress') {
        const paid = Math.max(0, Math.min(30, Math.floor((now() - r.arrivedAt) / 60_000) - 2));
        r.waitingCharged = paid * 50_000; r.startedAt = now();
      }
      if (body.status === 'completed') {
        state.stats.ridesToday += 1; state.stats.earnedToday += r.priceTiyin + (r.waitingCharged ?? 0);
        state.stats.ridesWeek += 1; state.stats.earnedWeek += r.priceTiyin + (r.waitingCharged ?? 0);
        state.nextRequestAt = now() + 8000;
      }
      return ok(rideView());
    }
    if (action === 'cancel-terms') {
      if (r.status !== 'arrived' || q.get('noShow') !== 'true') return ok({ allowed: true, feeTiyin: 0 });
      const from = r.arrivedAt + 5 * 60_000;
      return from <= now() ? ok({ allowed: true, feeTiyin: 500_000 }) : ok({ allowed: false, feeTiyin: 500_000, noShowFrom: iso(from) });
    }
    if (action === 'cancel') {
      if (body?.noShow && now() < r.arrivedAt + 5 * 60_000) return err(409, 'too_early_for_no_show', { noShowFrom: iso(r.arrivedAt + 5 * 60_000) });
      r.status = 'cancelled'; r.cancelledBy = 'driver'; state.nextRequestAt = now() + 8000;
      if (body?.noShow) r.cancelFee = { amountTiyin: 500_000, status: 'pending' };
      return ok(rideView());
    }
    if (action === 'rating') { r.myScore = body.score; return { status: 204, body: {} }; }
  }
  if (path === '/rating-tags') {
    const about = q.get('about') ?? 'passenger';
    const l = (lang as 'uz' | 'ru' | 'en');
    const list = (tone: string) => RATING_TAGS.filter((t) => t.about === about && t.tone === tone).map((t) => ({ code: t.code, label: t.label[l] }));
    return ok({ language: l, maxTags: 5, positive: list('positive'), negative: list('negative') });
  }
  return err(404, 'not_found');
}
