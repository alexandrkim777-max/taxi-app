import { useState } from 'react';
import { api } from '../api';
import { dateTime, phone, plate, sum } from '../format';
import { Action, ErrorBox, Loading, PageHead, Pill, Seg, StatusPill, Timeline, tr, useApp, useLoad } from '../ui';

interface Item { id: string; rideId: string; category: string; openedBy: string; status: string; respondBy: string; createdAt: string; statements: number }

export function Disputes() {
  const { t, lang, go } = useApp();
  const [status, setStatus] = useState<'in_review' | 'awaiting_response' | 'resolved'>('in_review');
  const { data, error, loading } = useLoad(() => api<Item[]>(`/admin/disputes?status=${status}`), [status]);
  const { label } = tr(lang);
  return (
    <>
      <PageHead title={t.nav.disputes}>
        <Seg value={status} onChange={setStatus} options={[
          { value: 'in_review', label: t.inReview }, { value: 'awaiting_response', label: t.awaiting }, { value: 'resolved', label: t.resolvedDisputes },
        ]} />
      </PageHead>
      {loading && !data ? <Loading /> : error ? <ErrorBox text={error} /> : (
        <div className="list">
          {data!.length === 0 && <p className="muted">—</p>}
          {data!.map((d) => (
            <button key={d.id} type="button" className="item" onClick={() => go(`dispute-${d.id}`)}>
              <div className="main-col">
                <span className="title">{label(d.category)}</span>
                <span className="muted small">{d.openedBy === 'passenger' ? t.passenger : t.driver} · {dateTime(d.createdAt)}</span>
              </div>
              <Pill kind={d.statements === 2 ? 'ok' : 'warm'}>{d.statements}/2</Pill>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

interface Detail {
  dispute: { id: string; category: string; openedBy: string; status: string; respondBy: string; outcome: string | null; resolution: string | null; createdAt: string };
  statements: { role: 'passenger' | 'driver'; text: string; createdAt: string }[];
  ride: Record<string, any>;
  events: { type: string; actor: string; payload: Record<string, unknown>; at: string }[];
  priceChanges: Record<string, any>[];
}

export function DisputeDetail({ id }: { id: string }) {
  const { t, lang, go, toast, refreshCounts } = useApp();
  const { data, error, loading, reload } = useLoad(() => api<Detail>(`/admin/disputes/${id}`), [id]);
  const [outcome, setOutcome] = useState<'passenger' | 'driver' | 'both' | 'no_fault'>('no_fault');
  const [resolution, setResolution] = useState('');
  const [waive, setWaive] = useState(false);
  const { label } = tr(lang);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox text={error ?? ''} />;
  const { dispute: d, ride: r } = data;
  const byRole = (role: 'passenger' | 'driver') => data.statements.find((s) => s.role === role);

  return (
    <>
      <PageHead back="disputes" title={label(d.category)} sub={<span className="line"><StatusPill status={d.status} /><span className="muted">{dateTime(d.createdAt)}</span></span>}>
        <button type="button" className="btn" onClick={() => go(`ride-${r.id}`)}>{t.nav.rides} →</button>
      </PageHead>
      <div className="statements">
        {(['passenger', 'driver'] as const).map((role) => {
          const s = byRole(role);
          return (
            <div key={role} className="statement">
              <div className="line between">
                <b>{t.statementOf}: {role === 'passenger' ? `${t.passenger} · ${r.passengerName}` : `${t.driver} · ${r.driverName ?? '—'}`}</b>
                {d.openedBy === role && <Pill kind="warm">{lang === 'uz' ? 'ochgan' : 'открыл(а)'}</Pill>}
              </div>
              {s ? <><p>{s.text}</p><span className="muted small">{dateTime(s.createdAt)}</span></> : <span className="muted">{t.notWritten}</span>}
            </div>
          );
        })}
      </div>
      <div className="grid wide">
        <div className="card">
          <dl className="kv">
            <dt>{t.price}</dt><dd className="num">{sum(r.priceTiyin, lang)}</dd>
            {r.cancelFeeTiyin ? <><dt>{t.cancelFee}</dt><dd className="num">{sum(r.cancelFeeTiyin, lang)}</dd></> : null}
            <dt>{t.passenger}</dt><dd className="num">{r.passengerName} · {phone(r.passengerPhone)}</dd>
            <dt>{t.driver}</dt><dd className="num">{r.driverName ?? '—'} · {phone(r.driverPhone)} · {plate(r.plate)}</dd>
            <dt>{lang === 'uz' ? 'Holat' : 'Статус'}</dt><dd><StatusPill status={r.status} /></dd>
          </dl>
        </div>
        <div className="card stack"><h2>{t.rideLog}</h2><Timeline events={data.events} /></div>
      </div>
      {d.status !== 'resolved' ? (
        <div className="card stack">
          <h2>{t.decide}</h2>
          {d.status === 'awaiting_response' && <div className="notice">{t.awaiting} → {dateTime(d.respondBy)}</div>}
          <label className="field"><span>{t.outcome}</span>
            <select id="d-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
              <option value="passenger">{t.outcomePassenger}</option><option value="driver">{t.outcomeDriver}</option>
              <option value="both">{t.outcomeBoth}</option><option value="no_fault">{t.outcomeNoFault}</option>
            </select></label>
          <label className="field"><span>{t.resolution}</span><textarea id="d-resolution" value={resolution} onChange={(e) => setResolution(e.target.value)} /></label>
          {r.cancelFeeTiyin ? <label className="check"><input id="d-waive" type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} />{t.waiveFee} ({sum(r.cancelFeeTiyin, lang)})</label> : null}
          <div><Action kind="primary" disabled={resolution.trim().length < 10 || d.status !== 'in_review'} onRun={async () => {
            await api(`/admin/disputes/${id}/resolve`, { body: { outcome, resolution, ...(waive ? { waiveCancelFee: true } : {}) } });
            toast(t.done); refreshCounts(); reload();
          }}>{t.decide}</Action></div>
        </div>
      ) : <div className="notice">{t.outcome}: <b>{d.outcome}</b> · {d.resolution}</div>}
    </>
  );
}
