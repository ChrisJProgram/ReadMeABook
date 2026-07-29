/**
 * Component: Request Status Constants Tests (B5)
 */

import { describe, expect, it } from 'vitest';
import {
  ADVANCEABLE_FROM_INTERACTIVE_SEARCH,
  COMPLETED_STATUSES,
  CANCELLABLE_STATUSES,
} from '@/lib/constants/request-statuses';

const advanceable = ADVANCEABLE_FROM_INTERACTIVE_SEARCH as readonly string[];

describe('ADVANCEABLE_FROM_INTERACTIVE_SEARCH (B5)', () => {
  it('covers the in-flight states where a manual override is the whole point', () => {
    // A release that is downloading but ungettable/stalled is THE documented B5
    // case; without these the modal falls back to create-new and 409s.
    expect(advanceable).toContain('downloading');
    expect(advanceable).toContain('searching');
    expect(advanceable).toContain('processing');
    expect(advanceable).toContain('awaiting_import');
  });

  it('covers warn — routing it away from the create path protects the F2(b) blocklist', () => {
    // warn is in canReRequest, so the create path DELETES the request and the
    // BlockedRelease cascade wipes the learned ungettable-release history.
    expect(advanceable).toContain('warn');
  });

  it('keeps the statuses that already worked', () => {
    for (const s of ['pending', 'failed', 'awaiting_search', 'awaiting_release']) {
      expect(advanceable).toContain(s);
    }
  });

  it('never advances awaiting_approval (select-torrent 403s it by design)', () => {
    expect(advanceable).not.toContain('awaiting_approval');
  });

  it('never advances a fulfilled request (re-grab is a separate feature)', () => {
    for (const s of COMPLETED_STATUSES) {
      expect(advanceable).not.toContain(s);
    }
  });

  it('never advances a cancelled request (fresh request is the right semantic)', () => {
    expect(advanceable).not.toContain('cancelled');
  });

  it('has no duplicates', () => {
    expect(new Set(advanceable).size).toBe(advanceable.length);
  });

  it('leaves the other status sets untouched', () => {
    expect(COMPLETED_STATUSES).toEqual(['available', 'downloaded']);
    expect(CANCELLABLE_STATUSES).toContain('awaiting_approval');
  });
});
