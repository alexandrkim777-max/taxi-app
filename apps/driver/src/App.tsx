// Driver app shell: sign-in, onboarding, then the working tabs. An active ride or the rating
// screen takes over the whole app until it is finished.

import { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, ApiError, DEMO, loadToken, saveToken } from './api';
import { App as AppContext, useApp, type DriverProfile } from './context';
import { DICTS, type Lang } from './i18n';
import { LineProvider, useLine } from './line';
import { space, ThemeProvider, useTheme } from './theme';
import { T } from './components/ui';
import { CodeScreen, LanguageScreen, PhoneScreen } from './screens/Auth';
import { ApplyScreen, DocumentsScreen, PendingScreen } from './screens/Onboarding';
import { HomeScreen, RateScreen, RideScreen } from './screens/Line';
import { ProfileScreen, SubscriptionScreen, TariffScreen } from './screens/Account';

type Auth = { step: 'language' } | { step: 'phone' } | { step: 'code'; phone: string };
type Tab = 'line' | 'price' | 'subscription' | 'profile';

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
  const [signedIn, setSignedIn] = useState(false);
  const [auth, setAuth] = useState<Auth>({ step: 'language' });
  const [driver, setDriver] = useState<DriverProfile | null>(null);
  const [driverLoaded, setDriverLoaded] = useState(false);
  const [docsStep, setDocsStep] = useState(false);

  const reloadDriver = useCallback(async () => {
    try {
      const d = await api<DriverProfile>('/drivers/me');
      setDriver(d); setDriverLoaded(true);
      return d;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) { setDriver(null); setDriverLoaded(true); return null; }
      throw err;
    }
  }, []);

  useEffect(() => {
    (async () => {
      if (await loadToken()) {
        try {
          const me = await api<{ language: Lang }>('/me');
          setLangState(me.language); setSignedIn(true); await reloadDriver();
        } catch { await saveToken(null); }
      }
      setBooting(false);
    })();
  }, [reloadDriver]);

  const setLang = (l: Lang) => {
    setLangState(l);
    if (signedIn) api('/me', { method: 'PATCH', body: { language: l } }).catch(() => {});
  };
  const logout = () => {
    api('/auth/logout', { body: {} }).catch(() => {});
    saveToken(null); setSignedIn(false); setDriver(null); setDriverLoaded(false); setAuth({ step: 'language' });
  };

  // Stay on the documents screen until the driver presses "Send for review", even once all are uploaded.
  useEffect(() => {
    if (driver && driver.status !== 'verified' && driver.missingDocuments.length > 0) setDocsStep(true);
  }, [driver]);

  if (booting) return <View style={{ flex: 1, backgroundColor: c.surfacePage }} />;
  const t = DICTS[lang];

  let content;
  if (!signedIn) {
    content = auth.step === 'language' ? <LanguageScreen onPick={(l) => { setLangState(l); setAuth({ step: 'phone' }); }} />
      : auth.step === 'phone' ? <PhoneScreen lang={lang} onSent={(phone) => setAuth({ step: 'code', phone })} onBack={() => setAuth({ step: 'language' })} />
        : <CodeScreen lang={lang} phone={auth.phone} onBack={() => setAuth({ step: 'phone' })}
          onSignedIn={async (token) => { await saveToken(token); setSignedIn(true); await reloadDriver(); }} />;
  } else if (!driverLoaded) {
    content = <View style={{ flex: 1, backgroundColor: c.surfacePage }} />;
  } else if (!driver || driver.vehicles.length === 0) {
    content = <ApplyScreen />;
  } else if (driver.status !== 'verified' && docsStep) {
    content = <DocumentsScreen onDone={() => setDocsStep(false)} />;
  } else if (driver.status !== 'verified') {
    content = <PendingScreen onFixDocs={() => setDocsStep(true)} />;
  } else {
    content = <LineProvider><Main /></LineProvider>;
  }

  return (
    <AppContext.Provider value={{ lang, t, setLang, driver, reloadDriver, logout }}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <View style={{ flex: 1, backgroundColor: c.surfacePage }}>
        {DEMO && <View style={{ position: 'absolute', zIndex: 5, right: 12, top: 8 }} pointerEvents="none"><T v="label" muted>{t.demo}</T></View>}
        {content}
      </View>
    </AppContext.Provider>
  );
}

function Main() {
  const line = useLine();
  const [tab, setTab] = useState<Tab>('line');
  if (line.ride) return <RideScreen ride={line.ride} />;
  if (line.finished) return <RateScreen ride={line.finished} />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {tab === 'line' && <HomeScreen onSubscription={() => setTab('subscription')} />}
        {tab === 'price' && <TariffScreen />}
        {tab === 'subscription' && <SubscriptionScreen />}
        {tab === 'profile' && <ProfileScreen />}
      </View>
      <TabBar tab={tab} setTab={setTab} />
    </View>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const line = useLine();
  const { t } = useApp();
  const tabs: { key: Tab; label: string }[] = [
    { key: 'line', label: t.tabLine }, { key: 'price', label: t.tabPrice },
    { key: 'subscription', label: t.tabSubscription }, { key: 'profile', label: t.tabProfile },
  ];
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surfaceCard, paddingBottom: insets.bottom }}>
      {tabs.map((x) => {
        const on = x.key === tab;
        return (
          <Pressable key={x.key} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setTab(x.key)}
            style={{ flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 2, paddingTop: space.s1 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: x.key === 'line' && line.online ? c.success : on ? c.brand : 'transparent' }} />
            <T v="label" color={on ? c.link : c.inkMuted} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{x.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}
