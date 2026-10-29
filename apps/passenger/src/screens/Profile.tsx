// Profile (name, language, theme, blocked drivers, sign out, delete account), saved places, cards,
// debts, about.

import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { api, DEMO } from '../api';
import { CARD_PROVIDER, expiryOk, luhnOk, ProviderSdkMissing, tokenizeCard } from '../cards';
import { useApp } from '../context';
import type { Lang } from '../i18n';
import { money, plate } from '../format';
import { Icon } from '../components/icons';
import { space, useTheme, type ThemeMode } from '../theme';
import type { Card as PayCard, SavedPlace } from '../types';
import { Badge, Button, Card, Chip, Divider, ErrorNote, Field, Header, ListRow, Pill, Row, Screen, Seg, T, Tiles } from '../components/ui';

const APP_VERSION = '0.1.0';

export function ProfileScreen() {
  const { t, lang, setLang, me, setMe, logout, push, pop, err } = useApp();
  const { c, mode, setMode } = useTheme();
  const [name, setName] = useState(me?.name ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<unknown[]>('/me/blocked-drivers').then((l) => setBlocked(l.length)).catch(() => {}); }, []);
  return (
    <Screen>
      <Header title={t.profile} onBack={pop} />
      <T v="label" muted>{t.personalData}</T>
      <Card>
        <T muted>{me?.phone}</T>
        <Field label={t.name} value={name} onChangeText={(v) => { setName(v); setSaved(false); }} maxLength={80} autoCapitalize="words" />
        <Button compact kind="secondary" title={saved ? '✓' : t.save} disabled={name.trim().length < 2 || name.trim() === me?.name}
          onPress={async () => {
            try { await api('/me', { method: 'PATCH', body: { name: name.trim() } }); if (me) setMe({ ...me, name: name.trim() }); setSaved(true); }
            catch (e) { setError(err(e)); }
          }} />
      </Card>
      <T v="caption" muted>{t.language}</T>
      <Seg<Lang> value={lang} onChange={setLang} options={[{ value: 'uz', label: 'Oʻzbekcha' }, { value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' }]} />
      <T v="caption" muted>{t.theme}</T>
      <Seg<ThemeMode> value={mode} onChange={setMode} options={[{ value: 'auto', label: t.themeAuto }, { value: 'day', label: t.themeDay }, { value: 'night', label: t.themeNight }]} />
      <Divider />
      <ListRow lead={<Icon name="block" />} title={t.blacklist} right={<T muted>{blocked ?? ''}</T>} onPress={() => push({ name: 'blocked' })} />
      <ListRow lead={<Icon name="logout" />} title={t.logout} onPress={logout} right={<View />} />
      <ListRow lead={<Icon name="trash" color={c.danger} />} title={t.deleteAccount} onPress={() => setConfirmDelete(true)} right={<View />} />
      {confirmDelete && (
        <Card tone="warm">
          <T v="heading" color={c.warmInk}>{t.deleteAccount}</T>
          <T color={c.warmInk}>{t.deleteConfirm}</T>
          <Button kind="danger" title={t.deleteForever} busy={busy} onPress={async () => {
            setBusy(true); setError(null);
            try { await api('/me', { method: 'DELETE', body: { confirm: true } }); logout(); }
            catch (e) { setError(err(e)); } finally { setBusy(false); }
          }} />
          <Button kind="secondary" title={t.back} onPress={() => setConfirmDelete(false)} />
        </Card>
      )}
      <ErrorNote text={error} />
    </Screen>
  );
}

export function BlockedScreen() {
  const { t, pop, err } = useApp();
  const [list, setList] = useState<{ id: string; driverName: string | null; makeModel: string | null; plate: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api<NonNullable<typeof list>>('/me/blocked-drivers').then(setList).catch((e) => setError(err(e))); }, [err]);
  useEffect(load, [load]);
  return (
    <Screen>
      <Header title={t.blacklist} onBack={pop} />
      {list?.length === 0 && <T muted>{t.noBlocked}</T>}
      {list?.map((b) => (
        <ListRow key={b.id} lead={<Icon name="block" />} title={b.driverName ?? '—'} subtitle={[b.makeModel, b.plate ? plate(b.plate) : null].filter(Boolean).join(' · ')}
          right={<Chip label={t.remove} onPress={() => api(`/me/blocked-drivers/${b.id}`, { method: 'DELETE' }).then(load).catch((e) => setError(err(e)))} />} />
      ))}
      <ErrorNote text={error} />
    </Screen>
  );
}

export function AboutScreen() {
  const { t, pop } = useApp();
  return (
    <Screen>
      <Header title={t.about} onBack={pop} />
      <Tiles />
      <T v="title">Taxi</T>
      <T>{t.aboutText}</T>
      <T v="caption" muted>{t.mapData}</T>
      <T v="caption" muted>{t.version} {APP_VERSION}</T>
    </Screen>
  );
}

export function PlacesScreen() {
  const { t, pop, push, err } = useApp();
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api<SavedPlace[]>('/me/places').then(setPlaces).catch((e) => setError(err(e))); }, [err]);
  useEffect(load, [load]);
  const set = (kind: 'home' | 'work') => push({
    name: 'search', purpose: kind,
    onPick: (s) => api(`/me/places/${kind}`, { method: 'PUT', body: { address: s.address, lat: s.lat, lng: s.lng } }).then(load).catch((e) => setError(err(e))),
  });
  const home = places.find((p) => p.kind === 'home');
  const work = places.find((p) => p.kind === 'work');
  return (
    <Screen footer={<Button kind="secondary" title={`+ ${t.addPlace}`} onPress={() => push({
      name: 'search', purpose: 'other',
      onPick: (s) => api('/me/places', { body: { address: s.address, lat: s.lat, lng: s.lng, label: s.address.split(',')[0]!.slice(0, 40) } }).then(load).catch((e) => setError(err(e))),
    })} />}>
      <Header title={t.places} onBack={pop} />
      <ListRow lead={<Badge text="⌂" />} title={t.home} subtitle={home?.address ?? t.setHome} onPress={() => set('home')} />
      <ListRow lead={<Badge text="▣" />} title={t.work} subtitle={work?.address ?? t.setWork} onPress={() => set('work')} />
      {places.filter((p) => p.kind === 'other').map((p) => (
        <ListRow key={p.id} lead={<Badge text="★" />} title={p.label || p.address} subtitle={p.address}
          right={<Chip label={t.delete} onPress={() => api(`/me/places/${p.id}`, { method: 'DELETE' }).then(load).catch((e) => setError(err(e)))} />} />
      ))}
      <ErrorNote text={error} />
    </Screen>
  );
}

