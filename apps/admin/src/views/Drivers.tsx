import { useState } from 'react';
import { api } from '../api';
import { date, dateTime, phone, plate, sum } from '../format';
import { Action, complaintLabel, Copy, ErrorBox, Loading, PageHead, Pill, Seg, StatusPill, tr, useApp, useLoad } from '../ui';

const CLASSES = ['economy', 'comfort', 'business', 'minivan'];

interface Vehicle { id: string; make_model: string; year: number; color: string; plate: string; class_code: string | null }
interface Doc { id: string; type: string; status: string; note: string | null; fileUrl: string; created_at: string }
interface Driver {
  id: string; userId?: string; status: string; name: string; phone: string; rating: number | null; ratingCount?: number;
  vehicles: Vehicle[]; documents: Doc[]; missingDocuments: string[]; created_at?: string;
  subscriptionUntil?: string | null; pausedUntil?: string | null;
  stats?: { completed: number; cancelledByDriver: number; completed30d: number; earned30dTiyin: number };
  tags?: { code: string; count: number }[] | null;
  complaints?: { id: string; type: string; severity: string; status: string; createdAt: string }[];
  blocks?: { id: string; reason: string; until: string | null; appealStatus: string; createdAt: string }[];
  recentRides?: { id: string; status: string; priceTiyin: number; createdAt: string }[];
}

