// Passenger app shell: language → phone → code, then the map (home, or the active ride) with a side
// menu; a finished ride shows the rating screen; pushed screens sit on top.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary, installErrorReporting } from './monitoring';
import { api, DEMO, errorText, loadToken, onUnauthorized, saveToken, setApiLanguage } from './api';
import { App as AppContext, useApp, type Draft, type Route } from './context';
import { registerForPush, unregisterPush } from './push';
import { DICTS, type Lang } from './i18n';
import { RideProvider, useRide } from './ride';
import { ThemeProvider, useTheme } from './theme';
import type { Me, LegalDoc } from './types';
import { T } from './components/ui';
import { CodeScreen, LanguageScreen, PhoneScreen } from './screens/Auth';
import { HomeScreen } from './screens/Home';
import { ConsentScreen } from './screens/Consent';
import { SearchScreen } from './screens/Search';
import { OrderScreen } from './screens/Order';
import { RideScreen } from './screens/Ride';
import { EndedNotice, RateScreen } from './screens/Rate';
import { RideDetailsScreen, RidesScreen } from './screens/Rides';
import { AboutScreen, AddCardScreen, BlockedScreen, CardsScreen, DebtsScreen, PlacesScreen, ProfileScreen } from './screens/Profile';
import { Menu } from './screens/Menu';

type Auth = { step: 'language' } | { step: 'phone' } | { step: 'code'; phone: string };

installErrorReporting();

export function App() {
  return (
    <ErrorBoundary label="Что-то пошло не так. / Nimadir xato ketdi." retry="Перезапустить / Qayta ishga tushirish">
      <SafeAreaProvider>
        <ThemeProvider>
          <Root />
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

function Root() {
  const { c, dark } = useTheme();
  const [lang, setLangState] = useState<Lang>('uz');
  const [booting, setBooting] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [auth, setAuth] = useState<Auth>({ step: 'language' });
  const [stack, setStack] = useState<Route[]>([]);
  const [draft, setDraft] = useState<Draft>({ pickup: null, stops: [] });
  // Texts to accept before ordering (empty = all accepted).
  const [consents, setConsents] = useState<LegalDoc[]>([]);
  const checkConsents = useCallback(() => {
    api<{ needed: LegalDoc[] }>('/me/consents?app=passenger').then((r) => setConsents(r.needed)).catch(() => {});
  }, []);

  const applyLang = (l: Lang) => { setLangState(l); setApiLanguage(l); };

  const signOut = useCallback(() => {
    setMe(null); setStack([]); setDraft({ pickup: null, stops: [] }); setAuth({ step: 'language' });
  }, []);

  useEffect(() => {
    onUnauthorized(signOut);
    (async () => {
      if (await loadToken()) {
        try { const m = await api<Me>('/me'); applyLang(m.language); setMe(m); registerForPush(); checkConsents(); } catch { await saveToken(null); }
      }
      setBooting(false);
    })();
  }, [signOut, checkConsents]);

  const t = DICTS[lang];
  const ctx = useMemo(() => ({
    lang, t, me, setMe, draft, setDraft,
    setLang: (l: Lang) => { applyLang(l); if (me) api('/me', { method: 'PATCH', body: { language: l } }).catch(() => {}); },
    logout: async () => { await unregisterPush(); api('/auth/logout', { body: {} }).catch(() => {}); saveToken(null); signOut(); },
    push: (r: Route) => setStack((s) => [...s, r]),
    pop: () => setStack((s) => s.slice(0, -1)),
    reset: () => setStack([]),
    needConsent: setConsents,
    err: (e: unknown) => errorText(e, t.errors),
  }), [lang, t, me, draft, signOut]);

  if (booting) return <View style={{ flex: 1, backgroundColor: c.surfacePage }} />;

  let content;
  if (!me) {
    content = auth.step === 'language' ? <LanguageScreen onPick={(l) => { applyLang(l); setAuth({ step: 'phone' }); }} />
      : auth.step === 'phone' ? <PhoneScreen lang={lang} onSent={(phone) => setAuth({ step: 'code', phone })} onBack={() => setAuth({ step: 'language' })} />
        : <CodeScreen lang={lang} phone={auth.phone} onBack={() => setAuth({ step: 'phone' })}
          onSignedIn={async (token) => { await saveToken(token); const m = await api<Me>('/me'); applyLang(m.language); setMe(m); registerForPush(); checkConsents(); }} />;
  } else if (consents.length) {
    content = <ConsentScreen docs={consents} onDone={setConsents} />;
  } else {
    content = <RideProvider><Main stack={stack} /></RideProvider>;
  }

  return (
    <AppContext.Provider value={ctx}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <View style={{ flex: 1, backgroundColor: c.surfacePage }}>
        {content}
        {DEMO && <View style={{ position: 'absolute', zIndex: 5, right: 12, top: 8 }} pointerEvents="none"><T v="label" muted>{t.demo}</T></View>}
      </View>
    </AppContext.Provider>
  );
}

function Main({ stack }: { stack: Route[] }) {
  const { ride, ended, clearEnded } = useRide();
  const { push, setDraft } = useApp();
  const [menu, setMenu] = useState(false);
  const keys = useRef(new WeakMap<Route, number>());
  const keySeq = useRef(0);

  // Every pushed screen stays mounted under the one on top, so going back keeps what was typed
  // (the order being composed survives "add a card" or "add a stop").
  const screens = stack.map((r, i) => {
    if (!keys.current.has(r)) keys.current.set(r, ++keySeq.current);
    let el;
    switch (r.name) {
      case 'search': el = <SearchScreen purpose={r.purpose} onPick={r.onPick} />; break;
      case 'order': el = <OrderScreen />; break;
      case 'cards': el = <CardsScreen onPick={r.onPick} />; break;
      case 'addCard': el = <AddCardScreen onAdded={r.onAdded} />; break;
      case 'places': el = <PlacesScreen />; break;
      case 'rideDetails': el = <RideDetailsScreen rideId={r.rideId} />; break;
      case 'debts': el = <DebtsScreen />; break;
      case 'profile': el = <ProfileScreen />; break;
      case 'rides': el = <RidesScreen />; break;
      case 'blocked': el = <BlockedScreen />; break;
      case 'about': el = <AboutScreen />; break;
    }
    return <View key={keys.current.get(r)} style={{ ...StyleSheet.absoluteFillObject, display: i === stack.length - 1 ? 'flex' : 'none' }}>{el}</View>;
  });

  let base;
  if (ended?.status === 'completed' && ended.rating?.canRate !== false) base = <RateScreen ride={ended} onDone={clearEnded} />;
  else if (ended?.status === 'cancelled') {
    base = <EndedNotice ride={ended} onDone={clearEnded} onAgain={() => {
      const [p, ...rest] = ended.stops;
      if (p) setDraft({ pickup: { lat: p.lat, lng: p.lng, address: p.address ?? '' }, stops: rest.map((s) => ({ lat: s.lat, lng: s.lng, address: s.address ?? '' })) });
      clearEnded(); push({ name: 'order' });
    }} />;
  } else {
    base = (
      <>
        {ride ? <RideScreen ride={ride} onMenu={() => setMenu(true)} /> : <HomeScreen onMenu={() => setMenu(true)} />}
        {menu && <Menu onClose={() => setMenu(false)} />}
      </>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, display: stack.length ? 'none' : 'flex' }}>{base}</View>
      {screens}
    </View>
  );
}