export function CardsScreen({ onPick }: { onPick?: (c: PayCard) => void }) {
  const { t, pop, push, err } = useApp();
  const [cards, setCards] = useState<PayCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api<PayCard[]>('/me/cards').then(setCards).catch((e) => setError(err(e))); }, [err]);
  useEffect(load, [load]);
  return (
    <Screen footer={<Button kind={onPick ? 'secondary' : 'primary'} title={`+ ${t.addCard}`} onPress={() => push({ name: 'addCard', onAdded: (c) => { load(); if (onPick) { pop(); onPick(c); } } })} />}>
      <Header title={t.cards} onBack={pop} />
      {cards.map((card) => (
        <Card key={card.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="heading">{card.panMasked}</T>
            {card.isDefault && <Pill tone="ok">{t.defaultCard}</Pill>}
          </Row>
          <T v="caption" muted>{card.provider.toUpperCase()} · {card.expiry}</T>
          <Row>
            {onPick && <Chip label={t.choose} selected onPress={() => { pop(); onPick(card); }} />}
            {!onPick && !card.isDefault && <Chip label={t.makeDefault} onPress={() => api(`/me/cards/${card.id}/default`, { body: {} }).then(load).catch((e) => setError(err(e)))} />}
            {!onPick && <Chip label={t.delete} tone="warm" onPress={() => api(`/me/cards/${card.id}`, { method: 'DELETE' }).then(load).catch((e) => setError(err(e)))} />}
          </Row>
        </Card>
      ))}
      <ErrorNote text={error} />
    </Screen>
  );
}

