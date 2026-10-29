// Composing the order: pickup with entrance, destination and stops, class with the one-tap price,
// one tap or choose a driver, payment, wishes. Prices come from /quotes; nothing is priced on the phone.

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError } from '../api';
import { useApp } from '../context';
import { km, money, moneyRange } from '../format';
import { Map } from '../map/Map';
import type { MapPin } from '../map/types';
import { useRide } from '../ride';
import { radius, space, useTheme } from '../theme';
import type { Card, Entrance, Quote, Ride, Stop } from '../types';
import { Button, Chip, Divider, ErrorNote, Field, Header, Pill, Row, Seg, T } from '../components/ui';

const OPTIONS = ['childSeat', 'pet', 'quiet', 'luggage'] as const;
const MAX_STOPS = 4; // plus the pickup: 5 points, as the API allows

export function OrderScreen() {
  const { t, lang, draft, setDraft, push, pop, reset, err } = useApp();
  const { setRide } = useRide();
  const { c } = useTheme();
  const pickup = draft.pickup!;
  const stops = draft.stops;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [cls, setCls] = useState('economy');
  const [mode, setMode] = useState<'auto' | 'choose'>('auto');
  const [entrances, setEntrances] = useState<Entrance[]>([]);
  const [typing, setTyping] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [pay, setPay] = useState<{ method: 'cash' } | { method: 'card'; cardId: string }>({ method: 'cash' });
  const [options, setOptions] = useState<Record<string, boolean>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const points = [pickup, ...stops];
  const routeKey = points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');

  useEffect(() => {
    setQuote(null); setError(null);
    api<Quote>('/quotes', { body: { stops: points.map((p) => ({ lat: p.lat, lng: p.lng })) } })
      .then((q) => { setQuote(q); if (!q.classes.some((x) => x.code === cls) && q.classes[0]) setCls(q.classes[0].code); })
      .catch((e) => setError(err(e)));
  }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api<Entrance[]>(`/geo/entrances?lat=${pickup.lat.toFixed(5)}&lng=${pickup.lng.toFixed(5)}`).then(setEntrances).catch(() => setEntrances([]));
  }, [pickup.lat, pickup.lng]);

  const loadCards = () => api<Card[]>('/me/cards').then((list) => {
    setCards(list);
    const def = list.find((x) => x.isDefault);
    if (def) setPay((p) => (p.method === 'cash' && list.length === 1 ? { method: 'card', cardId: def.id } : p));
  }).catch(() => {});
  useEffect(() => { loadCards(); }, []);

  const setPickup = (patch: Partial<Stop>) => setDraft((d) => ({ ...d, pickup: { ...d.pickup!, ...patch } }));
  const chosenClass = quote?.classes.find((x) => x.code === cls) ?? null;
  // One tap: the passenger agrees to the best price shown; with nobody nearby, to the class's top price.
  const ceiling = chosenClass ? chosenClass.best?.priceTiyin ?? chosenClass.maxFareTiyin : null;

  async function order() {
    if (!chosenClass) return;
    setBusy(true); setError(null);
    try {
      const ride = await api<Ride>('/rides', {
        body: {
          classCode: cls, mode, stops: points.map(({ lat, lng, address, entranceId, entranceLabel }) => ({
            lat, lng, address, ...(entranceId ? { entranceId } : {}), ...(entranceLabel ? { entranceLabel } : {}),
          })),
          ...(mode === 'auto' ? { maxPriceTiyin: ceiling } : {}),
          paymentMethod: pay.method, ...(pay.method === 'card' ? { cardId: pay.cardId } : {}),
          options, ...(comment.trim() ? { comment: comment.trim() } : {}),
        },
      });
      setRide(ride);
      setDraft((d) => ({ ...d, stops: [] }));
      reset();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unpaid_debt') push({ name: 'debts' });
      setError(err(e));
    } finally { setBusy(false); }
  }

  // Entrances first, so the pickup pin is drawn on top of them.
  const pins: MapPin[] = [
    ...entrances.map((e): MapPin => ({ id: `e${e.id}`, kind: 'entrance', lat: e.lat, lng: e.lng, label: e.number, selected: e.id === pickup.entranceId })),
    { id: 'pickup', kind: 'pickup', lat: pickup.lat, lng: pickup.lng },
    ...stops.map((s, i): MapPin => ({ id: `s${i}`, kind: i === stops.length - 1 ? 'dropoff' : 'stop', lat: s.lat, lng: s.lng })),
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.surfacePage }} edges={['top', 'left', 'right', 'bottom']}>
      <View style={{ paddingHorizontal: space.s5, paddingTop: space.s2 }}><Header title={t.orderAt} onBack={pop} /></View>
      <View style={{ height: 210, marginHorizontal: space.s5, borderRadius: radius.lg, overflow: 'hidden' }}>
        <Map pins={pins} line={points} onPinPress={(p) => {
          if (p.kind !== 'entrance') return;
          const e = entrances.find((x) => `e${x.id}` === p.id);
          if (e) { setTyping(false); setPickup({ entranceId: e.id, entranceLabel: undefined }); }
        }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: space.s5, gap: space.s4 }} keyboardShouldPersistTaps="handled">
        {/* Route */}
        <View style={{ gap: space.s2 }}>
          <Pressable accessibilityRole="button" onPress={() => push({ name: 'search', purpose: 'pickup', onPick: (s) => setDraft((d) => ({ ...d, pickup: s })) })}>
            <Row gap={space.s3} style={{ flexWrap: 'nowrap' }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.brand }} />
              <T v="bodyStrong" numberOfLines={2} style={{ flex: 1 }}>{pickup.address}</T>
            </Row>
          </Pressable>
          <View style={{ marginLeft: 24, gap: space.s2 }}>
            <T v="caption" muted>{t.entrance} · {t.entranceHint}</T>
            <Row>
              {entrances.map((e) => (
                <Chip key={e.id} label={e.number} selected={pickup.entranceId === e.id}
                  onPress={() => { setTyping(false); setPickup(pickup.entranceId === e.id ? { entranceId: undefined } : { entranceId: e.id, entranceLabel: undefined }); }} />
              ))}
              <Chip label={pickup.entranceLabel ? `${t.entrance} ${pickup.entranceLabel}` : t.entranceOther} selected={typing || !!pickup.entranceLabel}
                onPress={() => { setTyping(true); setPickup({ entranceId: undefined }); }} />
            </Row>
            {typing && (
              <Field label={t.entranceNumber} value={pickup.entranceLabel ?? ''} maxLength={8} autoFocus
                onChangeText={(v) => setPickup({ entranceLabel: v.replace(/[^0-9A-Za-zА-Яа-я]/g, '').slice(0, 8) || undefined })} />
            )}
          </View>
          {stops.map((s, i) => (
            <Row key={`${i}-${s.address}`} gap={space.s3} style={{ flexWrap: 'nowrap' }}>
              <View style={{ width: 12, height: 12, borderRadius: i === stops.length - 1 ? 3 : 6, backgroundColor: c.ink }} />
              <Pressable style={{ flex: 1 }} accessibilityRole="button"
                onPress={() => push({ name: 'search', purpose: i === stops.length - 1 ? 'dropoff' : 'stop', onPick: (n) => setDraft((d) => ({ ...d, stops: d.stops.map((x, j) => (j === i ? n : x)) })) })}>
                <T v="bodyStrong" numberOfLines={2}>{s.address}</T>
              </Pressable>
              {stops.length > 1 && <Chip label="✕" onPress={() => setDraft((d) => ({ ...d, stops: d.stops.filter((_, j) => j !== i) }))} />}
            </Row>
          ))}
          {stops.length < MAX_STOPS && (
            <Pressable accessibilityRole="button" style={{ marginLeft: 24, minHeight: 44, justifyContent: 'center' }}
              onPress={() => push({ name: 'search', purpose: 'stop', onPick: (s) => setDraft((d) => ({ ...d, stops: [...d.stops.slice(0, -1), s, d.stops[d.stops.length - 1]!] })) })}>
              <T v="bodyStrong" color={c.link}>+ {t.addStop}</T>
            </Pressable>
          )}
          {quote && <T v="caption" muted>{km(quote.route.distanceM)} {t.km} · {Math.round(quote.route.durationS / 60)} {t.min}</T>}
        </View>

        <Divider />

        {/* How to find a driver */}
        <Seg value={mode} onChange={setMode} options={[{ value: 'auto', label: t.oneTap }, { value: 'choose', label: t.chooseDriver }]} />
        <T v="caption" muted>{mode === 'auto' ? t.oneTapHint : t.chooseDriverHint}</T>

        {/* Classes */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s2 }}>
          {(quote?.classes ?? []).map((q) => {
            const on = q.code === cls;
            return (
              <Pressable key={q.code} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => setCls(q.code)}
                style={{ width: 184, borderRadius: radius.lg, padding: space.s3, gap: 2, borderWidth: on ? 2 : 1, borderColor: on ? c.brand : c.border, backgroundColor: c.surfaceCard }}>
                <T v="bodyStrong">{q.name}</T>
                {mode === 'auto' && q.best
                  ? <T v="price">{money(q.best.priceTiyin, lang)}</T>
                  : <T v="bodyStrong" numberOfLines={1} style={{ fontSize: 14 }}>{moneyRange(q.minFareTiyin, q.maxFareTiyin, lang)}</T>}
                <T v="caption" muted>{q.best ? `${q.best.pickupMin} ${t.min} ${t.pickupIn}` : t.noDriversNow}</T>
              </Pressable>
            );
          })}
          {!quote && !error && <T muted>…</T>}
        </ScrollView>
        {chosenClass && chosenClass.coefficient !== 1 && (
          <Pill tone={chosenClass.coefficient > 1 ? 'warm' : 'ok'}>
            {chosenClass.coefficient > 1 ? t.coefficient : t.coefficientLow} ×{chosenClass.coefficient.toFixed(2).replace('.', ',')}
          </Pill>
        )}

        {/* Payment */}
        <T v="label" muted>{t.payment}</T>
        <Row>
          <Chip label={t.cash} selected={pay.method === 'cash'} onPress={() => setPay({ method: 'cash' })} />
          {cards.map((card) => (
            <Chip key={card.id} label={`•••• ${card.panMasked.slice(-4)}`} selected={pay.method === 'card' && pay.cardId === card.id}
              onPress={() => setPay({ method: 'card', cardId: card.id })} />
          ))}
          <Chip label={`+ ${t.addCard}`} onPress={() => push({ name: 'addCard', onAdded: (card) => { loadCards(); setPay({ method: 'card', cardId: card.id }); } })} />
        </Row>

        {/* Wishes */}
        <T v="label" muted>{t.options}</T>
        <Row>
          {OPTIONS.map((o) => <Chip key={o} label={t[o]} selected={!!options[o]} onPress={() => setOptions((x) => ({ ...x, [o]: !x[o] }))} />)}
        </Row>
        <Field label={t.comment} value={comment} onChangeText={setComment} maxLength={300} />
        <ErrorNote text={error} />
      </ScrollView>
      <View style={{ paddingHorizontal: space.s5, paddingBottom: space.s3 }}>
        <Button busy={busy} disabled={!chosenClass} onPress={order}
          title={mode === 'auto' ? `${t.order}${ceiling ? ` · ${money(ceiling, lang)}` : ''}` : t.chooseDriver} />
      </View>
    </SafeAreaView>
  );
}
