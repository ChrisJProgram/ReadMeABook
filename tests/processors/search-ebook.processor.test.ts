/**
 * Component: Search Ebook Processor Tests
 * Documentation: documentation/integrations/ebook-sidecar.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();

const configServiceMock = vi.hoisted(() => ({
  get: vi.fn(),
  // getMany is consumed by resolveEbookSourceOrder (the real, un-mocked source
  // order resolver). Implemented in beforeEach to defer to the same key map as get.
  getMany: vi.fn(),
  getAudibleRegion: vi.fn().mockResolvedValue('us'),
}));

const jobQueueMock = vi.hoisted(() => ({
  addStartDirectDownloadJob: vi.fn(() => Promise.resolve()),
}));

const ebookScraperMock = vi.hoisted(() => ({
  searchByAsin: vi.fn(),
  searchByTitle: vi.fn(),
  getSlowDownloadLinks: vi.fn(),
}));

const libgenScraperMock = vi.hoisted(() => ({
  searchLibgen: vi.fn(),
  DEFAULT_LIBGEN_MIRROR: 'https://libgen.bz',
}));

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => configServiceMock,
}));

vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => jobQueueMock,
}));

vi.mock('@/lib/services/ebook-scraper', () => ebookScraperMock);

vi.mock('@/lib/services/libgen-scraper', () => libgenScraperMock);

/**
 * Wire configServiceMock.get + .getMany from a single key→value map so the real
 * resolveEbookSourceOrder (which calls getMany) and the processor (which calls
 * get) see a consistent config.
 */
function setConfig(map: Record<string, string | null>) {
  configServiceMock.get.mockImplementation(async (key: string) =>
    key in map ? map[key] : null
  );
  configServiceMock.getMany.mockImplementation(async (keys: string[]) => {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = key_in(map, k);
    return out;
  });
}
function key_in(map: Record<string, string | null>, k: string): string | null {
  return k in map ? map[k] : null;
}

