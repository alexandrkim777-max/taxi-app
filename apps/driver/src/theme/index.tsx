// Day / night themes from the design system tokens. "Auto" follows the phone's setting and, as
// the design system asks for drivers, also switches to night after sunset hours in Tashkent.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { colors, radius, size, space, type, type Palette } from './tokens';

export type ThemeMode = 'auto' | 'day' | 'night';

function tashkentHour(): number {
  return (new Date().getUTCHours() + 5) % 24;
}

interface ThemeCtx { c: Palette; dark: boolean; mode: ThemeMode; setMode: (m: ThemeMode) => void }
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>('auto');
  const [hour, setHour] = useState(tashkentHour());
  useEffect(() => {
    const t = setInterval(() => setHour(tashkentHour()), 60_000);
    return () => clearInterval(t);
  }, []);
  const dark = mode === 'night' || (mode === 'auto' && (system === 'dark' || hour >= 19 || hour < 6));
  const value = useMemo(() => ({ c: (dark ? colors.dark : colors.light) as Palette, dark, mode, setMode }), [dark, mode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('ThemeProvider missing');
  return v;
}

export { radius, size, space, type };
