import { useState } from 'react';
import { api } from '../api';
import { date, dateTime, phone, plate } from '../format';
import { Action, complaintLabel, Copy, ErrorBox, Loading, PageHead, Pill, StatusPill, useApp, useLoad, errorText } from '../ui';

interface Found { userId: string; name: string | null; phone: string; roles: string[]; driverId: string | null; driverStatus: string | null; plates: string | null }

export function Search() {
  const { t, go } = useApp();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try { setResults(await api<Found[]>(`/admin/search?q=${encodeURIComponent(q.trim())}`)); } catch (err) { setError(errorText(err)); }
  }

  return (
    <>
      <PageHead title={t.nav.search} sub={t.searchHint} />
      <form className="form" onSubmit={run}>
        <label className="field full"><span>{t.searchHint}</span>
          <input id="search-q" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="+998 90 123 45 67 · 01 A 123 BC" /></label>
        <button className="btn primary" disabled={q.trim().length < 3}>{t.find}</button>
      </form>
      {error && <ErrorBox text={error} />}
      {results && (
        <div className="list">
          {results.length === 0 && <p className="muted">{t.nothingFound}</p>}
          {results.map((r) => (
            <button key={r.userId} type="button" className="item" onClick={() => go(r.driverId ? `driver-${r.driverId}` : `user-${r.userId}`)}>
              <div className="main-col">
                <span className="title">{r.name ?? '—'}</span>
                <span className="muted small num">{phone(r.phone)}{r.plates ? ` · ${r.plates.split(', ').map(plate).join(', ')}` : ''}</span>
              </div>
              <div className="line">
                {r.driverId ? <Pill kind="brand">{t.driver}</Pill> : <Pill>{t.passenger}</Pill>}
                {r.driverStatus && <StatusPill status={r.driverStatus} />}
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

interface UserP {
  id: string; name: string | null; phone: string; language: string; roles: string[]; rating: number | null; ratingCount: number;
  createdAt: string; completed: number; cancelled: number; cards: number;
  complaints: { id: string; type: string; severity: string; status: string; createdAt: string }[];
  blocks: { id: string; reason: string; until: string | null; appealStatus: string; createdAt: string }[];
}

const STAFF = ['support', 'admin'];

export function UserProfile({ id }: { id: string }) {
  const { t, lang, go, toast, isAdmin, me } = useApp();
  const { data: u, error, loading, reload } = useLoad(() => api<UserP>(`/admin/users/${id}`), [id]);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('');
  const [roles, setRoles] = useState<string[] | null>(null);
  if (loading && !u) return <Loading />;
  if (error || !u) return <ErrorBox text={error ?? ''} />;
  const blocked = u.blocks.some((b) => b.appealStatus !== 'lifted' && (!b.until || new Date(b.until) > new Date()));
  const current = roles ?? u.roles;

  return (
    <>
      <PageHead back="search" title={u.name ?? phone(u.phone)} sub={<span className="line">
        {blocked && <StatusPill status="blocked" />}
        {u.rating && u.ratingCount >= 5 ? <Pill kind="brand">★ {u.rating.toFixed(2)}</Pill> : <Pill>{t.ratingNew}</Pill>}
        {u.roles.filter((r) => STAFF.includes(r)).map((r) => <Pill key={r} kind="warm">{r}</Pill>)}
      </span>} />
      <div className="grid wide">
        <div className="card">
          <dl className="kv">
            <dt>{t.phone}</dt><dd><Copy text={u.phone} shown={phone(u.phone)} /></dd>
            <dt>{t.language}</dt><dd>{u.language}</dd>
            <dt>{t.completedTotal}</dt><dd className="num">{u.completed}</dd>
            <dt>{t.cancelledByPassenger}</dt><dd className="num">{u.cancelled}</dd>
            <dt>{t.cards}</dt><dd className="num">{u.cards}</dd>
            <dt>{lang === 'uz' ? 'Roʻyxatdan oʻtgan' : 'С нами с'}</dt><dd className="num">{date(u.createdAt)}</dd>
          </dl>
        </div>
        <div className="card stack">
          <h2>{t.complaintsAbout}</h2>
          {u.complaints.length === 0 ? <span className="muted">—</span> : u.complaints.map((c) => (
            <button key={c.id} type="button" className={`item ${c.severity === 'safety' ? 'safety' : ''}`} onClick={() => go(`complaint-${c.id}`)}>
              <span>{complaintLabel(c.type, lang)}</span><StatusPill status={c.status} />
            </button>
          ))}
        </div>
      </div>
      <div className="card stack">
        <h2>{t.blocks}</h2>
        {u.blocks.map((b) => (
          <div key={b.id} className="line between small"><span>{b.reason}</span>
            <span className="muted num">{dateTime(b.createdAt)} → {b.until ? dateTime(b.until) : '∞'}</span></div>
        ))}
        <div className="form">
          <label className="field"><span>{t.reason}</span><input id="u-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          {!blocked && <label className="field"><span>{t.days}</span><input id="u-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} /></label>}
          {blocked
            ? <Action disabled={reason.trim().length < 3} onRun={async () => { await api(`/admin/users/${u.id}/unblock`, { body: { reason } }); toast(t.done); setReason(''); reload(); }}>{t.unblock}</Action>
            : <Action kind="danger" disabled={reason.trim().length < 3 || u.id === me.id} onRun={async () => {
              await api(`/admin/users/${u.id}/block`, { body: { reason, ...(days ? { days: Number(days) } : {}) } }); toast(t.done); setReason(''); reload();
            }}>{t.block}</Action>}
        </div>
      </div>
      {isAdmin && (
        <div className="card stack">
          <h2>{t.roles}</h2>
          <div className="line">
            {STAFF.map((r) => (
              <label key={r} className="check">
                <input type="checkbox" id={`role-${r}`} checked={current.includes(r)} disabled={u.id === me.id && r === 'admin'}
                  onChange={(e) => setRoles(e.target.checked ? [...current, r] : current.filter((x) => x !== r))} />
                {r}
              </label>
            ))}
          </div>
          <div><Action onRun={async () => { await api(`/admin/users/${u.id}/roles`, { method: 'PUT', body: { roles: current } }); toast(t.done); setRoles(null); reload(); }}>{t.saveRoles}</Action></div>
        </div>
      )}
    </>
  );
}
