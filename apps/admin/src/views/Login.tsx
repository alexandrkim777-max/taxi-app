import { useState } from 'react';
import { api } from '../api';
import { DICTS, type Lang } from '../i18n';
import type { Me } from '../ui';
import { errorText } from '../ui';

export function Login({ lang, setLang, onSignedIn }: { lang: Lang; setLang: (l: Lang) => void; onSignedIn: (u: Me, token: string) => void }) {
  const t = DICTS[lang];
  const [phone, setPhone] = useState('+998 ');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('/auth/request-code', { body: { phone, language: lang } });
      setSent(true);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api<{ token: string; user: Me }>('/auth/verify', { body: { phone, code } });
      if (!res.user.roles.includes('admin') && !res.user.roles.includes('support')) {
        setError(t.notStaff);
        return;
      }
      onSignedIn(res.user, res.token);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <div className="card">
        <div className="stack">
          <div className="tiles" aria-hidden="true" />
          <h1>{t.appName}</h1>
          <span className="muted">{t.login}</span>
        </div>
        <div className="seg" role="group" aria-label={t.language}>
          <button type="button" aria-pressed={lang === 'ru'} onClick={() => setLang('ru')}>Русский</button>
          <button type="button" aria-pressed={lang === 'uz'} onClick={() => setLang('uz')}>Oʻzbekcha</button>
        </div>
        {!sent ? (
          <form className="stack" onSubmit={requestCode}>
            <label className="field"><span>{t.phone}</span>
              <input id="login-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy}>{t.getCode}</button>
          </form>
        ) : (
          <form className="stack" onSubmit={verify}>
            <label className="field"><span>{t.code}</span>
              <input id="login-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
            <button className="btn primary" disabled={busy || code.length !== 6}>{t.signIn}</button>
          </form>
        )}
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
