// The session token is kept in the phone's secure storage (Keychain / Keystore). On the web demo
// it lives in memory only; it is never written to localStorage.

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const memory = new Map<string, string>();
const native = Platform.OS !== 'web';

export async function getItem(key: string): Promise<string | null> {
  return native ? SecureStore.getItemAsync(key) : memory.get(key) ?? null;
}

export async function setItem(key: string, value: string | null): Promise<void> {
  if (native) {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } else if (value === null) memory.delete(key);
  else memory.set(key, value);
}
