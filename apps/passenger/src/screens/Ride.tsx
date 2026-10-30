// The active ride, from "looking for a driver" to the end of the trip. Everything shown here is the
// server's view (polled every 2.5 s); money changes only through explicit passenger confirmations.

import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { RATING_TAGS } from '../../../../packages/shared/src/ratingTags.ts';
import { api, ApiError } from '../api';
import { useApp } from '../context';
import { mmss, money, plate } from '../format';
import { distanceM } from '../location';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Map } from '../map/Map';
import { MapButton } from './Menu';
import type { MapPin } from '../map/types';
import { useRide } from '../ride';
import { space, useTheme } from '../theme';
import type { CancelTerms, Ride, Stop } from '../types';
import { Button, Card, Chip, Divider, ErrorNote, Pill, Plate, Progress, Row, Sheet, T } from '../components/ui';

function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Stops as the API expects them back (keeps the pickup entrance across a route change). */
function stopsOf(ride: Ride): Stop[] {
  return ride.stops.map((s, i) => ({
    lat: s.lat, lng: s.lng, address: s.address ?? '',
    ...(i === 0 && s.entrance && /^[0-9A-Za-zА-Яа-я]{1,8}$/.test(s.entrance) ? { entranceLabel: s.entrance } : {}),
  }));
}

