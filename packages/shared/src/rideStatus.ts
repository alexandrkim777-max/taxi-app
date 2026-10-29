// Ride status machine. A ride may only move along these transitions;
// every transition is also written to ride_events by the API.

export const RIDE_STATUSES = [
  'scheduled',
  'created',
  'accepted',
  'driver_en_route',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

const TRANSITIONS: Record<RideStatus, readonly RideStatus[]> = {
  scheduled: ['created', 'cancelled'],
  created: ['accepted', 'cancelled'],
  accepted: ['driver_en_route', 'cancelled'],
  driver_en_route: ['arrived', 'cancelled'],
  arrived: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

export function canTransition(from: RideStatus, to: RideStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RideStatus, to: RideStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid ride status transition: ${from} -> ${to}`);
  }
}
