// Fare calculation. All amounts are integer tiyin (1 sum = 100 tiyin).

export interface Tariff {
  baseTiyin: number;
  perKmTiyin: number;
  perMinTiyin: number;
  minFareTiyin: number;
}

export interface Corridor {
  /** Lowest allowed price relative to the recommended tariff, percent (e.g. -20). */
  minPct: number;
  /** Highest allowed price relative to the recommended tariff, percent (e.g. 0). */
  maxPct: number;
}

export interface RouteEstimate {
  distanceM: number;
  durationS: number;
}

/** Fare for a route under a tariff, before options; never below the minimum fare. */
export function fareTiyin(tariff: Tariff, route: RouteEstimate): number {
  const km = route.distanceM / 1000;
  const min = route.durationS / 60;
  const raw = tariff.baseTiyin + km * tariff.perKmTiyin + min * tariff.perMinTiyin;
  return roundToSum(Math.max(tariff.minFareTiyin, raw));
}

/**
 * Clamp a driver's fare into the class corridor around the recommended fare.
 * The ceiling keeps us never more expensive than the reference tariff.
 */
export function clampToCorridor(driverFare: number, recommendedFare: number, corridor: Corridor): number {
  const low = Math.ceil((recommendedFare * (100 + corridor.minPct)) / 100);
  const high = Math.floor((recommendedFare * (100 + corridor.maxPct)) / 100);
  return roundToSum(Math.min(high, Math.max(low, driverFare)));
}

/** Round to a whole 500 sum, the way fares are shown to passengers. */
export function roundToSum(tiyin: number, stepSum = 500): number {
  const step = stepSum * 100;
  return Math.round(tiyin / step) * step;
}
