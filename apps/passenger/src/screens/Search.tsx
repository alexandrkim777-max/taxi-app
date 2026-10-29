// Address search: our own geocoder (/geo/search), saved places and "my location" on top.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { useApp } from '../context';
import { currentPosition } from '../location';
import { radius, size, space, useTheme } from '../theme';
import type { LatLng, Place, SavedPlace, Stop } from '../types';
import { Badge, Divider, ErrorNote, Header, ListRow, T } from '../components/ui';

export function placeToStop(p: Place): Stop {
  const address = p.address && p.address !== p.name && !p.address.startsWith(p.name) ? `${p.name}, ${p.address}` : p.address || p.name;
  return { lat: p.lat, lng: p.lng, address: address.slice(0, 200) };
}

export function SearchScreen({ purpose, onPick }: { purpose: 'pickup' | 'dropoff' | 'stop' | 'home' | 'work' | 'other'; onPick: (s: Stop) => void }) {
  const { t, pop, draft, err } = useApp();
  const { c } = useTheme();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedPlace[]>([]);
  const seq = useRef(0);
  const near: LatLng | null = draft.pickup;

  useEffect(() => { if (['pickup', 'dropoff', 'stop'].includes(purpose)) api<SavedPlace[]>('/me/places').then(setSaved).catch(() => {}); }, [purpose]);

  // Debounced search; only the latest answer is shown.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setResults(null); return; }
    const my = ++seq.current;
    const timer = setTimeout(async () => {
      setBusy(true); setError(null);
      try {
        const qs = `q=${encodeURIComponent(query)}${near ? `&lat=${near.lat.toFixed(5)}&lng=${near.lng.toFixed(5)}` : ''}`;
        const r = await api<Place[]>(`/geo/search?${qs}`);
        if (my === seq.current) setResults(r);
      } catch (e) { if (my === seq.current) setError(err(e)); } finally { if (my === seq.current) setBusy(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (s: Stop) => { pop(); onPick(s); };
  const title = purpose === 'pickup' ? t.from : purpose === 'home' ? t.home : purpose === 'work' ? t.work : purpose === 'stop' ? t.addStop : purpose === 'other' ? t.addPlace : t.where;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.surfacePage }} edges={['top', 'left', 'right']}>
      <View style={{ padding: space.s5, paddingBottom: space.s2, gap: space.s3 }}>
        <Header title={title} onBack={pop} />
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: size.buttonMain, borderRadius: radius.sm, backgroundColor: c.surfaceCard, borderWidth: 1, borderColor: c.border, paddingHorizontal: space.s4 }}>
          <TextInput value={q} onChangeText={setQ} autoFocus placeholder={t.searchPlaceholder} placeholderTextColor={c.inkMuted} maxLength={100}
            accessibilityLabel={t.searchPlaceholder} style={{ flex: 1, color: c.ink, fontSize: 17, minHeight: size.buttonMain }} returnKeyType="search" />
          {busy && <ActivityIndicator color={c.inkMuted} />}
        </View>
      </View>
      <View style={{ paddingHorizontal: space.s5, flex: 1 }}>
        <ErrorNote text={error} />
        {results === null ? (
          <View>
            {purpose === 'pickup' && (
              <ListRow lead={<Badge text="◎" tone="brand" />} title={t.myLocation} onPress={async () => {
                const p = await currentPosition();
                if (!p) return;
                const r = await api<Place | null>(`/geo/reverse?lat=${p.lat.toFixed(5)}&lng=${p.lng.toFixed(5)}`).catch(() => null);
                pick({ ...p, address: r ? placeToStop(r).address : t.myLocation });
              }} />
            )}
            {saved.map((s) => (
              <ListRow key={s.id} lead={<Badge text={s.kind === 'home' ? '⌂' : s.kind === 'work' ? '▣' : '★'} />}
                title={s.kind === 'home' ? t.home : s.kind === 'work' ? t.work : s.label || s.address} subtitle={s.address}
                onPress={() => pick({ lat: s.lat, lng: s.lng, address: s.address, ...(s.entranceId && purpose === 'pickup' ? { entranceId: s.entranceId } : {}) })} />
            ))}
          </View>
        ) : results.length === 0 ? (
          <T muted>{t.noResults}</T>
        ) : (
          <View>
            {results.map((r, i) => (
              <View key={`${r.lat},${r.lng},${i}`}>
                {i > 0 && <Divider />}
                <ListRow title={r.name} subtitle={r.address !== r.name ? r.address : null} onPress={() => pick(placeToStop(r))} right={<View />} />
              </View>
            ))}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}