export function Moderation() {
  const { t, lang, go } = useApp();
  const [status, setStatus] = useState<'pending' | 'verified' | 'blocked' | 'rejected'>('pending');
  const { data, error, loading } = useLoad(() => api<Driver[]>(`/admin/drivers?status=${status}`), [status]);
  const { status: st, label } = tr(lang);
  return (
    <>
      <PageHead title={t.nav.moderation} sub={t.pendingDrivers}>
        <Seg value={status} onChange={setStatus} options={(['pending', 'verified', 'blocked', 'rejected'] as const).map((s) => ({ value: s, label: st(s) }))} />
      </PageHead>
      {loading && !data ? <Loading /> : error ? <ErrorBox text={error} /> : (
        <div className="list">
          {data!.length === 0 && <p className="muted">{t.noPending}</p>}
          {data!.map((d) => (
            <button key={d.id} type="button" className="item" onClick={() => go(`driver-${d.id}`)}>
              <div className="main-col">
                <span className="title">{d.name}</span>
                <span className="muted small num">{phone(d.phone)} · {d.vehicles.map((v) => `${v.make_model}, ${plate(v.plate)}`).join('; ')}</span>
              </div>
              <div className="line" style={{ justifyContent: 'flex-end' }}>
                {d.missingDocuments.length > 0
                  ? <Pill kind="bad">{t.missingDocs}: {d.missingDocuments.map(label).join(', ')}</Pill>
                  : <Pill kind="ok">{t.docs} {d.documents.length}/5</Pill>}
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function DriverDossier({ id }: { id: string }) {
  const { t, lang, go, toast, refreshCounts } = useApp();
  const { data: d, error, loading, reload } = useLoad(() => api<Driver>(`/admin/drivers/${id}/dossier`), [id]);
  const [vehicleId, setVehicleId] = useState<string>('');
  const [cls, setCls] = useState('economy');
  const [reason, setReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [blockDays, setBlockDays] = useState('');
  const [docNote, setDocNote] = useState<Record<string, string>>({});
  const { label } = tr(lang);

  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBox text={error ?? ''} />;
  const blocked = (d.blocks ?? []).some((b) => b.appealStatus !== 'lifted' && (!b.until || new Date(b.until) > new Date()));
  const vId = vehicleId || d.vehicles[0]?.id || '';

  return (
    <>
      <PageHead back="moderation" title={d.name} sub={<span className="line"><StatusPill status={blocked ? 'blocked' : d.status} />
        {d.rating ? <Pill kind="brand">★ {d.rating.toFixed(2)} · {d.ratingCount}</Pill> : <Pill>{t.ratingNew}</Pill>}
        {d.pausedUntil && <Pill kind="warm">pause → {dateTime(d.pausedUntil)}</Pill>}</span>} />

      <div className="grid wide">
        <div className="card stack">
          <h2>{t.profile}</h2>
          <dl className="kv">
            <dt>{t.phone}</dt><dd><Copy text={d.phone} shown={phone(d.phone)} /></dd>
            <dt>{t.subscription}</dt><dd className="num">{d.subscriptionUntil ? date(d.subscriptionUntil) : '—'}</dd>
            {d.stats && <>
              <dt>{t.completedTotal}</dt><dd className="num">{d.stats.completed}</dd>
              <dt>{t.rides30}</dt><dd className="num">{d.stats.completed30d}</dd>
              <dt>{t.earned30}</dt><dd className="num">{sum(d.stats.earned30dTiyin, lang)}</dd>
              <dt>{t.cancelledByDriverTotal}</dt><dd className="num">{d.stats.cancelledByDriver}</dd>
            </>}
          </dl>
        </div>
        <div className="card stack">
          <h2>{t.cars}</h2>
          {d.vehicles.map((v) => (
            <div key={v.id} className="stack">
              <div className="line between"><b>{v.make_model}, {v.year}</b><Pill kind="brand">{v.class_code ?? '—'}</Pill></div>
              <span className="muted">{v.color} · <span className="num">{plate(v.plate)}</span></span>
              {d.status === 'verified' && (
                <div className="form">
                  <label className="field"><span>{t.klass}</span>
                    <select id={`cls-${v.id}`} defaultValue={v.class_code ?? 'economy'} onChange={(e) => setCls(e.target.value)}>
                      {CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select></label>
                  <label className="field"><span>{t.reason}</span><input id={`clsr-${v.id}`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                  <Action small disabled={reason.trim().length < 3} onRun={async () => {
                    await api(`/admin/drivers/${d.id}/vehicles/${v.id}/class`, { body: { classCode: cls, reason } });
                    toast(t.done); setReason(''); reload();
                  }}>{t.changeClass}</Action>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <section className="section">
        <div className="line between"><h2>{t.docs}</h2>
          {d.missingDocuments.length > 0 && <Pill kind="bad">{t.missingDocs}: {d.missingDocuments.map(label).join(', ')}</Pill>}</div>
        <div className="docs">
          {d.documents.map((doc) => (
            <div key={doc.id} className="card doc">
              <a href={doc.fileUrl} target="_blank" rel="noreferrer noopener"><img src={doc.fileUrl} alt={label(doc.type)} loading="lazy" /></a>
              <div className="line between"><b>{label(doc.type)}</b><StatusPill status={doc.status} /></div>
              <span className="muted small">{dateTime(doc.created_at)}</span>
              <input id={`note-${doc.id}`} type="text" placeholder={t.note} value={docNote[doc.id] ?? ''} onChange={(e) => setDocNote({ ...docNote, [doc.id]: e.target.value })} />
              <Action small disabled={(docNote[doc.id] ?? '').trim().length < 3} onRun={async () => {
                await api(`/admin/drivers/${d.id}/documents/${doc.id}/reject`, { body: { note: docNote[doc.id] } });
                toast(t.done); reload();
              }}>{t.rejectDoc}</Action>
            </div>
          ))}
        </div>
      </section>

      {d.status === 'pending' && (
        <div className="card stack">
          <h2>{t.approve} / {t.reject}</h2>
          <div className="form">
            {d.vehicles.length > 1 && (
              <label className="field"><span>{t.car}</span>
                <select id="approve-vehicle" value={vId} onChange={(e) => setVehicleId(e.target.value)}>
                  {d.vehicles.map((v) => <option key={v.id} value={v.id}>{v.make_model} {plate(v.plate)}</option>)}
                </select></label>
            )}
            <label className="field"><span>{t.klass}</span>
              <select id="approve-class" value={cls} onChange={(e) => setCls(e.target.value)}>
                {CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select></label>
            <Action kind="primary" disabled={d.missingDocuments.length > 0} onRun={async () => {
              await api(`/admin/drivers/${d.id}/approve`, { body: { vehicleId: vId, classCode: cls } });
              toast(t.done); refreshCounts(); reload();
            }}>{t.approve}</Action>
          </div>
          <div className="form">
            <label className="field full"><span>{t.reason}</span>
              <input id="reject-reason" type="text" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} /></label>
            <Action kind="danger" disabled={rejectReason.trim().length < 3} onRun={async () => {
              await api(`/admin/drivers/${d.id}/reject`, { body: { reason: rejectReason } });
              toast(t.done); refreshCounts(); go('moderation');
            }}>{t.reject}</Action>
          </div>
        </div>
      )}

      {d.tags && d.tags.length > 0 && (
        <section className="section">
          <h2>{t.tags}</h2>
          <div className="line">
            {d.tags.map((tag) => {
              const bad = ['unsafe_driving', 'phone_while_driving', 'dirty_car', 'rude', 'wrong_route', 'late', 'smoking', 'car_mismatch', 'asked_extra_cash'].includes(tag.code);
              return <Pill key={tag.code} kind={bad ? 'bad' : 'ok'}>{label(tag.code)} · {tag.count}</Pill>;
            })}
          </div>
        </section>
      )}

      <div className="grid wide">
        <div className="card stack">
          <h2>{t.complaintsAbout}</h2>
          {(d.complaints ?? []).length === 0 ? <span className="muted">—</span> : (d.complaints ?? []).map((c) => (
            <button key={c.id} type="button" className={`item ${c.severity === 'safety' ? 'safety' : ''}`} onClick={() => go(`complaint-${c.id}`)}>
              <span>{complaintLabel(c.type, lang)}</span>
              <StatusPill status={c.status} />
            </button>
          ))}
        </div>
        <div className="card stack">
          <h2>{t.recentRides}</h2>
          {(d.recentRides ?? []).length === 0 ? <span className="muted">—</span> : (d.recentRides ?? []).map((r) => (
            <button key={r.id} type="button" className="item" onClick={() => go(`ride-${r.id}`)}>
              <span className="num">{dateTime(r.createdAt)} · {sum(r.priceTiyin, lang)}</span><StatusPill status={r.status} />
            </button>
          ))}
        </div>
      </div>

      {d.userId && (
        <div className="card stack">
          <h2>{t.blocks}</h2>
          {(d.blocks ?? []).map((b) => (
            <div key={b.id} className="line between small">
              <span>{b.reason}</span>
              <span className="muted num">{dateTime(b.createdAt)} → {b.until ? dateTime(b.until) : '∞'} {b.appealStatus === 'lifted' ? '· lifted' : ''}</span>
            </div>
          ))}
          <div className="form">
            <label className="field"><span>{t.reason}</span><input id="block-reason" type="text" value={blockReason} onChange={(e) => setBlockReason(e.target.value)} /></label>
            {!blocked && <label className="field"><span>{t.days}</span><input id="block-days" type="number" min={1} max={365} value={blockDays} onChange={(e) => setBlockDays(e.target.value)} /></label>}
            {blocked ? (
              <Action disabled={blockReason.trim().length < 3} onRun={async () => {
                await api(`/admin/users/${d.userId}/unblock`, { body: { reason: blockReason } });
                toast(t.done); setBlockReason(''); reload();
              }}>{t.unblock}</Action>
            ) : (
              <Action kind="danger" disabled={blockReason.trim().length < 3} onRun={async () => {
                await api(`/admin/users/${d.userId}/block`, { body: { reason: blockReason, ...(blockDays ? { days: Number(blockDays) } : {}) } });
                toast(t.done); setBlockReason(''); reload();
              }}>{t.block}</Action>
            )}
          </div>
        </div>
      )}
    </>
  );
}
