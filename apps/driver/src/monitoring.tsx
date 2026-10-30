// Crash reporting to our own API (POST /client-errors): uncaught errors and screens that fail to
// draw. The server groups them and strips personal data; nothing is sent from the demo build.
// The same message is sent once per app run, so a loop of errors does not flood the network.

import { Component, type ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { API_BASE, DEMO } from './api';

const APP = 'driver';
const sent = new Set<string>();

export function reportError(err: unknown, screen?: string): void {
  if (DEMO) return;
  const e = err instanceof Error ? err : new Error(String(err));
  const key = `${e.message}|${screen ?? ''}`;
  if (sent.has(key) || sent.size > 50) return;
  sent.add(key);
  const platform = Platform.OS === 'android' || Platform.OS === 'ios' || Platform.OS === 'web' ? Platform.OS : undefined;
  fetch(`${API_BASE}/client-errors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: APP,
      message: (e.message || e.name || 'Error').slice(0, 500),
      ...(e.stack ? { stack: e.stack.slice(0, 4000) } : {}),
      ...(Constants.expoConfig?.version ? { appVersion: Constants.expoConfig.version } : {}),
      ...(platform ? { platform } : {}),
      ...(screen ? { screen: screen.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) } : {}),
    }),
  }).catch(() => {});
}

/** Catches errors nothing else caught (React Native's global handler), then lets RN handle them as before. */
export function installErrorReporting(): void {
  const g = (globalThis as { ErrorUtils?: { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void } }).ErrorUtils;
  if (!g) return;
  const previous = g.getGlobalHandler();
  g.setGlobalHandler((e, fatal) => { reportError(e, fatal ? 'fatal' : 'uncaught'); previous(e, fatal); });
}

/** A screen that throws while drawing: report it and offer a restart instead of a white screen. */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string; retry: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { reportError(error, 'render'); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, backgroundColor: '#F6F1E7' }}>
        <Text style={{ fontSize: 17, color: '#1D2A2F', textAlign: 'center' }}>{this.props.label}</Text>
        <Pressable accessibilityRole="button" onPress={() => this.setState({ failed: false })}
          style={{ backgroundColor: '#0B6A70', borderRadius: 28, paddingHorizontal: 24, paddingVertical: 14 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>{this.props.retry}</Text>
        </Pressable>
      </View>
    );
  }
}
