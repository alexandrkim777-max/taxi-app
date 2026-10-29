import { api } from '../api';
import { sum } from '../format';
import { ErrorBox, Loading, PageHead, useApp, useLoad } from '../ui';

interface Dash {
  live: { driversOnline: number; driversOnRide: number; rides: { searching: number; pickup: number; inTrip: number } };
  today: Record<string, number>;
  queues: Record<string, number>;
  coefficients: { code: string; coefficient: number }[];
}

export function Dashboard() {
  const { t, lang, go } = useApp();
  const { data, error, loading } = useLoad(() => api<Dash>('/admin/dashboard'), []);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox text={error ?? ''} />;
  const { live, today, queues } = data;

  const queueItems: { key: string; label: string; to: string; hot?: boolean }[] = [
    { key: 'safetyComplaints', label: t.safetyComplaints, to: 'complaints', hot: true },
    { key: 'driversToModerate', label: t.driversToModerate, to: 'moderation' },
    { key: 'disputesToDecide', label: t.disputesToDecide, to: 'disputes' },
    { key: 'complaints', label: t.complaintsQ, to: 'complaints' },
    { key: 'refundsPending', label: t.refundsPending, to: 'finance' },
  ];
  const cancelRate = today.ordered ? Math.round((100 * ((today.cancelledByPassenger ?? 0) + (today.cancelledByDriver ?? 0))) / today.ordered) : 0;

  return (
    <>
      <PageHead title={t.nav.dashboard} sub={new Date().toLocaleDateString(lang === 'uz' ? 'uz-UZ' : 'ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Tashkent' })} />

      <section className="section">
        <span className="label">{t.live}</span>
        <div className="grid five">
          <div className="stat hero"><span className="v">{live.driversOnline}</span><span className="k">{t.driversOnline}</span></div>
          <div className="stat"><span className="v">{live.driversOnRide}</span><span className="k">{t.driversOnRide}</span></div>
          <div className="stat"><span className="v">{live.rides.searching}</span><span className="k">{t.searching}</span></div>
          <div className="stat"><span className="v">{live.rides.pickup}</span><span className="k">{t.pickup}</span></div>
          <div className="stat"><span className="v">{live.rides.inTrip}</span><span className="k">{t.inTrip}</span></div>
        </div>
      </section>

      <section className="section">
        <span className="label">{t.queues}</span>
        <div className="grid five">
          {queueItems.map((q) => (
            <button key={q.key} type="button" className={`queue ${q.hot && queues[q.key] ? 'hot' : ''}`} onClick={() => go(q.to)}>
              <span>{q.label}</span><span className="v">{queues[q.key] ?? 0}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <span className="label">{t.today}</span>
        <div className="card">
          <dl className="kv num">
            <dt>{t.ordered}</dt><dd><b>{today.ordered}</b></dd>
            <dt>{t.completed}</dt><dd>{today.completed}</dd>
            <dt>{t.cancelledByPassenger}</dt><dd>{today.cancelledByPassenger}</dd>
            <dt>{t.cancelledByDriver}</dt><dd>{today.cancelledByDriver} <span className="muted small">· {cancelRate}%</span></dd>
            <dt>{t.noDriverFound}</dt><dd>{today.noDriverFound}</dd>
            <dt>{t.avgPrice}</dt><dd>{sum(today.avgPriceTiyin, lang)}</dd>
            <dt>{t.driversEarned}</dt><dd>{sum(today.driversEarnedTiyin, lang)}</dd>
            <dt>{t.subscriptionsSold}</dt><dd>{today.subscriptionsSold}</dd>
            <dt>{t.subscriptionRevenue}</dt><dd><b>{sum(today.subscriptionRevenueTiyin, lang)}</b></dd>
          </dl>
        </div>
      </section>

      <section className="section">
        <div className="line between"><span className="label">{t.coefficientNow}</span>
          <button type="button" className="btn small" onClick={() => go('pricing')}>{t.nav.pricing} →</button></div>
        <div className="line">
          {data.coefficients.map((c) => (
            <span key={c.code} className={`pill ${c.coefficient > 1 ? 'warm' : c.coefficient < 1 ? 'ok' : ''}`}>
              {c.code} ×{c.coefficient.toFixed(2)}
            </span>
          ))}
        </div>
      </section>
    </>
  );
}
