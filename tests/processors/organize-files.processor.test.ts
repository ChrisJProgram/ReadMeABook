/**
 * Component: Organize Files Processor Tests
 * Documentation: documentation/phase3/file-organization.md
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import { generateFilesHash } from '@/lib/utils/files-hash';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import nodePath from 'path';

const prismaMock = createPrismaMock();
const organizerMock = vi.hoisted(() => ({ organize: vi.fn(), organizeEbook: vi.fn() }));
// F6: the quality inspector is mocked for WIRING tests — its detection logic has
// its own unit suite against real EPUB archives (tests/utils/epub-quality.test.ts).
const inspectEpubQualityMock = vi.hoisted(() => vi.fn());
const libraryServiceMock = vi.hoisted(() => ({ triggerLibraryScan: vi.fn() }));
const jobQueueMock = vi.hoisted(() => ({
  addNotificationJob: vi.fn(() => Promise.resolve()),
}));
const configMock = vi.hoisted(() => ({
  getBackendMode: vi.fn(),
  get: vi.fn(),
}));
const formatCoercionMock = vi.hoisted(() => ({
  coerceToPlexCompatible: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/utils/file-organizer', () => ({
  getFileOrganizer: () => organizerMock,
}));

vi.mock('@/lib/services/library', () => ({
  getLibraryService: () => libraryServiceMock,
}));

vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => configMock,
}));

vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => jobQueueMock,
}));

vi.mock('@/lib/utils/format-coercion', () => formatCoercionMock);

const audioProbeMock = vi.hoisted(() => ({ probeAudioFile: vi.fn() }));
vi.mock('@/lib/utils/audio-probe', () => audioProbeMock);

vi.mock('@/lib/utils/epub-quality', () => ({
  inspectEpubQuality: inspectEpubQualityMock,
}));

describe('processOrganizeFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // D6 default: probe knows nothing — organize outcomes must not depend on it.
    audioProbeMock.probeAudioFile.mockResolvedValue({ kbps: null, channels: null, codec: null });
    // Default mock for request lookup (processor needs to determine request type)
    prismaMock.request.findUnique.mockResolvedValue({
      id: 'req-default',
      type: 'audiobook', // Default to audiobook type
      user: { plexUsername: 'testuser' },
    });
    // Default passthrough for Plex format coercion (issue #166): leave audio files unchanged
    formatCoercionMock.coerceToPlexCompatible.mockImplementation(async (paths: string[]) => ({
      renamed: [],
      warnings: [],
      errors: [],
      finalAudioFiles: paths,
    }));
  });

  it('organizes files and triggers filesystem scan when enabled', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a1',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN1',
    });
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 1,
      errors: [],
      audioFiles: ['/media/Author/Book/Book.m4b'],
    });
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'plex.trigger_scan_after_import') return 'true';
      if (key === 'plex_audiobook_library_id') return 'lib-1';
      if (key === 'audiobook_path_template') return '{author}/{title} {asin}';
      return null;
    });

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-1',
      audiobookId: 'a1',
      downloadPath: '/downloads/book',
      jobId: 'job-1',
    });

    expect(result.success).toBe(true);
    expect(libraryServiceMock.triggerLibraryScan).toHaveBeenCalledWith('lib-1');
  });

  // ================= D6: post-import actual bitrate =================

  const audiobookFixture = (id: string) => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id,
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN-D6',
    });
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 1,
      errors: [],
      audioFiles: ['/media/Author/Book/Book.m4b'],
    });
    prismaMock.audiobook.update.mockResolvedValue({});
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.get.mockResolvedValue(null);
  };

  it('persists actual bitrate and channels measured by the probe (D6)', async () => {
    audiobookFixture('a-d6');
    audioProbeMock.probeAudioFile.mockResolvedValue({ kbps: 125, channels: 2, codec: 'aac' });

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-d6',
      audiobookId: 'a-d6',
      downloadPath: '/downloads/book',
      jobId: 'job-d6',
    });

    expect(result.success).toBe(true);
    expect(audioProbeMock.probeAudioFile).toHaveBeenCalledWith('/media/Author/Book/Book.m4b');
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a-d6' },
        data: expect.objectContaining({
          actualKbps: 125,
          audioChannels: 2,
          status: 'completed',
        }),
      })
    );
  });

  it('never fails the import when the probe blows up (D6)', async () => {
    audiobookFixture('a-d6-fail');
    audioProbeMock.probeAudioFile.mockRejectedValue(new Error('ffprobe exploded'));

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-d6-fail',
      audiobookId: 'a-d6-fail',
      downloadPath: '/downloads/book',
      jobId: 'job-d6-fail',
    });

    expect(result.success).toBe(true); // import unharmed
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actualKbps: null,
          audioChannels: null,
          status: 'completed',
        }),
      })
    );
  });

  it('skips filesystem scan when disabled', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a3',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN3',
      year: 2020,
    });
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 1,
      errors: [],
      audioFiles: ['/media/Author/Book/Book.m4b'],
    });
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.get.mockResolvedValue('false');

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-3',
      audiobookId: 'a3',
      downloadPath: '/downloads/book',
      jobId: 'job-3',
    });

    expect(result.success).toBe(true);
    expect(libraryServiceMock.triggerLibraryScan).not.toHaveBeenCalled();
  });

  it('continues when scan is enabled but library ID is missing', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a4',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN4',
    });
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 1,
      errors: [],
      audioFiles: ['/media/Author/Book/Book.m4b'],
    });
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'plex.trigger_scan_after_import') return 'true';
      if (key === 'plex_audiobook_library_id') return null;
      return null;
    });

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-4',
      audiobookId: 'a4',
      downloadPath: '/downloads/book',
      jobId: 'job-4',
    });

    expect(result.success).toBe(true);
    expect(libraryServiceMock.triggerLibraryScan).not.toHaveBeenCalled();
  });

  it('updates year from AudibleCache when missing', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a5',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN5',
      year: null,
    });
    prismaMock.audibleCache.findUnique.mockResolvedValue({
      releaseDate: '2020-01-01',
    });
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 1,
      errors: [],
      audioFiles: ['/media/Author/Book/Book.m4b'],
    });
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.get.mockResolvedValue('false');

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-5',
      audiobookId: 'a5',
      downloadPath: '/downloads/book',
      jobId: 'job-5',
    });

    expect(result.success).toBe(true);
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ year: 2020 }),
      })
    );
  });

  it('queues retry when a retryable error occurs', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a2',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN2',
    });
    organizerMock.organize.mockResolvedValue({
      success: false,
      targetPath: '',
      filesMovedCount: 0,
      errors: ['No audiobook files found in download'],
      audioFiles: [],
    });
    prismaMock.request.findFirst.mockResolvedValue({
      importAttempts: 0,
      maxImportRetries: 3,
      deletedAt: null,
    });
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'audiobook_path_template') return '{author}/{title} {asin}';
      return null;
    });

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-2',
      audiobookId: 'a2',
      downloadPath: '/downloads/book',
      jobId: 'job-2',
    });

    expect(result.success).toBe(false);
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'awaiting_import' }),
      })
    );
    // Auto-block must NOT fire on a retry — only on the terminal warn transition.
    expect(prismaMock.blockedRelease.upsert).not.toHaveBeenCalled();
  });

  it('marks request as warn when max retries exceeded, auto-blocks the release, and notifies user', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a6',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN6',
    });
    organizerMock.organize.mockResolvedValue({
      success: false,
      targetPath: '',
      filesMovedCount: 0,
      errors: ['No audiobook files found in download'],
      audioFiles: [],
    });
    prismaMock.request.findFirst.mockResolvedValue({
      importAttempts: 2,
      maxImportRetries: 3,
      deletedAt: null,
    });
    prismaMock.request.findUnique.mockResolvedValue({
      id: 'req-6',
      audiobook: { title: 'Book', author: 'Author' },
      user: { plexUsername: 'user' },
    });
    prismaMock.downloadHistory.findFirst.mockResolvedValue({
      id: 'dh-6',
      torrentName: 'Book by Author [M4B]',
      torrentHash: 'hash-6',
      nzbId: null,
      indexerName: 'TestIndexer',
      indexerId: 7,
    });
    prismaMock.blockedRelease.upsert.mockResolvedValue({
      id: 'block-6',
      releaseName: 'Book by Author [M4B]',
      releaseKey: 'book by author [m4b]',
      createdAt: new Date(),
    });
    configMock.get.mockResolvedValue(null);

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-6',
      audiobookId: 'a6',
      downloadPath: '/downloads/book',
      jobId: 'job-6',
    });

    expect(result.success).toBe(false);
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'warn' }),
      })
    );
    expect(jobQueueMock.addNotificationJob).toHaveBeenCalledWith(
      'request_error',
      'req-6',
      'Book',
      'Author',
      'user',
      expect.stringContaining('Max retries')
    );
    // Terminal warn writes a single blocklist row keyed on the selected download.
    expect(prismaMock.blockedRelease.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId_releaseKey: { requestId: 'req-6', releaseKey: 'book by author [m4b]' } },
        create: expect.objectContaining({
          requestId: 'req-6',
          releaseName: 'Book by Author [M4B]',
          releaseKey: 'book by author [m4b]',
          releaseHash: 'hash-6',
          indexerName: 'TestIndexer',
          indexerId: 7,
          source: 'organize_fail',
          reason: 'No audiobook files found',
          downloadHistoryId: 'dh-6',
        }),
      })
    );
  });

  it('marks request failed for non-retryable errors and notifies user', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a7',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN7',
    });
    organizerMock.organize.mockResolvedValue({
      success: false,
      targetPath: '',
      filesMovedCount: 0,
      errors: ['Unexpected error'],
      audioFiles: [],
    });
    prismaMock.request.findUnique.mockResolvedValue({
      id: 'req-7',
      audiobook: { title: 'Book', author: 'Author' },
      user: { plexUsername: 'user' },
    });
    configMock.get.mockResolvedValue(null);

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');

    await expect(processOrganizeFiles({
      requestId: 'req-7',
      audiobookId: 'a7',
      downloadPath: '/downloads/book',
      jobId: 'job-7',
    })).rejects.toThrow(/File organization failed/i);

    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      })
    );
    expect(jobQueueMock.addNotificationJob).toHaveBeenCalledWith(
      'request_error',
      'req-7',
      'Book',
      'Author',
      'user',
      expect.stringContaining('File organization failed')
    );
    // Non-retryable failures do not auto-block — only terminal warn does.
    expect(prismaMock.blockedRelease.upsert).not.toHaveBeenCalled();
  });

  it('queues retry when organizer returns EPERM copy failure', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a-eperm',
      title: 'Theo of Golden',
      author: 'Allen Levi',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'B0FTT6KFKR',
    });
    // Organizer returns success: false with EPERM error (the fixed behavior)
    organizerMock.organize.mockResolvedValue({
      success: false,
      targetPath: '/media/audiobooks/Fiction/Allen Levi/Theo of Golden B0FTT6KFKR',
      filesMovedCount: 0,
      errors: [
        'Failed to copy Theo of Golden [B0FTT6KFKR].m4b: EPERM: operation not permitted, copyfile',
        'No audio files were successfully copied to the target directory',
      ],
      audioFiles: [],
    });
    prismaMock.request.findFirst.mockResolvedValue({
      importAttempts: 0,
      maxImportRetries: 3,
      deletedAt: null,
    });
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'audiobook_path_template') return '{author}/{title} {asin}';
      return null;
    });

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-eperm',
      audiobookId: 'a-eperm',
      downloadPath: '/data/torrents/bookbit',
      jobId: 'job-eperm',
    });

    // Should be identified as retryable and queued for re-import
    expect(result.success).toBe(false);
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'awaiting_import',
          importAttempts: 1,
          errorMessage: expect.stringContaining('EPERM'),
        }),
      })
    );
  });

  it('calls Plex format coercion when enabled (default)', async () => {
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a-coerce-on',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN-CO1',
    });
    // configuration.findUnique returns undefined (no setting persisted) -> default-on
    prismaMock.configuration.findUnique.mockResolvedValue(undefined);
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 1,
      errors: [],
      audioFiles: ['/media/Author/Book/Book.mp4'],
    });
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.get.mockResolvedValue('false');

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-coerce-on',
      audiobookId: 'a-coerce-on',
      downloadPath: '/downloads/book',
      jobId: 'job-coerce-on',
    });

    expect(result.success).toBe(true);
    expect(formatCoercionMock.coerceToPlexCompatible).toHaveBeenCalledWith(
      ['/media/Author/Book/Book.mp4'],
      expect.anything()
    );
  });

  it('skips Plex format coercion when disabled', async () => {
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a-coerce-off',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN-CO2',
    });
    prismaMock.configuration.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.key === 'plex_format_coercion_enabled') {
        return { key: 'plex_format_coercion_enabled', value: 'false' };
      }
      return undefined;
    });
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 1,
      errors: [],
      audioFiles: ['/media/Author/Book/Book.mp4'],
    });
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.get.mockResolvedValue('false');

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-coerce-off',
      audiobookId: 'a-coerce-off',
      downloadPath: '/downloads/book',
      jobId: 'job-coerce-off',
    });

    expect(result.success).toBe(true);
    expect(formatCoercionMock.coerceToPlexCompatible).not.toHaveBeenCalled();
  });

  it('coercion failure does NOT mark request failed', async () => {
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a-coerce-throw',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN-CO3',
    });
    prismaMock.configuration.findUnique.mockResolvedValue(undefined);
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 1,
      errors: [],
      audioFiles: ['/media/Author/Book/Book.mp4'],
    });
    formatCoercionMock.coerceToPlexCompatible.mockRejectedValueOnce(new Error('boom'));
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.get.mockResolvedValue('false');

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-coerce-throw',
      audiobookId: 'a-coerce-throw',
      downloadPath: '/downloads/book',
      jobId: 'job-coerce-throw',
    });

    expect(result.success).toBe(true);
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'downloaded' }),
      })
    );
  });

  it('filesHash reflects post-coercion filenames', async () => {
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a-coerce-hash',
      title: 'Book',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN-CO4',
    });
    prismaMock.configuration.findUnique.mockResolvedValue(undefined);
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 1,
      errors: [],
      audioFiles: ['/media/Book.mp4'],
    });
    // Coercion renames .mp4 -> .m4b
    formatCoercionMock.coerceToPlexCompatible.mockResolvedValueOnce({
      renamed: [{ from: '/media/Book.mp4', to: '/media/Book.m4b' }],
      warnings: [],
      errors: [],
      finalAudioFiles: ['/media/Book.m4b'],
    });
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.get.mockResolvedValue('false');

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-coerce-hash',
      audiobookId: 'a-coerce-hash',
      downloadPath: '/downloads/book',
      jobId: 'job-coerce-hash',
    });

    expect(result.success).toBe(true);
    const expectedHash = generateFilesHash(['/media/Book.m4b']);
    expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a-coerce-hash' },
        data: expect.objectContaining({ filesHash: expectedHash }),
      })
    );
  });

  it('generates and stores filesHash after successful organization', async () => {
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.audiobook.findUnique.mockResolvedValue({
      id: 'a-hash-1',
      title: 'Book With Hash',
      author: 'Author',
      narrator: null,
      coverArtUrl: null,
      audibleAsin: 'ASIN-HASH',
    });
    organizerMock.organize.mockResolvedValue({
      success: true,
      targetPath: '/media/Author/Book',
      filesMovedCount: 3,
      errors: [],
      audioFiles: [
        '/media/Author/Book/Chapter 01.mp3',
        '/media/Author/Book/Chapter 02.mp3',
        '/media/Author/Book/Chapter 03.mp3',
      ],
    });
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('false');

    const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
    const result = await processOrganizeFiles({
      requestId: 'req-hash-1',
      audiobookId: 'a-hash-1',
      downloadPath: '/downloads/book',
      jobId: 'job-hash-1',
    });

    expect(result.success).toBe(true);

    // Verify filesHash was included in the audiobook update
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a-hash-1' },
        data: expect.objectContaining({
          filePath: '/media/Author/Book',
          filesHash: expect.stringMatching(/^[a-f0-9]{64}$/), // SHA256 hash format
          status: 'completed',
        }),
      })
    );
  });

  // ================= F6: ebook quality gate =================

  describe('F6: ebook quality gate', () => {
    let epubPath: string;

    beforeAll(async () => {
      // detectEpubFilePath stats the real filesystem — give it a real .epub file
      // (content irrelevant: the inspector itself is mocked in this suite).
      const dir = await mkdtemp(nodePath.join(tmpdir(), 'f6-organize-'));
      epubPath = nodePath.join(dir, 'book.epub');
      await writeFile(epubPath, 'stub');
    });

    const ebookSetup = (gate: string | null) => {
      prismaMock.request.findUnique.mockResolvedValue({
        id: 'req-e1',
        type: 'ebook',
        user: { plexUsername: 'testuser' },
      });
      prismaMock.audiobook.findUnique.mockResolvedValue({
        id: 'e1',
        title: 'Book',
        author: 'Author',
        narrator: 'N',
        year: 2020,
        series: 'S',
        seriesPart: '1',
        audibleAsin: 'ASIN1',
      });
      prismaMock.downloadHistory.findFirst.mockResolvedValue({
        id: 'dh-1',
        torrentName: 'Book - Author.epub',
        torrentHash: 'md5abc',
        nzbId: null,
        indexerName: 'Libgen',
        indexerId: null,
        downloadClient: 'direct',
      });
      prismaMock.request.update.mockResolvedValue({});
      prismaMock.audiobook.update.mockResolvedValue({});
      prismaMock.blockedRelease.upsert.mockResolvedValue({ id: 'b1', createdAt: new Date() });
      organizerMock.organizeEbook.mockResolvedValue({
        success: true,
        targetPath: '/media/Author/Book/book.epub',
        errors: [],
        format: 'epub',
      });
      configMock.getBackendMode.mockResolvedValue('plex');
      configMock.get.mockImplementation(async (key: string) => {
        if (key === 'ebook_quality_gate') return gate;
        return null;
      });
    };

    const run = async () => {
      const { processOrganizeFiles } = await import('@/lib/processors/organize-files.processor');
      return processOrganizeFiles({
        requestId: 'req-e1',
        audiobookId: 'e1',
        downloadPath: epubPath,
        jobId: 'job-e1',
      });
    };

    const strongReport = {
      ok: true,
      spineDocCount: 10,
      totalTextChars: 0,
      avgTextCharsPerDoc: 0,
      imageCount: 10,
      imageBytes: 50_000,
      archiveBytes: 55_000,
      imageByteShare: 0.9,
      tocEntries: 0,
      scanSuspected: true,
      noChapters: true,
      strongVerdict: true,
      notes: ['possibly scanned pages (images 90% of archive across 10 files; ~0 text chars/page over 10 pages)', 'no chapter TOC (0 entries)'],
    };

    it('flag mode (default): imports anyway and persists the quality notes', async () => {
      ebookSetup(null); // unset config → default 'flag'
      inspectEpubQualityMock.mockReturnValue(strongReport);

      const result = await run();

      expect(result.success).toBe(true);
      expect(organizerMock.organizeEbook).toHaveBeenCalled();
      expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'completed',
            ebookQualityNotes: expect.stringContaining('possibly scanned'),
          }),
        })
      );
      // request reaches the ebook terminal state
      expect(prismaMock.request.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'downloaded' }) })
      );
      expect(prismaMock.blockedRelease.upsert).not.toHaveBeenCalled();
    });

    it('reject mode + strong verdict: blocklists, flips to awaiting_search, RETURNS (no throw), never organizes', async () => {
      ebookSetup('reject');
      inspectEpubQualityMock.mockReturnValue(strongReport);

      const result = await run(); // must resolve, not reject — the F2(b) return-not-throw rule

      expect(result.success).toBe(false);
      expect(result.qualityGate).toBe('rejected');
      expect(organizerMock.organizeEbook).not.toHaveBeenCalled();
      // blocklisted with the md5 as the release hash (edition-level skip)
      expect(prismaMock.blockedRelease.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            source: 'organize_fail',
            releaseHash: 'md5abc',
            reason: expect.stringContaining('quality gate'),
          }),
        })
      );
      expect(prismaMock.request.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'awaiting_search' }) })
      );
    });

    it('reject mode + WEAK verdict (no chapters only): still imports, only flags', async () => {
      ebookSetup('reject');
      inspectEpubQualityMock.mockReturnValue({
        ...strongReport,
        scanSuspected: false,
        strongVerdict: false,
        totalTextChars: 50_000,
        avgTextCharsPerDoc: 5_000,
        notes: ['no chapter TOC (0 entries)'],
      });

      const result = await run();

      expect(result.success).toBe(true);
      expect(organizerMock.organizeEbook).toHaveBeenCalled();
      expect(prismaMock.blockedRelease.upsert).not.toHaveBeenCalled();
      expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ebookQualityNotes: expect.stringContaining('no chapter TOC') }),
        })
      );
    });

    it('gate off: never inspects', async () => {
      ebookSetup('off');
      const result = await run();
      expect(result.success).toBe(true);
      expect(inspectEpubQualityMock).not.toHaveBeenCalled();
    });

    it('inspection error NEVER fails the import (probe rule)', async () => {
      ebookSetup('reject');
      inspectEpubQualityMock.mockReturnValue({ ok: false, error: 'corrupt zip' });

      const result = await run();

      expect(result.success).toBe(true);
      expect(organizerMock.organizeEbook).toHaveBeenCalled();
      expect(prismaMock.blockedRelease.upsert).not.toHaveBeenCalled();
      // clean import clears any stale note (null write)
      expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ebookQualityNotes: null }) })
      );
    });
  });
});


