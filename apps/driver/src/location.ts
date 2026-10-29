// Position updates while the driver is on the line.
// - In the foreground: a watcher sends a ping every few seconds.
// - With the screen off / app in the background: a background task with a visible Android
//   notification ("You are on the line") keeps sending, as the stores require.
// Nothing is sent while offline. Pings go to /drivers/me/location with the session token.

import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { api, DEMO } from './api';

const TASK = 'driver-position';
const native = Platform.OS !== 'web' && !DEMO;

if (native) {
  TaskManager.defineTask(TASK, async ({ data, error }) => {
    if (error) return;
    const loc = (data as { locations?: Location.LocationObject[] })?.locations?.at(-1);
    if (loc) await sendPosition(loc).catch(() => {});
  });
}

async function sendPosition(loc: Location.LocationObject): Promise<void> {
  await api('/drivers/me/location', {
    body: {
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      ...(loc.coords.heading !== null && loc.coords.heading >= 0 ? { heading: Math.round(loc.coords.heading) % 360 } : {}),
    },
  });
}

export interface Position { lat: number; lng: number }

/** Demo / web without GPS: a point in central Tashkent. */
const DEMO_POSITION: Position = { lat: 41.2995, lng: 69.2401 };

export async function requestPermission(): Promise<boolean> {
  if (!native) return true;
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return false;
  // Background permission is asked separately (Android 11+ sends the user to settings).
  await Location.requestBackgroundPermissionsAsync().catch(() => null);
  return true;
}

export async function currentPosition(): Promise<Position> {
  if (!native) return DEMO_POSITION;
  const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { lat: loc.coords.latitude, lng: loc.coords.longitude };
}

let watcher: Location.LocationSubscription | null = null;

export async function startTracking(notificationTitle: string): Promise<void> {
  if (!native) return;
  watcher?.remove();
  watcher = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.High, timeInterval: 4000, distanceInterval: 10 },
    (loc) => { sendPosition(loc).catch(() => {}); },
  );
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.status === 'granted' && !(await Location.hasStartedLocationUpdatesAsync(TASK))) {
    await Location.startLocationUpdatesAsync(TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: 5000,
      distanceInterval: 15,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: { notificationTitle, notificationBody: '', killServiceOnDestroy: false },
    });
  }
}

export async function stopTracking(): Promise<void> {
  watcher?.remove();
  watcher = null;
  if (native && (await Location.hasStartedLocationUpdatesAsync(TASK))) await Location.stopLocationUpdatesAsync(TASK);
}
