// Shared JSON schemas for coordinates.

// Points must be inside Uzbekistan's bounding box (rough), so the API cannot be used
// as a free routing service for arbitrary places and junk coordinates never reach the database.
export const UZ_LAT = { type: 'number', minimum: 37.1, maximum: 45.6 } as const;
export const UZ_LNG = { type: 'number', minimum: 55.9, maximum: 73.2 } as const;

export const uzPoint = {
  type: 'object',
  required: ['lat', 'lng'],
  additionalProperties: false,
  properties: { lat: UZ_LAT, lng: UZ_LNG },
} as const;

/** A driver position ping: point plus optional compass heading. */
export const driverPosition = {
  type: 'object',
  required: ['lat', 'lng'],
  additionalProperties: false,
  properties: {
    lat: UZ_LAT,
    lng: UZ_LNG,
    heading: { type: 'integer', minimum: 0, maximum: 359 },
  },
} as const;

export const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } },
} as const;

/** Great-circle distance in metres. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
