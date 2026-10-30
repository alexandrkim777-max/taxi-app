import { useState } from 'react';
import { api } from '../api';
import { dateTime, phone, plate, sum } from '../format';
import { Action, ErrorBox, Loading, PageHead, Pill, StatusPill, Timeline, tr, useApp, useLoad } from '../ui';

interface Item { id: string; status: string; priceTiyin: number | null; paymentMethod: string; createdAt: string; passengerName: string; driverName: string | null; plate: string | null }
const STATUSES = ['created', 'accepted', 'driver_en_route', 'arrived', 'in_progress', 'completed', 'cancelled'];

export function Rides() {
  const { t, lang, go } = useApp();
  const [phoneQ, setPhoneQ] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, loading } = useLoad(() => api<Item[]>(`/admin/rides${query}`), [query]);
  const { status: st } = tr(lang);
  return (
    <>
      <PageHead title={t.ridesSearch} />
      <form className="form" onSubmit={(e) => {
        e.preventDefault();
        const p = new URLSearchParams();
        if (phoneQ.trim()) p.set('phone', phoneQ.trim());
        if (status) p.set('status', status);
        setQuery(p.toString() ? `?${p}` : '');
      }}>
        <label className="field"><span>{t.phone}</span><input id="r-phone" type="tel" value={phoneQ} onChange={(e) => setPhoneQ(e.target.value)} placeholder="+998 …" /></label>
        <label className="field"><span>{lang === 'uz' ? 'Holat' : 'Статус'}</span>
          <select id="r-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t.anyStatus}</option>{STATUSES.map((s) => <option key={s} value={s}>{st(s)}</option>)}
          </select></label>
        <button className="btn primary">{t.find}</button>
      </form>
      {loading && !data ? <Loading /> : error ? <ErrorBox text={error} /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t.when}</th><th>{lang === 'uz' ? 'Holat' : 'Статус'}</th><th>{t.passenger}</th><th>{t.driver}</th><th>{t.price}</th><th>{t.payment}</th></tr></thead>
            <tbody>
              {data!.map((r) => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => go(`ride-${r.id}`)}>
                  <td>{dateTime(r.createdAt)}</td><td><StatusPill status={r.status} /></td><td>{r.passengerName}</td>
                  <td>{r.driverName ?? '—'} {r.plate && <span className="muted">· {plate(r.plate)}</span>}</td>
                  <td>{sum(r.priceTiyin, lang)}</td><td>{r.paymentMethod}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface Detail {
  ride: Record<string, any>;
  stops: { position: number; lat: number; lng: number; address: string | null }[];
  events: { type: string; actor: string; payload: Record<string, unknown>; at: string }[];
  priceChanges: Record<string, any>[];
  payments: Record<string, any>[];
  ratings: { score: number; tags: string[]; reason: string | null }[];
  complaints: { id: string; type: string; severity: string; status: string }[];
  dispute: { id: string; status: string; outcome: string | null } | null;
}

/**
 * Give money back from one card payment: amount and reason, sent through the provider. One form =
 * one idempotency key, so a double click or a lost answer never sends the money twice.
 */
function RefundForm({ payment, onDone }: { payment: Record<string, any>; onDone: () => void }) {
  const { t, lang, toast } = useApp();
  const max = Number(payment.refundable_tiyin);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(max / 100));
  const [reason, setReason] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const tiyin = Math.round(Number(amount.replace(/\s/g, '').replace(',', '.')) * 100);
  const valid = Number.isFinite(tiyin) && tiyin >= 100 && tiyin <= max && reason.trim().length >= 5;
  if (!open) return <button type="button" className="btn small" onClick={() => setOpen(true)}>{t.refund}</button>;
  return (
    <div className="stack" style={{ width: '100%' }}>
      <label className="field"><span>{t.refundAmount} ({t.upTo} {sum(max, lang)})</span>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="field"><span>{t.refundReason}</span>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="line">
        <Action kind="danger" small disabled={!valid} onRun={async () => {
          const res = await api<{ status: string }>(`/admin/payments/${payment.id}/refund`, {
            body: { amountTiyin: tiyin, reason: reason.trim() }, headers: { 'idempotency-key': key },
          });
          toast(res.status === 'failed' ? t.refundFailed : t.refundSent);
          setOpen(false);
          onDone();
        }}>{t.refundConfirm} {Number.isFinite(tiyin) ? sum(tiyin, lang) : ''}</Action>
        <button type="button" className="btn small" onClick={() => setOpen(false)}>{t.cancel}</button>
      </div>
    </div>
  );
}

export function RideDetail({ id }: { id: string }) {
  const { t, lang, go, isAdmin } = useApp();
  const { data, error, loading, reload } = useLoad(() => api<Detail>(`/admin/rides/${id}`), [id]);
  const { label } = tr(lang);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox text={error ?? ''} />;
  const r = data.ride;
  return (
    <>
      <PageHead back="rides" title={`${sum(r.locked_price_tiyin, lang)} · ${r.class_code}`}
        sub={<span className="line"><StatusPill status={r.status} /><span className="muted">{dateTime(r.created_at)}</span>
          {Number(r.price_coefficient) !== 1 && <Pill kind="warm">×{Number(r.price_coefficient).toFixed(2)}</Pill>}</span>}>
        {data.dispute && <button type="button" className="btn" onClick={() => go(`dispute-${data.dispute!.id}`)}>{t.nav.disputes} →</button>}
      </PageHead>
      <div className="grid wide">
        <div className="card">
          <dl className="kv">
            <dt>{t.passenger}</dt><dd className="num">{r.passenger_name} · {phone(r.passenger_phone)}</dd>
            <dt>{t.driver}</dt><dd className="num">{r.driver_name ?? '—'} · {phone(r.driver_phone)}</dd>
            <dt>{t.car}</dt><dd className="num">{r.make_model ?? '—'} · {plate(r.plate)}</dd>
            <dt>{t.payment}</dt><dd>{r.payment_method}{r.payment_status ? ` · ${r.payment_status}` : ''}</dd>
            <dt>{t.km}</dt><dd className="num">{(r.route_distance_m / 1000).toFixed(1)} {t.km} · {Math.round(r.route_duration_s / 60)} {t.min}</dd>
            {r.cancel_fee_tiyin ? <><dt>{t.cancelFee}</dt><dd className="num">{sum(r.cancel_fee_tiyin, lang)} · {r.cancel_fee_status}</dd></> : null}
          </dl>
        </div>
        <div className="card stack">
          <h2>{t.stops}</h2>
          {data.stops.map((s) => (
            <div key={s.position} className="line"><Pill kind={s.position === 0 ? 'brand' : 'warm'}>{s.position === 0 ? 'A' : String.fromCharCode(65 + s.position)}</Pill>
              <span>{s.address ?? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`}</span></div>
          ))}
        </div>
      </div>
      <div className="grid wide">
        <div className="card stack"><h2>{t.rideLog}</h2><Timeline events={data.events} /></div>
        <div className="stack">
          <div className="card stack"><h2>{t.payments}</h2>
            {data.payments.length === 0 ? <span className="muted">—</span> : data.payments.map((p) => (
              <div key={p.id} className="stack" style={{ gap: 4 }}>
                <div className="line between"><span>{label(p.type)} · {p.provider}</span><span className="line num">{p.type === 'refund' ? '−' : ''}{sum(Number(p.amount_tiyin), lang)} <StatusPill status={p.status} /></span></div>
                {p.type === 'refund' && <span className="muted">
                  {p.refund_kind === 'overpaid' ? t.refundOverpaid : `${p.refund_reason ?? ''} · ${p.approved_by_name ?? phone(p.approved_by_phone)}`}
                  {p.failure_reason ? ` · ${p.failure_reason}` : ''}</span>}
                {isAdmin && Number(p.refundable_tiyin) > 0 && <RefundForm payment={p} onDone={reload} />}
              </div>
            ))}
          </div>
          <div className="card stack"><h2>{t.ratings}</h2>
            {data.ratings.length === 0 ? <span className="muted">—</span> : data.ratings.map((rt, i) => (
              <div key={i} className="line"><Pill kind={rt.score >= 4 ? 'ok' : 'bad'}>★ {rt.score}</Pill>{rt.tags.map((tag) => <Pill key={tag}>{label(tag)}</Pill>)}{rt.reason && <span>{rt.reason}</span>}</div>
            ))}
          </div>
          {data.complaints.length > 0 && <div className="card stack"><h2>{t.nav.complaints}</h2>
            {data.complaints.map((c) => (
              <button key={c.id} type="button" className={`item ${c.severity === 'safety' ? 'safety' : ''}`} onClick={() => go(`complaint-${c.id}`)}>
                <span>{label(c.type)}</span><StatusPill status={c.status} /></button>
            ))}</div>}
        </div>
      </div>
    </>
  );
}
