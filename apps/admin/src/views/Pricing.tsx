import { useEffect, useState } from 'react';
import { api } from '../api';
import { dateTime, pick, sum } from '../format';
import { Action, ErrorBox, Loading, PageHead, Pill, Seg, useApp, useLoad } from '../ui';

interface Cls {
  code: string; name: unknown; coefficient: number; baseTiyin: number; perKmTiyin: number; perMinTiyin: number; minFareTiyin: number;
  corridorMinPct: number; corridorMaxPct: number; cancelFeeTiyin: number; freeWaitMin: number; waitPerMinTiyin: number;
}
interface Rule { id: string; classCode: string | null; value: number; reason: string; validFrom: string; validUntil: string | null; setBy: string; createdAt: string; cancelledAt?: string | null; active: boolean }
interface Plan { code: string; name: unknown; priceTiyin: number; periodDays: number; isActive: boolean }
interface Pricing { classes: Cls[]; coefficientRules: Rule[]; plans: Plan[] }

const MIN = 0.7;
const MAX = 1.5;
const PRESETS = [0.9, 1.0, 1.1, 1.2, 1.3, 1.5];

/** Same formula as the API: max(minimum, base + km·perKm + min·perMin) × k, rounded to 500 sum. */
function fare(c: Cls, km: number, minutes: number, k: number): number {
  const raw = Math.max(c.minFareTiyin, c.baseTiyin + km * c.perKmTiyin + minutes * c.perMinTiyin);
  const step = 50_000;
  return Math.round((Math.round(raw / step) * step * k) / step) * step;
}

