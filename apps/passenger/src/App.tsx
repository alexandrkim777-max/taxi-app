// Passenger app shell: language → phone → code, then three tabs (Taxi, Rides, Profile). An active ride
// takes over the Taxi tab; a finished ride shows the rating screen; pushed screens sit on top.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, DEMO, errorText, loadToken, onUnauthorized, saveToken, setApiLanguage } from './api';
import { App as AppContext, useApp, type Draft, type Route } from './context';
import { DICTS, type Lang } from './i18n';
import { RideProvider, useRide } from './ride';
import { space, ThemeProvider, useTheme } from './theme';
import type { Me } from './types';
import { T } from './components/ui';
import { CodeScreen, LanguageScreen, PhoneScreen } from './screens/Auth';
import { HomeScreen } from './screens/Home';
import { SearchScreen } from './screens/Search';
import { OrderScreen } from './screens/Order';
import { RideScreen } from './screens/Ride';
import { EndedNotice, RateScreen } from './screens/Rate';
import { RideDetailsScreen, RidesScreen } from './screens/Rides';
import { AddCardScreen, CardsScreen, DebtsScreen, PlacesScreen, ProfileScreen } from './screens/Profile';

type Auth = { step: 'language' } | { step: 'phone' } | { step: 'code'; phone: string };
type Tab = 'taxi' | 'rides' | 'profile';

export function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Root />
      </ThemeProvider>
    </SafeAreaProvider>
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

  const applyLang = (l: Lang) => { setLangState(l); setApiLanguage(l); };

  const signOut = useCallback(() => {
    setMe(null); setStack([]); setDraft({ pickup: null, stops: [] }); setAuth({ step: 'language' });
  }, []);

  useEffect(() => {
    onUnauthorized(signOut);
    (async () => {
      if (await loadToken()) {
        try { const m = await api<Me>('/me'); applyLang(m.language); setMe(m); } catch { await saveToken(null); }
      }
      setBooting(false);
    })();
  }, [signOut]);

  const t = DICTS[lang];
  const ctx = useMemo(() => ({
    lang, t, me, setMe, draft, setDraft,
    setLang: (l: Lang) => { applyLang(l); if (me) api('/me', { method: 'PATCH', body: { language: l } }).catch(() => {}); },
    logout: () => { api('/auth/logout', { body: {} }).catch(() => {}); saveToken(null); signOut(); },
    push: (r: Route) => setStack((s) => [...s, r]),
    pop: () => setStack((s) => s.slice(0, -1)),
    reset: () => setStack([]),
    err: (e: unknown) => errorText(e, t.errors),
  }), [lang, t, me, draft, signOut]);

  if (booting) return <View style={{ flex: 1, backgroundColor: c.surfacePage }} />;

  let content;
  if (!me) {
    content = auth.step === 'language' ? <LanguageScreen onPick={(l) => { applyLang(l); setAuth({ step: 'phone' }); }} />
      : auth.step === 'phone' ? <PhoneScreen lang={lang} onSent={(phone) => setAuth({ step: 'code', phone })} onBack={() => setAuth({ step: 'language' })} />
        : <CodeScreen lang={lang} phone={auth.phone} onBack={() => setAuth({ step: 'phone' })}
          onSignedIn={async (token) => { await saveToken(token); const m = await api<Me>('/me'); applyLang(m.language); setMe(m); }} />;
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
  const [tab, setTab] = useState<Tab>('taxi');
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
        <View style={{ flex: 1 }}>
          {tab === 'taxi' && (ride ? <RideScreen ride={ride} /> : <HomeScreen />)}
          {tab === 'rides' && <RidesScreen />}
          {tab === 'profile' && <ProfileScreen />}
        </View>
        <TabBar tab={tab} setTab={setTab} live={!!ride} />
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

function TabBar({ tab, setTab, live }: { tab: Tab; setTab: (t: Tab) => void; live: boolean }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useApp();
  const tabs: { key: Tab; label: string }[] = [{ key: 'taxi', label: t.tabTaxi }, { key: 'rides', label: t.tabRides }, { key: 'profile', label: t.tabProfile }];
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surfaceCard, paddingBottom: insets.bottom }}>
      {tabs.map((x) => {
        const on = x.key === tab;
        return (
          <Pressable key={x.key} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setTab(x.key)}
            style={{ flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 2, paddingTop: space.s1 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: x.key === 'taxi' && live ? c.success : on ? c.brand : 'transparent' }} />
            <T v="label" color={on ? c.link : c.inkMuted} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{x.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}
