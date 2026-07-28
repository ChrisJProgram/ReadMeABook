/**
 * Component: Indexer Flag Exclusion Rules (F2(a))
 * Documentation: documentation/phase3/ranking-algorithm.md
 *
 * Pre-rank filter applied by every AUTOMATIC search path (audiobook, ebook) to
 * drop releases the account can never fetch — e.g. MyAnonamouse `[VIP]` releases
 * for a non-VIP account. MAM encodes entitlement in the release TITLE, which never
 * appears in Prowlarr's `flags` array, so these rules match the title by regex and
 * HARD-EXCLUDE (a score penalty can't reliably disqualify a high-priority release).
 *
 * Exclude rules are stored alongside scoring rules in the `indexer_flag_config`
 * array; an entry is a rule here iff `action === 'exclude'` (see [[IndexerFlagConfig]]).
 *
 * Interactive/admin search does NOT call this — that surface intentionally shows
 * every result and lets the user decide (mirrors [[filter-blocked-results]]).
 */

import type { IndexerFlagConfig } from '@/lib/utils/ranking-algorithm';

export interface ExcludableResult {
  title: string;
  indexerId?: number;
}

export interface ExcludeMatch<T> {
  result: T;
  rule: IndexerFlagConfig;
}

export interface FilterExcludedOutput<T> {
  kept: T[];
  excluded: ExcludeMatch<T>[];
}

interface CompiledRule {
  rule: IndexerFlagConfig;
  regex: RegExp;
}

/**
 * Precompile the exclude rules out of a flag-config array.
 *
 * Drops entries that are inert (not an exclude rule, or no pattern) and — crucially —
 * entries whose pattern is an invalid regex. Invalid patterns FAIL OPEN (inert): a
 * broken user-authored rule must never silently strand every request. The settings UI
 * validates patterns at author time; this is the defensive backstop for the search path.
 */
function compileExcludeRules(rules: IndexerFlagConfig[] | undefined): CompiledRule[] {
  if (!rules || rules.length === 0) return [];

  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    if (rule.action !== 'exclude') continue;
    const pattern = rule.pattern?.trim();
    if (!pattern) continue;
    try {
      compiled.push({ rule, regex: new RegExp(pattern, 'i') });
    } catch {
      // Invalid regex → inert (fail open). Never throws into the search path.
    }
  }
  return compiled;
}

/** First exclude rule that matches this result (title regex + optional indexer scope), or null. */
function firstMatch(compiled: CompiledRule[], result: ExcludableResult): IndexerFlagConfig | null {
  for (const { rule, regex } of compiled) {
    // Per-indexer scope: an unset indexerId applies to all indexers.
    if (rule.indexerId != null && result.indexerId !== rule.indexerId) continue;
    if (regex.test(result.title)) return rule;
  }
  return null;
}

/**
 * Return the first exclude rule matching `result`, or null. Convenience/single-item
 * entry point; the bulk path is [[filterExcludedByRules]] (compiles once).
 */
export function matchExcludeRule(
  result: ExcludableResult,
  rules: IndexerFlagConfig[] | undefined
): IndexerFlagConfig | null {
  return firstMatch(compileExcludeRules(rules), result);
}

/**
 * Partition results into those kept and those excluded by a title-pattern rule.
 *
 * Returns the original array unchanged when there are no compiled rules or no results
 * (the common hot-path case), so a config with only scoring rules costs nothing.
 */
export function filterExcludedByRules<T extends ExcludableResult>(
  results: T[],
  rules: IndexerFlagConfig[] | undefined
): FilterExcludedOutput<T> {
  const compiled = compileExcludeRules(rules);
  if (compiled.length === 0 || results.length === 0) {
    return { kept: results, excluded: [] };
  }

  const kept: T[] = [];
  const excluded: ExcludeMatch<T>[] = [];
  for (const result of results) {
    const rule = firstMatch(compiled, result);
    if (rule) {
      excluded.push({ result, rule });
    } else {
      kept.push(result);
    }
  }
  return { kept, excluded };
}

/**
 * Human-readable summary of what got excluded, for a single log line.
 * e.g. `2 excluded by rule(s): "MAM VIP" (×2)`
 */
export function summarizeExcluded<T>(excluded: ExcludeMatch<T>[]): string {
  const counts = new Map<string, number>();
  for (const { rule } of excluded) {
    const label = rule.name?.trim() || rule.pattern || 'exclude rule';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([label, n]) => `"${label}" (×${n})`);
  return `${excluded.length} excluded by rule(s): ${parts.join(', ')}`;
}
