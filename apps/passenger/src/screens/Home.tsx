// Start screen: the map with the pickup pin, "Where to?", home / work and recent places.

import { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api, DEMO } from '../api';
import { useApp } from '../context';
import { currentPosition, DEMO_POSITION } from '../location';
import { Map } from '../map/Map';
import { money } from '../format';
import { radius, size, space, useTheme } from '../theme';
import type { LatLng, PastRide, Place, SavedPlace, Stop } from '../types';
import { Badge, Button, Card, Chip, ListRow, Row, Sheet, T } from '../components/ui';
import { placeToStop } from './Search';

export function HomeScreen() {
  const { t, lang, draft, setDraft, push } = useApp();
  const { c } = useTheme();
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [recent, setRecent] = useState<Stop[]>([]);
  const [debt, setDebt] = useState(0);
  const [sheetH, setSheetH] = useState(320);
  const [locating, setLocating] = useState(false);

  const setPickupAt = useCallback(async (p: LatLng) => {
    const r = await api<Place | null>(`/geo/reverse?lat=${p.lat.toFixed(5)}&lng=${p.lng.toFixed(5)}`).catch(() => null);
    setDraft((d) => ({ ...d, pickup: { ...p, address: r ? placeToStop(r).address : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` } }));
  }, [setDraft]);

  const load = useCallback(() => {
    api<SavedPlace[]>('/me/places').then(setPlaces).catch(() => {});
    api<{ totalTiyin: number }>('/me/debts').then((d) => setDebt(d.totalTiyin)).catch(() => {});
    api<PastRide[]>('/me/rides').then((rides) => {
      const seen = new Set<string>();
      const out: Stop[] = [];
      for (const r of rides) {
        if (!r.to?.address || seen.has(r.to.address)) continue;
        seen.add(r.to.address);
        out.push({ lat: r.to.lat, lng: r.to.lng, address: r.to.address });
        if (out.length === 3) break;
      }
      setRecent(out);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    if (!draft.pickup) {
      setLocating(true);
      currentPosition().then((p) => setPickupAt(p ?? DEMO_POSITION)).finally(() => setLocating(false));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = (s: Stop) => { setDraft((d) => ({ ...d, stops: [s] })); push({ name: 'order' }); };
  const home = places.find((p) => p.kind === 'home');
  const work = places.find((p) => p.kind === 'work');
  const savePlace = (kind: 'home' | 'work') => push({
    name: 'search', purpose: kind,
    onPick: async (s) => { await api(`/me/places/${kind}`, { method: 'PUT', body: { address: s.address, lat: s.lat, lng: s.lng } }).catch(() => {}); load(); },
  });

  const pickup = draft.pickup;
  return (
    <View style={{ flex: 1 }}>
      <Map
        pins={pickup ? [{ id: 'pickup', kind: 'pickup', lat: pickup.lat, lng: pickup.lng, label: t.from }] : []}
        bottomInset={sheetH}
        center={pickup ?? undefined}
        onCenterChange={DEMO ? undefined : setPickupAt}
      />
      <Sheet onLayoutHeight={setSheetH}>
        {debt > 0 && (
          <Card tone="warm">
            <T v="bodyStrong" color={c.warmInk}>{t.debtTitle}: {money(debt, lang)}</T>
            <T color={c.warmInk}>{t.debtHint}</T>
            <Button compact title={t.payDebt} onPress={() => push({ name: 'debts' })} />
          </Card>
        )}
        <Pressable accessibilityRole="button" onPress={() => push({ name: 'search', purpose: 'pickup', onPick: (s) => setDraft((d) => ({ ...d, pickup: s })) })}>
          <Row gap={space.s3} style={{ flexWrap: 'nowrap' }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.brand }} />
            <View style={{ flex: 1 }}>
              <T v="caption" muted>{t.from}</T>
              <T v="bodyStrong" numberOfLines={1}>{pickup?.address ?? (locating ? t.locating : '—')}</T>
            </View>
          </Row>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => push({ name: 'search', purpose: 'dropoff', onPick: goTo })}
          style={({ pressed }) => ({ minHeight: size.buttonMain + 8, borderRadius: radius.lg, backgroundColor: pressed ? c.border : c.surfaceSunken, justifyContent: 'center', paddingHorizontal: space.s5 })}>
          <T v="title">{t.where}</T>
        </Pressable>
        <Row>
          <Chip label={home ? `⌂ ${t.home}` : `+ ${t.home}`} onPress={() => (home ? goTo({ lat: home.lat, lng: home.lng, address: home.address }) : savePlace('home'))} />
          <Chip label={work ? `▣ ${t.work}` : `+ ${t.work}`} onPress={() => (work ? goTo({ lat: work.lat, lng: work.lng, address: work.address }) : savePlace('work'))} />
          {places.filter((p) => p.kind === 'other').slice(0, 3).map((p) => (
            <Chip key={p.id} label={`★ ${p.label || p.address}`} onPress={() => goTo({ lat: p.lat, lng: p.lng, address: p.address })} />
          ))}
        </Row>
        {recent.length > 0 && <T v="label" muted>{t.recent}</T>}
        {recent.map((r) => <ListRow key={r.address} lead={<Badge text="↺" />} title={r.address} onPress={() => goTo(r)} />)}
      </Sheet>
    </View>
  );
}
