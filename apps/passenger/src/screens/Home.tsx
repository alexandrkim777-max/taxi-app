// Start screen, laid out the way passengers know it: the map over the whole screen with free cars
// around, the menu button, and a sheet with "From", "Where to?" with home / work, and recent places.

import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, DEMO } from '../api';
import { useApp } from '../context';
import { currentPosition, DEMO_POSITION } from '../location';
import { Map } from '../map/Map';
import type { MapPin } from '../map/types';
import { money } from '../format';
import { radius, space, useTheme } from '../theme';
import type { LatLng, PastRide, Place, SavedPlace, Stop } from '../types';
import { Icon } from '../components/icons';
import { Button, Card, Sheet, T } from '../components/ui';
import { MapButton } from './Menu';
import { placeToStop } from './Search';

interface Car extends LatLng { heading: number | null }

export function HomeScreen({ onMenu }: { onMenu: () => void }) {
  const { t, lang, draft, setDraft, push } = useApp();
  const { c } = useTheme();
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [recent, setRecent] = useState<Stop[]>([]);
  const [cars, setCars] = useState<Car[]>([]);
  const [debt, setDebt] = useState(0);
  const [sheetH, setSheetH] = useState(300);
  const [locating, setLocating] = useState(false);

  const setPickupAt = useCallback(async (p: LatLng) => {
    const r = await api<Place | null>(`/geo/reverse?lat=${p.lat.toFixed(5)}&lng=${p.lng.toFixed(5)}`).catch(() => null);
    setDraft((d) => ({ ...d, pickup: { ...p, address: r ? placeToStop(r).address : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` } }));
  }, [setDraft]);

  const locate = useCallback(() => {
    setLocating(true);
    currentPosition().then((p) => setPickupAt(p ?? DEMO_POSITION)).finally(() => setLocating(false));
  }, [setPickupAt]);

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
        if (out.length === 5) break;
      }
      setRecent(out);
    }).catch(() => {});
  }, []);

  useEffect(() => { load(); if (!draft.pickup) locate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Free cars around the pickup (approximate positions from the server), refreshed every 15 s.
  const pickup = draft.pickup;
  useEffect(() => {
    if (!pickup) return;
    const get = () => api<{ cars: Car[] }>(`/geo/cars?lat=${pickup.lat.toFixed(4)}&lng=${pickup.lng.toFixed(4)}`).then((r) => setCars(r.cars)).catch(() => {});
    get();
    const timer = setInterval(get, 15_000);
    return () => clearInterval(timer);
  }, [pickup?.lat, pickup?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = (s: Stop) => { setDraft((d) => ({ ...d, stops: [s] })); push({ name: 'order' }); };
  const home = places.find((p) => p.kind === 'home');
  const work = places.find((p) => p.kind === 'work');
  const savePlace = (kind: 'home' | 'work') => push({
    name: 'search', purpose: kind,
    onPick: async (s) => { await api(`/me/places/${kind}`, { method: 'PUT', body: { address: s.address, lat: s.lat, lng: s.lng } }).catch(() => {}); load(); },
  });
  // Saved places first, then recent destinations, in one row.
  const strip: Stop[] = [
    ...places.filter((p) => p.kind === 'other').map((p) => ({ lat: p.lat, lng: p.lng, address: p.label ? `${p.label}` : p.address })),
    ...recent,
  ].slice(0, 6);

  const pins: MapPin[] = [
    ...cars.map((car, i): MapPin => ({ id: `car${i}`, kind: 'car', lat: car.lat, lng: car.lng, heading: car.heading })),
    ...(pickup ? [{ id: 'pickup', kind: 'pickup', lat: pickup.lat, lng: pickup.lng } as MapPin] : []),
  ];
  const field = { minHeight: 60, borderRadius: radius.md, backgroundColor: c.surfaceSunken, flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.s3, paddingHorizontal: space.s4 };

  return (
    <View style={{ flex: 1 }}>
      <Map pins={pins} bottomInset={sheetH} center={pickup ?? undefined} onCenterChange={DEMO ? undefined : setPickupAt} />
      <SafeAreaView edges={['top']} style={{ position: 'absolute', top: 0, left: 0, right: 0 }} pointerEvents="box-none">
        <View style={{ padding: space.s4, flexDirection: 'row' }} pointerEvents="box-none">
          <MapButton icon="menu" label="Menu" onPress={onMenu} />
        </View>
      </SafeAreaView>
      <View style={{ position: 'absolute', right: space.s4, bottom: sheetH + space.s3 }}>
        <MapButton icon="locate" label={t.myLocation} onPress={locate} />
      </View>
      <Sheet onLayoutHeight={setSheetH}>
        {debt > 0 && (
          <Card tone="warm">
            <T v="bodyStrong" color={c.warmInk}>{t.debtTitle}: {money(debt, lang)}</T>
            <T color={c.warmInk}>{t.debtHint}</T>
            <Button compact title={t.payDebt} onPress={() => push({ name: 'debts' })} />
          </Card>
        )}
        <Pressable accessibilityRole="button" style={field}
          onPress={() => push({ name: 'search', purpose: 'pickup', onPick: (s) => setDraft((d) => ({ ...d, pickup: s })) })}>
          <Icon name="pin" color={c.brand} />
          <T v="heading" numberOfLines={1} style={{ flex: 1 }}>{pickup?.address ?? (locating ? t.locating : t.from)}</T>
        </Pressable>
        <View style={{ flexDirection: 'row', gap: space.s2 }}>
          <Pressable accessibilityRole="button" style={[field, { flex: 1 }]} onPress={() => push({ name: 'search', purpose: 'dropoff', onPick: goTo })}>
            <Icon name="arrow" />
            <T v="heading" muted>{t.where}</T>
          </Pressable>
          <View style={[field, { gap: 0, paddingHorizontal: 0 }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={t.home} style={{ width: 56, height: 60, alignItems: 'center', justifyContent: 'center' }}
              onPress={() => (home ? goTo({ lat: home.lat, lng: home.lng, address: home.address }) : savePlace('home'))}>
              <Icon name="home" color={home ? c.ink : c.inkMuted} />
              {!home && <View style={{ position: 'absolute', top: 12, right: 10 }}><Icon name="plus" size={12} strokeWidth={3} color={c.brand} /></View>}
            </Pressable>
            <View style={{ width: 1, height: 28, backgroundColor: c.border }} />
            <Pressable accessibilityRole="button" accessibilityLabel={t.work} style={{ width: 56, height: 60, alignItems: 'center', justifyContent: 'center' }}
              onPress={() => (work ? goTo({ lat: work.lat, lng: work.lng, address: work.address }) : savePlace('work'))}>
              <Icon name="work" color={work ? c.ink : c.inkMuted} />
              {!work && <View style={{ position: 'absolute', top: 12, right: 10 }}><Icon name="plus" size={12} strokeWidth={3} color={c.brand} /></View>}
            </Pressable>
          </View>
        </View>
        {strip.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s4, paddingVertical: space.s1 }}>
            {strip.map((s, i) => (
              <Pressable key={`${s.address}-${i}`} accessibilityRole="button" onPress={() => goTo(s)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.s2, width: 210 }}>
                <Icon name="pin" color={c.inkMuted} size={22} />
                <T numberOfLines={2} style={{ flex: 1 }}>{s.address}</T>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </Sheet>
    </View>
  );
}
