// Shared panel building blocks: app context, data loading, small components.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { DICTS, LABELS, STATUS, type Dict, type Lang } from './i18n';

export interface Me {
  id: string;
  name: string | null;
  phone: string;
  roles: string[];
}

export interface Ctx {
  lang: Lang;
  t: Dict;
  me: Me;
  isAdmin: boolean;
  go: (route: string) => void;
  toast: (text: string) => void;
  refreshCounts: () => void;
}

export const AppCtx = createContext<Ctx | null>(null);
export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('AppCtx missing');
  return c;
}

export function tr(lang: Lang) {
  return { t: DICTS[lang], status: (s: string) => STATUS[lang][s] ?? s, label: (s: string) => LABELS[lang][s] ?? s };
}

/** Loads data for a view; `reload` after an action. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => setState({ data, error: null, loading: false }),
      (err: unknown) => setState({ data: null, error: errorText(err), loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run };
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const extra = Object.entries(err.body).filter(([k]) => k !== 'error' && k !== 'message').map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
    return `${err.code}${extra ? ` (${extra})` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function Loading() {
  const { t } = useApp();
  return <p className="muted">{t.loading}</p>;
}

export function ErrorBox({ text }: { text: string }) {
  const { t } = useApp();
  return <div className="error" role="alert">{t.error}: {text}</div>;
}

export function Pill({ kind, children }: { kind?: 'ok' | 'bad' | 'warm' | 'brand'; children: ReactNode }) {
  return <span className={`pill ${kind ?? ''}`}>{children}</span>;
}

export function StatusPill({ status }: { status: string }) {
  const { lang } = useApp();
  const kind = ['completed', 'verified', 'resolved', 'succeeded', 'approved', 'paid'].includes(status) ? 'ok'
    : ['cancelled', 'blocked', 'rejected', 'failed'].includes(status) ? 'bad'
      : ['pending', 'open', 'awaiting_response'].includes(status) ? 'warm' : 'brand';
  return <Pill kind={kind}>{tr(lang).status(status)}</Pill>;
}

export function Copy({ text, shown }: { text: string; shown?: string }) {
  const { t, toast } = useApp();
  return (
    <span className="line">
      <span className="num" style={{ userSelect: 'all' }}>{shown ?? text}</span>
      <button
        className="btn small ghost"
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => toast(t.copied), () => toast(text));
        }}
      >
        {t.copy}
      </button>
    </span>
  );
}

/** A button that runs an async action, shows progress and reports errors as a toast. */
export function Action({ onRun, children, kind, disabled, small }: {
  onRun: () => Promise<unknown>; children: ReactNode; kind?: 'primary' | 'danger'; disabled?: boolean; small?: boolean;
}) {
  const { toast, t } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${kind ?? ''} ${small ? 'small' : ''}`}
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try {
          await onRun();
        } catch (err) {
          toast(`${t.error}: ${errorText(err)}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function PageHead({ title, sub, back, children }: { title: ReactNode; sub?: ReactNode; back?: string; children?: ReactNode }) {
  const { go, t } = useApp();
  return (
    <div className="pagehead">
      <div className="stack">
        {back && <button className="btn small ghost" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} type="button" onClick={() => go(back)}>← {t.back}</button>}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <div className="row-controls">{children}</div>}
    </div>
  );
}

export function Timeline({ events }: { events: { type: string; actor: string; payload?: Record<string, unknown>; at: string }[] }) {
  const { lang } = useApp();
  const { status, label } = tr(lang);
  return (
    <div className="timeline">
      {events.map((e, i) => {
        const name = e.type.startsWith('status:') ? status(e.type.slice(7)) : label(e.type);
        const bad = e.type === 'status:cancelled' || e.type.includes('declined') || e.type.includes('timeout') || e.type.includes('failed');
        return (
          <div key={i} className={`ev ${bad ? 'bad' : ''}`}>
            <div className="line"><b>{name}</b><span className="muted small">{e.actor}</span></div>
            <div className="muted small num">{new Date(e.at).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Tashkent' })}
              {e.payload && Object.keys(e.payload).length > 0 && <> · {Object.entries(e.payload).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')}</>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** "rating_safety:unsafe_driving,phone_while_driving" -> "Опасное вождение, Телефон за рулём". */
export function complaintLabel(type: string, lang: Lang): string {
  const { label } = tr(lang);
  if (type.startsWith('rating_safety:')) return type.slice('rating_safety:'.length).split(',').map(label).join(', ');
  return label(type);
}
