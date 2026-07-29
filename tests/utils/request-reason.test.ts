/**
 * Component: Request Reason Classifier Tests
 * Documentation: documentation/frontend/components.md
 *
 * Pins each REAL awaiting_search errorMessage (verbatim from the processors) to
 * its user-facing category, so the "why isn't this downloading" mapping can't
 * drift from the messages the pipeline actually writes.
 */

import { describe, expect, it } from 'vitest';
import { classifyAwaitingSearchReason } from '@/lib/utils/request-reason';

describe('classifyAwaitingSearchReason', () => {
  it('returns null when there is nothing to classify', () => {
    expect(classifyAwaitingSearchReason(undefined)).toBeNull();
    expect(classifyAwaitingSearchReason(null)).toBeNull();
    expect(classifyAwaitingSearchReason('   ')).toBeNull();
  });

  // ── Locked (entitlement / exhausted) ──────────────────────────────────────
  it('maps an exclude-rule (VIP) miss to Locked', () => {
    const r = classifyAwaitingSearchReason(
      'No usable releases — 2 candidate(s) matched an exclude rule'
    )!;
    expect(r.category).toBe('locked');
    expect(r.label).toBe('Locked');
    expect(r.tone).toBe('blocked');
  });

  it('maps all-candidates-blocklisted to Locked', () => {
    const r = classifyAwaitingSearchReason(
      'No usable releases — 5 candidates tried, all blocked'
    )!;
    expect(r.category).toBe('locked');
    expect(r.label).toBe('Locked');
  });

  // ── Held (manual pick) ────────────────────────────────────────────────────
  it('maps an unknown-runtime hold to Held', () => {
    const r = classifyAwaitingSearchReason(
      'Runtime unknown — held for manual selection (implied bitrate cannot be computed). ' +
        'Pick a release via interactive search, or set audiobook_hold_unknown_runtime=false to allow automatic grabs.'
    )!;
    expect(r.category).toBe('held');
    expect(r.label).toBe('Held');
    expect(r.tone).toBe('action');
  });

  // ── Low Quality (floor / score threshold) ─────────────────────────────────
  it('maps a bitrate-floor miss to Low Quality (blocked)', () => {
    const r = classifyAwaitingSearchReason(
      'No release met the bitrate floor (128 kbps implied) — best candidate ~96 kbps. ' +
        'Will retry automatically; pick manually via interactive search or lower audiobook_min_implied_kbps.'
    )!;
    expect(r.category).toBe('low_quality');
    expect(r.label).toBe('Low Quality');
    expect(r.tone).toBe('blocked');
  });

  it('maps a no-quality-match to Low Quality (waiting)', () => {
    const r = classifyAwaitingSearchReason('No quality matches found. Will retry automatically.')!;
    expect(r.category).toBe('low_quality');
    expect(r.tone).toBe('waiting');
  });

  // ── Not Found ─────────────────────────────────────────────────────────────
  it('maps no-torrents to Not Found', () => {
    const r = classifyAwaitingSearchReason('No torrents/nzbs found. Will retry automatically.')!;
    expect(r.category).toBe('not_found');
    expect(r.label).toBe('Not Found');
  });

  it('maps no-ebook-found to Not Found', () => {
    const r = classifyAwaitingSearchReason(
      'No ebook found on Libgen or Indexer Search. Will retry automatically.'
    )!;
    expect(r.category).toBe('not_found');
  });

  it('maps no-sources-enabled to Not Found and keeps the raw actionable hint', () => {
    const msg = "No ebook sources enabled. Enable Libgen, Indexer Search, or Anna's Archive in settings.";
    const r = classifyAwaitingSearchReason(msg)!;
    expect(r.category).toBe('not_found');
    expect(r.hint).toBe(msg);
  });

  // ── Searching (active re-select after a failed download) ──────────────────
  it('maps a torrent download-fail re-search to Searching', () => {
    const r = classifyAwaitingSearchReason(
      'Download fetch failed (HTTP 500) — blocklisted "Jumpnauts [VIP]", re-searching for an alternative.'
    )!;
    expect(r.category).toBe('searching');
    expect(r.label).toBe('Searching');
    expect(r.tone).toBe('info');
  });

  it('maps a transient ebook re-search (attempt N) to Searching', () => {
    const r = classifyAwaitingSearchReason(
      'Ebook download failed (No download URLs available) — re-searching (attempt 1).'
    )!;
    expect(r.category).toBe('searching');
  });

  it('maps a budget-exhausted ebook blocklist re-search to Searching', () => {
    const r = classifyAwaitingSearchReason(
      'Ebook unreachable from this source after 3 attempts — blocklisted "Slow Book - Author.epub", re-searching for an alternative.'
    )!;
    expect(r.category).toBe('searching');
  });

  // ── Fallback ──────────────────────────────────────────────────────────────
  it('falls back to Searching and surfaces the raw text for an unknown message', () => {
    const r = classifyAwaitingSearchReason('Some brand new message we have not mapped yet')!;
    expect(r.category).toBe('searching');
    expect(r.hint).toBe('Some brand new message we have not mapped yet');
  });

  it('classifies before the generic fallback — exclude beats the default', () => {
    // Regression guard: a message containing "matched an exclude rule" must NOT
    // fall through to the generic Searching bucket.
    const r = classifyAwaitingSearchReason(
      'No usable releases — 2 candidate(s) matched an exclude rule'
    )!;
    expect(r.category).not.toBe('searching');
  });
});
