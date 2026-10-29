// Where the passenger is, to put the pickup pin. Asked only while the app is open ("when in use");
// the position goes to our server only as part of a search or an order.

import * as Location from 'expo-location';
import { DEMO } from './api';
import type { LatLng } from './types';

/** Chilonzor, Tashkent: the demo's pretend position and the fallback without permission. */
export const DEMO_POSITION: LatLng = { lat: 41.2856, lng: 69.2034 };

export async function currentPosition(): Promise<LatLng | null> {
  if (DEMO) return DEMO_POSITION;
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    const p = last ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }));
    return { lat: p.coords.latitude, lng: p.coords.longitude };
  } catch {
    return null;
  }
}

/** Straight-line distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
