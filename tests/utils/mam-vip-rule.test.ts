/**
 * Component: MAM VIP rule helper tests (F7 / L2)
 */

import { describe, expect, it } from 'vitest';
import {
  makeMamVipRule,
  isMamVipRule,
  hasMamVipRule,
  withMamVipRule,
  withoutMamVipRule,
  shouldExcludeVip,
  MAM_VIP_PATTERN,
} from '@/lib/utils/mam-vip-rule';
import type { IndexerFlagConfig } from '@/lib/utils/ranking-algorithm';

describe('makeMamVipRule', () => {
  it('produces the canonical exclude entry scoped to the MAM indexer', () => {
    expect(makeMamVipRule(5)).toEqual({
      name: 'MAM VIP',
      modifier: 0,
      action: 'exclude',
      pattern: MAM_VIP_PATTERN,
      indexerId: 5,
    });
  });
});

describe('isMamVipRule', () => {
  it('recognises the canonical rule', () => {
    expect(isMamVipRule(makeMamVipRule(5), 5)).toBe(true);
  });
  it('is tolerant of label/pattern hand-edits that still target VIP', () => {
    const edited: IndexerFlagConfig = { name: 'no vips!', modifier: 0, action: 'exclude', pattern: '\\[vip\\]', indexerId: 5 };
    expect(isMamVipRule(edited, 5)).toBe(true);
  });
  it('rejects a rule on a different indexer', () => {
    expect(isMamVipRule(makeMamVipRule(6), 5)).toBe(false);
  });
  it('rejects a scoring rule and a non-VIP exclude', () => {
    expect(isMamVipRule({ name: 'Freeleech', modifier: 50 }, 5)).toBe(false);
    expect(isMamVipRule({ name: 'x', modifier: 0, action: 'exclude', pattern: '\\[ENG', indexerId: 5 }, 5)).toBe(false);
  });
});

describe('has / with / without MamVipRule', () => {
  const other: IndexerFlagConfig = { name: 'Freeleech', modifier: 50 };

  it('adds the rule when absent and is idempotent', () => {
    const once = withMamVipRule([other], 5);
    expect(hasMamVipRule(once, 5)).toBe(true);
    expect(once).toHaveLength(2);
    const twice = withMamVipRule(once, 5);
    expect(twice).toHaveLength(2); // no duplicate
  });

  it('preserves unrelated rules and other indexers when removing', () => {
    const configs = [other, makeMamVipRule(5), makeMamVipRule(6)];
    const removed = withoutMamVipRule(configs, 5);
    expect(hasMamVipRule(removed, 5)).toBe(false);
    expect(hasMamVipRule(removed, 6)).toBe(true); // indexer 6 untouched
    expect(removed).toContain(other);
  });

  it('removing when absent is a no-op', () => {
    expect(withoutMamVipRule([other], 5)).toEqual([other]);
  });
});

describe('shouldExcludeVip', () => {
  it('keeps the rule exactly while VIP is not active (VIP is a readable class)', () => {
    expect(shouldExcludeVip(false)).toBe(true); // no VIP class → exclude [VIP] releases
    expect(shouldExcludeVip(true)).toBe(false); // class IS VIP → they are freeleech → keep them
  });
});
