// Before the first order (and after a text changes): the offer and the privacy policy, each a link to
// the published text, one checkbox, one button. The server records the exact versions shown.

import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { api, ApiError } from '../api';
import { useApp } from '../context';
import { radius, space, useTheme } from '../theme';
import type { LegalDoc } from '../types';
import { Button, Card, ErrorNote, Screen, T, Tiles } from '../components/ui';

export function ConsentScreen({ docs, onDone }: { docs: LegalDoc[]; onDone: (stillNeeded: LegalDoc[]) => void }) {
  const { t, err, logout } = useApp();
  const { c } = useTheme();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true); setError(null);
    try {
      await api('/me/consents', { body: { accept: docs.map((d) => ({ code: d.code, version: d.version })) } });
      onDone([]);
    } catch (e) {
      // The text changed while this screen was open: show the new versions.
      if (e instanceof ApiError && e.code === 'version_outdated') {
        const fresh = await api<{ needed: LegalDoc[] }>('/me/consents?app=passenger').catch(() => null);
        if (fresh) { setChecked(false); onDone(fresh.needed); return; }
      }
      setError(err(e));
    } finally { setBusy(false); }
  }

  return (
    <Screen footer={<>
      <Button title={t.consentAccept} disabled={!checked} busy={busy} onPress={accept} />
      <Button kind="ghost" compact title={t.logout} onPress={logout} />
    </>}>
      <Tiles />
      <T v="title">{t.consentTitle}</T>
      <T muted>{t.consentText}</T>
      <Card>
        {docs.map((d) => (
          <Pressable key={d.code} accessibilityRole="link" onPress={() => Linking.openURL(d.url).catch(() => {})} style={{ paddingVertical: space.s2 }}>
            <T v="bodyStrong" color={c.brand}>{t.legalDocs[d.code]} ↗</T>
          </Pressable>
        ))}
      </Card>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => setChecked((v) => !v)}
        style={{ flexDirection: 'row', gap: space.s3, alignItems: 'flex-start', paddingVertical: space.s2 }}>
        <View style={{
          width: 24, height: 24, borderRadius: radius.sm, borderWidth: 2, borderColor: checked ? c.brand : c.border,
          backgroundColor: checked ? c.brand : 'transparent', alignItems: 'center', justifyContent: 'center',
        }}>{checked && <T v="bodyStrong" color={c.onBrand}>✓</T>}</View>
        <T style={{ flex: 1 }}>{t.consentCheck}</T>
      </Pressable>
      <ErrorNote text={error} />
    </Screen>
  );
}
