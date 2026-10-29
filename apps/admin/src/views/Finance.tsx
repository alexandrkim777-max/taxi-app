import { useState } from 'react';
import { api } from '../api';
import { dateTime, phone, sum } from '../format';
import { ErrorBox, Loading, PageHead, Seg, StatusPill, tr, useApp, useLoad } from '../ui';

interface Fin {
  days: number;
  payments: { type: string; status: string; count: number; amountTiyin: number }[];
  debts: { unpaidRidesTiyin: number; unpaidCancelFeesTiyin: number };
  refundsPending: { id: string; rideId: string; amountTiyin: number; createdAt: string }[];
}

export function Finance() {
  const { t, lang, isAdmin, go } = useApp();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const { data, error, loading } = useLoad(() => (isAdmin ? api<Fin>(`/admin/finance?days=${days}`) : Promise.reject(new Error(t.adminOnly))), [days, isAdmin]);
  const { label } = tr(lang);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox text={error ?? ''} />;
  const revenue = data.payments.filter((p) => p.type === 'subscription' && p.status === 'succeeded').reduce((a, p) => a + Number(p.amountTiyin), 0);
  const cardRides = data.payments.filter((p) => p.type === 'ride' && p.status === 'succeeded').reduce((a, p) => a + Number(p.amountTiyin), 0);

  return (
    <>
      <PageHead title={t.financeTitle}>
        <Seg value={days} onChange={setDays} options={[{ value: '7', label: '7' }, { value: '30', label: '30' }, { value: '90', label: '90' }]} />
      </PageHead>
      <div className="grid">
        <div className="stat hero"><span className="v">{sum(revenue, lang)}</span><span className="k">{t.subscriptionRevenue}</span></div>
        <div className="stat"><span className="v">{sum(cardRides, lang)}</span><span className="k">{label('ride')} · {lang === 'uz' ? 'karta' : 'карта'}</span></div>
        <div className="stat"><span className="v">{sum(Number(data.debts.unpaidRidesTiyin), lang)}</span><span className="k">{t.unpaidRides}</span></div>
        <div className="stat"><span className="v">{sum(Number(data.debts.unpaidCancelFeesTiyin), lang)}</span><span className="k">{t.unpaidFees}</span></div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{t.payments}</th><th>{lang === 'uz' ? 'Holat' : 'Статус'}</th><th>{lang === 'uz' ? 'Soni' : 'Кол-во'}</th><th>{t.price}</th></tr></thead>
          <tbody>
            {data.payments.map((p, i) => (
              <tr key={i}><td>{label(p.type)}</td><td><StatusPill status={p.status} /></td><td>{p.count}</td><td>{sum(Number(p.amountTiyin), lang)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="section">
        <h2>{t.refundsPending}</h2>
        <div className="list">
          {data.refundsPending.length === 0 && <p className="muted">—</p>}
          {data.refundsPending.map((r) => (
            <button key={r.id} type="button" className="item" onClick={() => go(`ride-${r.rideId}`)}>
              <span className="num">{dateTime(r.createdAt)}</span><b className="num">{sum(r.amountTiyin, lang)}</b>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

interface Entry { id: number; action: string; targetType: string | null; targetId: string | null; payload: Record<string, unknown>; ip: string; at: string; adminName: string | null; adminPhone: string }

export function Audit() {
  const { t, lang, isAdmin } = useApp();
  const { data, error, loading } = useLoad(() => (isAdmin ? api<Entry[]>('/admin/audit?limit=200') : Promise.reject(new Error(t.adminOnly))), [isAdmin]);
  const { label } = tr(lang);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox text={error ?? ''} />;
  return (
    <>
      <PageHead title={t.auditTitle} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>{t.when}</th><th>{t.who}</th><th>{t.what}</th><th>ID</th><th>IP</th></tr></thead>
          <tbody>
            {data.map((e) => (
              <tr key={e.id}>
                <td>{dateTime(e.at)}</td>
                <td>{e.adminName ?? phone(e.adminPhone)}</td>
                <td className="wrap">{label(e.action)}{Object.keys(e.payload).length > 0 && <span className="muted small"> · {JSON.stringify(e.payload)}</span>}</td>
                <td className="muted small">{e.targetType ? `${e.targetType}:${(e.targetId ?? '').slice(0, 8)}` : '—'}</td>
                <td className="muted small">{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
