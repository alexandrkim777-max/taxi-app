// End of the ride: the receipt, stars and "what did you like" tags for the driver's rating.
// Also the short notice when the driver cancelled or nobody was found.

import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useApp } from '../context';
import { money } from '../format';
import { space, useTheme } from '../theme';
import type { Ride } from '../types';
import { Button, Card, Chip, ErrorNote, Field, Row, Screen, Stars, T, Tiles } from '../components/ui';

interface Tags { maxTags: number; positive: { code: string; label: string }[]; negative: { code: string; label: string }[] }

export function RateScreen({ ride, onDone }: { ride: Ride; onDone: () => void }) {
  const { t, lang, err, push } = useApp();
  const { c } = useTheme();
  const [score, setScore] = useState(0);
  const [tags, setTags] = useState<Tags | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => { api<Tags>('/rating-tags?about=driver').then(setTags).catch(() => {}); }, []);
  useEffect(() => { setPicked([]); }, [score >= 4]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = score === 0 ? [] : score >= 4 ? tags?.positive ?? [] : tags?.negative ?? [];
  const needsReason = score > 0 && score < 4 && picked.length === 0 && reason.trim().length < 3;
  const fare = ride.priceTiyin ?? 0;
  const waiting = ride.waiting?.chargedTiyin ?? 0;

  if (sent) {
    return (
      <Screen footer={<Button title={t.ok} onPress={onDone} />}>
        <Tiles />
        <T v="display">{t.thanks}</T>
        <Stars value={score} size={32} />
      </Screen>
    );
  }

  return (
    <Screen footer={<>
      <Button title={t.send} busy={busy} disabled={score === 0 || needsReason} onPress={async () => {
        setBusy(true); setError(null);
        try {
          await api(`/rides/${ride.id}/rating`, { body: { score, tags: picked, ...(reason.trim() ? { reason: reason.trim() } : {}) } });
          setSent(true);
        } catch (e) { setError(err(e)); } finally { setBusy(false); }
      }} />
      <Button kind="ghost" compact title={t.skip} onPress={onDone} />
    </>}>
      <Tiles />
      <Card tone="sunken">
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="caption" muted>{t.total}</T>
          <T v="caption" muted>{ride.payment.method === 'cash' ? t.cash : t.card}</T>
        </Row>
        <T v="display">{money(fare, lang)}</T>
        {waiting > 0 && <T v="caption" muted>{t.ride} {money(fare - waiting, lang)} + {t.waiting} {money(waiting, lang)}</T>}
        <T muted numberOfLines={1}>{ride.stops[0]?.address} → {ride.stops[ride.stops.length - 1]?.address}</T>
      </Card>
      <T v="title">{t.rateTitle}</T>
      {ride.driver && <T muted>{ride.driver.name} · {ride.driver.vehicle.color} {ride.driver.vehicle.makeModel}</T>}
      <Stars value={score} onChange={setScore} />
      {list.length > 0 && <T v="heading">{score >= 4 ? t.liked : t.disliked}</T>}
      <Row>
        {list.map((x) => {
          const on = picked.includes(x.code);
          return <Chip key={x.code} label={x.label} selected={on} tone={score < 4 ? 'warm' : undefined}
            onPress={() => setPicked((p) => (on ? p.filter((y) => y !== x.code) : p.length < (tags?.maxTags ?? 5) ? [...p, x.code] : p))} />;
        })}
      </Row>
      {score > 0 && <Field label={t.reason} value={reason} onChangeText={setReason} maxLength={300} multiline />}
      {score > 0 && score < 4 && (
        <View>
          <Button kind="ghost" compact title={blocked ? `✓ ${t.blockedDone}` : t.blockDriver} disabled={blocked}
            onPress={() => api(`/rides/${ride.id}/block-driver`, { body: {} }).then(() => setBlocked(true)).catch((e) => setError(err(e)))} />
          <Button kind="ghost" compact title={`${t.complaint} / ${t.dispute}`} onPress={() => push({ name: 'rideDetails', rideId: ride.id })} />
        </View>
      )}
      <ErrorNote text={error} />
      {needsReason && <T v="caption" color={c.inkMuted}>{t.disliked}</T>}
    </Screen>
  );
}

export function EndedNotice({ ride, onDone, onAgain }: { ride: Ride; onDone: () => void; onAgain: () => void }) {
  const { t, lang } = useApp();
  const { c } = useTheme();
  const noDrivers = ride.cancelledBy === 'system';
  return (
    <Screen footer={<>
      <Button title={t.orderAgain} onPress={onAgain} />
      <Button kind="ghost" compact title={t.ok} onPress={onDone} />
    </>}>
      <Tiles />
      <T v="title">{t.cancelled}</T>
      <Card tone="warm"><T color={c.warmInk}>{noDrivers ? t.noDriversFound : t.cancelledByDriver}</T></Card>
      <T muted>{ride.stops[0]?.address} → {ride.stops[ride.stops.length - 1]?.address}</T>
      {ride.priceTiyin ? <T muted>{money(ride.priceTiyin, lang)}</T> : null}
      <View style={{ height: space.s2 }} />
    </Screen>
  );
}
