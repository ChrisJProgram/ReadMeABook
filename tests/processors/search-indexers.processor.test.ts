/**
 * Component: Search Indexers Processor Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import { createJobQueueMock } from '../helpers/job-queue';

const prismaMock = createPrismaMock();
const configMock = vi.hoisted(() => ({ get: vi.fn(), getAudibleRegion: vi.fn().mockResolvedValue('us') }));
const jobQueueMock = createJobQueueMock();
const prowlarrMock = vi.hoisted(() => ({ search: vi.fn(), searchWithVariations: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => configMock,
}));

vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => jobQueueMock,
}));

vi.mock('@/lib/integrations/prowlarr.service', () => ({
  getProwlarrService: () => prowlarrMock,
}));

const getRuntimeMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/integrations/audible.service', () => ({
  getAudibleService: () => ({ getRuntime: getRuntimeMock }),
}));

describe('processSearchIndexers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.getAudibleRegion.mockResolvedValue('us');
    // Default to empty blocklist so the filter is a no-op unless a test overrides.
    prismaMock.blockedRelease.findMany.mockResolvedValue([]);
    // F0/F1 defaults: the audiobook row already knows its runtime, so legacy
    // scenarios proceed to search instead of tripping the unknown-runtime hold.
    // Hold-specific tests override findUnique with null.
    prismaMock.audiobook.findUnique.mockResolvedValue({ runtimeMinutes: 600 });
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.audibleCache.findUnique.mockResolvedValue(null);
    getRuntimeMock.mockResolvedValue(null);
  });

  it('marks request awaiting_search when no results found', async () => {
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      return null;
    });
    prowlarrMock.searchWithVariations.mockResolvedValue([]);
    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    const result = await processSearchIndexers({
      requestId: 'req-1',
      audiobook: { id: 'a1', title: 'Book', author: 'Author' },
      jobId: 'job-1',
    });

    expect(result.success).toBe(false);
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'awaiting_search' }),
      })
    );
  });

  it('queues download job when results are ranked', async () => {
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      if (key === 'indexer_flag_config') {
        return JSON.stringify([]);
      }
      return null;
    });

    prowlarrMock.searchWithVariations.mockResolvedValue([
      {
        indexer: 'Indexer',
        indexerId: 1,
        title: 'Book - Author',
        size: 50 * 1024 * 1024,
        seeders: 10,
        publishDate: new Date(),
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        guid: 'guid-1',
        format: 'M4B',
      },
    ]);

    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    const result = await processSearchIndexers({
      requestId: 'req-2',
      audiobook: { id: 'a2', title: 'Book', author: 'Author' },
      jobId: 'job-2',
    });

    expect(result.success).toBe(true);
    expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
      'req-2',
      { id: 'a2', title: 'Book', author: 'Author' },
      expect.objectContaining({ title: 'Book - Author' })
    );
  });

  it('fails when no indexers are configured', async () => {
    configMock.get.mockResolvedValue(null);
    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    await expect(
      processSearchIndexers({
        requestId: 'req-3',
        audiobook: { id: 'a3', title: 'Book', author: 'Author' },
        jobId: 'job-3',
      })
    ).rejects.toThrow('No indexers configured');

    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      })
    );
  });

  it('filters out blocklisted releases by name (case-insensitive) before ranking', async () => {
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      if (key === 'indexer_flag_config') return JSON.stringify([]);
      return null;
    });

    prowlarrMock.searchWithVariations.mockResolvedValue([
      {
        indexer: 'Indexer',
        indexerId: 1,
        title: 'BAD Release - Author',
        size: 50 * 1024 * 1024,
        seeders: 10,
        publishDate: new Date(),
        downloadUrl: 'magnet:?xt=urn:btih:bad',
        guid: 'guid-bad',
        format: 'M4B',
      },
      {
        indexer: 'Indexer',
        indexerId: 1,
        title: 'Good Release - Author',
        size: 50 * 1024 * 1024,
        seeders: 20,
        publishDate: new Date(),
        downloadUrl: 'magnet:?xt=urn:btih:good',
        guid: 'guid-good',
        format: 'M4B',
      },
    ]);

    // Blocklist contains the bad release with lowercased key — must match case-insensitively.
    prismaMock.blockedRelease.findMany.mockResolvedValue([
      { id: 'b1', releaseKey: 'bad release - author', releaseHash: null },
    ]);
    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    const result = await processSearchIndexers({
      requestId: 'req-filter-name',
      audiobook: { id: 'a-filter', title: 'Good Release', author: 'Author' },
      jobId: 'job-filter-name',
    });

    expect(result.success).toBe(true);
    expect(jobQueueMock.addDownloadJob).toHaveBeenCalledTimes(1);
    expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
      'req-filter-name',
      expect.objectContaining({ id: 'a-filter' }),
      expect.objectContaining({ title: 'Good Release - Author' })
    );
  });

  it('filters out blocklisted releases by infoHash even when title differs', async () => {
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      if (key === 'indexer_flag_config') return JSON.stringify([]);
      return null;
    });

    prowlarrMock.searchWithVariations.mockResolvedValue([
      {
        indexer: 'Indexer',
        indexerId: 1,
        title: 'Some Other Title - Author',
        size: 50 * 1024 * 1024,
        seeders: 10,
        publishDate: new Date(),
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        guid: 'guid-hash-bad',
        infoHash: 'abc123',
        format: 'M4B',
      },
      {
        indexer: 'Indexer',
        indexerId: 1,
        title: 'Good Release - Author',
        size: 50 * 1024 * 1024,
        seeders: 20,
        publishDate: new Date(),
        downloadUrl: 'magnet:?xt=urn:btih:def',
        guid: 'guid-hash-good',
        infoHash: 'def456',
        format: 'M4B',
      },
    ]);

    prismaMock.blockedRelease.findMany.mockResolvedValue([
      { id: 'b2', releaseKey: 'unrelated key', releaseHash: 'abc123' },
    ]);
    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    const result = await processSearchIndexers({
      requestId: 'req-filter-hash',
      audiobook: { id: 'a-filter-hash', title: 'Good Release', author: 'Author' },
      jobId: 'job-filter-hash',
    });

    expect(result.success).toBe(true);
    expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
      'req-filter-hash',
      expect.anything(),
      expect.objectContaining({ title: 'Good Release - Author' })
    );
  });

  it('uses blocklist-exhaustion message when every candidate is blocked', async () => {
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      if (key === 'indexer_flag_config') return JSON.stringify([]);
      return null;
    });

    prowlarrMock.searchWithVariations.mockResolvedValue([
      {
        indexer: 'Indexer',
        indexerId: 1,
        title: 'Bad Release One',
        size: 50 * 1024 * 1024,
        seeders: 10,
        publishDate: new Date(),
        downloadUrl: 'magnet:?xt=urn:btih:1',
        guid: 'g1',
        format: 'M4B',
      },
      {
        indexer: 'Indexer',
        indexerId: 1,
        title: 'Bad Release Two',
        size: 50 * 1024 * 1024,
        seeders: 5,
        publishDate: new Date(),
        downloadUrl: 'magnet:?xt=urn:btih:2',
        guid: 'g2',
        format: 'M4B',
      },
    ]);

    prismaMock.blockedRelease.findMany.mockResolvedValue([
      { id: 'b1', releaseKey: 'bad release one', releaseHash: null },
      { id: 'b2', releaseKey: 'bad release two', releaseHash: null },
    ]);
    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    const result = await processSearchIndexers({
      requestId: 'req-exhausted',
      audiobook: { id: 'a-exhausted', title: 'Bad Release', author: 'Author' },
      jobId: 'job-exhausted',
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No usable releases — 2 candidates tried, all blocked/);
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'awaiting_search',
          errorMessage: 'No usable releases — 2 candidates tried, all blocked',
        }),
      })
    );
    expect(jobQueueMock.addDownloadJob).not.toHaveBeenCalled();
  });

  // ================= F0/F1: runtime resolution, hold, floor =================

  const indexerConfig = (extra: Record<string, string | null> = {}) =>
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      if (key === 'indexer_flag_config') return JSON.stringify([]);
      if (key in extra) return extra[key];
      return null;
    });

  const candidate = (sizeMB: number, title = 'Book - Author') => ({
    indexer: 'Indexer',
    indexerId: 1,
    title,
    size: sizeMB * 1024 * 1024,
    seeders: 10,
    publishDate: new Date(),
    downloadUrl: 'magnet:?xt=urn:btih:abc',
    guid: `guid-${sizeMB}`,
    format: 'M4B',
  });

  describe('F1 (D5): unknown-runtime hold', () => {
    it('holds for manual selection without touching the indexers', async () => {
      indexerConfig();
      prismaMock.audiobook.findUnique.mockResolvedValue(null); // no persisted runtime
      prismaMock.audibleCache.findUnique.mockResolvedValue(null);
      getRuntimeMock.mockResolvedValue(null); // Audnexus gap
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-hold',
        audiobook: { id: 'a-hold', title: 'Obscure Book', author: 'Author', asin: 'B0UNKNOWN0' },
        jobId: 'job-hold',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/held for manual selection/i);
      expect(prismaMock.request.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'awaiting_search',
            errorMessage: expect.stringContaining('held for manual selection'),
          }),
        })
      );
      // The whole point of holding early: no indexer traffic, no grab.
      expect(prowlarrMock.searchWithVariations).not.toHaveBeenCalled();
      expect(jobQueueMock.addDownloadJob).not.toHaveBeenCalled();
    });

    it('proceeds with unknown runtime when the hold is disabled', async () => {
      indexerConfig({ audiobook_hold_unknown_runtime: 'false' });
      prismaMock.audiobook.findUnique.mockResolvedValue(null);
      getRuntimeMock.mockResolvedValue(null);
      prowlarrMock.searchWithVariations.mockResolvedValue([candidate(50)]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-nohold',
        audiobook: { id: 'a-nohold', title: 'Book', author: 'Author', asin: 'B0UNKNOWN1' },
        jobId: 'job-nohold',
      });

      expect(result.success).toBe(true);
      expect(jobQueueMock.addDownloadJob).toHaveBeenCalled();
    });
  });

  describe('F0: runtime resolution chain', () => {
    it('uses the persisted row without consulting cache or Audnexus', async () => {
      indexerConfig();
      prismaMock.audiobook.findUnique.mockResolvedValue({ runtimeMinutes: 600 });
      prowlarrMock.searchWithVariations.mockResolvedValue([candidate(700)]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-row',
        audiobook: { id: 'a-row', title: 'Book', author: 'Author', asin: 'B0KNOWN000' },
        jobId: 'job-row',
      });

      expect(result.success).toBe(true);
      expect(prismaMock.audibleCache.findUnique).not.toHaveBeenCalled();
      expect(getRuntimeMock).not.toHaveBeenCalled();
      // Row already had runtime — no backfill write.
      expect(prismaMock.audiobook.update).not.toHaveBeenCalled();
    });

    it('falls back to AudibleCache and persists the backfill', async () => {
      indexerConfig();
      prismaMock.audiobook.findUnique.mockResolvedValue({ runtimeMinutes: null });
      prismaMock.audibleCache.findUnique.mockResolvedValue({ durationMinutes: 480 });
      prowlarrMock.searchWithVariations.mockResolvedValue([candidate(500)]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-cache',
        audiobook: { id: 'a-cache', title: 'Book', author: 'Author', asin: 'B0CACHED00' },
        jobId: 'job-cache',
      });

      expect(result.success).toBe(true);
      expect(getRuntimeMock).not.toHaveBeenCalled(); // cache beat the live call
      expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'a-cache' },
          data: { runtimeMinutes: 480 },
        })
      );
    });

    it('falls back to live Audnexus last and persists the backfill', async () => {
      indexerConfig();
      prismaMock.audiobook.findUnique.mockResolvedValue(null);
      prismaMock.audibleCache.findUnique.mockResolvedValue(null);
      getRuntimeMock.mockResolvedValue(720);
      prowlarrMock.searchWithVariations.mockResolvedValue([candidate(800)]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-live',
        audiobook: { id: 'a-live', title: 'Book', author: 'Author', asin: 'B0LIVE0000' },
        jobId: 'job-live',
      });

      expect(result.success).toBe(true);
      expect(getRuntimeMock).toHaveBeenCalledWith('B0LIVE0000');
      expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { runtimeMinutes: 720 } })
      );
    });
  });

  describe('F1 (D1/D2): implied-bitrate floor', () => {
    // 600 min runtime: 50 MB ≈ 12 kbps implied; 700 MB ≈ 163 kbps implied.

    it('is OFF by default — low implied bitrate still grabs', async () => {
      indexerConfig();
      prowlarrMock.searchWithVariations.mockResolvedValue([candidate(50)]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-nofloor',
        audiobook: { id: 'a-nofloor', title: 'Book', author: 'Author', asin: 'B0FLOOR000' },
        jobId: 'job-nofloor',
      });

      expect(result.success).toBe(true);
      expect(jobQueueMock.addDownloadJob).toHaveBeenCalled();
    });

    it('fails visibly when nothing clears an enabled floor (D2)', async () => {
      indexerConfig({ audiobook_min_implied_kbps: '100' });
      prowlarrMock.searchWithVariations.mockResolvedValue([candidate(50)]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-floor-fail',
        audiobook: { id: 'a-floor-fail', title: 'Book', author: 'Author', asin: 'B0FLOOR001' },
        jobId: 'job-floor-fail',
      });

      expect(result.success).toBe(false);
      expect(prismaMock.request.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'awaiting_search',
            errorMessage: expect.stringContaining('bitrate floor'),
          }),
        })
      );
      // The reason must carry the best implied figure, or the failure is
      // indistinguishable from "book doesn't exist".
      const updateCall = prismaMock.request.update.mock.calls.find(
        (c: any[]) => c[0]?.data?.errorMessage?.includes?.('bitrate floor')
      );
      expect(updateCall[0].data.errorMessage).toMatch(/best candidate ~\d+ kbps/);
      expect(jobQueueMock.addDownloadJob).not.toHaveBeenCalled();
    });

    it('grabs the release that clears the floor', async () => {
      indexerConfig({ audiobook_min_implied_kbps: '100' });
      prowlarrMock.searchWithVariations.mockResolvedValue([candidate(50), candidate(700, 'Book - Author [700]')]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-floor-pass',
        audiobook: { id: 'a-floor-pass', title: 'Book', author: 'Author', asin: 'B0FLOOR002' },
        jobId: 'job-floor-pass',
      });

      expect(result.success).toBe(true);
      expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
        'req-floor-pass',
        expect.anything(),
        expect.objectContaining({ title: 'Book - Author [700]' })
      );
    });
  });

  describe('F3: strict indexer tiers', () => {
    const tieredConfig = () =>
      configMock.get.mockImplementation(async (key: string) => {
        if (key === 'prowlarr_indexers') {
          return JSON.stringify([
            { id: 1, name: 'AudiobookBay', protocol: 'torrent', priority: 25, tier: 1, categories: [3030] },
            { id: 2, name: 'MyAnonamouse', protocol: 'torrent', priority: 20, tier: 2, categories: [3030] },
          ]);
        }
        if (key === 'indexer_flag_config') return JSON.stringify([]);
        return null;
      });

    const abb = () => ({
      indexer: 'AudiobookBay',
      indexerId: 1,
      title: 'Book - Author [ABB]',
      size: 700 * 1024 * 1024,
      seeders: 1, // ABB publishes no counts; hardcoded 1
      publishDate: new Date(),
      downloadUrl: 'magnet:?xt=urn:btih:abb',
      guid: 'guid-abb',
      format: 'M4B',
    });
    const mam = () => ({
      indexer: 'MyAnonamouse',
      indexerId: 2,
      title: 'Book - Author [MAM]',
      size: 700 * 1024 * 1024,
      seeders: 28, // scoring puts this first — the live failure F3 fixes
      publishDate: new Date(),
      downloadUrl: 'magnet:?xt=urn:btih:mam',
      guid: 'guid-mam',
      format: 'M4B',
    });

    it('grabs tier 1 (ABB) even though tier 2 (MAM) outscores it on seeders', async () => {
      tieredConfig();
      prowlarrMock.searchWithVariations.mockResolvedValue([mam(), abb()]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-tier',
        audiobook: { id: 'a-tier', title: 'Book', author: 'Author', asin: 'B0TIER0000' },
        jobId: 'job-tier',
      });

      expect(result.success).toBe(true);
      expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
        'req-tier',
        expect.anything(),
        expect.objectContaining({ title: 'Book - Author [ABB]' })
      );
    });

    it('falls through to tier 2 when tier 1 has no candidate', async () => {
      tieredConfig();
      prowlarrMock.searchWithVariations.mockResolvedValue([mam()]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-tier-fall',
        audiobook: { id: 'a-tier-fall', title: 'Book', author: 'Author', asin: 'B0TIER0001' },
        jobId: 'job-tier-fall',
      });

      expect(result.success).toBe(true);
      expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
        'req-tier-fall',
        expect.anything(),
        expect.objectContaining({ title: 'Book - Author [MAM]' })
      );
    });

    it('keeps weighted behaviour when no indexer has a tier', async () => {
      indexerConfig(); // config without tier fields
      prowlarrMock.searchWithVariations.mockResolvedValue([
        { ...mam(), indexerId: 1 }, // same indexer id as config
        { ...abb(), indexerId: 1 },
      ]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-untier',
        audiobook: { id: 'a-untier', title: 'Book', author: 'Author', asin: 'B0TIER0002' },
        jobId: 'job-untier',
      });

      expect(result.success).toBe(true);
      // Weighted ranking wins: the 28-seeder release stays on top.
      expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
        'req-untier',
        expect.anything(),
        expect.objectContaining({ title: 'Book - Author [MAM]' })
      );
    });

    it('tier 1 below an enabled floor falls through to a tier 2 that clears it', async () => {
      configMock.get.mockImplementation(async (key: string) => {
        if (key === 'prowlarr_indexers') {
          return JSON.stringify([
            { id: 1, name: 'AudiobookBay', protocol: 'torrent', priority: 25, tier: 1, categories: [3030] },
            { id: 2, name: 'MyAnonamouse', protocol: 'torrent', priority: 20, tier: 2, categories: [3030] },
          ]);
        }
        if (key === 'indexer_flag_config') return JSON.stringify([]);
        if (key === 'audiobook_min_implied_kbps') return '100';
        return null;
      });
      // ABB copy is tiny (~12 kbps implied), MAM copy clears the floor.
      prowlarrMock.searchWithVariations.mockResolvedValue([
        { ...abb(), size: 50 * 1024 * 1024 },
        mam(),
      ]);
      prismaMock.request.update.mockResolvedValue({});

      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      const result = await processSearchIndexers({
        requestId: 'req-tier-floor',
        audiobook: { id: 'a-tier-floor', title: 'Book', author: 'Author', asin: 'B0TIER0003' },
        jobId: 'job-tier-floor',
      });

      expect(result.success).toBe(true);
      expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
        'req-tier-floor',
        expect.anything(),
        expect.objectContaining({ title: 'Book - Author [MAM]' })
      );
    });
  });

});


