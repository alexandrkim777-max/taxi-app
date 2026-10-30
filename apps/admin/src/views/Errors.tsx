// Errors from the API, background jobs, both apps and this panel, grouped by kind (newest first).
// "Fixed" hides a kind; if it happens again it comes back here (and in the Telegram alert, if set up).

import { useState } from 'react';
import { api } from '../api';
import { dateTime } from '../format';
import { Action, ErrorBox, Loading, PageHead, Pill, Seg, useApp, useLoad } from '../ui';

interface ErrorKind {
  id: string; source: string; message: string; stack: string | null; context: Record<string, unknown>;
  appVersion: string | null; count: number; firstSeen: string; lastSeen: string; resolvedAt: string | null;
}

export function Errors() {
  const { t } = useApp();
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad(() => api<ErrorKind[]>(`/admin/errors?status=${status}`), [status]);
  return (
    <>
      <PageHead title={t.nav.errors} sub={<span className="muted">{t.errorsHint}</span>}>
        <Seg value={status} onChange={setStatus} options={[{ value: 'open', label: t.errorsOpen }, { value: 'resolved', label: t.errorsResolved }]} />
      </PageHead>
      {loading && !data ? <Loading /> : error ? <ErrorBox text={error} /> : data!.length === 0 ? <p className="muted">{t.errorsNone}</p> : (
        <div className="list">
          {data!.map((e) => (
            <div key={e.id} className="card stack">
              <div className="line between">
                <span className="line"><Pill kind={e.source === 'api' || e.source === 'job' ? 'bad' : 'warm'}>{e.source}</Pill>
                  <b className="num">×{e.count}</b>
                  <span className="muted small">{Object.values(e.context).join(' · ')}{e.appVersion ? ` · v${e.appVersion}` : ''}</span></span>
                <span className="muted small num">{dateTime(e.lastSeen)}</span>
              </div>
              <span className="wrap">{e.message}</span>
              <div className="line">
                {e.stack && <button type="button" className="btn small" onClick={() => setOpen(open === e.id ? null : e.id)}>{t.errorsStack}</button>}
                {!e.resolvedAt && <Action small onRun={async () => { await api(`/admin/errors/${e.id}/resolve`, { body: {} }); reload(); }}>{t.errorsFixed}</Action>}
                <span className="muted small">{t.errorsFirst}: {dateTime(e.firstSeen)}</span>
              </div>
              {open === e.id && e.stack && <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0 }}>{e.stack}</pre>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
