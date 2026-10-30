// Push notifications through Expo's push service. The device token goes only to our API, which sends
// through Expo (no Apple / Google keys in the app or on our servers). Skipped in the web demo, in
// simulators, and until the EAS project id is set (EXPO_PUBLIC_EAS_PROJECT_ID or app.json extra.eas).

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { api, DEMO } from './api';

const APP = 'driver';
let current: string | null = null;

// Shown and heard also while the app is open: a new order or "driver arrived" must not be missed.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
});

async function channels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('orders', {
    name: 'New orders', importance: Notifications.AndroidImportance.MAX, sound: 'default',
    vibrationPattern: [0, 400, 200, 400], lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.setNotificationChannelAsync('rides', {
    name: 'Rides', importance: Notifications.AndroidImportance.HIGH, sound: 'default',
  });
}

function projectId(): string | undefined {
  const fromConfig = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  return process.env.EXPO_PUBLIC_EAS_PROJECT_ID || fromConfig || Constants.easConfig?.projectId || undefined;
}

/** After sign-in (and on every start while signed in): ask permission once and register this device. */
export async function registerForPush(): Promise<void> {
  if (DEMO || Platform.OS === 'web' || !Device.isDevice) return;
  const id = projectId();
  if (!id) return;
  try {
    await channels();
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
    await api('/me/push-token', { body: { token, app: APP, platform: Platform.OS === 'ios' ? 'ios' : 'android' } });
    current = token;
  } catch {
    // No push this time (offline, no Google services): the app still works by polling.
  }
}

/** Before sign-out: this device stops receiving this account's notifications. */
export async function unregisterPush(): Promise<void> {
  if (!current) return;
  const token = current;
  current = null;
  await api('/me/push-token', { method: 'DELETE', body: { token } }).catch(() => {});
}