export function AddCardScreen({ onAdded }: { onAdded?: (c: PayCard) => void }) {
  const { t, pop, err } = useApp();
  const { c } = useTheme();
  const [pan, setPan] = useState('');
  const [exp, setExp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = pan.replace(/\D/g, '');
  const valid = luhnOk(digits) && expiryOk(exp);
  return (
    <Screen footer={<Button title={t.addCard} busy={busy} disabled={!valid} onPress={async () => {
      setBusy(true); setError(null);
      try {
        const token = await tokenizeCard(CARD_PROVIDER, digits, exp);
        const card = await api<PayCard>('/me/cards', { body: { provider: CARD_PROVIDER, token } });
        setPan(''); setExp('');
        pop(); onAdded?.(card);
      } catch (e) {
        setError(e instanceof ProviderSdkMissing ? t.errors.provider_sdk_not_connected! : err(e));
      } finally { setBusy(false); }
    }} />}>
      <Header title={t.addCard} onBack={pop} />
      <Field label={t.cardNumber} value={pan} keyboardType="number-pad" maxLength={23} autoFocus placeholder="8600 0000 0000 0000"
        onChangeText={(v) => setPan(v.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 '))} />
      <View style={{ width: 140 }}>
        <Field label={t.cardExpiry} value={exp} keyboardType="number-pad" maxLength={5} placeholder="MM/YY"
          onChangeText={(v) => { const d = v.replace(/\D/g, '').slice(0, 4); setExp(d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d); }} />
      </View>
      <T v="caption" muted>{t.cardSafe}</T>
      {DEMO && <T v="caption" color={c.warmInk}>Demo: 8600 1234 5678 9012 — works; 8600 0000 0000 0502 — no money on it (the 60% charge fails).</T>}
      <ErrorNote text={error} />
    </Screen>
  );
}

export function DebtsScreen() {
  const { t, lang, pop, push, err } = useApp();
  const { c } = useTheme();
  const [debts, setDebts] = useState<{ totalTiyin: number; items: { rideId: string; kind: string; amountTiyin: number }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api<typeof debts>('/me/debts').then(setDebts).catch((e) => setError(err(e))); }, [err]);
  useEffect(load, [load]);
  const payWith = (card: PayCard) => {
    setBusy(true); setError(null);
    api('/me/debts/pay', { body: { cardId: card.id } }).then(load).catch((e) => setError(err(e))).finally(() => setBusy(false));
  };
  return (
    <Screen footer={debts && debts.totalTiyin > 0 ? <Button title={t.payDebt} busy={busy} onPress={() => push({ name: 'cards', onPick: payWith })} /> : undefined}>
      <Header title={t.debts} onBack={pop} />
      {debts && debts.totalTiyin === 0 && <Card tone="sunken"><T color={c.success}>✓ 0</T></Card>}
      {debts && debts.totalTiyin > 0 && (
        <Card tone="warm">
          <T v="display" color={c.warmInk}>{money(debts.totalTiyin, lang)}</T>
          <T color={c.warmInk}>{t.debtHint}</T>
        </Card>
      )}
      {debts?.items.map((d) => <ListRow key={`${d.rideId}-${d.kind}`} title={d.kind === 'ride' ? t.ride : t.cancelPart} right={<T v="bodyStrong">{money(d.amountTiyin, lang)}</T>} />)}
      <ErrorNote text={error} />
    </Screen>
  );
}
