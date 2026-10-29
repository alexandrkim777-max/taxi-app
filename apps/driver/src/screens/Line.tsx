// The working screens: the line (online switch, today's money), an incoming order, the ride,
// rating the passenger afterwards.

import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import { api } from '../api';
import { useApp } from '../context';
import { date, km, mmss, money } from '../format';
import { useLine, type Request, type Ride, type Stop } from '../line';
import { radius, space, useTheme } from '../theme';
import { Button, Card, ErrorNote, Field, Pill, Row, Screen, T } from '../components/ui';

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(id); }, [intervalMs]);
  return now;
}

interface Stats {
  today: { rides: number; earnedTiyin: number; keptVsCommissionTiyin: number };
  week: { rides: number; earnedTiyin: number; keptVsCommissionTiyin: number };
  subscriptionUntil: string | null;
}

export function HomeScreen({ onSubscription }: { onSubscription: () => void }) {
  const { t, lang, driver } = useApp();
  const { c } = useTheme();
  const line = useLine();
  const [stats, setStats] = useState<Stats | null>(null);
  const [period, setPeriod] = useState<'today' | 'week'>('today');
  useEffect(() => { api<Stats>('/drivers/me/stats').then(setStats).catch(() => {}); }, [line.finished, line.online]);
  const now = useNow(60_000);
  const daysLeft = stats?.subscriptionUntil ? Math.max(0, Math.ceil((new Date(stats.subscriptionUntil).getTime() - now) / 86_400_000)) : 0;
  const p = stats?.[period];
  const name = driver?.name?.split(' ')[0] ?? '';

  return (
    <View style={{ flex: 1 }}>
      <Screen footer={line.online
        ? <Button kind="secondary" title={t.goOffline} busy={line.busy} onPress={line.goOffline} />
        : <Button title={t.goOnline} busy={line.busy} onPress={line.goOnline} />}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="title">{lang === 'uz' ? `Salom, ${name}` : lang === 'ru' ? `Салом, ${name}` : `Hi, ${name}`}</T>
          <Pill tone={line.online ? 'brand' : 'neutral'}>{line.online ? `● ${t.online}` : t.offline}</Pill>
        </Row>

        <Card tone="brand" style={{ gap: space.s1 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="label" color={c.onBrand}>{t.kept}</T>
            <Pressable onPress={() => setPeriod(period === 'today' ? 'week' : 'today')} hitSlop={12}>
              <T v="label" color={c.onBrand}>{period === 'today' ? t.today : t.week} ⇄</T>
            </Pressable>
          </Row>
          <T v="display" color={c.onBrand}>{money(p?.keptVsCommissionTiyin ?? 0, lang)}</T>
          <T v="caption" color={c.onBrand}>{t.vsCommission}</T>
        </Card>

        <Row gap={space.s2} style={{ flexWrap: 'nowrap' }}>
          <Card style={{ flex: 1 }}><T v="caption" muted>{t.earned}</T><T v="price">{money(p?.earnedTiyin ?? 0, lang)}</T></Card>
          <Card style={{ flex: 1 }}><T v="caption" muted>{period === 'today' ? t.today : t.week}</T><T v="price">{p?.rides ?? 0} {t.rides}</T></Card>
        </Row>

        <Pressable onPress={onSubscription}>
          <Card tone={daysLeft <= 2 ? 'warm' : 'sunken'}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="bodyStrong" color={daysLeft <= 2 ? c.warmInk : undefined}>{t.subscriptionUntil}: {date(stats?.subscriptionUntil)}</T>
              <T v="caption" color={daysLeft <= 2 ? c.warmInk : c.inkMuted}>{daysLeft} {t.daysLeft} →</T>
            </Row>
          </Card>
        </Pressable>

        {line.online && !line.request && <T muted center>{t.waitingOrders}</T>}
        <ErrorNote text={line.notice} />
      </Screen>
      {line.request && <RequestSheet r={line.request} />}
    </View>
  );
}

function RequestSheet({ r }: { r: Request }) {
  const { t, lang } = useApp();
  const { c } = useTheme();
  const line = useLine();
  const now = useNow(250);
  const left = Math.max(0, (new Date(r.expiresAt).getTime() - now) / 1000);
  const total = 15;
  return (
    <View style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' } as never}>
      <View style={{ backgroundColor: c.surfaceCard, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.s5, gap: space.s3 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="heading">{t.newOrder}</T>
          <T v="bodyStrong" color={left < 5 ? c.danger : c.inkMuted}>{Math.ceil(left)} {t.seconds}</T>
        </Row>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}>
          <View style={{ width: `${Math.min(100, (left / total) * 100)}%`, height: 6, backgroundColor: left < 5 ? c.danger : c.brand }} />
        </View>
        <T v="display">{money(r.priceTiyin, lang)}</T>
        <Row>
          {r.pickupDistanceM !== null && <Pill tone="brand">{km(r.pickupDistanceM)} {t.km} {t.toPickup}</Pill>}
          <Pill>{km(r.distanceM)} {t.km} · {Math.round(r.durationS / 60)} {t.min} {t.trip}</Pill>
          {r.passengerRating !== null && <Pill tone="ok">★ {r.passengerRating.toFixed(2)}</Pill>}
          {Object.entries(r.options ?? {}).filter(([, v]) => v).map(([k]) => <Pill key={k} tone="warm">{k}</Pill>)}
        </Row>
        <Stops stops={r.stops} />
        {r.comment && <T muted>“{r.comment}”</T>}
        <Button title={t.accept} busy={line.busy} onPress={line.accept} />
        <Button kind="ghost" compact title={t.decline} onPress={line.decline} />
      </View>
    </View>
  );
}

function Stops({ stops }: { stops: Stop[] }) {
  const { t } = useApp();
  const { c } = useTheme();
  return (
    <View style={{ gap: space.s2 }}>
      {stops.map((s, i) => {
        const last = i === stops.length - 1;
        return (
          <Row key={s.position} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <View style={{ width: 14, height: 14, marginTop: 4, borderRadius: 7, backgroundColor: i === 0 ? c.brand : last ? c.warm : c.inkMuted }} />
            <View style={{ flex: 1 }}>
              <T v="caption" muted>{i === 0 ? t.pickup : last ? t.dropoff : t.stop}</T>
              <T v="bodyStrong">{s.address ?? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`}</T>
            </View>
          </Row>
        );
      })}
    </View>
  );
}

async function openNavigator(app: 'yandex' | '2gis' | 'google', s: Stop) {
  const urls = {
    yandex: `yandexnavi://build_route_on_map?lat_to=${s.lat}&lon_to=${s.lng}`,
    '2gis': `dgis://2gis.ru/routeSearch/rsType/car/to/${s.lng},${s.lat}`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`,
  };
  const url = urls[app];
  if (app !== 'google' && Platform.OS !== 'web' && !(await Linking.canOpenURL(url).catch(() => false))) {
    await Linking.openURL(urls.google);
    return;
  }
  await Linking.openURL(url).catch(() => {});
}

const NEXT: Record<string, { status: string; label: 'goToClient' | 'iArrived' | 'startTrip' | 'finishTrip' }> = {
  accepted: { status: 'driver_en_route', label: 'goToClient' },
  driver_en_route: { status: 'arrived', label: 'iArrived' },
  arrived: { status: 'in_progress', label: 'startTrip' },
  in_progress: { status: 'completed', label: 'finishTrip' },
};

export function RideScreen({ ride }: { ride: Ride }) {
  const { t, lang } = useApp();
  const { c } = useTheme();
  const line = useLine();
  const now = useNow(1000);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [terms, setTerms] = useState<{ allowed: boolean; noShowFrom?: string } | null>(null);
  const next = NEXT[ride.status];
  const target = ride.status === 'in_progress' ? ride.stops[ride.stops.length - 1]! : ride.stops[0]!;

  useEffect(() => {
    if (cancelOpen && ride.status === 'arrived') {
      api<{ allowed: boolean; noShowFrom?: string }>(`/rides/${ride.id}/cancel-terms?noShow=true`).then(setTerms).catch(() => {});
    }
  }, [cancelOpen, ride.status, ride.id]);

  const w = ride.waiting;
  const freeLeft = w ? (new Date(w.freeUntil).getTime() - now) / 1000 : 0;
  const cash = ride.payment?.method === 'cash';

  return (
    <Screen footer={<>
      {next && <Button title={t[next.label]} busy={line.busy} onPress={() => line.setStatus(next.status)} />}
      {ride.status !== 'in_progress' && <Button kind="ghost" compact title={t.cancelRide} onPress={() => setCancelOpen(!cancelOpen)} />}
    </>}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="title">{ride.passenger?.name ?? '—'}</T>
        {ride.passenger?.rating ? <Pill tone="ok">★ {ride.passenger.rating.toFixed(2)}</Pill> : null}
      </Row>
      <T v="display">{money(ride.priceTiyin, lang)}</T>
      <Card tone={cash ? 'warm' : 'sunken'}>
        <T v="bodyStrong" color={cash ? c.warmInk : undefined}>{cash ? `${t.collectCash}: ${money(ride.cashToCollectTiyin ?? ride.priceTiyin, lang)}` : t.paidByCard}</T>
      </Card>

      {w && (
        <Card>
          <T v="caption" muted>{t.waiting}</T>
          {freeLeft > 0
            ? <T v="price">{mmss(freeLeft)} · {t.freeWait}</T>
            : <T v="price" color={c.warmInk}>{w.paidMinutes} {t.min} · {t.paidWait} · +{money(w.accruedTiyin, lang)}</T>}
        </Card>
      )}
      {ride.trip && (
        <Card>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}>
            <View style={{ width: `${ride.trip.progressPct}%`, height: 8, backgroundColor: c.brand }} />
          </View>
          <T v="caption" muted>{km(ride.trip.drivenM)} / {km(ride.route.distanceM)} {t.km}</T>
        </Card>
      )}

      <Card><Stops stops={ride.stops} />{ride.comment ? <T muted>“{ride.comment}”</T> : null}</Card>
      <Row>
        <View style={{ flex: 1, minWidth: 100 }}><Button compact kind="secondary" title="Yandex" onPress={() => openNavigator('yandex', target)} /></View>
        <View style={{ flex: 1, minWidth: 100 }}><Button compact kind="secondary" title="2GIS" onPress={() => openNavigator('2gis', target)} /></View>
        <View style={{ flex: 1, minWidth: 100 }}><Button compact kind="secondary" title="Google" onPress={() => openNavigator('google', target)} /></View>
      </Row>

      {cancelOpen && (
        <Card>
          {ride.status === 'arrived' && (
            terms?.allowed
              ? <Button kind="danger" compact title={t.noShow} onPress={() => line.cancel({ noShow: true })} />
              : <T muted>{t.noShow}: {t.noShowFrom} {terms?.noShowFrom ? new Date(terms.noShowFrom).toLocaleTimeString().slice(0, 5) : '…'}</T>
          )}
          <Field label={t.cancelReason} value={reason} onChangeText={setReason} maxLength={300} />
          <Button kind="secondary" compact title={t.cancelRide} disabled={reason.trim().length < 3} onPress={() => line.cancel({ reason: reason.trim() })} />
        </Card>
      )}
      <ErrorNote text={line.notice} />
    </Screen>
  );
}

export function RateScreen({ ride }: { ride: Ride }) {
  const { t, lang } = useApp();
  const { c } = useTheme();
  const line = useLine();
  const [score, setScore] = useState(5);
  const [tags, setTags] = useState<string[]>([]);
  const [lists, setLists] = useState<{ positive: { code: string; label: string }[]; negative: { code: string; label: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<typeof lists>('/rating-tags?about=passenger').then(setLists).catch(() => {}); }, []);
  const options = score >= 4 ? lists?.positive ?? [] : lists?.negative ?? [];
  const cash = ride.payment?.method === 'cash';

  return (
    <Screen footer={<>
      <Button title={t.send} busy={busy} disabled={score < 4 && tags.length === 0} onPress={async () => {
        setBusy(true);
        try { await api(`/rides/${ride.id}/rating`, { body: { score, tags } }); } catch { /* rating is optional */ }
        setBusy(false); line.doneRating();
      }} />
      <Button kind="ghost" compact title={t.skip} onPress={line.doneRating} />
    </>}>
      <T v="title">{t.rateTitle}</T>
      <Card tone={cash ? 'warm' : 'sunken'}>
        <T v="price" color={cash ? c.warmInk : undefined}>{money(ride.priceTiyin, lang)}</T>
        <T color={cash ? c.warmInk : c.inkMuted}>{cash ? t.collectCash : t.paidByCard}</T>
      </Card>
      <Row gap={space.s3} style={{ justifyContent: 'center' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} accessibilityRole="button" accessibilityLabel={`${n}`} hitSlop={6} onPress={() => { setScore(n); setTags([]); }}>
            <T v="display" color={n <= score ? c.brand : c.border}>★</T>
          </Pressable>
        ))}
      </Row>
      <Row>
        {options.map((o) => {
          const on = tags.includes(o.code);
          return (
            <Pressable key={o.code} onPress={() => setTags(on ? tags.filter((x) => x !== o.code) : [...tags, o.code].slice(0, 5))}
              style={{ minHeight: 40, paddingHorizontal: space.s4, borderRadius: radius.pill, justifyContent: 'center', borderWidth: 1,
                borderColor: on ? c.brand : c.border, backgroundColor: on ? c.surfaceSunken : c.surfaceCard }}>
              <T v="bodyStrong" color={on ? c.link : c.ink}>{o.label}</T>
            </Pressable>
          );
        })}
      </Row>
    </Screen>
  );
}
