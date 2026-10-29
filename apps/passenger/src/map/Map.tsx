// Phones: a real vector map from our own tile server (OpenStreetMap data, our style from the design
// tokens). No Google / Yandex SDK, no per-view fees, passenger positions never leave our servers.

import { useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import { Camera, LineLayer, MapView, MarkerView, ShapeSource, type CameraRef } from '@maplibre/maplibre-react-native';
import { mapStyle } from '../../../../packages/shared/src/mapStyle.ts';
import { useTheme } from '../theme';
import { PinView } from './Pin';
import type { MapProps } from './types';

const TILES_URL = (process.env.EXPO_PUBLIC_TILES_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const TASHKENT: [number, number] = [69.2797, 41.3111];

export function Map({ pins, line, bottomInset = 0, style, onPinPress, onCenterChange, center }: MapProps) {
  const { c, dark } = useTheme();
  const camera = useRef<CameraRef>(null);
  const styleJson = useMemo(() => JSON.stringify(mapStyle(c, TILES_URL, dark)), [c, dark]);

  // Fit everything that matters (pickup, destination, car) above the bottom sheet.
  const key = pins.filter((p) => p.kind !== 'entrance').map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|');
  useEffect(() => {
    const pts = pins.filter((p) => p.kind !== 'entrance');
    if (onCenterChange) return;
    if (pts.length === 1) camera.current?.flyTo([pts[0]!.lng, pts[0]!.lat], 600);
    if (pts.length > 1) {
      const lats = pts.map((p) => p.lat);
      const lngs = pts.map((p) => p.lng);
      camera.current?.fitBounds([Math.max(...lngs), Math.max(...lats)], [Math.min(...lngs), Math.min(...lats)], [80, 48, bottomInset + 40, 48], 600);
    }
  }, [key, bottomInset]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={[{ flex: 1, backgroundColor: c.surfaceSunken }, style]}>
      <MapView
        style={{ flex: 1 }}
        mapStyle={styleJson}
        logoEnabled={false}
        attributionEnabled
        attributionPosition={{ top: 8, left: 8 }}
        compassEnabled={false}
        pitchEnabled={false}
        onRegionDidChange={(f) => {
          if (onCenterChange && f.properties.isUserInteraction) onCenterChange({ lng: f.geometry.coordinates[0]!, lat: f.geometry.coordinates[1]! });
        }}
      >
        <Camera ref={camera} defaultSettings={{ centerCoordinate: center ? [center.lng, center.lat] : TASHKENT, zoomLevel: 15 }} />
        {line && line.length > 1 && (
          <ShapeSource id="route" shape={{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line.map((p) => [p.lng, p.lat]) } }}>
            <LineLayer id="route-line" style={{ lineColor: c.route, lineWidth: 5, lineCap: 'round', lineJoin: 'round' }} />
          </ShapeSource>
        )}
        {pins.map((p) => (
          <MarkerView key={p.id} coordinate={[p.lng, p.lat]} anchor={p.kind === 'pickup' || p.kind === 'dropoff' || p.kind === 'stop' ? { x: 0.5, y: 1 } : { x: 0.5, y: 0.5 }} allowOverlap>
            <View onTouchEnd={onPinPress ? () => onPinPress(p) : undefined}><PinView pin={p} /></View>
          </MarkerView>
        ))}
      </MapView>
    </View>
  );
}
