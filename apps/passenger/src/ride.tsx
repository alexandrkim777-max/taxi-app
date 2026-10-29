// The passenger's current ride, kept fresh by polling while the app is open (every 2.5 s during
// a ride, which is also how the driver's car moves on the map; every 30 s otherwise).
// Push notifications come later.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { api } from './api';
import type { Ride } from './types';

interface RideCtx {
  ride: Ride | null;
  /** A ride that just ended: completed (rate it) or cancelled by the driver / no driver found. */
  ended: Ride | null;
  clearEnded: () => void;
  setRide: (r: Ride | null) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<RideCtx | null>(null);

export function RideProvider({ children }: { children: ReactNode }) {
  const [ride, setRideState] = useState<Ride | null>(null);
  const [ended, setEnded] = useState<Ride | null>(null);
  const last = useRef<Ride | null>(null);
  const wake = useRef<(() => void) | null>(null);

  const setRide = useCallback((r: Ride | null) => {
    const started = r && !last.current;
    last.current = r; setRideState(r);
    if (started) wake.current?.();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const active = await api<Ride | null>('/rides/active');
      if (active) { setRide(active); return; }
      const prev = last.current;
      if (prev) {
        // The ride is no longer active: find out how it ended.
        const final = await api<Ride>(`/rides/${prev.id}`);
        setRide(null);
        if (final.status === 'completed' || (final.status === 'cancelled' && final.cancelledBy !== 'passenger')) setEnded(final);
      }
    } catch {
      // Offline for a moment: keep the last known state and try again on the next tick.
    }
  }, [setRide]);

  useEffect(() => {
    // Fast while a ride is on (car position, status); slow otherwise (a ride ordered elsewhere).
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    const loop = async () => {
      await refresh();
      if (active) timer = setTimeout(loop, last.current ? 2500 : 30_000);
    };
    wake.current = () => { if (timer) clearTimeout(timer); if (active) timer = setTimeout(loop, 2500); };
    loop();
    const sub = AppState.addEventListener('change', (s) => {
      if (timer) clearTimeout(timer);
      active = s === 'active';
      if (active) loop();
    });
    return () => { active = false; wake.current = null; if (timer) clearTimeout(timer); sub.remove(); };
  }, [refresh]);

  return <Ctx.Provider value={{ ride, ended, clearEnded: () => setEnded(null), setRide, refresh }}>{children}</Ctx.Provider>;
}

export function useRide(): RideCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('RideProvider missing');
  return v;
}
