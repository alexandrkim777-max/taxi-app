// "The line": going online/offline, incoming requests, the active ride. Requests and the ride are
// polled every few seconds while relevant (push notifications come later).

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { api, ApiError, errorText } from './api';
import { currentPosition, lastPingOkAt, onNotOnline, requestPermission, startTracking, stopTracking } from './location';
import { useApp } from './context';
import type { LegalDoc } from './screens/Consent';

export interface Stop { position: number; lat: number; lng: number; address: string | null; entrance?: string | null }
export interface Request {
  rideId: string; offerId: string; priceTiyin: number; expiresAt: string; distanceM: number; durationS: number;
  options: Record<string, boolean>; comment: string | null; passengerRating: number | null; pickupDistanceM: number | null; stops: Stop[];
}
export interface Ride {
  id: string; status: string; priceTiyin: number; route: { distanceM: number; durationS: number }; stops: Stop[];
  passenger?: { name: string | null; rating: number | null };
  payment?: { method: 'cash' | 'card'; status: string | null; paidTiyin: number };
  cashToCollectTiyin?: number;
  waiting?: { arrivedAt: string; freeUntil: string; ratePerMinTiyin: number; paidMinutes: number; accruedTiyin: number } | null;
  trip?: { drivenM: number; progressPct: number };
  cancelledBy?: string | null;
  cancelFee?: { amountTiyin: number; status: string } | null;
  comment?: string | null;
}

interface LineCtx {
  online: boolean;
  /** On the line, but the server has not had a position for a while: no orders will come. */
  signalLost: boolean;
  busy: boolean;
  notice: string | null;
  request: Request | null;
  ride: Ride | null;
  finished: Ride | null;
  goOnline: () => Promise<void>;
  goOffline: () => Promise<void>;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  setStatus: (status: string) => Promise<void>;
  cancel: (opts: { noShow?: boolean; reason?: string }) => Promise<void>;
  refreshRide: () => Promise<void>;
  doneRating: () => void;
}

/** Warn after this long without an accepted ping (the server's own cut-off is 60 s). */
const SIGNAL_LOST_MS = 45_000;

const Ctx = createContext<LineCtx | null>(null);
export function useLine(): LineCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('LineProvider missing');
  return v;
}

const ACTIVE = ['accepted', 'driver_en_route', 'arrived', 'in_progress'];

