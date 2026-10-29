// My price, subscription, profile.

import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api, errorText } from '../api';
import { useApp } from '../context';
import { date, money, plate } from '../format';
import type { Lang } from '../i18n';
import { radius, space, useTheme, type ThemeMode } from '../theme';
import { Button, Card, ErrorNote, Pill, Row, Screen, Seg, T } from '../components/ui';

type Key = 'baseTiyin' | 'perKmTiyin' | 'perMinTiyin' | 'minFareTiyin';
interface TariffInfo {
  classCode: string;
  current: Record<Key, number> & { version: number };
  recommended: Record<Key, number>;
  bounds: Record<Key, { min: number; max: number }>;
}
const KEYS: { k: Key; label: 'base' | 'perKm' | 'perMin' | 'minFare'; step: number }[] = [
  { k: 'baseTiyin', label: 'base', step: 50_000 }, { k: 'perKmTiyin', label: 'perKm', step: 10_000 },
  { k: 'perMinTiyin', label: 'perMin', step: 5_000 }, { k: 'minFareTiyin', label: 'minFare', step: 50_000 },
];

export function TariffScreen() {
  const { t, lang } = useApp();
  const { c } = useTheme();
  const [info, setInfo] = useState<TariffInfo | null>(null);
  const [vals, setVals] = useState<Record<Key, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<TariffInfo>('/drivers/me/tariff').then((i) => { setInfo(i); setVals({ baseTiyin: i.current.baseTiyin, perKmTiyin: i.current.perKmTiyin, perMinTiyin: i.current.perMinTiyin, minFareTiyin: i.current.minFareTiyin }); })
      .catch((e) => setMsg(errorText(e)));
  }, []);
  if (!info || !vals) return <Screen><T v="title">{t.tariffTitle}</T><ErrorNote text={msg} /></Screen>;

  // Example: 8 km, 20 minutes, like the passenger app shows.
  const fare = (v: Record<Key, number>) => Math.max(v.minFareTiyin, v.baseTiyin + 8 * v.perKmTiyin + 20 * v.perMinTiyin);
  const changed = KEYS.some(({ k }) => vals[k] !== info.current[k]);
  const pct = Math.round(((fare(vals) - fare(info.recommended)) / fare(info.recommended)) * 100);

  return (
    <Screen footer={<Button title={t.save} busy={busy} disabled={!changed} onPress={async () => {
      setBusy(true); setMsg(null);
      try { await api('/drivers/me/tariff', { method: 'PUT', body: vals }); setInfo({ ...info, current: { ...vals, version: info.current.version + 1 } }); setMsg('✓'); }
      catch (e) { setMsg(errorText(e)); } finally { setBusy(false); }
    }} />}>
      <T v="title">{t.tariffTitle}</T>
      <T muted>{t.tariffHint}</T>
      <Card tone="sunken">
        <T v="caption" muted>8 {t.km} · 20 {t.min}</T>
        <Row style={{ justifyContent: 'space-between' }}><T v="display">{money(Math.round(fare(vals) / 50_000) * 50_000, lang)}</T><Pill tone={pct < 0 ? 'ok' : 'neutral'}>{pct}%</Pill></Row>
      </Card>
      {KEYS.map(({ k, label, step }) => {
        const b = info.bounds[k];
        const set = (v: number) => setVals({ ...vals, [k]: Math.min(b.max, Math.max(b.min, v)) });
        return (
          <Card key={k}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="bodyStrong">{t[label]}</T>
              <T v="caption" muted>{t.recommended}: {money(info.recommended[k], lang)}</T>
            </Row>
            <Row style={{ flexWrap: 'nowrap', justifyContent: 'space-between' }}>
              <Stepper sign="−" disabled={vals[k] <= b.min} onPress={() => set(vals[k] - step)} />
              <T v="price">{money(vals[k], lang)}</T>
              <Stepper sign="+" disabled={vals[k] >= b.max} onPress={() => set(vals[k] + step)} />
            </Row>
            <T v="caption" muted>{money(b.min, lang)} … {money(b.max, lang)}</T>
          </Card>
        );
      })}
      {msg && <T color={msg === '✓' ? c.success : c.danger}>{msg === '✓' ? '✓' : `${t.error}: ${msg}`}</T>}
    </Screen>
  );
}

function Stepper({ sign, onPress, disabled }: { sign: string; onPress: () => void; disabled: boolean }) {
  const { c } = useTheme();
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, opacity: disabled ? 0.35 : 1 }}>
      <T v="title">{sign}</T>
    </Pressable>
  );
}

