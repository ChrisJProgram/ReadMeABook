/**
 * Component: Indexer Tiers (F3)
 * Documentation: documentation/phase3/README.md
 *
 * Strict tiered indexer preference for AUTOMATIC selection. Additive priority
 * (1-25) gets swamped by seeder count — observed live: AudiobookBay at
 * priority 25 with 1 seeder repeatedly lost to MyAnonamouse at 20 with 28
 * seeders, so "use ABB if it has it at all, otherwise MAM" was inexpressible.
 *
 * Semantics:
 * - `tier` is an optional positive integer per indexer; LOWER wins (tier 1 is
 *   considered before tier 2, etc.).
 * - Every candidate from the best populated tier is taken before ANY candidate
 *   from a later tier; ranking/scoring only orders candidates WITHIN a tier.
 * - Indexers with no tier act as the LAST tier (they win only when no tiered
 *   indexer produced a candidate).
 * - No tiers configured at all → selection is returned untouched, preserving
 *   upstream's weighted behaviour as the default.
 */

export interface TierSelection<T> {
  selected: T[];
  /** The winning tier, or null when tiering did not apply. */
  tier: number | null;
  /** How many candidates from later tiers were deferred. */
  deferred: number;
}

/** Build indexerId → tier from the prowlarr_indexers config array. */
export function buildTierMap(
  indexers: Array<{ id: number; tier?: number | null }>
): Map<number, number> {
  const map = new Map<number, number>();
  for (const idx of indexers) {
    if (typeof idx.tier === 'number' && Number.isFinite(idx.tier) && idx.tier > 0) {
      map.set(idx.id, idx.tier);
    }
  }
  return map;
}

/**
 * Keep only the candidates from the best (lowest) populated tier, preserving
 * their existing rank order. Pass the already-ranked (and floor-filtered) list.
 */
export function selectTopTier<T extends { indexerId?: number }>(
  results: T[],
  tierMap: Map<number, number>
): TierSelection<T> {
  if (tierMap.size === 0 || results.length === 0) {
    return { selected: results, tier: null, deferred: 0 };
  }

  const tierOf = (r: T): number =>
    (r.indexerId !== undefined ? tierMap.get(r.indexerId) : undefined) ?? Number.POSITIVE_INFINITY;

  let best = Number.POSITIVE_INFINITY;
  for (const r of results) {
    const t = tierOf(r);
    if (t < best) best = t;
  }

  // Only untiered candidates present → tiering has nothing to say.
  if (!Number.isFinite(best)) {
    return { selected: results, tier: null, deferred: 0 };
  }

  const selected = results.filter((r) => tierOf(r) === best);
  return { selected, tier: best, deferred: results.length - selected.length };
}
