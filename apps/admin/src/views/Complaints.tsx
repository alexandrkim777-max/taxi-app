import { useState } from 'react';
import { api } from '../api';
import { dateTime, phone } from '../format';
import { Action, complaintLabel, ErrorBox, Loading, PageHead, Pill, Seg, StatusPill, Timeline, tr, useApp, useLoad } from '../ui';

interface Item { id: string; rideId: string; type: string; severity: string; status: string; createdAt: string; authorName: string; aboutName: string | null; aboutTotal: number }

export function Complaints() {
  const { t, lang, go } = useApp();
  const [status, setStatus] = useState<'open' | 'in_review' | 'resolved' | 'rejected'>('open');
  const { data, error, loading } = useLoad(() => api<Item[]>(`/admin/complaints?status=${status}`), [status]);
  return (
    <>
      <PageHead title={t.nav.complaints}>
        <Seg value={status} onChange={setStatus} options={[
          { value: 'open', label: t.statusOpen }, { value: 'in_review', label: t.statusInReview },
          { value: 'resolved', label: t.statusResolved }, { value: 'rejected', label: t.statusRejected },
        ]} />
      </PageHead>
      {loading && !data ? <Loading /> : error ? <ErrorBox text={error} /> : (
        <div className="list">
          {data!.length === 0 && <p className="muted">—</p>}
          {data!.map((c) => (
            <button key={c.id} type="button" className={`item ${c.severity === 'safety' ? 'safety' : ''}`} onClick={() => go(`complaint-${c.id}`)}>
              <div className="main-col">
                <span className="title">{complaintLabel(c.type, lang)}</span>
                <span className="muted small">{c.authorName} → {c.aboutName ?? '—'} · {dateTime(c.createdAt)}</span>
              </div>
              <div className="line" style={{ justifyContent: 'flex-end' }}>
                {c.severity === 'safety' && <Pill kind="bad">{t.safety}</Pill>}
                {c.aboutTotal > 1 && <Pill kind="warm">×{c.aboutTotal}</Pill>}
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

interface Detail {
  complaint: Record<string, any>;
  rating: { score: number; tags: string[]; reason: string | null } | null;
  rideEvents: { type: string; actor: string; payload: Record<string, unknown>; at: string }[];
  previousAboutSamePerson: { id: string; type: string; severity: string; status: string; createdAt: string }[];
}

export function ComplaintDetail({ id }: { id: string }) {
  const { t, lang, go, toast, refreshCounts } = useApp();
  const { data, error, loading, reload } = useLoad(() => api<Detail>(`/admin/complaints/${id}`), [id]);
  const [status, setStatus] = useState<'resolved' | 'rejected'>('resolved');
  const [resolution, setResolution] = useState('');
  const [action, setAction] = useState<'none' | 'warning' | 'block'>('none');
  const [days, setDays] = useState('7');
  const { label } = tr(lang);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox text={error ?? ''} />;
  const c = data.complaint;
  const closed = c.status === 'resolved' || c.status === 'rejected';

  return (
    <>
      <PageHead back="complaints" title={complaintLabel(c.type, lang)} sub={<span className="line"><StatusPill status={c.status} />
        {c.severity === 'safety' && <Pill kind="bad">{t.safety}</Pill>}<span className="muted">{dateTime(c.created_at)}</span></span>}>
        <button type="button" className="btn" onClick={() => go(`ride-${c.ride_id}`)}>{t.nav.rides} →</button>
      </PageHead>
      <div className="grid wide">
        <div className="card stack">
          <span className="label">{lang === 'uz' ? 'Kim yozdi' : 'Кто пожаловался'}</span>
          <b>{c.author_name}</b><span className="muted num">{phone(c.author_phone)}</span>
          {c.text && <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.text}</p>}
          {data.rating && (
            <div className="line"><Pill kind="warm">★ {data.rating.score}</Pill>
              {data.rating.tags.map((tag) => <Pill key={tag} kind="bad">{label(tag)}</Pill>)}
              {data.rating.reason && <span>{data.rating.reason}</span>}</div>
          )}
        </div>
        <div className="card stack">
          <span className="label">{lang === 'uz' ? 'Kim haqida' : 'На кого'}</span>
          <b>{c.about_name ?? '—'}</b><span className="muted num">{phone(c.about_phone)}</span>
          <span className="label">{t.previousComplaints}</span>
          {data.previousAboutSamePerson.length === 0 ? <span className="muted">—</span> : data.previousAboutSamePerson.map((p) => (
            <button key={p.id} type="button" className={`item ${p.severity === 'safety' ? 'safety' : ''}`} onClick={() => go(`complaint-${p.id}`)}>
              <span className="small">{complaintLabel(p.type, lang)} · {dateTime(p.createdAt)}</span><StatusPill status={p.status} />
            </button>
          ))}
        </div>
      </div>
      <div className="card stack">
        <h2>{t.rideLog}</h2>
        <Timeline events={data.rideEvents} />
      </div>
      {!closed && (
        <div className="card stack">
          <div className="line between"><h2>{t.resolve}</h2>
            {c.status === 'open' && <Action small onRun={async () => { await api(`/admin/complaints/${id}/assign`, { body: {} }); toast(t.done); reload(); }}>{t.assignMe}</Action>}</div>
          <Seg value={status} onChange={setStatus} options={[{ value: 'resolved', label: t.resolved }, { value: 'rejected', label: t.rejected }]} />
          <label className="field"><span>{t.resolution}</span><textarea id="c-resolution" value={resolution} onChange={(e) => setResolution(e.target.value)} /></label>
          <div className="form">
            <label className="field"><span>{t.action}</span>
              <select id="c-action" value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
                <option value="none">{t.actionNone}</option><option value="warning">{t.actionWarning}</option><option value="block">{t.actionBlock}</option>
              </select></label>
            {action === 'block' && <label className="field"><span>{t.days}</span><input id="c-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} /></label>}
            <Action kind={action === 'block' ? 'danger' : 'primary'} disabled={resolution.trim().length < 3} onRun={async () => {
              await api(`/admin/complaints/${id}/resolve`, { body: { status, resolution, action, ...(action === 'block' && days ? { blockDays: Number(days) } : {}) } });
              toast(t.done); refreshCounts(); reload();
            }}>{t.confirm}</Action>
          </div>
        </div>
      )}
      {closed && c.resolution && <div className="notice">{t.resolution}: {c.resolution}</div>}
    </>
  );
}