interface Plans { plans: { code: string; name: string; priceTiyin: number; periodDays: number }[]; providers: string[] }

export function SubscriptionScreen() {
  const { t, lang } = useApp();
  const { c } = useTheme();
  const [sub, setSub] = useState<{ active: boolean; activeUntil: string | null } | null>(null);
  const [plans, setPlans] = useState<Plans | null>(null);
  const [plan, setPlan] = useState('week');
  const [provider, setProvider] = useState('payme');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    api<typeof sub>('/drivers/me/subscription').then(setSub).catch(() => {});
    api<Plans>('/subscription-plans').then((p) => { setPlans(p); if (p.providers[0] && !p.providers.includes(provider)) setProvider(p.providers[0]); }).catch(() => {});
  };
  useEffect(load, []);

  return (
    <Screen footer={<Button title={t.pay} busy={busy} disabled={!plans} onPress={async () => {
      setBusy(true); setError(null);
      try {
        const r = await api<{ paymentId: string; checkoutUrl: string | null }>('/drivers/me/subscriptions', { body: { planCode: plan, provider } });
        if (r.checkoutUrl) await WebBrowser.openBrowserAsync(r.checkoutUrl);
        // After returning from the payment page: check the result (the provider confirms to our server).
        for (let i = 0; i < 10; i++) {
          const p = await api<{ status: string }>(`/payments/${r.paymentId}`);
          if (p.status !== 'pending') break;
          await new Promise((res) => setTimeout(res, 1500));
        }
        load();
      } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    }} />}>
      <T v="title">{t.subscriptionTitle}</T>
      <Card tone={sub?.active ? 'sunken' : 'warm'}>
        <T v="caption" color={sub?.active ? c.inkMuted : c.warmInk}>{t.activeUntil}</T>
        <T v="price" color={sub?.active ? c.ink : c.warmInk}>{date(sub?.activeUntil)}</T>
      </Card>
      <T muted>{t.subscriptionHint}</T>
      <View style={{ gap: space.s2 }}>
        {plans?.plans.map((p) => {
          const on = p.code === plan;
          return (
            <Pressable key={p.code} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => setPlan(p.code)}
              style={{ borderRadius: radius.lg, padding: space.s4, borderWidth: on ? 2 : 1, borderColor: on ? c.brand : c.border, backgroundColor: c.surfaceCard }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T v="heading">{p.name}</T>
                <T v="price">{money(p.priceTiyin, lang)}</T>
              </Row>
              <T v="caption" muted>{money(Math.round(p.priceTiyin / p.periodDays), lang)} / {lang === 'uz' ? 'kun' : lang === 'ru' ? 'день' : 'day'}</T>
            </Pressable>
          );
        })}
      </View>
      {plans && plans.providers.length > 1 && (
        <Seg value={provider} onChange={setProvider} options={plans.providers.map((p) => ({ value: p, label: p === 'payme' ? 'Payme' : p === 'click' ? 'Click' : p === 'uzum' ? 'Uzum' : p }))} />
      )}
      <ErrorNote text={error} />
    </Screen>
  );
}

export function ProfileScreen() {
  const { t, lang, setLang, driver, logout } = useApp();
  const { mode, setMode } = useTheme();
  const v = driver?.vehicles[0];
  return (
    <Screen footer={<Button kind="secondary" title={t.logout} onPress={logout} />}>
      <T v="title">{t.profile}</T>
      <Card>
        <T v="heading">{driver?.name}</T>
        <T muted>{driver?.phone}</T>
        {v && <T>{v.make_model}, {v.year} · {v.color} · {plate(v.plate)}</T>}
        <Row>{v?.class_code && <Pill tone="brand">{v.class_code}</Pill>}{driver?.rating ? <Pill tone="ok">★ {driver.rating.toFixed(2)}</Pill> : null}</Row>
      </Card>
      <T v="caption" muted>{t.language}</T>
      <Seg<Lang> value={lang} onChange={setLang} options={[{ value: 'uz', label: 'Oʻzbekcha' }, { value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' }]} />
      <T v="caption" muted>{t.theme}</T>
      <Seg<ThemeMode> value={mode} onChange={setMode} options={[{ value: 'auto', label: t.themeAuto }, { value: 'day', label: t.themeDay }, { value: 'night', label: t.themeNight }]} />
    </Screen>
  );
}
