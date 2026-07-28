/**
 * Component: Indexer Tiers (F3) Tests
 * Documentation: documentation/phase3/README.md
 */

import { describe, expect, it } from 'vitest';
import { buildTierMap, selectTopTier } from '@/lib/utils/indexer-tiers';

const r = (indexerId: number | undefined, title: string) => ({ indexerId, title });

describe('buildTierMap', () => {
  it('keeps only positive finite integer tiers', () => {
    const map = buildTierMap([
      { id: 1, tier: 1 },
      { id: 2, tier: 2 },
      { id: 3 }, // untiered
      { id: 4, tier: 0 }, // invalid
      { id: 5, tier: null },
    ]);
    expect([...map.entries()]).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe('selectTopTier', () => {
  it('is a no-op when no tiers are configured (weighted default preserved)', () => {
    const results = [r(2, 'MAM'), r(1, 'ABB')];
    const sel = selectTopTier(results, buildTierMap([{ id: 1 }, { id: 2 }]));
    expect(sel.selected).toEqual(results);
    expect(sel.tier).toBeNull();
    expect(sel.deferred).toBe(0);
  });

  it('takes tier 1 over a higher-ranked tier-2 candidate (the ABB/MAM case)', () => {
    // Ranked order puts MAM first (28 seeders beat ABB with 1) — exactly the
    // live failure that motivated F3. Tier 1 must win anyway.
    const results = [r(2, 'MAM 28 seeders'), r(1, 'ABB 1 seeder')];
    const sel = selectTopTier(results, buildTierMap([{ id: 1, tier: 1 }, { id: 2, tier: 2 }]));
    expect(sel.selected).toEqual([r(1, 'ABB 1 seeder')]);
    expect(sel.tier).toBe(1);
    expect(sel.deferred).toBe(1);
  });

  it('falls through to tier 2 when tier 1 produced nothing', () => {
    const results = [r(2, 'MAM only')];
    const sel = selectTopTier(results, buildTierMap([{ id: 1, tier: 1 }, { id: 2, tier: 2 }]));
    expect(sel.selected).toEqual([r(2, 'MAM only')]);
    expect(sel.tier).toBe(2);
  });

  it('treats untiered indexers as the last tier', () => {
    const results = [r(3, 'untiered'), r(2, 'tier 2')];
    const sel = selectTopTier(results, buildTierMap([{ id: 1, tier: 1 }, { id: 2, tier: 2 }]));
    expect(sel.selected).toEqual([r(2, 'tier 2')]);
    expect(sel.deferred).toBe(1);
  });

  it('lets untiered candidates through when no tiered indexer matched', () => {
    const results = [r(3, 'untiered A'), r(4, 'untiered B')];
    const sel = selectTopTier(results, buildTierMap([{ id: 1, tier: 1 }]));
    expect(sel.selected).toEqual(results);
    expect(sel.tier).toBeNull();
  });

  it('preserves rank order within the winning tier', () => {
    const results = [r(1, 'first'), r(2, 'other tier'), r(1, 'second')];
    const sel = selectTopTier(results, buildTierMap([{ id: 1, tier: 1 }, { id: 2, tier: 2 }]));
    expect(sel.selected.map((x) => x.title)).toEqual(['first', 'second']);
  });

  it('handles results with no indexerId as untiered', () => {
    const results = [r(undefined, 'mystery'), r(1, 'tier 1')];
    const sel = selectTopTier(results, buildTierMap([{ id: 1, tier: 1 }]));
    expect(sel.selected).toEqual([r(1, 'tier 1')]);
  });
});
