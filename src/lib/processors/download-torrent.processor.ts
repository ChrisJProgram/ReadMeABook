/**
 * Component: Download Job Processor
 * Documentation: documentation/phase3/README.md
 */

import { DownloadTorrentPayload, getJobQueueService } from '../services/job-queue.service';
import { prisma } from '../db';
import { getConfigService } from '../services/config.service';
import { getDownloadClientManager } from '../services/download-client-manager.service';
import { ProwlarrService } from '../integrations/prowlarr.service';
import { RMABLogger } from '../utils/logger';
import { isTransientConnectionError } from '../utils/connection-errors';
import { addAutoBlock } from '../services/blocklist.service';

/**
 * Process download job
 * Routes to appropriate download client based on protocol detection
 * Adds selected result to download client and starts monitoring
 */
export async function processDownloadTorrent(payload: DownloadTorrentPayload): Promise<any> {
  const { requestId, audiobook, torrent, jobId } = payload;

  const logger = RMABLogger.forJob(jobId, 'DownloadTorrent');

  logger.info(`Processing request ${requestId} for "${audiobook.title}"`);
  logger.info(`Selected result: ${torrent.title}`, {
    size: torrent.size,
    seeders: torrent.seeders,
    format: torrent.format,
    indexer: torrent.indexer,
  });

  // Tracks whether we got as far as calling the download client's addDownload().
  // Only failures AFTER this point are release-specific (indexer 403/404/410/500,
  // client add-reject) and eligible for F2(b) blocklist + re-selection. Failures
  // BEFORE it (e.g. "no client configured") are config/precondition errors —
  // blocklisting the release for those would wrongly discard a gettable copy.
  let attemptedAdd = false;

  try {
    // Update request status to downloading
    const request = await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'downloading',
        progress: 0,
        updatedAt: new Date(),
      },
      include: {
        user: { select: { plexUsername: true } },
      },
    });

    // Detect protocol from result and get appropriate client
    const isUsenet = ProwlarrService.isNZBResult(torrent);
    const protocol = isUsenet ? 'usenet' : 'torrent';
    const config = await getConfigService();
    const manager = getDownloadClientManager(config);

    const client = await manager.getClientServiceForProtocol(protocol);

    if (!client) {
      throw new Error(`No ${protocol} download client configured. Please add a ${protocol} client in Settings > Download Clients.`);
    }

    // Get client config for category
    const clientConfig = await manager.getClientForProtocol(protocol);
    const category = clientConfig?.category || 'readmeabook';

    logger.info(`Routing to ${client.clientType} (${client.protocol})`);

    // Include Prowlarr API key as source header so NZB/torrent downloads from
    // Prowlarr proxy URLs are authenticated (fixes 403 for indexers like NZBFinder)
    const prowlarrApiKey = (await config.getMany(['prowlarr_api_key'])).prowlarr_api_key || process.env.PROWLARR_API_KEY;
    const sourceHeaders: Record<string, string> = {};
    if (prowlarrApiKey) {
      sourceHeaders['X-Api-Key'] = prowlarrApiKey;
    }

    // Add download via unified interface. From here on, a permanent failure is
    // release-specific (F2(b) blocklist + re-select applies).
    attemptedAdd = true;
    const downloadClientId = await client.addDownload(torrent.downloadUrl, {
      category,
      priority: 'normal',
      sourceHeaders,
    });

    logger.info(`Download added with ID: ${downloadClientId}`);

    // Create DownloadHistory record
    // Determine indexer page URL - exclude magnet links from guid fallback
    const indexerPageUrl = torrent.infoUrl || (torrent.guid?.startsWith('magnet:') ? null : torrent.guid);

    const downloadHistory = await prisma.downloadHistory.create({
      data: {
        requestId,
        indexerName: torrent.indexer,
        indexerId: torrent.indexerId,
        downloadClient: client.clientType,
        downloadClientId,
        torrentName: torrent.title,
        // Set protocol-specific ID fields for backward compatibility
        torrentHash: client.protocol === 'torrent' ? (torrent.infoHash || downloadClientId) : undefined,
        nzbId: client.protocol === 'usenet' ? downloadClientId : undefined,
        torrentSizeBytes: torrent.size,
        torrentUrl: indexerPageUrl,
        magnetLink: torrent.downloadUrl,
        seeders: torrent.seeders || 0,
        leechers: torrent.leechers || 0,
        downloadStatus: 'downloading',
        selected: true,
        startedAt: new Date(),
      },
    });

    logger.info(`Created download history record: ${downloadHistory.id}`);

    // Send grab notification (non-blocking — failures here don't fail the download)
    const jobQueue = getJobQueueService();
    const grabMessage = `${torrent.title} via ${torrent.indexer} (${client.clientType})`;
    await jobQueue.addNotificationJob(
      'request_grabbed',
      requestId,
      audiobook.title,
      audiobook.author,
      request.user.plexUsername || 'Unknown User',
      grabMessage,
      request.type
    ).catch((error) => {
      logger.error('Failed to queue grab notification', { error: error instanceof Error ? error.message : String(error) });
    });

    // Trigger monitor download job with initial delay
    await jobQueue.addMonitorJob(
      requestId,
      downloadHistory.id,
      downloadClientId,
      client.clientType,
      3 // Wait 3 seconds before first check
    );

    logger.info(`Started monitoring job for request ${requestId} (${client.clientType}, 3s initial delay)`);

    return {
      success: true,
      message: `Download added to ${client.clientType} and monitoring started`,
      requestId,
      downloadHistoryId: downloadHistory.id,
      downloadClientId,
      torrent: {
        title: torrent.title,
        size: torrent.size,
        seeders: torrent.seeders || 0,
        format: torrent.format,
      },
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);

    if (isTransientConnectionError(error)) {
      // Transient (client unreachable, gateway 5xx, or a 429 rate limit) — do
      // NOT mark failed and do NOT blocklist. Bull retries this job (3 attempts
      // with exponential backoff); if exhausted, the global failed handler marks
      // it failed.
      logger.warn(`Transient download-client error for request ${requestId}, allowing Bull to retry`);
      throw error;
    }

    if (attemptedAdd) {
      // F2(b) — permanent, release-specific failure (indexer 403/404/410/500
      // "Download failed" on a VIP/ratio-gated release, or a client add-reject).
      // Blocklist this exact release and flip the request back to awaiting_search
      // so retry-missing-torrents re-runs selection; filterBlockedResults then
      // skips this release and a DIFFERENT candidate is chosen — instead of
      // retrying the same ungettable release forever. Return (do NOT throw): a
      // throw would let the global failed handler overwrite awaiting_search.
      const httpStatus = (error as { response?: { status?: number } })?.response?.status;
      const errMsg = error instanceof Error ? error.message : 'Failed to add download to client';
      const reason = httpStatus ? `Download fetch failed (HTTP ${httpStatus})` : 'Download add failed';

      await addAutoBlock({
        requestId,
        releaseName: torrent.title,
        releaseHash: torrent.infoHash ?? null,
        indexerName: torrent.indexer ?? null,
        indexerId: torrent.indexerId ?? null,
        source: 'download_fail',
        reason,
        reasonDetail: errMsg,
        jobId,
      });

      await prisma.request.update({
        where: { id: requestId },
        data: {
          status: 'awaiting_search',
          errorMessage: `${reason} — blocklisted "${torrent.title}", re-searching for an alternative.`,
          lastSearchAt: new Date(),
          updatedAt: new Date(),
        },
      });

      logger.warn(`Release "${torrent.title}" blocklisted (${reason}); request ${requestId} re-queued for search`);

      return {
        success: false,
        reselected: true,
        requestId,
        blockedRelease: torrent.title,
        message: 'Release failed; blocklisted and re-queued for search',
      };
    }

    // Precondition/config error before the add attempt (e.g. no client
    // configured) — genuinely failed; re-searching would not help. Mark failed
    // and rethrow (the global safety net also marks it failed).
    await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Failed to add download to client',
        updatedAt: new Date(),
      },
    });

    throw error;
  }
}