describe('processSearchEbook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configServiceMock.getAudibleRegion.mockResolvedValue('us');
    // Default: Anna's Archive only (preserves the pre-F5 test expectations).
    setConfig({
      ebook_sidecar_preferred_format: 'epub',
      ebook_sidecar_base_url: 'https://annas-archive.gl',
      ebook_annas_archive_enabled: 'true',
      ebook_indexer_search_enabled: 'false',
    });
  });

  it('searches by ASIN when available and triggers download', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-1' });
    prismaMock.downloadHistory.update.mockResolvedValue({});

    ebookScraperMock.searchByAsin.mockResolvedValue('abc123md5');
    ebookScraperMock.getSlowDownloadLinks.mockResolvedValue([
      'https://slow1.example.com/abc123',
      'https://slow2.example.com/abc123',
    ]);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    const result = await processSearchEbook({
      requestId: 'req-1',
      audiobook: {
        id: 'ab-1',
        title: 'Test Book',
        author: 'Test Author',
        asin: 'B001ASIN',
      },
      jobId: 'job-1',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("Anna's Archive");
    expect(ebookScraperMock.searchByAsin).toHaveBeenCalledWith(
      'B001ASIN',
      'epub',
      'https://annas-archive.gl',
      expect.anything(),
      undefined,
      'en'
    );
    expect(jobQueueMock.addStartDirectDownloadJob).toHaveBeenCalledWith(
      'req-1',
      'dh-1',
      'https://slow1.example.com/abc123',
      'Test Book - Test Author.epub',
      undefined
    );
  });

  it('falls back to title search when ASIN search fails', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-2' });
    prismaMock.downloadHistory.update.mockResolvedValue({});

    ebookScraperMock.searchByAsin.mockResolvedValue(null);
    ebookScraperMock.searchByTitle.mockResolvedValue('xyz789md5');
    ebookScraperMock.getSlowDownloadLinks.mockResolvedValue([
      'https://slow1.example.com/xyz789',
    ]);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    const result = await processSearchEbook({
      requestId: 'req-2',
      audiobook: {
        id: 'ab-2',
        title: 'Another Book',
        author: 'Another Author',
        asin: 'B002ASIN',
      },
      jobId: 'job-2',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("Anna's Archive");
    expect(ebookScraperMock.searchByAsin).toHaveBeenCalled();
    expect(ebookScraperMock.searchByTitle).toHaveBeenCalledWith(
      'Another Book',
      'Another Author',
      'epub',
      'https://annas-archive.gl',
      expect.anything(),
      undefined,
      'en'
    );
  });

  it('searches by title when no ASIN is available', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-3' });
    prismaMock.downloadHistory.update.mockResolvedValue({});

    ebookScraperMock.searchByTitle.mockResolvedValue('noasin123');
    ebookScraperMock.getSlowDownloadLinks.mockResolvedValue([
      'https://slow.example.com/noasin123',
    ]);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    const result = await processSearchEbook({
      requestId: 'req-3',
      audiobook: {
        id: 'ab-3',
        title: 'No ASIN Book',
        author: 'No ASIN Author',
        // No asin field
      },
      jobId: 'job-3',
    });

    expect(result.success).toBe(true);
    expect(ebookScraperMock.searchByAsin).not.toHaveBeenCalled();
    expect(ebookScraperMock.searchByTitle).toHaveBeenCalled();
  });

  it('marks request as awaiting_search when no ebook found', async () => {
    prismaMock.request.update.mockResolvedValue({});

    ebookScraperMock.searchByAsin.mockResolvedValue(null);
    ebookScraperMock.searchByTitle.mockResolvedValue(null);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    const result = await processSearchEbook({
      requestId: 'req-4',
      audiobook: {
        id: 'ab-4',
        title: 'Unfindable Book',
        author: 'Unknown Author',
        asin: 'B004ASIN',
      },
      jobId: 'job-4',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('re-search');
    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'req-4' },
      data: expect.objectContaining({
        status: 'awaiting_search',
        errorMessage: expect.stringContaining('No ebook found'),
        lastSearchAt: expect.any(Date),
      }),
    });
    expect(jobQueueMock.addStartDirectDownloadJob).not.toHaveBeenCalled();
  });

  it('marks request as awaiting_search when no download links available', async () => {
    prismaMock.request.update.mockResolvedValue({});

    ebookScraperMock.searchByAsin.mockResolvedValue('md5nolinks');
    ebookScraperMock.getSlowDownloadLinks.mockResolvedValue([]);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    const result = await processSearchEbook({
      requestId: 'req-5',
      audiobook: {
        id: 'ab-5',
        title: 'Book No Links',
        author: 'Author No Links',
        asin: 'B005ASIN',
      },
      jobId: 'job-5',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('re-search');
    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'req-5' },
      data: expect.objectContaining({
        status: 'awaiting_search',
        errorMessage: expect.stringContaining('No ebook found'),
        lastSearchAt: expect.any(Date),
      }),
    });
  });

  it('uses FlareSolverr when configured', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-6' });
    prismaMock.downloadHistory.update.mockResolvedValue({});

    setConfig({
      ebook_sidecar_preferred_format: 'epub',
      ebook_sidecar_base_url: 'https://annas-archive.gl',
      ebook_sidecar_flaresolverr_url: 'http://flaresolverr:8191',
      ebook_annas_archive_enabled: 'true',
      ebook_indexer_search_enabled: 'false',
    });

    ebookScraperMock.searchByAsin.mockResolvedValue('md5withflare');
    ebookScraperMock.getSlowDownloadLinks.mockResolvedValue(['https://slow.example.com/flare']);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    await processSearchEbook({
      requestId: 'req-6',
      audiobook: {
        id: 'ab-6',
        title: 'Flare Book',
        author: 'Flare Author',
        asin: 'B006ASIN',
      },
      jobId: 'job-6',
    });

    expect(ebookScraperMock.searchByAsin).toHaveBeenCalledWith(
      'B006ASIN',
      'epub',
      'https://annas-archive.gl',
      expect.anything(),
      'http://flaresolverr:8191',
      'en'
    );
  });

  it('fails request on unexpected errors', async () => {
    prismaMock.request.update.mockResolvedValue({});

    ebookScraperMock.searchByAsin.mockRejectedValue(new Error('Network error'));

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    await expect(processSearchEbook({
      requestId: 'req-7',
      audiobook: {
        id: 'ab-7',
        title: 'Error Book',
        author: 'Error Author',
        asin: 'B007ASIN',
      },
      jobId: 'job-7',
    })).rejects.toThrow('Network error');

    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'req-7' },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: 'Network error',
      }),
    });
  });

  it('creates download history with correct metadata', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-8' });
    prismaMock.downloadHistory.update.mockResolvedValue({});

    ebookScraperMock.searchByAsin.mockResolvedValue('md5metadata');
    ebookScraperMock.getSlowDownloadLinks.mockResolvedValue([
      'https://link1.example.com',
      'https://link2.example.com',
    ]);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    await processSearchEbook({
      requestId: 'req-8',
      audiobook: {
        id: 'ab-8',
        title: 'Metadata Book',
        author: 'Metadata Author',
        asin: 'B008ASIN',
      },
      jobId: 'job-8',
    });

    expect(prismaMock.downloadHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId: 'req-8',
        indexerName: "Anna's Archive",
        torrentName: 'Metadata Book - Metadata Author.epub',
        downloadClient: 'direct',
        downloadStatus: 'queued',
        selected: true,
        qualityScore: 100, // ASIN match = 100
      }),
    });

    // Check that all URLs are stored
    expect(prismaMock.downloadHistory.update).toHaveBeenCalledWith({
      where: { id: 'dh-8' },
      data: {
        torrentUrl: JSON.stringify([
          'https://link1.example.com',
          'https://link2.example.com',
        ]),
      },
    });
  });

  // ==================== F5: Libgen source + priority ordering ====================

  it('tries Libgen first when it has the lower priority, and does NOT fall back on a hit', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-lg' });
    prismaMock.downloadHistory.update.mockResolvedValue({});

    // Libgen (priority 10) + Anna's (priority 30) both enabled.
    setConfig({
      ebook_sidecar_preferred_format: 'epub',
      ebook_libgen_enabled: 'true',
      ebook_libgen_priority: '10',
      ebook_annas_archive_enabled: 'true',
      ebook_annas_archive_priority: '30',
      ebook_indexer_search_enabled: 'false',
    });

    libgenScraperMock.searchLibgen.mockResolvedValue([
      { md5: 'lgmd5', title: 'Libgen Book', author: 'Libgen Author', format: 'epub', sizeBytes: 1048576, language: 'English', collection: 'l', adsUrl: 'https://libgen.bz/ads.php?md5=lgmd5', score: 90 },
    ]);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    const result = await processSearchEbook({
      requestId: 'req-lg',
      audiobook: { id: 'ab-lg', title: 'Libgen Book', author: 'Libgen Author', asin: 'BLGASIN' },
      jobId: 'job-lg',
    });

    expect(result.success).toBe(true);
    expect(result.source).toBe('libgen');
    // Anna's must NOT be consulted once Libgen hits (first-hit-wins).
    expect(ebookScraperMock.searchByAsin).not.toHaveBeenCalled();
    expect(ebookScraperMock.searchByTitle).not.toHaveBeenCalled();
    // Direct download queued with source='libgen', the ads landing URL, size, and format.
    expect(jobQueueMock.addStartDirectDownloadJob).toHaveBeenCalledWith(
      'req-lg',
      'dh-lg',
      'https://libgen.bz/ads.php?md5=lgmd5',
      'Libgen Book - Libgen Author.epub',
      1048576,
      'libgen',
      'epub'
    );
    expect(prismaMock.downloadHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ indexerName: 'Libgen', downloadClient: 'direct' }),
    });
  });

  it('falls through from Libgen to the next source when Libgen has no match', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-fb' });
    prismaMock.downloadHistory.update.mockResolvedValue({});

    setConfig({
      ebook_sidecar_preferred_format: 'epub',
      ebook_sidecar_base_url: 'https://annas-archive.gl',
      ebook_libgen_enabled: 'true',
      ebook_libgen_priority: '10',
      ebook_annas_archive_enabled: 'true',
      ebook_annas_archive_priority: '30',
      ebook_indexer_search_enabled: 'false',
    });

    libgenScraperMock.searchLibgen.mockResolvedValue([]); // Libgen finds nothing
    ebookScraperMock.searchByAsin.mockResolvedValue('annasmd5');
    ebookScraperMock.getSlowDownloadLinks.mockResolvedValue(['https://slow.example.com/annas']);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    const result = await processSearchEbook({
      requestId: 'req-fb',
      audiobook: { id: 'ab-fb', title: 'Fallback Book', author: 'Fallback Author', asin: 'BFBASIN' },
      jobId: 'job-fb',
    });

    expect(result.success).toBe(true);
    expect(result.source).toBe('annas_archive');
    expect(libgenScraperMock.searchLibgen).toHaveBeenCalled(); // tried first
    expect(ebookScraperMock.searchByAsin).toHaveBeenCalled(); // then Anna's
  });

  it('lists all enabled sources (incl. Libgen) in the no-results message', async () => {
    prismaMock.request.update.mockResolvedValue({});

    setConfig({
      ebook_sidecar_preferred_format: 'epub',
      ebook_libgen_enabled: 'true',
      ebook_annas_archive_enabled: 'true',
      ebook_indexer_search_enabled: 'false',
    });

    libgenScraperMock.searchLibgen.mockResolvedValue([]);
    ebookScraperMock.searchByAsin.mockResolvedValue(null);
    ebookScraperMock.searchByTitle.mockResolvedValue(null);

    const { processSearchEbook } = await import('@/lib/processors/search-ebook.processor');

    const result = await processSearchEbook({
      requestId: 'req-nores',
      audiobook: { id: 'ab-nr', title: 'Nowhere Book', author: 'Nobody', asin: 'BNRASIN' },
      jobId: 'job-nr',
    });

    expect(result.success).toBe(false);
    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'req-nores' },
      data: expect.objectContaining({
        status: 'awaiting_search',
        errorMessage: expect.stringContaining('Libgen'),
      }),
    });
  });
});