export function Pricing() {
  const { t, lang, isAdmin, toast } = useApp();
  const { data, error, loading, reload } = useLoad(() => api<Pricing>('/admin/pricing'), []);
  const [scope, setScope] = useState<string>('city');
  const [value, setValue] = useState(1);
  const [useWindow, setUseWindow] = useState(false);
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');

  const scopeClass = data?.classes.find((c) => c.code === scope);
  const effective = scopeClass ? scopeClass.coefficient : data?.classes[0]?.coefficient ?? 1;
  useEffect(() => { setValue(effective); }, [effective, scope]);

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox text={error ?? ''} />;

  const exampleClass = scopeClass ?? data.classes[0]!;
  const before = fare(exampleClass, 8, 20, effective);
  const after = fare(exampleClass, 8, 20, value);
  const clamp = (v: number) => Math.min(MAX, Math.max(MIN, Math.round(v * 100) / 100));
  const pos = ((value - MIN) / (MAX - MIN)) * 100;
  const changed = Math.abs(value - effective) > 0.001 || useWindow;

  return (
    <>
      <PageHead title={t.nav.pricing} sub={t.coefHelp} />

      <div className="card stack">
        <div className="line between"><h2>{t.coefficient}</h2>
          <div className="line">{data.classes.map((c) => (
            <span key={c.code} className={`pill ${c.coefficient > 1 ? 'warm' : c.coefficient < 1 ? 'ok' : ''}`}>{pick(c.name, lang)} ×{c.coefficient.toFixed(2)}</span>
          ))}</div>
        </div>
        <Seg value={scope} onChange={setScope} options={[{ value: 'city', label: t.wholeCity }, ...data.classes.map((c) => ({ value: c.code, label: pick(c.name, lang) }))]} />

        <div className="coef">
          <div className="stack" style={{ gap: 'var(--space-4)' }}>
            <div className="coef-value">
              <button type="button" className="btn step" aria-label="−0.05" disabled={!isAdmin || value <= MIN} onClick={() => setValue(clamp(value - 0.05))}>−</button>
              <span className="big" aria-live="polite">×{value.toFixed(2)}</span>
              <button type="button" className="btn step" aria-label="+0.05" disabled={!isAdmin || value >= MAX} onClick={() => setValue(clamp(value + 0.05))}>+</button>
            </div>
            <div className="meter" aria-hidden="true"><i style={{ left: `${pos}%` }} /></div>
            <div className="line between small muted num"><span>×{MIN.toFixed(2)}</span><span>×1.00</span><span>×{MAX.toFixed(2)}</span></div>
            <div className="presets">
              {PRESETS.map((p) => (
                <button key={p} type="button" className="btn small" aria-pressed={Math.abs(p - value) < 0.001} disabled={!isAdmin}
                  style={Math.abs(p - value) < 0.001 ? { borderColor: 'var(--brand)', background: 'var(--brand-tint)' } : undefined}
                  onClick={() => setValue(p)}>×{p.toFixed(2)}</button>
              ))}
            </div>
          </div>
          <div className="stack" style={{ gap: 'var(--space-3)' }}>
            <span className="label">{t.coefExample} · {pick(exampleClass.name, lang)}</span>
            <div className="example"><span className="muted num">{sum(before, lang)}</span><span aria-hidden="true">→</span><span className="to">{sum(after, lang)}</span>
              {after !== before && <Pill kind={after > before ? 'warm' : 'ok'}>{after > before ? '+' : ''}{Math.round(((after - before) / before) * 100)}%</Pill>}</div>
            <label className="check"><input id="p-window" type="checkbox" checked={useWindow} disabled={!isAdmin} onChange={(e) => setUseWindow(e.target.checked)} />{t.window}</label>
            {useWindow && (
              <div className="form">
                <label className="field"><span>{t.from}</span><input id="p-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
                <label className="field"><span>{t.until}</span><input id="p-until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
              </div>
            )}
            <label className="field"><span>{t.reason}</span><input id="p-reason" type="text" value={reason} disabled={!isAdmin} onChange={(e) => setReason(e.target.value)}
              placeholder={lang === 'uz' ? 'Masalan: kuchli yomgʻir, Navroʻz' : 'Например: сильный дождь, Навруз'} /></label>
            {isAdmin ? (
              <div><Action kind="primary" disabled={!changed || reason.trim().length < 3 || (useWindow && !until)} onRun={async () => {
                await api('/admin/pricing/coefficients', { body: {
                  value, reason: reason.trim(), ...(scope === 'city' ? {} : { classCode: scope }),
                  ...(useWindow && from ? { validFrom: new Date(from).toISOString() } : {}),
                  ...(useWindow && until ? { validUntil: new Date(until).toISOString() } : {}),
                } });
                toast(t.done); setReason(''); setUseWindow(false); reload();
              }}>{t.setCoefficient} ×{value.toFixed(2)}</Action></div>
            ) : <div className="notice">{t.adminOnly}</div>}
          </div>
        </div>
      </div>

      <section className="section">
        <h2>{t.activeRules}</h2>
        <div className="list">
          {data.coefficientRules.length === 0 && <p className="muted">—</p>}
          {data.coefficientRules.map((r) => {
            const scheduled = !r.cancelledAt && new Date(r.validFrom) > new Date();
            const state = r.active ? t.activeNow : scheduled ? t.scheduled : t.ended;
            return (
              <div key={r.id} className="item" style={{ cursor: 'default' }}>
                <div className="main-col">
                  <span className="title num">×{r.value.toFixed(2)} · {r.classCode ? pick(data.classes.find((c) => c.code === r.classCode)?.name, lang) : t.wholeCity}</span>
                  <span className="muted small">{r.reason} · {r.setBy} · {dateTime(r.validFrom)} → {r.validUntil ? dateTime(r.validUntil) : '∞'}</span>
                </div>
                <div className="line">
                  <Pill kind={r.active ? 'brand' : scheduled ? 'warm' : undefined}>{state}</Pill>
                  {isAdmin && (r.active || scheduled) && <Action small onRun={async () => { await api(`/admin/pricing/coefficients/${r.id}/end`, { body: {} }); toast(t.done); reload(); }}>{t.end}</Action>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="section">
        <h2>{t.classTariffs}</h2>
        <div className="grid wide">
          {data.classes.map((c) => <ClassTariff key={c.code} c={c} onSaved={reload} />)}
        </div>
      </section>

      <section className="section">
        <h2>{t.plans}</h2>
        <div className="grid">
          {data.plans.filter((p) => p.code !== 'trial').map((p) => <PlanCard key={p.code} p={p} onSaved={reload} />)}
        </div>
      </section>
    </>
  );
}

const FIELDS = [
  ['baseTiyin', 'base'], ['perKmTiyin', 'perKm'], ['perMinTiyin', 'perMin'], ['minFareTiyin', 'minFare'],
  ['cancelFeeTiyin', 'cancelFee'], ['waitPerMinTiyin', 'waitPerMin'],
] as const;

function ClassTariff({ c, onSaved }: { c: Cls; onSaved: () => void }) {
  const { t, lang, isAdmin, toast } = useApp();
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries([...FIELDS.map(([k]) => [k, String((c as unknown as Record<string, number>)[k]! / 100)]), ['freeWaitMin', String(c.freeWaitMin)]]));
  const [reason, setReason] = useState('');
  const changes: Record<string, number> = {};
  for (const [k] of FIELDS) {
    const tiyin = Math.round(Number(vals[k]) * 100);
    if (Number.isFinite(tiyin) && tiyin !== (c as unknown as Record<string, number>)[k]) changes[k] = tiyin;
  }
  if (Number(vals.freeWaitMin) !== c.freeWaitMin) changes.freeWaitMin = Number(vals.freeWaitMin);

  return (
    <div className="card stack">
      <div className="line between"><h3>{pick(c.name, lang)}</h3><span className="muted small">{c.corridorMinPct}%…{c.corridorMaxPct}%</span></div>
      <div className="form">
        {FIELDS.map(([k, labelKey]) => (
          <label key={k} className="field"><span>{t[labelKey]}, {t.sum}</span>
            <input id={`${c.code}-${k}`} type="number" min={0} step={k === 'perMinTiyin' || k === 'waitPerMinTiyin' ? 50 : 500} disabled={!isAdmin}
              value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></label>
        ))}
        <label className="field"><span>{t.freeWait}</span>
          <input id={`${c.code}-free`} type="number" min={0} max={10} disabled={!isAdmin} value={vals.freeWaitMin} onChange={(e) => setVals({ ...vals, freeWaitMin: e.target.value })} /></label>
      </div>
      {isAdmin && Object.keys(changes).length > 0 && (
        <div className="form">
          <label className="field"><span>{t.reason}</span><input id={`${c.code}-reason`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <Action kind="primary" disabled={reason.trim().length < 3} onRun={async () => {
            await api(`/admin/pricing/classes/${c.code}`, { method: 'PUT', body: { ...changes, reason } });
            toast(t.done); setReason(''); onSaved();
          }}>{t.save}</Action>
        </div>
      )}
    </div>
  );
}

function PlanCard({ p, onSaved }: { p: Plan; onSaved: () => void }) {
  const { t, lang, isAdmin, toast } = useApp();
  const [price, setPrice] = useState(String(p.priceTiyin / 100));
  const [active, setActive] = useState(p.isActive);
  const [reason, setReason] = useState('');
  const dirty = Math.round(Number(price) * 100) !== p.priceTiyin || active !== p.isActive;
  return (
    <div className="card stack">
      <div className="line between"><h3>{pick(p.name, lang)}</h3><span className="muted small num">{p.periodDays} {t.periodDays}</span></div>
      <span className="num" style={{ fontSize: 22, fontWeight: 800 }}>{sum(p.priceTiyin, lang)}</span>
      {isAdmin && <>
        <label className="field"><span>{t.price}, {t.sum}</span><input id={`plan-${p.code}`} type="number" min={1000} step={1000} value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label className="check"><input id={`plan-active-${p.code}`} type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{t.active}</label>
        {dirty && <>
          <label className="field"><span>{t.reason}</span><input id={`plan-reason-${p.code}`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <Action kind="primary" disabled={reason.trim().length < 3} onRun={async () => {
            await api(`/admin/pricing/plans/${p.code}`, { method: 'PUT', body: { priceTiyin: Math.round(Number(price) * 100), isActive: active, reason } });
            toast(t.done); setReason(''); onSaved();
          }}>{t.save}</Action>
        </>}
      </>}
    </div>
  );
}
