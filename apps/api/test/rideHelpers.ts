// Ride test helpers: drivers on the map, passengers, rides in a given state.

import assert from 'node:assert/strict';
import { db, randomPhone, verifiedDriver, type Setup } from './helpers.ts';

export type Headers = Record<string, string>;

/** A random spot in Tashkent, so parallel test runs don't see each other's drivers. */
export function randomSpot(): { lat: number; lng: number } {
  return { lat: 41.25 + Math.random() * 0.1, lng: 69.18 + Math.random() * 0.15 };
}

/** About `m` metres north of a point. */
export function north(p: { lat: number; lng: number }, m: number) {
  return { lat: p.lat + m / 111_000, lng: p.lng };
}

export async function passenger(s: Setup): Promise<Headers> {
  return { authorization: `Bearer ${await s.login(randomPhone())}` };
}

export async function onlineDriver(s: Setup, at: { lat: number; lng: number }): Promise<Headers> {
  const auth = await verifiedDriver(s);
  const res = await s.app.inject({ method: 'POST', url: '/drivers/me/online', headers: auth, payload: at });
  assert.equal(res.statusCode, 200, res.body);
  return auth;
}

export async function createRide(s: Setup, auth: Headers, pickup: { lat: number; lng: number }) {
  return s.app.inject({
    method: 'POST', url: '/rides', headers: auth,
    payload: { classCode: 'economy', mode: 'choose', stops: [pickup, north(pickup, 6000)], options: { quiet: true } },
  });
}

/**
 * The offer from a given driver. Drivers left online by earlier tests may also be nearby,
 * so tests pick their own driver's offer explicitly.
 */
export async function offerOf(s: Setup, ride: { id: string; offers: { id: string }[] }, driver: Headers) {
  const driverId = (await s.app.inject({ method: 'GET', url: '/drivers/me', headers: driver })).json().id;
  const { rows } = await db.query(`SELECT id FROM ride_offers WHERE ride_id = $1 AND driver_id = $2`, [ride.id, driverId]);
  const offer = ride.offers.find((o) => o.id === rows[0]?.id);
  assert.ok(offer, 'the driver is offered');
  return offer as { id: string; priceTiyin: number; [k: string]: unknown };
}

/** Ride created, driver chosen and accepted. */
export async function acceptedRide(s: Setup) {
  const spot = randomSpot();
  const driver = await onlineDriver(s, north(spot, 300));
  const pax = await passenger(s);
  const ride = (await createRide(s, pax, spot)).json();
  const offer = await offerOf(s, ride, driver);
  const chosen = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/choose`, headers: pax, payload: { offerId: offer.id } });
  assert.equal(chosen.statusCode, 200, chosen.body);
  const accepted = await s.app.inject({ method: 'POST', url: `/rides/${ride.id}/accept`, headers: driver });
  assert.equal(accepted.statusCode, 200, accepted.body);
  return { spot, driver, pax, rideId: ride.id as string, offer };
}


/**
 * Moves an accepted ride through statuses as its driver. Before 'arrived' the driver's position
 * is put at the pickup, since the server only accepts 'arrived' there.
 */
export async function drive(s: Setup, driver: Headers, rideId: string, statuses: string[]): Promise<void> {
  for (const status of statuses) {
    if (status === 'arrived') {
      const ride = (await s.app.inject({ method: 'GET', url: `/rides/${rideId}`, headers: driver })).json();
      const pickup = ride.stops[0];
      const ping = await s.app.inject({
        method: 'POST', url: '/drivers/me/location', headers: driver, payload: { lat: pickup.lat, lng: pickup.lng },
      });
      assert.equal(ping.statusCode, 204, ping.body);
    }
    const res = await s.app.inject({ method: 'POST', url: `/rides/${rideId}/status`, headers: driver, payload: { status } });
    assert.equal(res.statusCode, 200, `${status}: ${res.body}`);
  }
}

/**
 * Takes drivers left online by earlier tests off the map and closes their still-searching rides,
 * so the dispatcher's picks in the next test are predictable.
 */
export async function clearMap(): Promise<void> {
  await db.query(`UPDATE driver_presence SET updated_at = now() - interval '10 minutes'`);
  await db.query(`UPDATE ride_offers SET status = 'expired' WHERE status IN ('open', 'chosen')`);
  await db.query(`UPDATE rides SET status = 'cancelled', cancelled_by = 'system', cancel_reason = 'test_cleanup' WHERE status = 'created'`);
}
