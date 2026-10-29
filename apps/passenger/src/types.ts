// Shapes of what the API returns to the passenger app.

export interface LatLng { lat: number; lng: number }
export interface Place extends LatLng { name: string; address: string }
export interface Entrance extends LatLng { id: string; number: string; distanceM: number; confirmedPickups: number }
export interface SavedPlace extends LatLng { id: string; kind: 'home' | 'work' | 'other'; label: string | null; address: string; entranceId: string | null }

/** One point of the order. The pickup may carry an entrance (known one or typed by the passenger). */
export interface Stop extends LatLng { address: string; entranceId?: string; entranceLabel?: string }

export interface QuoteClass {
  code: string; name: string; seats: number; maxFareTiyin: number; minFareTiyin: number; coefficient: number;
  best: { priceTiyin: number; pickupMin: number } | null; driversNearby: number;
}
export interface Quote { route: { distanceM: number; durationS: number }; classes: QuoteClass[] }

export interface Card { id: string; provider: string; panMasked: string; expiry: string; isDefault: boolean }

export interface Offer {
  id: string; status: 'open' | 'chosen'; priceTiyin: number; expiresAt: string; driverName: string | null;
  rating: number | null; makeModel: string; color: string; distanceM: number; pickupMin: number;
}

export interface Waiting {
  arrivedAt?: string; freeUntil?: string; ratePerMinTiyin?: number; paidMinutes: number; accruedTiyin?: number;
  chargedTiyin?: number; maxPaidMinutes?: number;
}

export type RideStatus = 'created' | 'accepted' | 'driver_en_route' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';

export interface Ride {
  id: string; status: RideStatus; mode: 'auto' | 'choose'; classCode: string; priceTiyin: number | null;
  route: { distanceM: number; durationS: number };
  stops: (LatLng & { position: number; address: string | null; entrance: string | null })[];
  options: Record<string, boolean>; comment: string | null;
  cancelledBy: 'passenger' | 'driver' | 'system' | null; cancelReason: string | null;
  cancelFee: { amountTiyin: number; status: string } | null;
  payment: { method: 'cash' | 'card'; status: string | null; paidTiyin: number; dueTiyin: number | null; actionRequired: boolean };
  maxPriceTiyin?: number; searchDeadline?: string;
  dispatch?: { state: 'searching' | 'waiting_driver' } | { state: 'needs_confirmation'; priceTiyin: number };
  offers?: Offer[];
  driver?: {
    name: string | null; rating: number | null; highlights: { code: string; count: number }[];
    vehicle: { makeModel: string; color: string; plate: string };
    location: (LatLng & { heading: number | null; at: string }) | null;
  };
  trip?: { drivenM: number; progressPct: number };
  waiting?: Waiting | null;
  rating?: { myScore: number | null; canRate: boolean };
}

export interface CancelTerms {
  allowed: boolean; feeTiyin: number; breakdown?: { cancelTiyin: number; waitingTiyin: number }; freeUntil?: string;
}

export interface PastRide {
  id: string; status: 'completed' | 'cancelled'; classCode: string; priceTiyin: number | null; paymentMethod: 'cash' | 'card';
  createdAt: string; cancelFeeTiyin: number | null; driverName: string | null; makeModel: string | null; plate: string | null;
  fromAddress: string | null; to: (LatLng & { address: string | null }) | null; hasDispute: boolean;
}

export interface DisputeView {
  id: string; category: string; openedBy: 'passenger' | 'driver'; status: 'awaiting_response' | 'in_review' | 'resolved';
  myStatement: { text: string; createdAt: string } | null; otherStatement: { text: string; createdAt: string } | null;
  otherHasWritten: boolean; awaitingMe: boolean; outcome: string | null; resolution: string | null;
}

export interface Me { id: string; phone: string; name: string | null; language: 'uz' | 'ru' | 'en'; roles: string[] }
