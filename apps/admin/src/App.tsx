// Panel shell: login gate, navigation (rail on wide screens, chips on phones), hash routing,
// language and theme switch. Views live in ./views.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, DEMO, setSignedOutHandler } from './api';
import { DICTS, type Lang } from './i18n';
import { AppCtx, type Ctx, type Me } from './ui';
import { Login } from './views/Login';
import { Dashboard } from './views/Dashboard';
import { Moderation, DriverDossier } from './views/Drivers';
import { Search, UserProfile } from './views/People';
import { Complaints, ComplaintDetail } from './views/Complaints';
import { Disputes, DisputeDetail } from './views/Disputes';
import { Rides, RideDetail } from './views/Rides';
import { Pricing } from './views/Pricing';
import { Finance, Audit } from './views/Finance';
import { Errors } from './views/Errors';

type NavKey = 'dashboard' | 'moderation' | 'search' | 'complaints' | 'disputes' | 'rides' | 'pricing' | 'finance' | 'audit' | 'errors';
const NAV: { key: NavKey; adminOnly?: boolean }[] = [
  { key: 'dashboard' }, { key: 'moderation' }, { key: 'complaints' }, { key: 'disputes' }, { key: 'search' },
  { key: 'rides' }, { key: 'pricing' }, { key: 'finance', adminOnly: true }, { key: 'audit', adminOnly: true }, { key: 'errors', adminOnly: true },
];
/** Detail views and the list they belong to. */
const PARENT: Record<string, NavKey> = { driver: 'moderation', user: 'search', complaint: 'complaints', dispute: 'disputes', ride: 'rides' };

function readRoute(): { view: string; id: string | null } {
  const h = location.hash.replace(/^#/, '');
  const i = h.indexOf('-');
  return i === -1 ? { view: h || 'dashboard', id: null } : { view: h.slice(0, i), id: h.slice(i + 1) };
}

function storedLang(): Lang {
  try {
    const l = localStorage.getItem('taxi_admin_lang');
    return l === 'uz' ? 'uz' : 'ru';
  } catch {
    return 'ru';
  }
}

type Theme = 'system' | 'light' | 'dark';

export function App() {
  const [lang, setLangState] = useState<Lang>(storedLang);
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [route, setRoute] = useState(readRoute);
  const [toastText, setToastText] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [theme, setTheme] = useState<Theme>('system');
  const t = DICTS[lang];

  useEffect(() => {
    const on = () => { setRoute(readRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    setSignedOutHandler(() => setMe(null));
    api<Me>('/me').then((u) => setMe(isStaff(u) ? u : null), () => setMe(null)).finally(() => setChecking(false));
    return () => setSignedOutHandler(null);
  }, []);

  const refreshCounts = useCallback(() => {
    api<{ queues: Record<string, number> }>('/admin/dashboard').then((d) => setCounts({
      moderation: d.queues.driversToModerate ?? 0,
      complaints: (d.queues.safetyComplaints ?? 0) + (d.queues.complaints ?? 0),
      complaintsAlert: d.queues.safetyComplaints ?? 0,
      disputes: d.queues.disputesToDecide ?? 0,
    }), () => {});
  }, []);
  useEffect(() => { if (me) refreshCounts(); }, [me, refreshCounts]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem('taxi_admin_lang', l); } catch { /* per-tab only */ }
  };

  const ctx: Ctx | null = useMemo(() => me && {
    lang, t, me, isAdmin: me.roles.includes('admin'),
    go: (r: string) => { location.hash = r; },
    toast: (text: string) => { setToastText(text); window.setTimeout(() => setToastText(null), 2600); },
    refreshCounts,
  }, [lang, t, me, refreshCounts]);

  if (checking) return null;
  if (!me || !ctx) {
    return <Login lang={lang} setLang={setLang} onSignedIn={(u) => setMe(u)} />;
  }

  const active = (PARENT[route.view] ?? route.view) as NavKey;
  const nav = NAV.filter((n) => !n.adminOnly || ctx.isAdmin);
  const navButtons = nav.map((n) => (
    <button key={n.key} type="button" className="navbtn" aria-current={active === n.key ? 'page' : undefined} onClick={() => ctx.go(n.key)}>
      <span>{t.nav[n.key]}</span>
      {counts[n.key] ? <span className={`count ${n.key === 'complaints' && counts.complaintsAlert ? 'alert' : ''}`}>{counts[n.key]}</span> : null}
    </button>
  ));
  const controls = (
    <div className="row-controls">
      <select aria-label={t.language} value={lang} onChange={(e) => setLang(e.target.value as Lang)} style={{ width: 'auto' }}>
        <option value="ru">Русский</option>
        <option value="uz">Oʻzbekcha</option>
      </select>
      <select aria-label={t.theme} value={theme} onChange={(e) => setTheme(e.target.value as Theme)} style={{ width: 'auto' }}>
        <option value="system">{lang === 'uz' ? 'Avto' : 'Авто'}</option>
        <option value="light">{lang === 'uz' ? 'Kunduzgi' : 'Дневная'}</option>
        <option value="dark">{lang === 'uz' ? 'Tungi' : 'Ночная'}</option>
      </select>
    </div>
  );

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <nav className="rail" aria-label="Menu">
          <div className="brandmark">
            <b>{t.appName}</b>
            <div className="tiles" aria-hidden="true" />
            {DEMO && <span className="pill warm demo-flag">{t.demo}</span>}
          </div>
          {navButtons}
          <div className="rail-foot">
            <span className="who">{me.name ?? me.phone} · {me.roles.filter((r) => r === 'admin' || r === 'support').join(', ')}</span>
            {controls}
            {!DEMO && <button type="button" className="btn small" onClick={() => { api('/staff/auth/logout', { body: {} }).catch(() => {}).finally(() => setMe(null)); }}>{t.logout}</button>}
          </div>
        </nav>
        <header className="topbar">
          <div className="topbar-head">
            <div className="stack" style={{ gap: 4 }}>
              <b>{t.appName}</b>
              {DEMO && <span className="pill warm demo-flag">{t.demo}</span>}
            </div>
            {controls}
          </div>
          <nav className="chips" aria-label="Menu">{navButtons}</nav>
        </header>
        <main className="main">
          <div className="content">
            <View view={route.view} id={route.id} />
          </div>
        </main>
      </div>
      {toastText && <div className="toast" role="status">{toastText}</div>}
    </AppCtx.Provider>
  );
}

function isStaff(u: Me): boolean {
  return u.roles.includes('admin') || u.roles.includes('support');
}

function View({ view, id }: { view: string; id: string | null }) {
  switch (view) {
    case 'moderation': return <Moderation />;
    case 'driver': return <DriverDossier id={id!} />;
    case 'search': return <Search />;
    case 'user': return <UserProfile id={id!} />;
    case 'complaints': return <Complaints />;
    case 'complaint': return <ComplaintDetail id={id!} />;
    case 'disputes': return <Disputes />;
    case 'dispute': return <DisputeDetail id={id!} />;
    case 'rides': return <Rides />;
    case 'ride': return <RideDetail id={id!} />;
    case 'pricing': return <Pricing />;
    case 'finance': return <Finance />;
    case 'audit': return <Audit />;
    case 'errors': return <Errors />;
    default: return <Dashboard />;
  }
}
