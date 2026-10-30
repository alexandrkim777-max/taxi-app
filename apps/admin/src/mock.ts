// Demo mode only: answers the panel's API calls in the browser with sample data that reacts to
// actions (approve, block, set the coefficient, ...). Names, phones and plates are made up.

type Res = { status: number; body: unknown };
type Row = Record<string, any>;

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const ahead = (min: number) => new Date(now + min * 60_000).toISOString();
let seq = 1;
const id = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`;

function docImage(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
<rect width="320" height="200" rx="14" fill="hsl(${hue},35%,88%)"/><rect x="18" y="22" width="84" height="104" rx="8" fill="hsl(${hue},25%,72%)"/>
<rect x="120" y="30" width="170" height="12" rx="6" fill="hsl(${hue},20%,60%)"/><rect x="120" y="56" width="130" height="10" rx="5" fill="hsl(${hue},20%,68%)"/>
<rect x="120" y="78" width="150" height="10" rx="5" fill="hsl(${hue},20%,68%)"/><rect x="120" y="100" width="90" height="10" rx="5" fill="hsl(${hue},20%,68%)"/>
<text x="18" y="170" font-family="sans-serif" font-size="18" font-weight="700" fill="hsl(${hue},40%,30%)">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const DOC_TYPES = ['passport', 'license', 'vehicle_registration', 'selfie', 'self_employed'];
const DOC_LABEL: Record<string, string> = {
  passport: 'PASPORT', license: 'HAYDOVCHILIK', vehicle_registration: 'TEXPASPORT', selfie: 'SELFI', self_employed: 'OʻZINI BAND',
};

function makeDriver(name: string, phone: string, car: string, color: string, plate: string, status: string, cls: string | null, opts: Row = {}): Row {
  const driverId = id();
  return {
    id: driverId, userId: id(), status, name, phone, rating: opts.rating ?? null, ratingCount: opts.ratingCount ?? 0,
    languages: ['uz', 'ru'], pickup_radius_m: 3000, verified_at: status === 'verified' ? ago(60 * 24 * 40) : null,
    vehicles: [{ id: id(), make_model: car, year: opts.year ?? 2021, color, plate, class_code: cls }],
    documents: DOC_TYPES.filter((t) => !(opts.missing ?? []).includes(t)).map((t, i) => ({
      id: id(), type: t, status: status === 'verified' ? 'approved' : 'pending', note: null,
      fileUrl: docImage(DOC_LABEL[t]!, 170 + i * 30), created_at: ago(opts.appliedMin ?? 90),
    })),
    pausedUntil: null, subscriptionUntil: status === 'verified' ? ahead(60 * 24 * (opts.subDays ?? 12)) : null,
    tags: opts.tags ?? [], stats: opts.stats ?? { completed: 0, cancelledByDriver: 0, completed30d: 0, earned30dTiyin: 0 },
    complaints: [], blocks: [], recentRides: [], roles: ['passenger', 'driver'],
  };
}

const drivers: Row[] = [
  makeDriver('Jasur Toshmatov', '+998901112233', 'Chevrolet Cobalt', 'oq', '01A777AA', 'pending', null, { appliedMin: 35 }),
  makeDriver('Dilshod Rahimov', '+998935554411', 'Chevrolet Gentra', 'kumush', '01B214KA', 'pending', null, { appliedMin: 140, missing: ['self_employed'] }),
  makeDriver('Aziz Karimov', '+998977001020', 'Chevrolet Malibu', 'qora', '01C505MA', 'pending', null, { appliedMin: 260, year: 2023 }),
  makeDriver('Bobur Aliyev', '+998909998877', 'Chevrolet Cobalt', 'oq', '01D321BA', 'verified', 'economy', {
    rating: 4.92, ratingCount: 318, stats: { completed: 1204, cancelledByDriver: 17, completed30d: 286, earned30dTiyin: 1_285_000_000 },
    tags: [{ code: 'careful_driving', count: 141 }, { code: 'clean_car', count: 118 }, { code: 'polite', count: 96 }, { code: 'late', count: 4 }],
  }),
  makeDriver('Sardor Yusupov', '+998946543210', 'Chevrolet Nexia 3', 'kulrang', '01E909HA', 'verified', 'economy', {
    rating: 4.31, ratingCount: 87, subDays: 2, stats: { completed: 402, cancelledByDriver: 39, completed30d: 97, earned30dTiyin: 402_500_000 },
    tags: [{ code: 'knows_city', count: 22 }, { code: 'unsafe_driving', count: 6 }, { code: 'phone_while_driving', count: 5 }],
  }),
];

const passengers: Row[] = [
  { id: id(), name: 'Madina Ergasheva', phone: '+998901234567', language: 'uz', roles: ['passenger'], rating: 4.95, ratingCount: 42, completed: 61, cancelled: 3, cards: 1, createdAt: ago(60 * 24 * 90), complaints: [], blocks: [] },
  { id: id(), name: 'Olga Kim', phone: '+998935671234', language: 'ru', roles: ['passenger'], rating: 4.8, ratingCount: 12, completed: 19, cancelled: 1, cards: 2, createdAt: ago(60 * 24 * 30), complaints: [], blocks: [] },
];

const classes: Row[] = [
  { code: 'economy', name: { ru: 'Эконом', uz: 'Ekonom' }, coefficient: 1, baseTiyin: 500000, perKmTiyin: 180000, perMinTiyin: 25000, minFareTiyin: 1200000, corridorMinPct: -20, corridorMaxPct: 0, cancelFeeTiyin: 500000, freeWaitMin: 2, waitPerMinTiyin: 50000 },
  { code: 'comfort', name: { ru: 'Комфорт', uz: 'Komfort' }, coefficient: 1, baseTiyin: 700000, perKmTiyin: 240000, perMinTiyin: 35000, minFareTiyin: 1600000, corridorMinPct: -20, corridorMaxPct: 0, cancelFeeTiyin: 700000, freeWaitMin: 2, waitPerMinTiyin: 70000 },
  { code: 'business', name: { ru: 'Бизнес', uz: 'Biznes' }, coefficient: 1, baseTiyin: 1200000, perKmTiyin: 400000, perMinTiyin: 60000, minFareTiyin: 3000000, corridorMinPct: -20, corridorMaxPct: 0, cancelFeeTiyin: 1000000, freeWaitMin: 2, waitPerMinTiyin: 100000 },
  { code: 'minivan', name: { ru: 'Минивэн', uz: 'Miniven' }, coefficient: 1, baseTiyin: 1000000, perKmTiyin: 300000, perMinTiyin: 45000, minFareTiyin: 2500000, corridorMinPct: -20, corridorMaxPct: 0, cancelFeeTiyin: 1000000, freeWaitMin: 2, waitPerMinTiyin: 100000 },
];
const plans: Row[] = [
  { code: 'trial', name: { ru: 'Пробный месяц', uz: 'Sinov oyi' }, priceTiyin: 0, periodDays: 30, isActive: true },
  { code: 'day', name: { ru: 'День', uz: 'Kun' }, priceTiyin: 1500000, periodDays: 1, isActive: true },
  { code: 'week', name: { ru: 'Неделя', uz: 'Hafta' }, priceTiyin: 5000000, periodDays: 7, isActive: true },
  { code: 'month', name: { ru: 'Месяц', uz: 'Oy' }, priceTiyin: 15000000, periodDays: 30, isActive: true },
];
const rules: Row[] = [
  { id: id(), classCode: null, value: 1.1, reason: 'Ёмғир, талаб юқори / Дождь', validFrom: ago(60 * 26), validUntil: ago(60 * 22), setBy: 'Aleksandr', createdAt: ago(60 * 26), cancelledAt: null, active: false },
];

const me = { id: id(), name: 'Aleksandr', phone: '+998900000001', roles: ['passenger', 'admin'], language: 'ru' };
const audit: Row[] = [];
function log(action: string, targetType: string | null, targetId: string | null, payload: Row = {}) {
  audit.unshift({ id: audit.length + 1, action, targetType, targetId, payload, ip: '10.0.0.5', at: new Date().toISOString(), adminName: me.name, adminPhone: me.phone });
}
log('driver_approved', 'driver', drivers[3]!.id, { classCode: 'economy' });

const rides: Row[] = [];
function makeRide(status: string, pax: Row, drv: Row | null, priceTiyin: number, minAgo: number, extra: Row = {}): Row {
  const r = {
    id: id(), status, locked_price_tiyin: priceTiyin, payment_method: extra.payment ?? 'cash', payment_status: extra.paymentStatus ?? null,
    created_at: ago(minAgo), passenger_name: pax.name, passenger_phone: pax.phone, driver_name: drv?.name ?? null,
    driver_phone: drv?.phone ?? null, plate: drv?.vehicles[0].plate ?? null, make_model: drv?.vehicles[0].make_model ?? null,
    class_code: 'economy', route_distance_m: extra.distance ?? 7400, route_duration_s: extra.duration ?? 1260,
    price_coefficient: 1, cancelled_by: extra.cancelledBy ?? null, cancel_reason: extra.cancelReason ?? null,
    cancel_fee_tiyin: extra.fee ?? null, cancel_fee_status: extra.fee ? 'pending' : null,
    _driverId: drv?.id, _paxId: pax.id,
  };
  rides.push(r);
  return r;
}
const r1 = makeRide('completed', passengers[0]!, drivers[3]!, 3_450_000, 50);
const r2 = makeRide('completed', passengers[1]!, drivers[4]!, 2_900_000, 180, { payment: 'card', paymentStatus: 'paid' });
const r3 = makeRide('in_progress', passengers[0]!, drivers[3]!, 2_150_000, 12);
const r4 = makeRide('cancelled', passengers[1]!, drivers[4]!, 1_850_000, 300, { cancelledBy: 'passenger', fee: 500_000 });
makeRide('created', passengers[1]!, null, 0, 1);
for (const d of [drivers[3]!, drivers[4]!]) {
  d.recentRides = rides.filter((r) => r._driverId === d.id).map((r) => ({ id: r.id, status: r.status, priceTiyin: r.locked_price_tiyin, createdAt: r.created_at }));
}

const events = (r: Row) => [
  { type: 'status:created', actor: 'passenger', payload: { mode: 'auto' }, at: ago(70) },
  { type: 'offer_sent', actor: 'system', payload: { priceTiyin: r.locked_price_tiyin }, at: ago(69.9) },
  { type: 'status:accepted', actor: 'driver', payload: { priceTiyin: r.locked_price_tiyin }, at: ago(69.7) },
  { type: 'status:driver_en_route', actor: 'driver', payload: {}, at: ago(69.6) },
  { type: 'status:arrived', actor: 'driver', payload: {}, at: ago(64) },
  { type: 'status:in_progress', actor: 'driver', payload: {}, at: ago(63) },
  ...(r.status === 'completed' ? [{ type: 'status:completed', actor: 'driver', payload: {}, at: ago(44) }] : []),
  ...(r.status === 'cancelled' ? [{ type: 'status:cancelled', actor: r.cancelled_by, payload: { feeTiyin: r.cancel_fee_tiyin }, at: ago(62) }] : []),
];

const complaints: Row[] = [
  { id: id(), ride_id: r2.id, type: 'rating_safety:unsafe_driving,phone_while_driving', severity: 'safety', status: 'open', text: null,
    created_at: ago(170), author_id: passengers[1]!.id, author_name: passengers[1]!.name, author_phone: passengers[1]!.phone,
    about_user_id: drivers[4]!.userId, about_name: drivers[4]!.name, about_phone: drivers[4]!.phone, assigned_to: null, resolution: null,
    _rating: { score: 2, tags: ['unsafe_driving', 'phone_while_driving'], reason: null } },
  { id: id(), ride_id: r2.id, type: 'asked_extra_cash', severity: 'safety', status: 'open', text: 'Oxirida yana 10 000 soʻm naqd soʻradi, kartadan toʻlangan boʻlsa ham.',
    created_at: ago(160), author_id: passengers[1]!.id, author_name: passengers[1]!.name, author_phone: passengers[1]!.phone,
    about_user_id: drivers[4]!.userId, about_name: drivers[4]!.name, about_phone: drivers[4]!.phone, assigned_to: null, resolution: null },
  { id: id(), ride_id: r1.id, type: 'lost_item', severity: 'normal', status: 'open', text: 'Забыла зонтик на заднем сиденье, синий.',
    created_at: ago(40), author_id: passengers[0]!.id, author_name: passengers[0]!.name, author_phone: passengers[0]!.phone,
    about_user_id: drivers[3]!.userId, about_name: drivers[3]!.name, about_phone: drivers[3]!.phone, assigned_to: null, resolution: null },
];
drivers[4]!.complaints = complaints.filter((c) => c.about_user_id === drivers[4]!.userId).map((c) => ({ id: c.id, type: c.type, severity: c.severity, status: c.status, createdAt: c.created_at }));

const disputes: Row[] = [
  { id: id(), rideId: r4.id, category: 'cancellation', openedBy: 'passenger', status: 'in_review', respondBy: ahead(600), createdAt: ago(280),
    outcome: null, resolution: null,
    statements: [
      { role: 'passenger', text: 'Haydovchi boshqa podyezd oldida turdi, men 3-podyezdda kutdim. Bekor qilish uchun 5 000 soʻm yechishdi.', createdAt: ago(280) },
      { role: 'driver', text: 'Я стоял ровно по метке на карте, звонил два раза, никто не ответил. Ждал 6 минут.', createdAt: ago(250) },
    ] },
];

const ok = (body: unknown = {}): Res => ({ status: 200, body });
const err = (status: number, error: string): Res => ({ status, body: { error } });
const findDriver = (did: string) => drivers.find((d) => d.id === did);
const findUser = (uid: string) => passengers.find((p) => p.id === uid) ?? drivers.find((d) => d.userId === uid);

function dashboard() {
  const verified = drivers.filter((d) => d.status === 'verified');
  return {
    live: { driversOnline: 214 + verified.length, driversOnRide: 87, rides: { searching: 6, pickup: 23, inTrip: 64 } },
    today: { ordered: 1342, completed: 1188, cancelledByPassenger: 71, cancelledByDriver: 29, noDriverFound: 14,
      avgPriceTiyin: 2_870_000, driversEarnedTiyin: 3_409_560_000, subscriptionsSold: 58, subscriptionRevenueTiyin: 371_000_000 },
    queues: {
      driversToModerate: drivers.filter((d) => d.status === 'pending').length,
      safetyComplaints: complaints.filter((c) => c.severity === 'safety' && ['open', 'in_review'].includes(c.status)).length,
      complaints: complaints.filter((c) => c.severity === 'normal' && ['open', 'in_review'].includes(c.status)).length,
      disputesToDecide: disputes.filter((d) => d.status === 'in_review').length,
      refundsPending: 1,
    },
    coefficients: classes.map((c) => ({ code: c.code, coefficient: c.coefficient })),
  };
}

function recomputeCoefficients() {
  const active = rules.filter((r) => !r.cancelledAt && new Date(r.validFrom).getTime() <= Date.now() && (!r.validUntil || new Date(r.validUntil).getTime() > Date.now()));
  for (const r of rules) r.active = active.includes(r);
  for (const c of classes) {
    const own = active.find((r) => r.classCode === c.code);
    const city = active.find((r) => r.classCode === null);
    c.coefficient = own?.value ?? city?.value ?? 1;
  }
}

/** Demo card payments per ride, kept so a refund made in the demo shows up on the next visit. */
const demoPayments: Record<string, any[]> = {};
function ridePayments(r: Record<string, any>): any[] {
  demoPayments[r.id] ??= [{ id: id(), ride_id: r.id, type: 'ride', status: 'succeeded', amount_tiyin: r.locked_price_tiyin, provider: 'payme',
    failure_reason: null, paid_at: ago(150), created_at: ago(150), refundable_tiyin: r.locked_price_tiyin }];
  return demoPayments[r.id]!;
}

/** Demo error list: what the panel shows when the apps or the server fail. */
const demoErrors = [
  { id: '41', source: 'driver', message: 'Network request failed', stack: 'TypeError: Network request failed\n    at sendPosition (location.ts:38:5)', context: { platform: 'android', screen: 'uncaught' }, appVersion: '0.1.0', count: 17, firstSeen: ago(300), lastSeen: ago(4), resolvedAt: null as string | null },
  { id: '40', source: 'api', message: 'OSRM responded 503', stack: 'Error: OSRM responded 503\n    at OsrmRouteProvider.route (routing/index.ts:96:24)', context: { route: 'POST /quotes', status: 500 }, appVersion: null, count: 3, firstSeen: ago(90), lastSeen: ago(35), resolvedAt: null as string | null },
];

export async function mockApi(method: string, fullPath: string, body: any): Promise<Res> {
  await new Promise((r) => setTimeout(r, 120));
  const [path, qs] = fullPath.split('?');
  const q = new URLSearchParams(qs ?? '');
  const seg = path!.split('/').filter(Boolean);
  const is = (m: string, pattern: string) => {
    if (m !== method) return null;
    const p = pattern.split('/').filter(Boolean);
    if (p.length !== seg.length) return null;
    const params: string[] = [];
    for (let i = 0; i < p.length; i++) {
      if (p[i] === ':') params.push(seg[i]!);
      else if (p[i] !== seg[i]) return null;
    }
    return params;
  };
  let m: string[] | null;

  if (is('GET', '/me')) return ok(me);
  if (is('POST', '/auth/request-code')) return { status: 204, body: {} };
  if (is('POST', '/auth/verify')) return ok({ token: 'demo', user: me });
  if (is('POST', '/staff/auth/verify')) return ok({ next: 'totp', ticket: 'demo' });
  if (is('POST', '/staff/auth/totp')) return ok({ user: me });
  if (is('POST', '/staff/auth/logout')) return { status: 204, body: {} };
  if (is('GET', '/admin/dashboard')) return ok(dashboard());

  if (is('GET', '/admin/drivers')) return ok(drivers.filter((d) => d.status === (q.get('status') ?? 'pending')).map(withMissing));
  if ((m = is('GET', '/admin/drivers/:/dossier'))) {
    const d = findDriver(m[0]!); if (!d) return err(404, 'not_found');
    log('driver_dossier_viewed', 'driver', d.id); return ok(withMissing(d));
  }
  if ((m = is('POST', '/admin/drivers/:/approve'))) {
    const d = findDriver(m[0]!); if (!d) return err(404, 'not_found');
    if (withMissing(d).missingDocuments.length) return { status: 409, body: { error: 'documents_missing', missing: withMissing(d).missingDocuments } };
    d.status = 'verified'; d.vehicles[0].class_code = body.classCode; d.subscriptionUntil = ahead(60 * 24 * 30);
    d.documents.forEach((x: Row) => (x.status = 'approved'));
    log('driver_approved', 'driver', d.id, { classCode: body.classCode }); return ok(withMissing(d));
  }
  if ((m = is('POST', '/admin/drivers/:/reject'))) {
    const d = findDriver(m[0]!); if (!d) return err(404, 'not_found');
    d.status = 'rejected'; log('driver_rejected', 'driver', d.id, { reason: body.reason }); return ok(withMissing(d));
  }
  if ((m = is('POST', '/admin/drivers/:/documents/:/reject'))) {
    const d = findDriver(m[0]!); if (!d) return err(404, 'not_found');
    d.documents = d.documents.filter((x: Row) => x.id !== m![1]); log('document_rejected', 'document', m[1]!, { note: body.note });
    return ok(withMissing(d));
  }
  if ((m = is('POST', '/admin/drivers/:/vehicles/:/class'))) {
    const d = findDriver(m[0]!); if (!d) return err(404, 'not_found');
    d.vehicles[0].class_code = body.classCode; log('vehicle_class_changed', 'vehicle', m[1]!, body); return ok(withMissing(d));
  }
  if (is('GET', '/admin/search')) {
    const term = (q.get('q') ?? '').toLowerCase().replace(/\s+/g, '');
    const all = [
      ...drivers.map((d) => ({ userId: d.userId, name: d.name, phone: d.phone, roles: d.roles, driverId: d.id, driverStatus: d.status, plates: d.vehicles[0].plate })),
      ...passengers.map((p) => ({ userId: p.id, name: p.name, phone: p.phone, roles: p.roles, driverId: null, driverStatus: null, plates: null })),
    ];
    return ok(all.filter((x) => x.name.toLowerCase().replace(/\s+/g, '').includes(term) || x.phone.includes(term.replace(/^\+?998/, '')) || (x.plates ?? '').toLowerCase().includes(term)));
  }
  if ((m = is('GET', '/admin/users/:'))) {
    const p = passengers.find((x) => x.id === m![0]);
    if (!p) return err(404, 'not_found');
    log('user_profile_viewed', 'user', p.id); return ok(p);
  }
  if ((m = is('POST', '/admin/users/:/block'))) {
    const u = findUser(m[0]!); if (!u) return err(404, 'not_found');
    u.blocks = [{ id: id(), reason: body.reason, until: body.days ? ahead(body.days * 1440) : null, appealStatus: 'none', createdAt: new Date().toISOString() }, ...(u.blocks ?? [])];
    if (u.status) u.status = 'blocked';
    log('user_blocked', 'user', m[0]!, body); return { status: 204, body: {} };
  }
  if ((m = is('POST', '/admin/users/:/unblock'))) {
    const u = findUser(m[0]!); if (!u) return err(404, 'not_found');
    const active = (u.blocks ?? []).filter((b: Row) => b.appealStatus !== 'lifted');
    if (!active.length) return err(409, 'not_blocked');
    active.forEach((b: Row) => (b.appealStatus = 'lifted'));
    if (u.status === 'blocked') u.status = 'verified';
    log('user_unblocked', 'user', m[0]!, body); return { status: 204, body: {} };
  }
  if ((m = is('PUT', '/admin/users/:/roles'))) {
    const u = findUser(m[0]!); if (!u) return err(404, 'not_found');
    u.roles = body.roles.includes('passenger') ? body.roles : ['passenger', ...body.roles];
    log('roles_changed', 'user', m[0]!, { roles: u.roles }); return ok({ id: m[0], roles: u.roles });
  }

  if (is('GET', '/admin/complaints')) {
    const status = q.get('status') ?? 'open';
    return ok(complaints.filter((c) => c.status === status).sort((a, b) => Number(b.severity === 'safety') - Number(a.severity === 'safety'))
      .map((c) => ({ id: c.id, rideId: c.ride_id, type: c.type, severity: c.severity, status: c.status, createdAt: c.created_at,
        assignedTo: c.assigned_to, authorName: c.author_name, aboutName: c.about_name,
        aboutTotal: complaints.filter((x) => x.about_user_id === c.about_user_id).length })));
  }
  if ((m = is('GET', '/admin/complaints/:'))) {
    const c = complaints.find((x) => x.id === m![0]); if (!c) return err(404, 'not_found');
    log('complaint_viewed', 'complaint', c.id);
    const ride = rides.find((r) => r.id === c.ride_id)!;
    return ok({ complaint: c, rating: c._rating ?? null, rideEvents: events(ride),
      previousAboutSamePerson: complaints.filter((x) => x.about_user_id === c.about_user_id && x.id !== c.id)
        .map((x) => ({ id: x.id, type: x.type, severity: x.severity, status: x.status, createdAt: x.created_at })) });
  }
  if ((m = is('POST', '/admin/complaints/:/assign'))) {
    const c = complaints.find((x) => x.id === m![0]); if (!c) return err(404, 'not_found');
    c.status = 'in_review'; c.assigned_to = me.id; log('complaint_assigned', 'complaint', c.id); return ok({ status: 'in_review' });
  }
  if ((m = is('POST', '/admin/complaints/:/resolve'))) {
    const c = complaints.find((x) => x.id === m![0]); if (!c) return err(404, 'not_found');
    if (['resolved', 'rejected'].includes(c.status)) return err(409, 'already_closed');
    c.status = body.status; c.resolution = body.resolution;
    if (body.action === 'block') { const u = findUser(c.about_user_id); if (u) { u.status = 'blocked'; u.blocks = [{ id: id(), reason: body.resolution, until: body.blockDays ? ahead(body.blockDays * 1440) : null, appealStatus: 'none', createdAt: new Date().toISOString() }, ...(u.blocks ?? [])]; } }
    log('complaint_resolved', 'complaint', c.id, { status: body.status, action: body.action ?? 'none' }); return ok({ status: body.status });
  }

  if (is('GET', '/admin/disputes')) {
    return ok(disputes.filter((d) => d.status === (q.get('status') ?? 'in_review'))
      .map((d) => ({ id: d.id, rideId: d.rideId, category: d.category, openedBy: d.openedBy, status: d.status, respondBy: d.respondBy, createdAt: d.createdAt, statements: d.statements.length })));
  }
  if ((m = is('GET', '/admin/disputes/:'))) {
    const d = disputes.find((x) => x.id === m![0]); if (!d) return err(404, 'not_found');
    const r = rides.find((x) => x.id === d.rideId)!;
    log('dispute_viewed', 'dispute', d.id);
    return ok({ dispute: d, statements: d.statements,
      ride: { id: r.id, status: r.status, priceTiyin: r.locked_price_tiyin, distanceM: r.route_distance_m, cancelledBy: r.cancelled_by,
        cancelReason: r.cancel_reason, createdAt: r.created_at, passengerName: r.passenger_name, passengerPhone: r.passenger_phone,
        driverName: r.driver_name, driverPhone: r.driver_phone, plate: r.plate, cancelFeeTiyin: r.cancel_fee_tiyin },
      events: events(r), priceChanges: [] });
  }
  if ((m = is('POST', '/admin/disputes/:/resolve'))) {
    const d = disputes.find((x) => x.id === m![0]); if (!d) return err(404, 'not_found');
    if (d.status === 'resolved') return err(409, 'already_resolved');
    d.status = 'resolved'; d.outcome = body.outcome; d.resolution = body.resolution;
    if (body.waiveCancelFee) { const r = rides.find((x) => x.id === d.rideId); if (r) r.cancel_fee_status = 'waived'; }
    log('dispute_resolved', 'dispute', d.id, { outcome: body.outcome, feeWaived: !!body.waiveCancelFee }); return ok({ status: 'resolved' });
  }

  if (is('GET', '/admin/rides')) {
    const ph = (q.get('phone') ?? '').replace(/\D/g, '');
    const st = q.get('status');
    return ok(rides.filter((r) => (!st || r.status === st) && (!ph || r.passenger_phone.includes(ph.slice(-9)) || (r.driver_phone ?? '').includes(ph.slice(-9))))
      .map((r) => ({ id: r.id, status: r.status, priceTiyin: r.locked_price_tiyin || null, paymentMethod: r.payment_method, createdAt: r.created_at,
        passengerName: r.passenger_name, driverName: r.driver_name, plate: r.plate })));
  }
  if ((m = is('POST', '/admin/payments/:/refund'))) {
    const p = Object.values(demoPayments).flat().find((x) => x.id === m![0]);
    if (!p) return err(404, 'not_found');
    if (!(body.amountTiyin >= 100 && body.amountTiyin <= p.refundable_tiyin)) return err(409, 'refund_exceeds_payment');
    p.refundable_tiyin -= body.amountTiyin;
    const list = demoPayments[p.ride_id]!;
    list.push({ id: id(), ride_id: p.ride_id, type: 'refund', status: 'succeeded', amount_tiyin: body.amountTiyin, provider: p.provider,
      failure_reason: null, paid_at: ago(0), created_at: ago(0), refund_of: p.id, refund_kind: 'moderator', refund_reason: body.reason,
      approved_by_name: me.name, refundable_tiyin: null });
    log('refund_sent', 'payment', p.id, body);
    return ok({ refundId: list.at(-1)!.id, status: 'succeeded' });
  }

  if ((m = is('GET', '/admin/rides/:'))) {
    const r = rides.find((x) => x.id === m![0]); if (!r) return err(404, 'not_found');
    log('ride_viewed', 'ride', r.id);
    return ok({ ride: r, stops: [
      { position: 0, lat: 41.2995, lng: 69.2401, address: 'Amir Temur shoh koʻchasi, 107' },
      { position: 1, lat: 41.3381, lng: 69.3346, address: 'Mega Planet, Yunusobod' },
    ], events: events(r), priceChanges: [], payments: r.payment_method === 'card' ? ridePayments(r) : [],
    ratings: r.status === 'completed' ? [{ score: 5, tags: ['careful_driving', 'clean_car'], reason: null }] : [],
    complaints: complaints.filter((c) => c.ride_id === r.id).map((c) => ({ id: c.id, type: c.type, severity: c.severity, status: c.status })),
    dispute: null });
  }

  if (is('GET', '/admin/pricing')) { recomputeCoefficients(); return ok({ classes, coefficientRules: rules, plans }); }
  if (is('POST', '/admin/pricing/coefficients')) {
    if (!(body.value >= 0.7 && body.value <= 1.5)) return err(400, 'out_of_range');
    if (!body.reason || body.reason.trim().length < 3) return err(400, 'reason_required');
    const rule = { id: id(), classCode: body.classCode ?? null, value: Math.round(body.value * 100) / 100, reason: body.reason,
      validFrom: body.validFrom ?? new Date().toISOString(), validUntil: body.validUntil ?? null, setBy: me.name, createdAt: new Date().toISOString(), cancelledAt: null, active: true };
    rules.unshift(rule); recomputeCoefficients(); log('price_coefficient_set', 'price_coefficient', rule.id, body);
    return { status: 201, body: { id: rule.id } };
  }
  if ((m = is('POST', '/admin/pricing/coefficients/:/end'))) {
    const r = rules.find((x) => x.id === m![0]); if (!r || r.cancelledAt) return err(409, 'not_active');
    r.cancelledAt = new Date().toISOString(); recomputeCoefficients(); log('price_coefficient_ended', 'price_coefficient', r.id);
    return ok({ status: 'ended' });
  }
  if ((m = is('PUT', '/admin/pricing/classes/:'))) {
    const c = classes.find((x) => x.code === m![0]); if (!c) return err(404, 'not_found');
    const { reason, ...changes } = body; Object.assign(c, changes); log('class_pricing_changed', 'vehicle_class', c.code, { reason, changes });
    return ok({ status: 'updated' });
  }
  if ((m = is('PUT', '/admin/pricing/plans/:'))) {
    const p = plans.find((x) => x.code === m![0]); if (!p) return err(404, 'not_found');
    const { reason, ...changes } = body; Object.assign(p, changes); log('plan_changed', 'subscription_plan', p.code, { reason, changes });
    return ok({ status: 'updated' });
  }
  if (is('GET', '/admin/finance')) {
    return ok({ days: Number(q.get('days') ?? 30), payments: [
      { type: 'subscription', status: 'succeeded', count: 1640, amountTiyin: 10_960_000_000 },
      { type: 'subscription', status: 'failed', count: 73, amountTiyin: 401_500_000 },
      { type: 'ride', status: 'succeeded', count: 9412, amountTiyin: 27_118_000_000 },
      { type: 'ride', status: 'failed', count: 211, amountTiyin: 590_800_000 },
      { type: 'cancel_fee', status: 'succeeded', count: 302, amountTiyin: 181_000_000 },
      { type: 'refund', status: 'pending', count: 1, amountTiyin: 450_000 },
    ], debts: { unpaidRidesTiyin: 41_300_000, unpaidCancelFeesTiyin: 9_500_000 },
    refundsPending: [{ id: id(), rideId: r2.id, amountTiyin: 450_000, createdAt: ago(170) }] });
  }
  if (is('GET', '/admin/audit')) return ok(audit.slice(0, 100));
  if (is('GET', '/admin/errors')) {
    return ok(q.get('status') === 'resolved' ? [] : demoErrors.filter((e) => !e.resolvedAt));
  }
  if ((m = is('POST', '/admin/errors/:/resolve'))) {
    const e = demoErrors.find((x) => x.id === m![0]); if (!e) return err(404, 'not_found');
    e.resolvedAt = new Date().toISOString(); log('error_resolved', 'error_event', e.id); return { status: 204, body: {} };
  }
  return err(404, 'not_found');
}

function withMissing(d: Row) {
  const present = new Set(d.documents.map((x: Row) => x.type));
  return { ...d, missingDocuments: DOC_TYPES.filter((t) => !present.has(t)) };
}