export function RideScreen({ ride, onMenu }: { ride: Ride; onMenu?: () => void }) {
  const { t, lang, push, err } = useApp();
  const { setRide } = useRide();
  const { c } = useTheme();
  const now = useNow();
  const [sheetH, setSheetH] = useState(360);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terms, setTerms] = useState<CancelTerms | null>(null);
  const [change, setChange] = useState<{ stops: Stop[]; oldPriceTiyin: number; newPriceTiyin: number } | null>(null);
  const [safety, setSafety] = useState<'closed' | 'open' | 'sent'>('closed');

  const pickup = ride.stops[0]!;
  const car = ride.driver?.location ?? null;

  async function act(key: string, fn: () => Promise<Ride | null | void>) {
    setBusy(key); setError(null);
    try { const r = await fn(); if (r) setRide(r); } catch (e) { setError(err(e)); } finally { setBusy(null); }
  }

  async function askCancel() {
    await act('terms', async () => { setTerms(await api<CancelTerms>(`/rides/${ride.id}/cancel-terms`)); });
  }
  async function cancel(feeTiyin: number) {
    setBusy('cancel'); setError(null);
    try {
      await api(`/rides/${ride.id}/cancel`, { body: feeTiyin > 0 ? { acceptFeeTiyin: feeTiyin } : {}, retry: true });
      setRide(null);
    } catch (e) {
      // Waiting kept ticking: show the new amount and ask again.
      if (e instanceof ApiError && e.code === 'fee_confirmation_required') setTerms({ allowed: true, feeTiyin: Number(e.body.feeTiyin), breakdown: e.body.breakdown as CancelTerms['breakdown'] });
      else setError(err(e));
    } finally { setBusy(null); }
  }

  async function previewRoute(stops: Stop[]) {
    await act('route', async () => {
      const p = await api<{ oldPriceTiyin: number; newPriceTiyin: number }>(`/rides/${ride.id}/route/preview`, { body: { stops } });
      setChange({ stops, ...p });
    });
  }
  const addStop = () => push({
    name: 'search', purpose: 'stop',
    onPick: (s) => { const cur = stopsOf(ride); previewRoute([...cur.slice(0, -1), s, cur[cur.length - 1]!]); },
  });
  const changeDestination = () => push({
    name: 'search', purpose: 'dropoff',
    onPick: (s) => { const cur = stopsOf(ride); previewRoute([...cur.slice(0, -1), s]); },
  });

  const pins: MapPin[] = [
    { id: 'pickup', kind: 'pickup', lat: pickup.lat, lng: pickup.lng, label: pickup.entrance ? `${t.entrance} ${pickup.entrance}` : undefined },
    ...ride.stops.slice(1).map((s, i, a): MapPin => ({ id: `s${i}`, kind: i === a.length - 1 ? 'dropoff' : 'stop', lat: s.lat, lng: s.lng })),
    ...(car ? [{ id: 'car', kind: 'car', lat: car.lat, lng: car.lng, heading: car.heading } as MapPin] : []),
  ];
  const enRoute = ride.status === 'accepted' || ride.status === 'driver_en_route';
  const line = enRoute && car ? [car, pickup] : ride.stops;
  const etaMin = enRoute && car ? Math.max(1, Math.round(distanceM(car, pickup) / 1000 / 25 * 60) + 1) : null;

  let body: ReactNode;
  if (ride.status === 'created' && ride.mode === 'auto') {
    const d = ride.dispatch;
    if (d?.state === 'needs_confirmation') {
      body = (
        <Card tone="warm">
          <T v="heading" color={c.warmInk}>{t.priceUpTitle}</T>
          <T color={c.warmInk}>{t.priceUpHint}</T>
          <T v="display" color={c.warmInk}>{money(d.priceTiyin, lang)}</T>
          <Button title={t.agree} busy={busy === 'confirm'} onPress={() => act('confirm', () => api<Ride>(`/rides/${ride.id}/confirm-price`, { body: { priceTiyin: d.priceTiyin } }))} />
        </Card>
      );
    } else {
      const left = ride.searchDeadline ? (new Date(ride.searchDeadline).getTime() - now) / 1000 : null;
      body = (
        <View style={{ gap: space.s2 }}>
          <Row gap={space.s3}><ActivityIndicator color={c.brand} /><T v="title">{d?.state === 'waiting_driver' ? t.waitingDriver : t.searching}</T></Row>
          {ride.priority && <Pill tone="neutral">{ride.priority === 'cheap' ? t.cheaper : t.faster}</Pill>}
          <T muted>{t.searchingHint} {money(ride.maxPriceTiyin ?? null, lang)}{left !== null && left > 0 ? ` · ${mmss(left)}` : ''}</T>
        </View>
      );
    }
  } else if (ride.status === 'created') {
    // Rides ordered from a list (an API-only mode): just wait for the driver.
    body = <Row gap={space.s3}><ActivityIndicator color={c.brand} /><T v="title">{t.waitingDriver}</T></Row>;
  } else {
    const w = ride.waiting;
    const freeLeft = w?.freeUntil ? (new Date(w.freeUntil).getTime() - now) / 1000 : 0;
    body = (
      <View style={{ gap: space.s3 }}>
        <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
          <T v="title" style={{ flex: 1 }}>{ride.status === 'arrived' ? t.driverArrived : ride.status === 'in_progress' ? t.inTrip : t.driverOnWay}</T>
          {etaMin !== null && <Pill tone="brand">{t.arriving} {etaMin} {t.min}</Pill>}
        </Row>
        {ride.driver && <DriverCard ride={ride} />}
        {ride.status === 'arrived' && w && (
          <Card tone={freeLeft > 0 ? 'sunken' : 'warm'}>
            {freeLeft > 0
              ? <Row style={{ justifyContent: 'space-between' }}><T v="bodyStrong">{t.freeWaitUntil}</T><T v="price">{mmss(freeLeft)}</T></Row>
              : <Row style={{ justifyContent: 'space-between' }}><T v="bodyStrong" color={c.warmInk}>{t.paidWaitNow} · {w.paidMinutes} {t.perMin}</T><T v="price" color={c.warmInk}>+{money(w.accruedTiyin ?? 0, lang)}</T></Row>}
            <T v="caption" muted>{t.waitRule} {money(w.ratePerMinTiyin ?? 0, lang)}</T>
          </Card>
        )}
        {ride.status === 'in_progress' && ride.trip && <Progress pct={ride.trip.progressPct} />}
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="display">{money(ride.priceTiyin, lang)}</T>
          <View style={{ alignItems: 'flex-end' }}>
            <T v="bodyStrong">{ride.payment.method === 'cash' ? t.cash : t.card}</T>
            {ride.payment.paidTiyin > 0 && <T v="caption" muted>{t.paidSoFar} {money(ride.payment.paidTiyin, lang)}</T>}
          </View>
        </Row>
        {ride.waiting?.chargedTiyin ? <T v="caption" muted>{t.waiting}: +{money(ride.waiting.chargedTiyin, lang)}</T> : null}
      </View>
    );
  }

  const canChangeRoute = ['accepted', 'driver_en_route', 'arrived', 'in_progress'].includes(ride.status);
  const canCancel = ride.status !== 'in_progress';

  return (
    <View style={{ flex: 1 }}>
      <Map pins={pins} line={line} bottomInset={sheetH} />
      {onMenu && (
        <SafeAreaView edges={['top']} style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="box-none">
          <View style={{ padding: space.s4 }}><MapButton icon="menu" label="Menu" onPress={onMenu} /></View>
        </SafeAreaView>
      )}
      <Sheet onLayoutHeight={setSheetH}>
        {ride.payment.actionRequired && (
          <Card tone="warm">
            <T v="heading" color={c.warmInk}>{t.cardDeclined}</T>
            <T color={c.warmInk}>{t.cardDeclinedHint}</T>
            <Button title={t.payCash} busy={busy === 'cash'} onPress={() => act('cash', () => api<Ride>(`/rides/${ride.id}/payment`, { body: { method: 'cash' } }))} />
            <Button kind="secondary" title={t.otherCard} onPress={() => push({ name: 'cards', onPick: (card) => act('card', () => api<Ride>(`/rides/${ride.id}/payment`, { body: { method: 'card', cardId: card.id } })) })} />
          </Card>
        )}
        {body}
        {change && (
          <Card>
            <T v="heading">{t.changeRoute}</T>
            <Row style={{ justifyContent: 'space-between' }}>
              <T muted>{t.oldPrice} {money(change.oldPriceTiyin, lang)}</T>
              <T v="price">{t.newPrice} {money(change.newPriceTiyin, lang)}</T>
            </Row>
            <T v="caption" muted>{t.priceOnlyYou}</T>
            <Button title={t.confirmPrice} busy={busy === 'routeConfirm'}
              onPress={() => act('routeConfirm', async () => { const r = await api<Ride>(`/rides/${ride.id}/route`, { body: { stops: change.stops, priceTiyin: change.newPriceTiyin } }); setChange(null); return r; })} />
            <Button kind="ghost" compact title={t.keepRide} onPress={() => setChange(null)} />
          </Card>
        )}
        {terms && (
          <Card tone={terms.feeTiyin > 0 ? 'warm' : 'sunken'}>
            <T v="heading" color={terms.feeTiyin > 0 ? c.warmInk : c.ink}>{terms.feeTiyin > 0 ? `${t.cancelFeeTitle}: ${money(terms.feeTiyin, lang)}` : t.cancelFree}</T>
            {terms.breakdown && (
              <T color={c.warmInk}>
                {t.cancelPart} {money(terms.breakdown.cancelTiyin, lang)}{terms.breakdown.waitingTiyin > 0 ? ` + ${t.waitPart} ${money(terms.breakdown.waitingTiyin, lang)}` : ''}
              </T>
            )}
            <Button kind="danger" title={terms.feeTiyin > 0 ? t.cancelAnyway : t.cancelRide} busy={busy === 'cancel'} onPress={() => cancel(terms.feeTiyin)} />
            <Button kind="secondary" title={t.keepRide} onPress={() => setTerms(null)} />
          </Card>
        )}
        {safety !== 'closed' && (
          <Card tone="warm">
            <T v="heading" color={c.warmInk}>{t.safetyTitle}</T>
            <T color={c.warmInk}>{safety === 'sent' ? t.complaintSent : t.safetyHint}</T>
            {safety === 'open' && (
              <Button kind="danger" title={t.reportUnsafe} busy={busy === 'unsafe'}
                onPress={() => act('unsafe', async () => {
                  await api(`/rides/${ride.id}/complaint`, { body: { type: 'unsafe_driving', text: 'Reported from the app during the ride.' } })
                    .catch((e) => { if (!(e instanceof ApiError && e.code === 'already_filed')) throw e; });
                  setSafety('sent');
                })} />
            )}
            <Button kind="secondary" title={t.call102} onPress={() => Linking.openURL('tel:102')} />
          </Card>
        )}
        <ErrorNote text={error} />
        {!change && !terms && (
          <View style={{ gap: space.s2 }}>
            {canChangeRoute && (
              <Row>
                <Chip label={`+ ${t.addStop}`} onPress={addStop} />
                <Chip label={t.changeRoute} onPress={changeDestination} />
                {ride.driver && <Chip tone="warm" label={t.safety} onPress={() => setSafety(safety === 'closed' ? 'open' : 'closed')} />}
              </Row>
            )}
            {canCancel && <Button kind="ghost" compact title={t.cancelRide} busy={busy === 'terms'} onPress={askCancel} />}
          </View>
        )}
      </Sheet>
    </View>
  );
}

function DriverCard({ ride }: { ride: Ride }) {
  const { lang } = useApp();
  const d = ride.driver!;
  const label = (code: string) => RATING_TAGS.find((x) => x.code === code)?.label[lang] ?? code;
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="heading">{d.name ?? '—'}{d.rating ? `  ★ ${d.rating.toFixed(2)}` : ''}</T>
          <T muted>{d.vehicle.color} {d.vehicle.makeModel}</T>
        </View>
        <Plate text={plate(d.vehicle.plate)} />
      </Row>
      {d.highlights.length > 0 && (
        <>
          <Divider />
          <Row>{d.highlights.map((h) => <Pill key={h.code} tone="ok">{label(h.code)} · {h.count}</Pill>)}</Row>
        </>
      )}
    </Card>
  );
}
