// Map markers in the design system's language: pickup in brand colour, destination in ink,
// cars as small dark capsules turned to their heading, entrances as tappable number chips.

import { View } from 'react-native';
import { T } from '../components/ui';
import { useTheme } from '../theme';
import type { MapPin } from './types';

export function PinView({ pin }: { pin: MapPin }) {
  const { c } = useTheme();
  if (pin.kind === 'car') {
    return (
      <View style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: `${pin.heading ?? 0}deg` }] }}>
        <View style={{ width: 16, height: 28, borderRadius: 7, backgroundColor: c.ink, borderWidth: 2, borderColor: c.surfaceCard }}>
          <View style={{ marginTop: 5, marginHorizontal: 2, height: 5, borderRadius: 2, backgroundColor: c.brand }} />
        </View>
      </View>
    );
  }
  if (pin.kind === 'entrance') {
    const on = pin.selected;
    return (
      <View style={{ minWidth: 26, height: 26, paddingHorizontal: 6, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
        backgroundColor: on ? c.brand : c.surfaceCard, borderWidth: 2, borderColor: on ? c.surfaceCard : c.brand }}>
        <T v="label" color={on ? c.onBrand : c.brand} style={{ letterSpacing: 0 }}>{pin.label ?? ''}</T>
      </View>
    );
  }
  const pickup = pin.kind === 'pickup';
  const bg = pickup ? c.brand : c.ink;
  const fg = pickup ? c.onBrand : c.surfaceCard;
  return (
    <View style={{ alignItems: 'center' }}>
      {pin.label ? (
        <View style={{ backgroundColor: bg, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginBottom: 3, maxWidth: 180 }}>
          <T v="label" color={fg} numberOfLines={1} style={{ textTransform: 'none', letterSpacing: 0 }}>{pin.label}</T>
        </View>
      ) : null}
      <View style={{ width: 22, height: 22, borderRadius: pin.kind === 'dropoff' ? 6 : 11, backgroundColor: bg, borderWidth: 3, borderColor: c.surfaceCard, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.surfaceCard }} />
      </View>
    </View>
  );
}
