// Web demo only: a schematic map (no tiles can be loaded in the preview). The phones use the real
// vector map in Map.tsx. Streets here are drawn shapes, not real geography.

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Path, Polyline, Rect } from 'react-native-svg';
import { T } from '../components/ui';
import { useTheme } from '../theme';
import { PinView } from './Pin';
import type { MapProps } from './types';

const STREETS = [
  'M -40 120 C 120 100, 260 140, 520 90', 'M -40 300 C 160 280, 300 330, 520 260', 'M -40 520 C 140 480, 330 540, 520 470',
  'M 80 -40 C 100 200, 60 420, 110 900', 'M 260 -40 C 240 260, 290 520, 250 900', 'M 420 -40 C 400 300, 440 600, 410 900',
  'M -40 700 C 200 660, 300 720, 520 650',
];
const MINOR = [
  'M -40 210 L 520 190', 'M -40 410 L 520 380', 'M -40 610 L 520 570', 'M 170 -40 L 190 900', 'M 340 -40 L 330 900',
];

export function Map({ pins, line, bottomInset = 0, style, onPinPress }: MapProps) {
  const { c, dark } = useTheme();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const pts = [...pins, ...(line ?? [])];
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const pad = 0.004;
  let minLat = Math.min(...lats, 99) - pad, maxLat = Math.max(...lats, -99) + pad;
  let minLng = Math.min(...lngs, 999) - pad, maxLng = Math.max(...lngs, -999) + pad;
  if (!pts.length) { minLat = 41.30; maxLat = 41.32; minLng = 69.27; maxLng = 69.29; }
  const top = 72, side = 40, bottom = bottomInset + 40;
  const W = Math.max(1, size.w - 2 * side), H = Math.max(1, size.h - top - bottom);
  // Keep the aspect ratio (1° longitude is ~0.75 of 1° latitude at Tashkent).
  const kx = W / ((maxLng - minLng) * 0.75), ky = H / (maxLat - minLat), k = Math.min(kx, ky);
  const cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;
  const x = (lng: number) => side + W / 2 + (lng - cx) * 0.75 * k;
  const y = (lat: number) => top + H / 2 - (lat - cy) * k;
  const water = dark ? '#16303A' : '#BFD9DA';
  const park = dark ? '#18261E' : '#DCE7CF';
  return (
    <View style={[{ flex: 1, backgroundColor: c.surfaceSunken, overflow: 'hidden' }, style]} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      <Svg width="100%" height="100%" viewBox="0 0 480 860" preserveAspectRatio="xMidYMid slice" style={{ position: 'absolute' }}>
        <Rect x={300} y={330} width={90} height={120} rx={18} fill={park} />
        <Rect x={20} y={560} width={120} height={80} rx={18} fill={park} />
        <Path d="M -40 380 C 120 360, 200 430, 300 400 S 450 420, 520 360" stroke={water} strokeWidth={16} fill="none" />
        {MINOR.map((d) => <Path key={d} d={d} stroke={c.mapRoad} strokeWidth={5} fill="none" opacity={0.8} />)}
        {STREETS.map((d) => <Path key={d} d={d} stroke={dark ? '#2E3742' : '#FFFFFF'} strokeWidth={12} fill="none" />)}
      </Svg>
      {size.w > 0 && line && line.length > 1 && (
        <Svg width={size.w} height={size.h} style={{ position: 'absolute' }}>
          <Polyline points={line.map((p) => `${x(p.lng)},${y(p.lat)}`).join(' ')} stroke={c.route} strokeWidth={5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      )}
      {size.w > 0 && pins.map((p) => {
        const anchorBottom = p.kind === 'pickup' || p.kind === 'dropoff' || p.kind === 'stop';
        return (
          <Pressable key={p.id} disabled={!onPinPress} onPress={() => onPinPress?.(p)}
            style={{ position: 'absolute', left: x(p.lng), top: y(p.lat), transform: [{ translateX: '-50%' as unknown as number }, { translateY: (anchorBottom ? '-100%' : '-50%') as unknown as number }] }}>
            <PinView pin={p} />
          </Pressable>
        );
      })}
      <View style={{ position: 'absolute', left: 10, bottom: bottomInset + 6, opacity: 0.6 }} pointerEvents="none"><T v="caption" muted>Demo · schematic map</T></View>
    </View>
  );
}
