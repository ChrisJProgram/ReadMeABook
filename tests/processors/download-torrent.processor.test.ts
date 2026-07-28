/**
 * Component: Download Torrent Processor Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import { createJobQueueMock } from '../helpers/job-queue';

const prismaMock = createPrismaMock();
const configMock = vi.hoisted(() => ({
  get: vi.fn(),
  getMany: vi.fn().mockResolvedValue({ prowlarr_api_key: null }),
}));
const jobQueueMock = createJobQueueMock();
const qbtMock = vi.hoisted(() => ({ addTorrent: vi.fn() }));
const sabMock = vi.hoisted(() => ({ addNZB: vi.fn() }));

const downloadClientManagerMock = vi.hoisted(() => ({
  getClientForProtocol: vi.fn(),
  getClientServiceForProtocol: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => configMock,
}));

vi.mock('@/lib/services/download-client-manager.service', () => ({
  getDownloadClientManager: () => downloadClientManagerMock,
}));

vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => jobQueueMock,
}));

vi.mock('@/lib/integrations/qbittorrent.service', () => ({
  getQBittorrentService: () => qbtMock,
}));

vi.mock('@/lib/integrations/sabnzbd.service', () => ({
  getSABnzbdService: () => sabMock,
}));

vi.mock('@/lib/integrations/prowlarr.service', () => ({
  ProwlarrService: {
    isNZBResult: vi.fn((result: any) => {
      // Detect NZB by URL pattern or protocol field
      return result.downloadUrl?.endsWith('.nzb') || result.protocol === 'usenet';
    }),
  },
}));

describe('processDownloadTorrent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default implementations cleared by clearAllMocks
    configMock.getMany.mockResolvedValue({ prowlarr_api_key: null });
    jobQueueMock.addNotificationJob.mockResolvedValue(undefined);
  });

  const torrentPayload = {
    requestId: 'req-1',
    audiobook: { id: 'a1', title: 'Book', author: 'Author' },
    torrent: {
      indexer: 'Indexer',
      indexerId: 1,
      title: 'Book - Author',
      size: 50 * 1024 * 1024,
      seeders: 10,
      publishDate: new Date(),
      downloadUrl: 'magnet:?xt=urn:btih:abc',
      guid: 'guid-1',
      format: 'M4B',
      protocol: 'torrent',
    },
    jobId: 'job-1',
  };

  const nzbPayload = {
    requestId: 'req-2',
    audiobook: { id: 'a2', title: 'Book2', author: 'Author2' },
    torrent: {
      indexer: 'UsenetIndexer',
      indexerId: 2,
      title: 'Book2 - Author2',
      size: 100 * 1024 * 1024,
      seeders: 0,
      publishDate: new Date(),
      downloadUrl: 'http://indexer.com/download/file.nzb',
      guid: 'guid-2',
      format: 'M4B',
      protocol: 'usenet',
    },
    jobId: 'job-2',
  };

  it('routes torrent downloads to qBittorrent', async () => {
    const qbtClientMock = {
      clientType: 'qbittorrent',
      protocol: 'torrent',
      addDownload: vi.fn().mockResolvedValue('hash-1'),
    };
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(qbtClientMock);
    downloadClientManagerMock.getClientForProtocol.mockResolvedValue({
      id: 'client-1',
      type: 'qbittorrent',
      enabled: true,
      category: 'readmeabook',
    });
    prismaMock.request.update.mockResolvedValue({ type: 'audiobook', user: { plexUsername: 'testuser' } });
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-1' });

    const { processDownloadTorrent } = await import('@/lib/processors/download-torrent.processor');
    const result = await processDownloadTorrent(torrentPayload);

    expect(result.success).toBe(true);
    expect(downloadClientManagerMock.getClientServiceForProtocol).toHaveBeenCalledWith('torrent');
    expect(qbtClientMock.addDownload).toHaveBeenCalled();
    expect(jobQueueMock.addMonitorJob).toHaveBeenCalledWith(
      'req-1',
      'dh-1',
      'hash-1',
      'qbittorrent',
      3
    );
  });

  it('routes NZB downloads to SABnzbd', async () => {
    const sabClientMock = {
      clientType: 'sabnzbd',
      protocol: 'usenet',
      addDownload: vi.fn().mockResolvedValue('nzb-1'),
    };
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(sabClientMock);
    downloadClientManagerMock.getClientForProtocol.mockResolvedValue({
      id: 'client-2',
      type: 'sabnzbd',
      enabled: true,
      category: 'readmeabook',
    });
    prismaMock.request.update.mockResolvedValue({ type: 'audiobook', user: { plexUsername: 'testuser' } });
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-2' });

    const { processDownloadTorrent } = await import('@/lib/processors/download-torrent.processor');
    const result = await processDownloadTorrent(nzbPayload);

    expect(result.success).toBe(true);
    expect(downloadClientManagerMock.getClientServiceForProtocol).toHaveBeenCalledWith('usenet');
    expect(sabClientMock.addDownload).toHaveBeenCalled();
    expect(jobQueueMock.addMonitorJob).toHaveBeenCalledWith(
      'req-2',
      'dh-2',
      'nzb-1',
      'sabnzbd',
      3
    );
  });

  it('throws error when no client configured for protocol', async () => {
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(null);
    prismaMock.request.update.mockResolvedValue({});

    const { processDownloadTorrent } = await import('@/lib/processors/download-torrent.processor');

    await expect(processDownloadTorrent(torrentPayload)).rejects.toThrow(
      'No torrent download client configured'
    );

    expect(downloadClientManagerMock.getClientServiceForProtocol).toHaveBeenCalledWith('torrent');
    // Precondition/config error (never attempted the add) must NOT blocklist the release.
    expect(prismaMock.blockedRelease.upsert).not.toHaveBeenCalled();
  });

  // F2(b): a permanent, release-specific add failure blocklists the release and
  // flips the request back to awaiting_search (re-selection), WITHOUT throwing —
  // a throw would let the global failed handler overwrite awaiting_search.
  it('blocklists the release and re-queues for search on a permanent add failure', async () => {
    const addErr = new Error('Download failed') as Error & { response?: { status?: number } };
    addErr.response = { status: 500 }; // indexer 500 "Download failed" (e.g. VIP-gated)
    const qbtClientMock = {
      clientType: 'qbittorrent',
      protocol: 'torrent',
      addDownload: vi.fn().mockRejectedValue(addErr),
    };
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(qbtClientMock);
    downloadClientManagerMock.getClientForProtocol.mockResolvedValue({
      id: 'client-1', type: 'qbittorrent', enabled: true, category: 'readmeabook',
    });
    prismaMock.request.update.mockResolvedValue({ type: 'audiobook', user: { plexUsername: 'testuser' } });
    prismaMock.blockedRelease.upsert.mockResolvedValue({ createdAt: new Date() });

    const { processDownloadTorrent } = await import('@/lib/processors/download-torrent.processor');
    const result = await processDownloadTorrent(torrentPayload);

    // Did NOT throw; reported a re-selection.
    expect(result.reselected).toBe(true);
    expect(result.blockedRelease).toBe('Book - Author');
    // Blocklisted this exact release as a download_fail.
    expect(prismaMock.blockedRelease.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          requestId: 'req-1',
          releaseName: 'Book - Author',
          source: 'download_fail',
        }),
      })
    );
    // Flipped to awaiting_search (NOT failed) so retry-missing-torrents re-searches.
    expect(prismaMock.request.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'req-1' },
        data: expect.objectContaining({ status: 'awaiting_search' }),
      })
    );
  });

  // A 429 (rate limit) is transient: retry via Bull (throw), and NEVER blocklist.
  it('rethrows and does NOT blocklist on a 429 rate-limit add failure', async () => {
    const rateErr = new Error('[QBittorrent] HTTP error 429') as Error & { response?: { status?: number } };
    rateErr.response = { status: 429 };
    const qbtClientMock = {
      clientType: 'qbittorrent',
      protocol: 'torrent',
      addDownload: vi.fn().mockRejectedValue(rateErr),
    };
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(qbtClientMock);
    downloadClientManagerMock.getClientForProtocol.mockResolvedValue({
      id: 'client-1', type: 'qbittorrent', enabled: true, category: 'readmeabook',
    });
    prismaMock.request.update.mockResolvedValue({ type: 'audiobook', user: { plexUsername: 'testuser' } });

    const { processDownloadTorrent } = await import('@/lib/processors/download-torrent.processor');

    await expect(processDownloadTorrent(torrentPayload)).rejects.toThrow('429');
    // Rate limit must not discard the release.
    expect(prismaMock.blockedRelease.upsert).not.toHaveBeenCalled();
  });

  it('detects protocol from result and routes appropriately', async () => {
    // Torrent result
    const qbtClientMock = {
      clientType: 'qbittorrent',
      protocol: 'torrent',
      addDownload: vi.fn().mockResolvedValue('hash-1'),
    };
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValueOnce(qbtClientMock);
    downloadClientManagerMock.getClientForProtocol.mockResolvedValueOnce({
      id: 'client-1',
      type: 'qbittorrent',
      enabled: true,
      category: 'readmeabook',
    });
    prismaMock.request.update.mockResolvedValue({ type: 'audiobook', user: { plexUsername: 'testuser' } });
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-1' });

    const { processDownloadTorrent } = await import('@/lib/processors/download-torrent.processor');
    await processDownloadTorrent(torrentPayload);

    expect(downloadClientManagerMock.getClientServiceForProtocol).toHaveBeenCalledWith('torrent');

    // NZB result
    const sabClientMock = {
      clientType: 'sabnzbd',
      protocol: 'usenet',
      addDownload: vi.fn().mockResolvedValue('nzb-1'),
    };
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValueOnce(sabClientMock);
    downloadClientManagerMock.getClientForProtocol.mockResolvedValueOnce({
      id: 'client-2',
      type: 'sabnzbd',
      enabled: true,
      category: 'readmeabook',
    });
    prismaMock.downloadHistory.create.mockResolvedValue({ id: 'dh-2' });

    await processDownloadTorrent(nzbPayload);

    expect(downloadClientManagerMock.getClientServiceForProtocol).toHaveBeenCalledWith('usenet');
  });
});
