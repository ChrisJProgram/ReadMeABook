/**
 * Component: Implied Bitrate (F1) Tests
 * Documentation: documentation/phase3/README.md
 *
 * Covers the F1 additions to the ranking layer:
 * - impliedKbps(): size/runtime → implied TOTAL kbps (never per-channel)
 * - RankedTorrent.impliedKbps carried on every audiobook result
 * - "Possible different edition" note for absurd implied bitrates (lossy only)
 */

import { describe, expect, it } from 'vitest';
import { rankTorrents, impliedKbps } from '@/lib/utils/ranking-algorithm';

const MB = 1024 * 1024;

const torrent = (overrides: Record<string, unknown> = {}) => ({
  indexer: 'Indexer',
  indexerId: 1,
  title: 'Book - Author',
  size: 700 * MB,
  seeders: 10,
  publishDate: new Date('2026-01-01'),
  downloadUrl: 'magnet:?xt=urn:btih:abc',
  guid: 'guid-1',
  format: 'M4B',
  ...overrides,
});

describe('impliedKbps', () => {
  it('matches the spec validation case (declared 125 kbps → implied ~127)', () => {
    // 476,250,000 bytes over 500 minutes = exactly 127 kbps
    expect(impliedKbps(476_250_000, 500)).toBe(127);
  });

  it('computes size*8 / (runtime*60) / 1000, rounded', () => {
    // 700 MiB over 600 min → 163.11 kbps → 163
    expect(impliedKbps(700 * MB, 600)).toBe(163);
  });

  it('returns null when runtime is unknown or nonsense', () => {
    expect(impliedKbps(700 * MB, undefined)).toBeNull();
    expect(impliedKbps(700 * MB, null)).toBeNull();
    expect(impliedKbps(700 * MB, 0)).toBeNull();
    expect(impliedKbps(700 * MB, -5)).toBeNull();
    expect(impliedKbps(0, 600)).toBeNull();
  });
});

describe('rankTorrents impliedKbps + edition note', () => {
  const audiobook = { title: 'Book', author: 'Author', durationMinutes: 600 };

  it('attaches impliedKbps to every ranked result when runtime is known', () => {
    const ranked = rankTorrents([torrent()], audiobook);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].impliedKbps).toBe(163);
  });

  it('attaches null when runtime is unknown (renders as — in the UI)', () => {
    const ranked = rankTorrents([torrent()], { title: 'Book', author: 'Author' });
    expect(ranked[0].impliedKbps).toBeNull();
  });

  it('flags a possible different edition when implied kbps is far above lossy norms', () => {
    // 2000 MiB over 600 min → ~466 kbps implied on a lossy format: that is a
    // longer/different recording, not a better encode. Without the note it
    // reads "Premium quality" — the exact trap the spec warned about.
    const ranked = rankTorrents([torrent({ size: 2000 * MB })], audiobook);
    expect(ranked[0].impliedKbps).toBeGreaterThan(320);
    expect(ranked[0].breakdown.notes.join(' | ')).toMatch(/possible different edition/i);
  });

  it('does NOT flag FLAC — lossless legitimately reaches those figures', () => {
    const ranked = rankTorrents([torrent({ size: 2000 * MB, format: 'FLAC' })], audiobook);
    expect(ranked[0].breakdown.notes.join(' | ')).not.toMatch(/possible different edition/i);
  });

  it('does NOT flag ordinary bitrates', () => {
    const ranked = rankTorrents([torrent()], audiobook); // ~163 kbps
    expect(ranked[0].breakdown.notes.join(' | ')).not.toMatch(/possible different edition/i);
  });
});
