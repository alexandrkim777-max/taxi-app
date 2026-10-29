// App-wide state: language, the driver's profile, sign-out.

import { createContext, useContext } from 'react';
import type { Dict, Lang } from './i18n';

export interface Vehicle { id: string; make_model: string; year: number; color: string; plate: string; class_code: string | null }
export interface Doc { id: string; type: string; status: string; note: string | null; fileUrl: string | null }
export interface DriverProfile {
  id: string; status: 'pending' | 'verified' | 'rejected' | 'blocked'; name: string | null; phone: string; rating: number | null;
  vehicles: Vehicle[]; documents: Doc[]; missingDocuments: string[];
  /** Documents staff sent back, with the reason. */
  rejections?: { type: string; note: string }[];
}

export interface AppCtx {
  lang: Lang;
  t: Dict;
  setLang: (l: Lang) => void;
  driver: DriverProfile | null;
  reloadDriver: () => Promise<DriverProfile | null>;
  logout: () => void;
}

export const App = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const v = useContext(App);
  if (!v) throw new Error('App context missing');
  return v;
}
