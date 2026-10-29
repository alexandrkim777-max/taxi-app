// The side menu, as passengers know it from other taxi apps: profile and rating on top, then rides,
// payment, places, debts, about; "become a driver" at the bottom.

import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { useApp, type Route } from '../context';
import { money } from '../format';
import { radius, space, useTheme } from '../theme';
import { Icon, type IconName } from '../components/icons';
import { T } from '../components/ui';

/** Link to the driver app in the stores; the item is hidden until it is set. */
const DRIVER_APP_URL = process.env.EXPO_PUBLIC_DRIVER_APP_URL ?? '';

export function Menu({ onClose }: { onClose: () => void }) {
  const { t, lang, me, push } = useApp();
  const { c } = useTheme();
  const [rating, setRating] = useState<number | null>(null);
  const [debt, setDebt] = useState(0);
  useEffect(() => {
    api<{ asPassenger: { rating: number | null } }>('/me/ratings').then((r) => setRating(r.asPassenger.rating)).catch(() => {});
    api<{ totalTiyin: number }>('/me/debts').then((d) => setDebt(d.totalTiyin)).catch(() => {});
  }, []);
  const go = (r: Route) => { onClose(); push(r); };
  const item = (icon: IconName, label: string, r: Route, right?: string) => (
    <Pressable key={label} accessibilityRole="button" onPress={() => go(r)}
      style={({ pressed }) => ({ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: space.s4, paddingHorizontal: space.s5, opacity: pressed ? 0.7 : 1 })}>
      <Icon name={icon} />
      <T v="heading" style={{ flex: 1 }}>{label}</T>
      {right ? <T v="bodyStrong" color={c.danger}>{right}</T> : null}
    </Pressable>
  );
  return (
    <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 20, flexDirection: 'row' }}>
      <SafeAreaView edges={['top', 'bottom', 'left']} style={{ width: '84%', maxWidth: 360, backgroundColor: c.surfacePage }}>
        <ScrollView contentContainerStyle={{ paddingVertical: space.s4, gap: space.s3 }}>
          <Pressable accessibilityRole="button" onPress={() => go({ name: 'profile' })}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.s4, paddingHorizontal: space.s5, minHeight: 72 }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center' }}>
              <T v="title" color={c.onBrand}>{(me?.name ?? '?').slice(0, 1).toUpperCase()}</T>
            </View>
            <View style={{ flex: 1 }}>
              <T v="title" numberOfLines={1}>{me?.name || me?.phone}</T>
              <T muted>{t.myProfile}</T>
            </View>
            <Icon name="chevron" color={c.inkMuted} />
          </Pressable>
          <View style={{ marginHorizontal: space.s4, borderRadius: radius.lg, backgroundColor: c.surfaceCard, padding: space.s4, flexDirection: 'row', alignItems: 'center', gap: space.s3 }}>
            <Icon name="star" />
            <View>
              <T v="caption" muted>{t.rating}</T>
              <T v="heading">{rating !== null ? rating.toFixed(2) : t.notRatedYet}</T>
            </View>
          </View>
          <View style={{ marginHorizontal: space.s4, borderRadius: radius.lg, backgroundColor: c.surfaceCard, paddingVertical: space.s1 }}>
            {item('clock', t.myRides, { name: 'rides' })}
            {item('card', t.payment, { name: 'cards' })}
            {item('home', t.places, { name: 'places' })}
            {item('alert', t.debts, { name: 'debts' }, debt > 0 ? money(debt, lang) : undefined)}
          </View>
          <View style={{ marginHorizontal: space.s4, borderRadius: radius.lg, backgroundColor: c.surfaceCard, paddingVertical: space.s1 }}>
            {item('info', t.about, { name: 'about' })}
          </View>
          {DRIVER_APP_URL ? (
            <Pressable accessibilityRole="link" onPress={() => Linking.openURL(DRIVER_APP_URL)}
              style={{ marginHorizontal: space.s4, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: space.s4, flexDirection: 'row', alignItems: 'center', gap: space.s3 }}>
              <Icon name="wheel" />
              <View style={{ flex: 1 }}>
                <T v="heading">{t.becomeDriver}</T>
                <T muted>{t.becomeDriverHint}</T>
              </View>
              <Icon name="chevron" color={c.inkMuted} />
            </Pressable>
          ) : null}
        </ScrollView>
      </SafeAreaView>
      <Pressable accessibilityRole="button" accessibilityLabel="Close menu" onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} />
    </View>
  );
}

/** Round floating button over the map (menu, my location). */
export function MapButton({ icon, onPress, label }: { icon: IconName; onPress: () => void; label: string }) {
  const { c } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({ width: 52, height: 52, borderRadius: 16, backgroundColor: c.surfaceCard, alignItems: 'center', justifyContent: 'center',
        shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 6, opacity: pressed ? 0.85 : 1 })}>
      <Icon name={icon} />
    </Pressable>
  );
}
