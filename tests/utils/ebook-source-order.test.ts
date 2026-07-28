/**
 * Component: Ebook Source Order Resolver Tests
 * Documentation: documentation/integrations/ebook-sidecar.md
 */

import { describe, expect, it } from 'vitest';
import { resolveEbookSourceOrder, DEFAULT_EBOOK_PRIORITY, ebookSourceLabel } from '@/lib/utils/ebook-source-order';

/** Fake config service backed by a plain map. */
function fakeConfig(map: Record<string, string | null>) {
  return {
    getMany: async (keys: string[]) => {
      const out: Record<string, string | null> = {};
      for (const k of keys) out[k] = k in map ? map[k] : null;
      return out;
    },
  };
}

describe('resolveEbookSourceOrder', () => {
  it('reports no sources enabled when all flags are off/absent', async () => {
    const res = await resolveEbookSourceOrder(fakeConfig({}));
    expect(res.anyEnabled).toBe(false);
    expect(res.ordered).toEqual([]);
  });

  it('orders enabled sources by default priority: libgen → indexer → annas', async () => {
    const res = await resolveEbookSourceOrder(fakeConfig({
      ebook_libgen_enabled: 'true',
      ebook_indexer_search_enabled: 'true',
      ebook_annas_archive_enabled: 'true',
    }));
    expect(res.anyEnabled).toBe(true);
    expect(res.ordered.map((s) => s.id)).toEqual(['libgen', 'indexer', 'annas_archive']);
    expect(res.ordered[0].priority).toBe(DEFAULT_EBOOK_PRIORITY.libgen);
  });

  it('respects custom priorities (Anna\'s can be promoted above Libgen)', async () => {
    const res = await resolveEbookSourceOrder(fakeConfig({
      ebook_libgen_enabled: 'true',
      ebook_libgen_priority: '50',
      ebook_annas_archive_enabled: 'true',
      ebook_annas_archive_priority: '5',
    }));
    expect(res.ordered.map((s) => s.id)).toEqual(['annas_archive', 'libgen']);
  });

  it('excludes disabled sources from the order', async () => {
    const res = await resolveEbookSourceOrder(fakeConfig({
      ebook_libgen_enabled: 'true',
      ebook_indexer_search_enabled: 'false',
      ebook_annas_archive_enabled: 'false',
    }));
    expect(res.ordered.map((s) => s.id)).toEqual(['libgen']);
    expect(res.libgenEnabled).toBe(true);
    expect(res.indexerEnabled).toBe(false);
    expect(res.annasEnabled).toBe(false);
  });

  it('applies the legacy ebook_sidecar_enabled shim for Anna\'s Archive', async () => {
    const res = await resolveEbookSourceOrder(fakeConfig({
      // New Anna's key absent; legacy key on → Anna's counts as enabled.
      ebook_sidecar_enabled: 'true',
    }));
    expect(res.annasEnabled).toBe(true);
    expect(res.ordered.map((s) => s.id)).toEqual(['annas_archive']);
  });

  it('does NOT apply the legacy shim once the new Anna\'s key is explicitly false', async () => {
    const res = await resolveEbookSourceOrder(fakeConfig({
      ebook_annas_archive_enabled: 'false',
      ebook_sidecar_enabled: 'true',
    }));
    expect(res.annasEnabled).toBe(false);
    expect(res.anyEnabled).toBe(false);
  });

  it('breaks priority ties with a stable source order', async () => {
    const res = await resolveEbookSourceOrder(fakeConfig({
      ebook_libgen_enabled: 'true',
      ebook_libgen_priority: '20',
      ebook_indexer_search_enabled: 'true',
      ebook_indexer_priority: '20',
      ebook_annas_archive_enabled: 'true',
      ebook_annas_archive_priority: '20',
    }));
    expect(res.ordered.map((s) => s.id)).toEqual(['libgen', 'indexer', 'annas_archive']);
  });

  it('falls back to defaults for non-numeric priority values', async () => {
    const res = await resolveEbookSourceOrder(fakeConfig({
      ebook_libgen_enabled: 'true',
      ebook_libgen_priority: 'not-a-number',
    }));
    expect(res.ordered[0].priority).toBe(DEFAULT_EBOOK_PRIORITY.libgen);
  });
});

describe('ebookSourceLabel', () => {
  it('maps ids to human labels', () => {
    expect(ebookSourceLabel('libgen')).toBe('Libgen');
    expect(ebookSourceLabel('indexer')).toBe('Indexer Search');
    expect(ebookSourceLabel('annas_archive')).toBe("Anna's Archive");
  });
});