export function LineProvider({ children }: { children: ReactNode }) {
  const { t, needConsent } = useApp();
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const [ride, setRide] = useState<Ride | null>(null);
  const [finished, setFinished] = useState<Ride | null>(null);
  const lastRequest = useRef<string | null>(null);
  const [signalLost, setSignalLost] = useState(false);

  const explain = useCallback((err: unknown) => {
    if (err instanceof ApiError) {
      if (err.code === 'subscription_required') return t.subscriptionNeeded;
      if (err.code === 'paused') return t.paused;
      if (err.code === 'blocked') return t.blocked;
    }
    return `${t.error}: ${errorText(err)}`;
  }, [t]);

  // Restore after an app restart: an active ride means we are on the line.
  useEffect(() => {
    api<Ride>('/rides/active').then((r) => {
      if (r && (r as Ride).id) { setRide(r); setOnline(true); startTracking(t.online).catch(() => {}); }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The server dropped us from the line (paused, blocked, or swept after a long silence).
  // Try to come back once; if that is refused, show why and stop tracking.
  const recovering = useRef(false);
  useEffect(() => {
    if (!online) { onNotOnline(null); return; }
    onNotOnline(() => {
      if (recovering.current) return;
      recovering.current = true;
      currentPosition()
        .then((pos) => api('/drivers/me/online', { body: pos }))
        .catch(async (err) => { await stopTracking().catch(() => {}); setOnline(false); setNotice(explain(err)); })
        .finally(() => { recovering.current = false; });
    });
    return () => onNotOnline(null);
  }, [online, explain]);

  // Warn when pings stop getting through (no GPS fix or no internet): the server stops
  // offering orders 60 s after the last position, so the driver should know at once.
  useEffect(() => {
    if (!online) { setSignalLost(false); return; }
    const id = setInterval(() => setSignalLost(Date.now() - lastPingOkAt() > SIGNAL_LOST_MS), 5000);
    return () => clearInterval(id);
  }, [online]);

  // Keep the screen on while on the line (navigation, incoming orders).
  const awake = useRef(false);
  useEffect(() => {
    if (online && !awake.current) { awake.current = true; activateKeepAwakeAsync('line').catch(() => {}); }
    if (!online && awake.current) { awake.current = false; Promise.resolve(deactivateKeepAwake('line')).catch(() => {}); }
  }, [online]);

  // Poll for requests while online and free.
  useEffect(() => {
    if (!online || ride) { setRequest(null); return; }
    let stop = false;
    const tick = async () => {
      try {
        const list = await api<Request[]>('/drivers/me/requests');
        if (stop) return;
        const next = list[0] ?? null;
        if (next && next.rideId !== lastRequest.current && Platform.OS !== 'web') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        }
        lastRequest.current = next?.rideId ?? null;
        setRequest(next);
      } catch { /* network hiccup: try again on the next tick */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(id); };
  }, [online, ride]);

  const refreshRide = useCallback(async () => {
    if (!ride) return;
    try {
      const r = await api<Ride>(`/rides/${ride.id}`);
      if (r.status === 'cancelled') {
        setRide(null);
        setNotice(r.cancelledBy === 'passenger' ? t.rideCancelled + (r.cancelFee ? ` · ${t.cancelFeeToYou}` : '') : null);
      } else if (r.status === 'completed') {
        setRide(null); setFinished(r);
      } else setRide(r);
    } catch { /* keep the last known state */ }
  }, [ride, t]);

  // Keep the active ride fresh (passenger may add a stop, cancel, switch to cash).
  useEffect(() => {
    if (!ride || !ACTIVE.includes(ride.status)) return;
    const id = setInterval(refreshRide, 4000);
    return () => clearInterval(id);
  }, [ride, refreshRide]);

  const value: LineCtx = {
    online, signalLost, busy, notice, request, ride, finished,
    goOnline: async () => {
      setBusy(true); setNotice(null);
      try {
        if (!(await requestPermission())) { setNotice(t.locationNeeded); return; }
        const pos = await currentPosition();
        try { await api('/drivers/me/online', { body: pos }); } catch (e) {
          // A new version of the agreement: accept it first, then go online again.
          if (e instanceof ApiError && e.code === 'consent_required') { needConsent(e.body.documents as LegalDoc[]); return; }
          throw e;
        }
        await startTracking(t.online);
        setOnline(true);
      } catch (err) { setNotice(explain(err)); } finally { setBusy(false); }
    },
    goOffline: async () => {
      setBusy(true);
      try { await api('/drivers/me/offline', { body: {} }); await stopTracking(); setOnline(false); }
      catch (err) { setNotice(explain(err)); } finally { setBusy(false); }
    },
    accept: async () => {
      if (!request) return;
      setBusy(true);
      try { setRide(await api<Ride>(`/rides/${request.rideId}/accept`, { body: {}, retry: true })); setRequest(null); }
      catch (err) { setRequest(null); setNotice(explain(err)); } finally { setBusy(false); }
    },
    decline: async () => {
      if (!request) return;
      const id = request.rideId;
      setRequest(null);
      await api(`/rides/${id}/decline`, { body: {} }).catch(() => {});
    },
    setStatus: async (status: string) => {
      if (!ride) return;
      setBusy(true);
      try {
        const r = await api<Ride>(`/rides/${ride.id}/status`, { body: { status }, retry: true });
        if (r.status === 'completed') { setRide(null); setFinished(r); } else setRide(r);
      } catch (err) { setNotice(explain(err)); } finally { setBusy(false); }
    },
    cancel: async ({ noShow, reason }) => {
      if (!ride) return;
      setBusy(true);
      try {
        await api(`/rides/${ride.id}/cancel`, { body: noShow ? { noShow: true } : reason ? { reason } : {}, retry: true });
        setRide(null);
      } catch (err) { setNotice(explain(err)); } finally { setBusy(false); }
    },
    refreshRide,
    doneRating: () => setFinished(null),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
