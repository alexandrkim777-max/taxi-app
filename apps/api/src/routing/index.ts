// Route distance/time behind an adapter. Distance always comes from our server,
// never from the client, so a passenger cannot fake a shorter trip.

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteResult {
  distanceM: number;
  durationS: number;
}

export interface RouteProvider {
  /** Route through the points in order (pickup, optional stops, destination). */
  route(points: LatLng[]): Promise<RouteResult>;
  /** Driving time in seconds from each of `from` to `to` (drivers to the pickup). */
  durationsTo(from: LatLng[], to: LatLng): Promise<number[]>;
}

const EARTH_RADIUS_M = 6_371_000;

function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Development fallback: straight-line distance times a road factor, average city speed.
 * Not for production pricing.
 */
export class EstimateRouteProvider implements RouteProvider {
  async route(points: LatLng[]): Promise<RouteResult> {
    let straight = 0;
    for (let i = 1; i < points.length; i++) straight += haversineM(points[i - 1], points[i]);
    const distanceM = Math.round(straight * 1.35);
    const durationS = Math.round(distanceM / (22_000 / 3600)); // ~22 km/h in city traffic
    return { distanceM, durationS };
  }

  async durationsTo(from: LatLng[], to: LatLng): Promise<number[]> {
    return from.map((f) => Math.round((haversineM(f, to) * 1.35) / (22_000 / 3600)));
  }
}

/** Self-hosted OSRM on OpenStreetMap data. The base URL comes from config, never from users. */
export class OsrmRouteProvider implements RouteProvider {
  private readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async route(points: LatLng[]): Promise<RouteResult> {
    const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const res = await fetch(`${this.baseUrl}/route/v1/driving/${coords}?overview=false`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`OSRM responded ${res.status}`);
    const body = (await res.json()) as { code?: string; routes?: { distance: number; duration: number }[] };
    const best = body.routes?.[0];
    if (body.code !== 'Ok' || !best || !Number.isFinite(best.distance) || !Number.isFinite(best.duration)) {
      throw new Error('OSRM returned no route');
    }
    return { distanceM: Math.round(best.distance), durationS: Math.round(best.duration) };
  }

  /** OSRM table service: many drivers to one pickup in a single request. */
  async durationsTo(from: LatLng[], to: LatLng): Promise<number[]> {
    if (from.length === 0) return [];
    const coords = [...from, to].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const sources = from.map((_, i) => i).join(';');
    const res = await fetch(`${this.baseUrl}/table/v1/driving/${coords}?sources=${sources}&destinations=${from.length}&annotations=duration`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`OSRM responded ${res.status}`);
    const body = (await res.json()) as { code?: string; durations?: (number | null)[][] };
    if (body.code !== 'Ok' || !body.durations || body.durations.length !== from.length) throw new Error('OSRM returned no table');
    return body.durations.map((row) => {
      const d = row[0];
      if (d === null || d === undefined || !Number.isFinite(d)) throw new Error('OSRM: unreachable point');
      return Math.round(d);
    });
  }
}

export function createRouteProvider(kind: string, osrmUrl: string): RouteProvider {
  switch (kind) {
    case 'osrm':
      return new OsrmRouteProvider(osrmUrl);
    case 'estimate':
      return new EstimateRouteProvider();
    default:
      throw new Error(`Unknown ROUTE_PROVIDER: ${kind}`);
  }
}
