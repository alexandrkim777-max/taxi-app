// First screens: language, phone number, SMS code. The chosen language is stored on the account.

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api, DEMO, errorText } from '../api';
import { DICTS, type Lang } from '../i18n';
import { radius, space, useTheme } from '../theme';
import { Button, ErrorNote, Field, Screen, T, Tiles } from '../components/ui';

const LANGS: { value: Lang; label: string; hint: string }[] = [
  { value: 'uz', label: 'Oʻzbekcha', hint: 'Tilni tanlang' },
  { value: 'ru', label: 'Русский', hint: 'Выберите язык' },
  { value: 'en', label: 'English', hint: 'Choose your language' },
];

export function LanguageScreen({ onPick }: { onPick: (l: Lang) => void }) {
  const { c } = useTheme();
  return (
    <Screen>
      <Tiles />
      <T v="display">Taxi</T>
      <T v="heading" muted>Tilni tanlang · Выберите язык · Choose your language</T>
      <View style={{ gap: space.s2 }}>
        {LANGS.map((l) => (
          <Pressable key={l.value} accessibilityRole="button" onPress={() => onPick(l.value)}
            style={({ pressed }) => ({ minHeight: 64, borderRadius: radius.lg, paddingHorizontal: space.s5, justifyContent: 'center',
              backgroundColor: pressed ? c.surfaceSunken : c.surfaceCard, borderWidth: 1, borderColor: c.border })}>
            <T v="title">{l.label}</T>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

export function PhoneScreen({ lang, onSent, onBack }: { lang: Lang; onSent: (phone: string) => void; onBack: () => void }) {
  const t = DICTS[lang];
  const [phone, setPhone] = useState('+998 ');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = phone.replace(/\D/g, '');
  return (
    <Screen footer={<>
      <Button title={t.getCode} busy={busy} disabled={digits.length !== 12} onPress={async () => {
        setBusy(true); setError(null);
        try { await api('/auth/request-code', { body: { phone, language: lang } }); onSent(phone); }
        catch (err) { setError(errorText(err, t.errors)); } finally { setBusy(false); }
      }} />
      <Button kind="ghost" compact title={LANGS.find((l) => l.value === lang)!.label} onPress={onBack} />
    </>}>
      <Tiles />
      <T v="title">{t.phoneTitle}</T>
      <T muted>{t.phoneHint}</T>
      <Field label={t.phoneTitle} value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={17} autoFocus />
      <ErrorNote text={error} />
    </Screen>
  );
}

export function CodeScreen({ lang, phone, onSignedIn, onBack }: { lang: Lang; phone: string; onSignedIn: (token: string) => void; onBack: () => void }) {
  const t = DICTS[lang];
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Screen footer={<>
      <Button title={t.signIn} busy={busy} disabled={code.length !== 6} onPress={async () => {
        setBusy(true); setError(null);
        try { const r = await api<{ token: string }>('/auth/verify', { body: { phone, code } }); onSignedIn(r.token); }
        catch (err) { setError(errorText(err, t.errors)); } finally { setBusy(false); }
      }} />
      <Button kind="ghost" compact title={t.change} onPress={onBack} />
    </>}>
      <Tiles />
      <T v="title">{t.codeTitle}</T>
      <T muted>{lang === 'ru' ? `${t.codeHint} ${phone}` : `${phone} ${t.codeHint}`}</T>
      <Field label={t.codeTitle} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={6} autoFocus />
      {DEMO && <T v="caption" muted>Demo: 123456</T>}
      <ErrorNote text={error} />
    </Screen>
  );
}
