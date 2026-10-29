// Day / night themes from the design system tokens. For passengers "Auto" follows the phone's setting
// (the automatic switch after 19:00 is for drivers only).

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { colors, radius, size, space, type, type Palette } from './tokens';

export type ThemeMode = 'auto' | 'day' | 'night';

interface ThemeCtx { c: Palette; dark: boolean; mode: ThemeMode; setMode: (m: ThemeMode) => void }
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>('auto');
  const dark = mode === 'night' || (mode === 'auto' && system === 'dark');
  const value = useMemo(() => ({ c: (dark ? colors.dark : colors.light) as Palette, dark, mode, setMode }), [dark, mode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('ThemeProvider missing');
  return v;
}

export { radius, size, space, type };
