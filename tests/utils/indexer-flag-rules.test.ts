/**
 * Component: Indexer Flag Exclusion Rules Tests (F2(a))
 * Documentation: documentation/phase3/ranking-algorithm.md
 */

import { describe, expect, it } from 'vitest';
import {
  filterExcludedByRules,
  matchExcludeRule,
  summarizeExcluded,
} from '@/lib/utils/indexer-flag-rules';
import type { IndexerFlagConfig } from '@/lib/utils/ranking-algorithm';

// The motivating case: exclude MyAnonamouse `[VIP]` releases (indexer id 20).
const vipRule: IndexerFlagConfig = {
  name: 'MAM VIP',
  modifier: 0,
  action: 'exclude',
  pattern: '\\[VIP\\]',
  indexerId: 20,
};

// A scoring rule that must be ignored by the exclusion filter entirely.
const freeleechScore: IndexerFlagConfig = { name: 'Freeleech', modifier: 50 };

describe('filterExcludedByRules', () => {
  it('returns input unchanged when there are no rules', () => {
    const results = [{ title: 'A Book [VIP]', indexerId: 20 }];
    const { kept, excluded } = filterExcludedByRules(results, undefined);
    expect(kept).toBe(results); // same reference — short-circuit
    expect(excluded).toEqual([]);
  });

  it('returns input unchanged when only scoring rules are present', () => {
    const results = [{ title: 'A Book [VIP]', indexerId: 20 }];
    const { kept, excluded } = filterExcludedByRules(results, [freeleechScore]);
    expect(kept).toBe(results);
    expect(excluded).toEqual([]);
  });

  it('returns input unchanged when results array is empty', () => {
    const { kept, excluded } = filterExcludedByRules([], [vipRule]);
    expect(kept).toEqual([]);
    expect(excluded).toEqual([]);
  });

  it('excludes a release whose title matches the pattern on the scoped indexer', () => {
    const results = [
      { title: 'Jumpnauts [ENG / M4B] [VIP]', indexerId: 20 },
      { title: 'Jumpnauts [ENG / M4B]', indexerId: 20 },
    ];
    const { kept, excluded } = filterExcludedByRules(results, [vipRule]);
    expect(kept).toEqual([{ title: 'Jumpnauts [ENG / M4B]', indexerId: 20 }]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].result.title).toBe('Jumpnauts [ENG / M4B] [VIP]');
    expect(excluded[0].rule).toBe(vipRule);
  });

  it('matches the title pattern case-insensitively', () => {
    const results = [{ title: 'Some Book [vip]', indexerId: 20 }];
    const { kept, excluded } = filterExcludedByRules(results, [vipRule]);
    expect(kept).toEqual([]);
    expect(excluded).toHaveLength(1);
  });

  it('respects per-indexer scope — a scoped rule does not touch other indexers', () => {
    const results = [
      { title: 'A Book [VIP]', indexerId: 20 }, // MAM → excluded
      { title: 'A Book [VIP]', indexerId: 25 }, // some public tracker → kept
    ];
    const { kept, excluded } = filterExcludedByRules(results, [vipRule]);
    expect(kept).toEqual([{ title: 'A Book [VIP]', indexerId: 25 }]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].result.indexerId).toBe(20);
  });

  it('applies to all indexers when indexerId is unset', () => {
    const globalRule: IndexerFlagConfig = {
      name: 'any vip',
      modifier: 0,
      action: 'exclude',
      pattern: '\\[VIP\\]',
    };
    const results = [
      { title: 'A [VIP]', indexerId: 20 },
      { title: 'B [VIP]', indexerId: 25 },
      { title: 'C [VIP]' }, // no indexerId at all
    ];
    const { kept, excluded } = filterExcludedByRules(results, [globalRule]);
    expect(kept).toEqual([]);
    expect(excluded).toHaveLength(3);
  });

  it('fails open on an invalid regex (never throws, excludes nothing)', () => {
    const badRule: IndexerFlagConfig = {
      name: 'broken',
      modifier: 0,
      action: 'exclude',
      pattern: '[unterminated(', // invalid regex
    };
    const results = [{ title: 'A Book [VIP]', indexerId: 20 }];
    expect(() => filterExcludedByRules(results, [badRule])).not.toThrow();
    const { kept, excluded } = filterExcludedByRules(results, [badRule]);
    expect(kept).toBe(results);
    expect(excluded).toEqual([]);
  });

  it('treats an empty/whitespace pattern as inert', () => {
    const emptyRule: IndexerFlagConfig = { name: 'empty', modifier: 0, action: 'exclude', pattern: '  ' };
    const results = [{ title: 'Anything', indexerId: 20 }];
    const { kept, excluded } = filterExcludedByRules(results, [emptyRule]);
    expect(kept).toBe(results);
    expect(excluded).toEqual([]);
  });

  it('excludes by the first matching rule when several apply', () => {
    const rule1: IndexerFlagConfig = { name: 'vip', modifier: 0, action: 'exclude', pattern: '\\[VIP\\]' };
    const rule2: IndexerFlagConfig = { name: 'eng', modifier: 0, action: 'exclude', pattern: '\\[ENG' };
    const results = [{ title: 'Book [ENG / M4B] [VIP]', indexerId: 20 }];
    const { excluded } = filterExcludedByRules(results, [rule1, rule2]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].rule).toBe(rule1); // first in the array wins
  });

  it('ignores scoring rules while honoring exclude rules in the same array', () => {
    const results = [
      { title: 'Good Book', indexerId: 20 },
      { title: 'Bad Book [VIP]', indexerId: 20 },
    ];
    const { kept, excluded } = filterExcludedByRules(results, [freeleechScore, vipRule]);
    expect(kept).toEqual([{ title: 'Good Book', indexerId: 20 }]);
    expect(excluded).toHaveLength(1);
  });
});

describe('matchExcludeRule', () => {
  it('returns the matching rule', () => {
    expect(matchExcludeRule({ title: 'X [VIP]', indexerId: 20 }, [vipRule])).toBe(vipRule);
  });

  it('returns null when nothing matches', () => {
    expect(matchExcludeRule({ title: 'X [VIP]', indexerId: 25 }, [vipRule])).toBeNull();
    expect(matchExcludeRule({ title: 'Clean', indexerId: 20 }, [vipRule])).toBeNull();
    expect(matchExcludeRule({ title: 'X [VIP]', indexerId: 20 }, [freeleechScore])).toBeNull();
  });
});

describe('summarizeExcluded', () => {
  it('groups counts by rule label', () => {
    const excluded = [
      { result: { title: 'a [VIP]' }, rule: vipRule },
      { result: { title: 'b [VIP]' }, rule: vipRule },
    ];
    expect(summarizeExcluded(excluded)).toBe('2 excluded by rule(s): "MAM VIP" (×2)');
  });

  it('falls back to the pattern when a rule has no label', () => {
    const unnamed: IndexerFlagConfig = { name: '', modifier: 0, action: 'exclude', pattern: '\\[VIP\\]' };
    const excluded = [{ result: { title: 'a [VIP]' }, rule: unnamed }];
    expect(summarizeExcluded(excluded)).toBe('1 excluded by rule(s): "\\[VIP\\]" (×1)');
  });
});
