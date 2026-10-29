// App-wide state: language, the signed-in user, a simple screen stack, the order being composed.

import { createContext, useContext, type ReactNode } from 'react';
import type { Dict, Lang } from './i18n';
import type { Card, Me, Stop } from './types';

export type Route =
  | { name: 'search'; purpose: 'pickup' | 'dropoff' | 'stop' | 'home' | 'work' | 'other'; onPick: (s: Stop) => void }
  | { name: 'order' }
  | { name: 'cards'; onPick?: (c: Card) => void }
  | { name: 'addCard'; onAdded?: (c: Card) => void }
  | { name: 'places' }
  | { name: 'rideDetails'; rideId: string }
  | { name: 'debts' }
  | { name: 'profile' }
  | { name: 'rides' }
  | { name: 'blocked' }
  | { name: 'about' };

export interface Draft { pickup: Stop | null; stops: Stop[] }

export interface AppCtx {
  lang: Lang;
  t: Dict;
  setLang: (l: Lang) => void;
  me: Me | null;
  setMe: (m: Me) => void;
  logout: () => void;
  push: (r: Route) => void;
  pop: () => void;
  /** Closes every pushed screen (back to the tabs). */
  reset: () => void;
  draft: Draft;
  setDraft: (d: Draft | ((d: Draft) => Draft)) => void;
  /** Error codes from the API in the user's language. */
  err: (e: unknown) => string;
}

export const App = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const v = useContext(App);
  if (!v) throw new Error('App context missing');
  return v;
}
export type { ReactNode };
