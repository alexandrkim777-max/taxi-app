// Becoming a driver: name and car, document photos, waiting for moderation.

import { useState } from 'react';
import { Image, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api, DEMO, errorText, uploadPhoto } from '../api';
import { useApp } from '../context';
import { plate } from '../format';
import { radius, space, useTheme } from '../theme';
import { Button, Card, ErrorNote, Field, Pill, Row, Screen, T, Tiles } from '../components/ui';

export const DOC_TYPES = ['passport', 'license', 'vehicle_registration', 'selfie', 'self_employed'] as const;

export function ApplyScreen() {
  const { t, reloadDriver, driver } = useApp();
  const [name, setName] = useState(driver?.name ?? '');
  const [makeModel, setMakeModel] = useState('Chevrolet Cobalt');
  const [year, setYear] = useState('');
  const [color, setColor] = useState('');
  const [plateText, setPlate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length >= 2 && makeModel.trim().length >= 2 && /^\d{4}$/.test(year) && color.trim().length >= 2 && plateText.replace(/\s/g, '').length >= 5;
  return (
    <Screen footer={<Button title={t.next} busy={busy} disabled={!valid} onPress={async () => {
      setBusy(true); setError(null);
      try {
        await api('/drivers/apply', { body: { name: name.trim() } });
        await api('/drivers/me/vehicles', { body: { makeModel: makeModel.trim(), year: Number(year), color: color.trim(), plate: plateText } });
        await reloadDriver();
      } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
    }} />}>
      <Tiles />
      <T v="title">{t.applyTitle}</T>
      <Field label={t.yourName} value={name} onChangeText={setName} autoCapitalize="words" maxLength={80} />
      <T v="heading">{t.car}</T>
      <Field label={t.makeModel} value={makeModel} onChangeText={setMakeModel} maxLength={60} />
      <Row gap={space.s3} style={{ flexWrap: 'nowrap' }}>
        <View style={{ flex: 1 }}><Field label={t.year} value={year} onChangeText={(v) => setYear(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={4} /></View>
        <View style={{ flex: 1 }}><Field label={t.color} value={color} onChangeText={setColor} maxLength={30} /></View>
      </Row>
      <Field label={t.plate} value={plateText} onChangeText={(v) => setPlate(v.toUpperCase())} placeholder="01 A 123 BC" autoCapitalize="characters" maxLength={16} />
      <ErrorNote text={error} />
    </Screen>
  );
}

export function DocumentsScreen({ onDone }: { onDone: () => void }) {
  const { t, driver, reloadDriver } = useApp();
  const { c } = useTheme();
  const [busyType, setBusyType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docs = driver?.documents ?? [];

  async function pick(type: string, camera: boolean) {
    setError(null);
    if (DEMO) {
      // Demo: no camera; pretend a photo was taken.
      setBusyType(type);
      try { await uploadPhoto(`/drivers/me/documents/${type}/photo`, ''); await reloadDriver(); } finally { setBusyType(null); }
      return;
    }
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : { granted: true };
    if (!perm.granted) return;
    const res = camera
      ? await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: false, exif: false })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.6, mediaTypes: ImagePicker.MediaTypeOptions.Images, exif: false });
    if (res.canceled || !res.assets[0]) return;
    setBusyType(type);
    try { await uploadPhoto(`/drivers/me/documents/${type}/photo`, res.assets[0].uri); await reloadDriver(); }
    catch (err) { setError(errorText(err)); } finally { setBusyType(null); }
  }

  const missing = driver?.missingDocuments ?? [...DOC_TYPES];
  return (
    <Screen footer={<Button title={t.sendForReview} disabled={missing.length > 0} onPress={onDone} />}>
      <Tiles />
      <T v="title">{t.docsTitle}</T>
      <T muted>{t.docsHint}</T>
      {DOC_TYPES.map((type) => {
        const doc = docs.find((d) => d.type === type);
        return (
          <Card key={type}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="bodyStrong">{t.docs[type]}</T>
              {doc ? <Pill tone={doc.status === 'approved' ? 'ok' : 'warm'}>{t.uploaded}</Pill> : <Pill tone="bad">{t.missing}</Pill>}
            </Row>
            {doc?.fileUrl ? <Image source={{ uri: doc.fileUrl }} style={{ width: '100%', aspectRatio: 16 / 10, borderRadius: radius.sm, backgroundColor: c.surfaceSunken }} resizeMode="cover" /> : null}
            {doc?.note ? <T color={c.danger}>{doc.note}</T> : null}
            {!doc && driver?.rejections?.find((r) => r.type === type) ? <T color={c.danger}>{driver.rejections.find((r) => r.type === type)!.note}</T> : null}
            <Row>
              <View style={{ flex: 1, minWidth: 140 }}><Button compact kind={doc ? 'secondary' : 'primary'} busy={busyType === type} title={doc ? t.retake : t.takePhoto} onPress={() => pick(type, !DEMO)} /></View>
              {!DEMO && <View style={{ flex: 1, minWidth: 140 }}><Button compact kind="secondary" title={t.fromGallery} onPress={() => pick(type, false)} /></View>}
            </Row>
          </Card>
        );
      })}
      <ErrorNote text={error} />
    </Screen>
  );
}

export function PendingScreen({ onFixDocs }: { onFixDocs: () => void }) {
  const { t, driver, reloadDriver } = useApp();
  const { c } = useTheme();
  const rejected = driver?.status === 'rejected';
  const notes = (driver?.rejections ?? []).map((r) => ({ id: r.type, type: r.type, note: r.note }));
  const v = driver?.vehicles[0];
  return (
    <Screen footer={<>
      {(rejected || (driver?.missingDocuments.length ?? 0) > 0) && <Button title={t.fixDocs} onPress={onFixDocs} />}
      {DEMO && <Button kind="secondary" title={t.demoApprove} onPress={async () => { await api('/demo/approve', { body: {} }); await reloadDriver(); }} />}
    </>}>
      <Tiles />
      <T v="title">{rejected ? t.rejectedTitle : t.pendingTitle}</T>
      <T muted>{t.pendingHint}</T>
      <Card>
        <T v="heading">{driver?.name}</T>
        {v && <T muted>{v.make_model}, {v.year} · {v.color} · {plate(v.plate)}</T>}
        <Row>{DOC_TYPES.map((d) => (
          <Pill key={d} tone={driver?.missingDocuments.includes(d) ? 'bad' : 'ok'}>{t.docs[d]}</Pill>
        ))}</Row>
      </Card>
      {notes.map((d) => <Card key={d.id} tone="warm"><T v="bodyStrong" color={c.warmInk}>{t.docs[d.type as keyof typeof t.docs]}</T><T color={c.warmInk}>{d.note}</T></Card>)}
    </Screen>
  );
}
