import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fareTiyin, clampToCorridor, roundToSum } from '../src/pricing.ts';
import { canTransition } from '../src/rideStatus.ts';

const tariff = { baseTiyin: 500_000, perKmTiyin: 200_000, perMinTiyin: 30_000, minFareTiyin: 1_200_000 };

test('fare uses distance and time, rounded to 500 sum', () => {
  // 5000 + 12.4 * 2000 + 23 * 300 = 36 700 sum -> 36 500 sum
  assert.equal(fareTiyin(tariff, { distanceM: 12_400, durationS: 23 * 60 }), 3_650_000);
});

test('fare never drops below the minimum', () => {
  assert.equal(fareTiyin(tariff, { distanceM: 500, durationS: 120 }), 1_200_000);
});

test('driver price is clamped into the -20%..0% corridor', () => {
  const rec = 4_000_000;
  const c = { minPct: -20, maxPct: 0 };
  assert.equal(clampToCorridor(5_000_000, rec, c), 4_000_000); // never above reference
  assert.equal(clampToCorridor(2_000_000, rec, c), 3_200_000); // never below -20%
  assert.equal(clampToCorridor(3_400_000, rec, c), 3_400_000);
});

test('rounding', () => {
  assert.equal(roundToSum(3_124_900), 3_100_000);
});

test('ride status transitions', () => {
  assert.equal(canTransition('created', 'accepted'), true);
  assert.equal(canTransition('created', 'completed'), false);
  assert.equal(canTransition('in_progress', 'cancelled'), false);
});

test('coefficient scales driver and reference fares alike', async () => {
  const { driverPriceTiyin, scaledFareTiyin } = await import('../src/pricing.ts');
  const rec = { baseTiyin: 500000, perKmTiyin: 180000, perMinTiyin: 25000, minFareTiyin: 1200000 };
  const cheap = { baseTiyin: 400000, perKmTiyin: 144000, perMinTiyin: 20000, minFareTiyin: 960000 };
  const route = { distanceM: 10000, durationS: 1200 };
  const corridor = { minPct: -20, maxPct: 0 };
  const base = driverPriceTiyin(cheap, rec, corridor, route, 1);
  const up = driverPriceTiyin(cheap, rec, corridor, route, 1.2);
  assert.ok(Math.abs(up - base * 1.2) <= 50000, 'about 20% more, rounded to 500 sum');
  assert.ok(up <= scaledFareTiyin(rec, route, 1.2), 'never above the scaled reference');
  assert.equal(up % 50000, 0);
});
