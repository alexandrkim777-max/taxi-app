// Composing the order, kept simple: the class, then "Cheaper" or "Faster" (or one "Best option"
// when they would be the same), payment, confirm. The passenger never sees drivers' tariffs or a
// list of drivers: the server picks the driver by the chosen rule and never charges more than shown.

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError, newKey } from '../api';
import { useApp } from '../context';
import { km, money } from '../format';
import { Map } from '../map/Map';
import type { MapPin } from '../map/types';
import { useRide } from '../ride';
import { radius, space, useTheme } from '../theme';
import type { Card, Entrance, Priority, Quote, QuoteClass, Ride, Stop } from '../types';
import { Button, Card as Box, Chip, Divider, ErrorNote, Field, Header, Pill, Row, T } from '../components/ui';

const OPTIONS = ['childSeat', 'pet', 'quiet', 'luggage'] as const;
const MAX_STOPS = 4; // plus the pickup: 5 points, as the API allows

/** What the order button will send: a rule and the price agreed to. */
interface Choice { priority: Priority; priceTiyin: number }

export function OrderScreen() {
  const { t, lang, draft, setDraft, push, pop, reset, err } = useApp();
  const { setRide } = useRide();
  const { c } = useTheme();
  const pickup = draft.pickup!;
  const stops = draft.stops;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [cls, setCls] = useState('economy');
  const [choice, setChoice] = useState<Choice | null>(null);
  const [entrances, setEntrances] = useState<Entrance[]>([]);
  const [typing, setTyping] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [pay, setPay] = useState<{ method: 'cash' } | { method: 'card'; cardId: string }>({ method: 'cash' });
  const [wishesOpen, setWishesOpen] = useState(false);
  const [options, setOptions] = useState<Record<string, boolean>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const orderKey = useRef(newKey());
  const [error, setError] = useState<string | null>(null);

  const points = [pickup, ...stops];
  const routeKey = points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');
  const current: QuoteClass | null = quote?.classes.find((x) => x.code === cls) ?? null;

  const loadQuote = () => api<Quote>('/quotes', { body: { stops: points.map((p) => ({ lat: p.lat, lng: p.lng })) } });
  useEffect(() => {
    setQuote(null); setError(null);
    loadQuote().then(setQuote).catch((e) => setError(err(e)));
  }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new quote or class: preselect the first option ("Cheaper", or the only one).
  useEffect(() => {
    const first = current?.options[0];
    setChoice(first ? { priority: first.priority, priceTiyin: first.priceTiyin } : null);
  }, [current]);

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

  async function order(ch: Choice) {
    setBusy(true); setError(null);
    try {
      const ride = await api<Ride>('/rides', {
        // One key per order attempt: a retry after a lost answer gets the same ride back.
        idempotencyKey: orderKey.current,
        body: {
          classCode: cls, mode: 'auto', priority: ch.priority, maxPriceTiyin: ch.priceTiyin,
          stops: points.map(({ lat, lng, address, entranceId, entranceLabel }) => ({
            lat, lng, address, ...(entranceId ? { entranceId } : {}), ...(entranceLabel ? { entranceLabel } : {}),
          })),
          paymentMethod: pay.method, ...(pay.method === 'card' ? { cardId: pay.cardId } : {}),
          options, ...(comment.trim() ? { comment: comment.trim() } : {}),
        },
      });
      setRide(ride);
      orderKey.current = newKey();
      setDraft((d) => ({ ...d, stops: [] }));
      reset();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unpaid_debt') push({ name: 'debts' });
      // The price moved since the quote (a driver changed their tariff): fetch fresh options.
      if (e instanceof ApiError && e.code === 'price_out_of_range') loadQuote().then(setQuote).catch(() => {});
      setError(err(e));
    } finally { setBusy(false); }
  }

  // Entrances first, so the pickup pin is drawn on top of them.
  const pins: MapPin[] = [
    ...entrances.map((e): MapPin => ({ id: `e${e.id}`, kind: 'entrance', lat: e.lat, lng: e.lng, label: e.number, selected: e.id === pickup.entranceId })),
    { id: 'pickup', kind: 'pickup', lat: pickup.lat, lng: pickup.lng },
    ...stops.map((s, i): MapPin => ({ id: `s${i}`, kind: i === stops.length - 1 ? 'dropoff' : 'stop', lat: s.lat, lng: s.lng })),
  ];

  const opts = current?.options ?? [];
  const noCars = !!current && opts.length === 0;
  // Nobody free right now: the passenger may still search for up to 5 minutes at the class's top price.
  const toSend: Choice | null = noCars && current ? { priority: 'fast', priceTiyin: current.maxFareTiyin } : choice;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.surfacePage }} edges={['top', 'left', 'right', 'bottom']}>
      <View style={{ paddingHorizontal: space.s5, paddingTop: space.s2 }}><Header title={t.orderAt} onBack={pop} /></View>
      <View style={{ height: 180, marginHorizontal: space.s5, borderRadius: radius.lg, overflow: 'hidden' }}>
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

        {/* Class */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s2 }}>
          {(quote?.classes ?? []).map((q) => (
            <Chip key={q.code} label={q.seats > 4 ? `${q.name} · ${q.seats} ${t.seats}` : q.name} selected={q.code === cls} onPress={() => setCls(q.code)} />
          ))}
        </ScrollView>

        {/* Cheaper / Faster */}
        {!quote && !error && <T muted>…</T>}
        {opts.map((o) => {
          const on = choice?.priority === o.priority;
          const single = opts.length === 1;
          const title = single ? t.bestOption : o.priority === 'cheap' ? t.cheaper : t.faster;
          const hint = single ? t.bestHint : o.priority === 'cheap' ? t.cheaperHint : t.fasterHint;
          return (
            <Pressable key={o.priority} accessibilityRole="radio" accessibilityState={{ selected: on }}
              onPress={() => setChoice({ priority: o.priority, priceTiyin: o.priceTiyin })}
              style={{ borderRadius: radius.lg, padding: space.s4, gap: 2, borderWidth: on ? 2 : 1, borderColor: on ? c.brand : c.border, backgroundColor: c.surfaceCard }}>
              <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <T v="heading">{title}</T>
                <T v="price">{money(o.priceTiyin, lang)}</T>
              </Row>
              <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <T v="caption" muted style={{ flex: 1 }}>{hint}</T>
                <T v="bodyStrong">{t.pickupApprox} {o.pickupMin} {t.min}</T>
              </Row>
            </Pressable>
          );
        })}
        {noCars && current && (
          <Box tone="warm">
            <T v="bodyStrong" color={c.warmInk}>{t.noCarsClass}</T>
            <T color={c.warmInk}>{t.priceAtMost} {money(current.maxFareTiyin, lang)}</T>
          </Box>
        )}
        {current && current.coefficient !== 1 && (
          <Pill tone={current.coefficient > 1 ? 'warm' : 'ok'}>
            {current.coefficient > 1 ? t.coefficient : t.coefficientLow} ×{current.coefficient.toFixed(2).replace('.', ',')}
          </Pill>
        )}

        {/* Payment */}
        <Row>
          <Chip label={t.cash} selected={pay.method === 'cash'} onPress={() => setPay({ method: 'cash' })} />
          {cards.map((card) => (
            <Chip key={card.id} label={`•••• ${card.panMasked.slice(-4)}`} selected={pay.method === 'card' && pay.cardId === card.id}
              onPress={() => setPay({ method: 'card', cardId: card.id })} />
          ))}
          <Chip label={`+ ${t.addCard}`} onPress={() => push({ name: 'addCard', onAdded: (card) => { loadCards(); setPay({ method: 'card', cardId: card.id }); } })} />
        </Row>

        {/* Wishes: hidden until asked for, to keep the screen short */}
        <Pressable accessibilityRole="button" onPress={() => setWishesOpen((x) => !x)} style={{ minHeight: 44, justifyContent: 'center' }}>
          <T v="bodyStrong" color={c.link}>{wishesOpen ? '−' : '+'} {t.wishes}{Object.values(options).some(Boolean) || comment ? ' •' : ''}</T>
        </Pressable>
        {wishesOpen && (
          <>
            <Row>{OPTIONS.map((o) => <Chip key={o} label={t[o]} selected={!!options[o]} onPress={() => setOptions((x) => ({ ...x, [o]: !x[o] }))} />)}</Row>
            <Field label={t.comment} value={comment} onChangeText={setComment} maxLength={300} />
          </>
        )}
        <ErrorNote text={error} />
      </ScrollView>
      <View style={{ paddingHorizontal: space.s5, paddingBottom: space.s3 }}>
        <Button busy={busy} disabled={!toSend} onPress={() => toSend && order(toSend)}
          title={noCars ? t.searchAnyway : toSend ? `${t.order} · ${money(toSend.priceTiyin, lang)}` : t.order} />
      </View>
    </SafeAreaView>
  );
}
