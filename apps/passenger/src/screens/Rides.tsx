// Ride history and one ride's details, with a complaint or a dispute (both sides write what happened).

import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { api, ApiError } from '../api';
import { useApp } from '../context';
import { date, money, plate, time } from '../format';
import { space, useTheme } from '../theme';
import type { DisputeView, PastRide } from '../types';
import { Button, Card, Chip, Divider, ErrorNote, Field, Header, ListRow, Pill, Row, Screen, T } from '../components/ui';

const COMPLAINT_TYPES = ['rude', 'unsafe_driving', 'asked_extra_cash', 'car_mismatch', 'harassment', 'lost_item', 'price', 'other'] as const;
const CATEGORIES = ['price', 'route', 'behavior', 'cancellation', 'vehicle', 'lost_item', 'safety', 'other'] as const;

export function RidesScreen() {
  const { t, lang, push, pop } = useApp();
  const [rides, setRides] = useState<PastRide[] | null>(null);
  useEffect(() => { api<PastRide[]>('/me/rides').then(setRides).catch(() => setRides([])); }, []);
  return (
    <Screen>
      <Header title={t.myRides} onBack={pop} />
      {rides?.length === 0 && <T muted>{t.noRides}</T>}
      {rides?.map((r, i) => (
        <View key={r.id}>
          {i > 0 && <Divider />}
          <ListRow
            title={r.to?.address ?? '—'}
            subtitle={`${date(r.createdAt)} ${time(r.createdAt)} · ${r.status === 'completed' ? money(r.priceTiyin, lang) : t.cancelled}`}
            onPress={() => push({ name: 'rideDetails', rideId: r.id })}
          />
        </View>
      ))}
    </Screen>
  );
}

export function RideDetailsScreen({ rideId }: { rideId: string }) {
  const { t, lang, pop, err } = useApp();
  const { c } = useTheme();
  const [ride, setRide] = useState<PastRide | null>(null);
  const [dispute, setDispute] = useState<DisputeView | null>(null);
  const [form, setForm] = useState<'none' | 'complaint' | 'dispute' | 'statement'>('none');
  const [kind, setKind] = useState<string>('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await api<PastRide[]>('/me/rides').catch(() => []);
    setRide(list.find((r) => r.id === rideId) ?? null);
    try { setDispute(await api<DisputeView>(`/rides/${rideId}/dispute`)); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) setError(err(e)); }
  }, [rideId, err]);
  useEffect(() => { load(); }, [load]);

  async function submit() {
    setBusy(true); setError(null);
    try {
      if (form === 'complaint') {
        await api(`/rides/${rideId}/complaint`, { body: { type: kind, text: text.trim() } });
        setNote(t.complaintSent);
      } else if (form === 'dispute') {
        setDispute(await api<DisputeView>(`/rides/${rideId}/dispute`, { body: { category: kind, text: text.trim() } }));
      } else if (form === 'statement') {
        setDispute(await api<DisputeView>(`/rides/${rideId}/dispute/statement`, { body: { text: text.trim() } }));
      }
      setForm('none'); setText(''); setKind('');
    } catch (e) { setError(err(e)); } finally { setBusy(false); }
  }

  const options = form === 'complaint' ? COMPLAINT_TYPES.map((x) => ({ code: x, label: t.types[x] }))
    : form === 'dispute' ? CATEGORIES.map((x) => ({ code: x, label: t.categories[x] })) : [];
  const valid = text.trim().length >= (form === 'complaint' ? 5 : 10) && (form === 'statement' || kind !== '');

  return (
    <Screen footer={form !== 'none' ? <>
      <Button title={t.send} busy={busy} disabled={!valid} onPress={submit} />
      <Button kind="ghost" compact title={t.back} onPress={() => { setForm('none'); setError(null); }} />
    </> : undefined}>
      <Header title={ride ? `${date(ride.createdAt)} ${time(ride.createdAt)}` : t.ride} onBack={pop} />
      {ride && (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="display">{ride.status === 'completed' ? money(ride.priceTiyin, lang) : ride.cancelFeeTiyin ? money(ride.cancelFeeTiyin, lang) : '—'}</T>
            <Pill tone={ride.status === 'completed' ? 'ok' : 'warm'}>{ride.status === 'completed' ? t.completed : t.cancelled}</Pill>
          </Row>
          <T>{ride.fromAddress} → {ride.to?.address}</T>
          {ride.driverName && <T muted>{ride.driverName} · {ride.makeModel} · {plate(ride.plate)}</T>}
          <T v="caption" muted>{ride.paymentMethod === 'cash' ? t.cash : t.card}</T>
          {ride.refundedTiyin ? <T v="bodyStrong" color={c.success}>{t.refunded}: {money(ride.refundedTiyin, lang)}</T> : null}
        </Card>
      )}

      {dispute && (
        <Card tone="sunken">
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="heading">{t.dispute}: {t.categories[dispute.category as keyof typeof t.categories] ?? dispute.category}</T>
            <Pill tone={dispute.status === 'resolved' ? 'ok' : 'neutral'}>{dispute.status === 'resolved' ? t.disputeResolved : t.disputeWaiting}</Pill>
          </Row>
          {dispute.myStatement && <><T v="caption" muted>{t.yourAccount}</T><T>{dispute.myStatement.text}</T></>}
          {dispute.otherStatement && <><T v="caption" muted>{t.theirAccount}</T><T>{dispute.otherStatement.text}</T></>}
          {dispute.resolution && <T v="bodyStrong">{dispute.resolution}</T>}
          {dispute.awaitingMe && form === 'none' && <Button compact title={t.send} onPress={() => setForm('statement')} />}
        </Card>
      )}

      {note && <Card tone="sunken"><T color={c.success}>{note}</T></Card>}

      {form === 'none' && ride?.driverName && (
        <Row>
          <Chip label={t.complaint} onPress={() => { setForm('complaint'); setNote(null); }} />
          {!dispute && <Chip label={t.openDispute} onPress={() => { setForm('dispute'); setNote(null); }} />}
          {note !== t.blockedDone && <Chip tone="warm" label={t.blockDriver} onPress={() => api(`/rides/${rideId}/block-driver`, { body: {} }).then(() => setNote(t.blockedDone)).catch((e) => setError(err(e)))} />}
        </Row>
      )}

      {form !== 'none' && (
        <View style={{ gap: space.s3 }}>
          {form === 'dispute' && <T muted>{t.disputeHint}</T>}
          {options.length > 0 && <Row>{options.map((o) => <Chip key={o.code} label={o.label} selected={kind === o.code} onPress={() => setKind(o.code)} />)}</Row>}
          <Field label={form === 'complaint' ? t.complaint : t.yourAccount} value={text} onChangeText={setText} maxLength={2000} multiline />
          {form !== 'complaint' && <T v="caption" muted>{t.textMin}</T>}
        </View>
      )}
      <ErrorNote text={error} />
    </Screen>
  );
}
