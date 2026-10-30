// Staff sign-in: phone -> SMS code -> code from an authenticator app. On the first sign-in the
// server hands out a new authenticator key once; it is shown here to add to the app.

import { useState } from 'react';
import { api } from '../api';
import { DICTS, type Lang } from '../i18n';
import type { Me } from '../ui';
import { errorText } from '../ui';

type Step =
  | { kind: 'phone' }
  | { kind: 'sms' }
  | { kind: 'totp'; ticket: string; setup: { secret: string; otpauthUrl: string } | null };

export function Login({ lang, setLang, onSignedIn }: { lang: Lang; setLang: (l: Lang) => void; onSignedIn: (u: Me) => void }) {
  const t = DICTS[lang];
  const [phone, setPhone] = useState('+998 ');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  const requestCode = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    await api('/auth/request-code', { body: { phone, language: lang } });
    setCode(''); setStep({ kind: 'sms' });
  }); };

  const verifySms = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    try {
      const res = await api<{ next: 'totp' | 'totp_setup'; ticket: string; secret?: string; otpauthUrl?: string }>(
        '/staff/auth/verify', { body: { phone, code } },
      );
      setCode('');
      setStep({ kind: 'totp', ticket: res.ticket, setup: res.secret && res.otpauthUrl ? { secret: res.secret, otpauthUrl: res.otpauthUrl } : null });
    } catch (err) {
      if (err instanceof Error && err.message === 'not_staff') { setError(t.notStaff); return; }
      throw err;
    }
  }); };

  const verifyTotp = (e: React.FormEvent) => { e.preventDefault(); if (step.kind !== 'totp') return; run(async () => {
    const res = await api<{ user: Me }>('/staff/auth/totp', { body: { ticket: step.ticket, code } });
    onSignedIn(res.user);
  }); };

  const codeInput = (label: string, autoComplete: string) => (
    <label className="field"><span>{label}</span>
      <input id="login-code" type="text" inputMode="numeric" autoComplete={autoComplete} maxLength={6} value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
    </label>
  );

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
        {step.kind === 'phone' && (
          <form className="stack" onSubmit={requestCode}>
            <label className="field"><span>{t.phone}</span>
              <input id="login-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy}>{t.getCode}</button>
          </form>
        )}
        {step.kind === 'sms' && (
          <form className="stack" onSubmit={verifySms}>
            {codeInput(t.code, 'one-time-code')}
            <button className="btn primary" disabled={busy || code.length !== 6}>{t.signIn}</button>
          </form>
        )}
        {step.kind === 'totp' && (
          <form className="stack" onSubmit={verifyTotp}>
            {step.setup && (
              <div className="stack">
                <strong>{t.totpSetupTitle}</strong>
                <span className="muted">{t.totpSetupText}</span>
                <div className="field"><span>{t.totpKey}</span>
                  <code id="totp-key" style={{ fontSize: 17, letterSpacing: '0.04em', wordBreak: 'break-word', userSelect: 'all' }}>
                    {step.setup.secret.replace(/(.{4})/g, '$1 ').trim()}
                  </code>
                </div>
                <a className="btn small" href={step.setup.otpauthUrl}>{t.totpOpen}</a>
              </div>
            )}
            {codeInput(t.totpCode, 'off')}
            <button className="btn primary" disabled={busy || code.length !== 6}>{t.signIn}</button>
          </form>
        )}
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
