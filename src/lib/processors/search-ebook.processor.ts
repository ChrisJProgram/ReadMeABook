/**
 * Component: Search Ebook Job Processor
 * Documentation: documentation/integrations/ebook-sidecar.md
 *
 * Searches for ebook downloads across config-driven, priority-ordered sources
 * (F5). Enabled sources are tried lowest-priority-number first; the first hit
 * wins:
 *   - Libgen (if enabled)        - direct HTTP downloads from a Libgen mirror
 *   - Indexer Search (if enabled) - via Prowlarr with ebook categories (MAM)
 *   - Anna's Archive (if enabled) - direct HTTP downloads (G2: last-resort)
 * Order + enablement come from resolveEbookSourceOrder (ebook-source-order.ts).
 */

import { SearchEbookPayload, EbookSearchResult, getJobQueueService } from '../services/job-queue.service';
import { prisma } from '../db';
import { getConfigService } from '../services/config.service';
import { RMABLogger } from '../utils/logger';
import { getProwlarrService } from '../integrations/prowlarr.service';
import { rankEbookTorrents, RankedEbookTorrent } from '../utils/ranking-algorithm';
import { groupIndexersByCategories, getGroupDescription } from '../utils/indexer-grouping';
import { getLanguageForRegion } from '../constants/language-config';
import { filterBlockedResults } from '../utils/filter-blocked-results';
import { filterExcludedByRules, summarizeExcluded } from '../utils/indexer-flag-rules';
import type { AudibleRegion } from '../types/audible';

// Import ebook scraper functions for Anna's Archive
import {
  searchByAsin,
  searchByTitle,
  getSlowDownloadLinks,
} from '../services/ebook-scraper';
import { searchLibgen, DEFAULT_LIBGEN_MIRROR } from '../services/libgen-scraper';
import { resolveEbookSourceOrder, ebookSourceLabel } from '../utils/ebook-source-order';

/**
 * Process search ebook job
 * Searches Anna's Archive first (if enabled), then falls back to indexer search (if enabled)
 */
export async function processSearchEbook(payload: SearchEbookPayload): Promise<any> {
  const { requestId, audiobook, preferredFormat: payloadFormat, jobId } = payload;

  const logger = RMABLogger.forJob(jobId, 'SearchEbook');

  logger.info(`Processing ebook request ${requestId} for "${audiobook.title}"`);

  try {
    // Update request status to searching and fetch custom search terms
    const requestRecord = await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'searching',
        searchAttempts: { increment: 1 },
        updatedAt: new Date(),
      },
      select: { customSearchTerms: true },
    });

    // Use custom search terms if set, otherwise use audiobook title
    const effectiveSearchTitle = requestRecord?.customSearchTerms || audiobook.title;
    const searchAudiobook = { ...audiobook, title: effectiveSearchTitle };

    if (requestRecord?.customSearchTerms) {
      logger.info(`Using custom search terms: "${effectiveSearchTitle}" (original: "${audiobook.title}")`);
    }

    // Get ebook configuration
    const configService = getConfigService();
    const preferredFormat = payloadFormat || await configService.get('ebook_sidecar_preferred_format') || 'epub';

    // F5: config-driven, priority-ordered source list (G1). Enabled sources are
    // tried lowest-priority-number first; the first hit wins.
    const sourceOrder = await resolveEbookSourceOrder(configService);

    logger.info(
      `Ebook sources (in order): ${sourceOrder.ordered.map(s => `${s.id}@${s.priority}`).join(' → ') || '(none enabled)'}`
    );
    logger.info(`Preferred format: ${preferredFormat}`);

    // ========== Iterate sources in priority order; first hit wins ==========
    for (const src of sourceOrder.ordered) {
      if (src.id === 'libgen') {
        logger.info(`Searching Libgen (priority ${src.priority})...`);
        const libgenResult = await searchLibgenSource(requestId, searchAudiobook, preferredFormat, logger);
        if (libgenResult) {
          logger.info(`Found ebook via Libgen (score: ${libgenResult.score})`);
          return await handleLibgenDownload(requestId, audiobook, libgenResult, preferredFormat, logger);
        }
        logger.info(`No results from Libgen`);
      } else if (src.id === 'indexer') {
        logger.info(`Searching indexers (priority ${src.priority})...`);
        const indexerResult = await searchIndexers(requestId, searchAudiobook, preferredFormat, logger);
        if (indexerResult) {
          logger.info(`Found ebook via indexer search (score: ${indexerResult.finalScore.toFixed(1)})`);
          return await handleIndexerDownload(requestId, audiobook, indexerResult, preferredFormat, logger);
        }
        logger.info(`No results from indexer search`);
      } else if (src.id === 'annas_archive') {
        logger.info(`Searching Anna's Archive (priority ${src.priority})...`);
        const annasArchiveResult = await searchAnnasArchive(requestId, searchAudiobook, preferredFormat, logger);
        if (annasArchiveResult) {
          logger.info(`Found ebook via Anna's Archive (score: ${annasArchiveResult.score})`);
          return await handleAnnasArchiveDownload(requestId, audiobook, annasArchiveResult, preferredFormat, logger);
        }
        logger.info(`No results from Anna's Archive`);
      }
    }

    // ========== No results from any enabled source ==========
    const message = sourceOrder.anyEnabled
      ? `No ebook found on ${sourceOrder.ordered.map(s => ebookSourceLabel(s.id)).join(' or ')}. Will retry automatically.`
      : 'No ebook sources enabled. Enable Libgen, Indexer Search, or Anna\'s Archive in settings.';

    logger.warn(`No ebook found for request ${requestId}, marking as awaiting_search`);

    await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'awaiting_search',
        errorMessage: message,
        lastSearchAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return {
      success: false,
      message: 'No ebook found, queued for re-search',
      requestId,
    };

  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);

    await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error during ebook search',
        updatedAt: new Date(),
      },
    });

    throw error;
  }
}

/**
 * Search Anna's Archive for ebook
 */
async function searchAnnasArchive(
  requestId: string,
  audiobook: { title: string; author: string; asin?: string },
  preferredFormat: string,
  logger: RMABLogger
): Promise<EbookSearchResult | null> {
  const configService = getConfigService();
  const baseUrl = await configService.get('ebook_sidecar_base_url') || 'https://annas-archive.gl';
  const flaresolverrUrl = await configService.get('ebook_sidecar_flaresolverr_url') || undefined;

  // Get language code from Audible region config
  const region = await configService.getAudibleRegion() as AudibleRegion;
  const langConfig = getLanguageForRegion(region);
  const languageCode = langConfig.annasArchiveLang;

  if (flaresolverrUrl) {
    logger.info(`Using FlareSolverr at ${flaresolverrUrl}`);
  }

  let md5: string | null = null;
  let searchMethod: 'asin' | 'title' = 'title';

  // Try ASIN search first (exact match - best)
  if (audiobook.asin) {
    logger.info(`Searching Anna's Archive by ASIN: ${audiobook.asin} (format: ${preferredFormat})...`);
    md5 = await searchByAsin(audiobook.asin, preferredFormat, baseUrl, logger, flaresolverrUrl, languageCode);

    if (md5) {
      logger.info(`Found via ASIN: ${md5}`);
      searchMethod = 'asin';
    } else {
      logger.info(`No ASIN results, trying title + author...`);
    }
  }

  // Fallback to title + author search
  if (!md5) {
    logger.info(`Searching Anna's Archive by title + author: "${audiobook.title}" by ${audiobook.author}...`);
    md5 = await searchByTitle(audiobook.title, audiobook.author, preferredFormat, baseUrl, logger, flaresolverrUrl, languageCode);

    if (md5) {
      logger.info(`Found via title search: ${md5}`);
      searchMethod = 'title';
    }
  }

  if (!md5) {
    return null;
  }

  // F6: skip a release this request has already blocklisted (e.g. rejected by
  // the quality gate) — Anna's resolves ONE md5, so a blocked hit means this
  // source has nothing new and the loop falls through to the next source.
  const { kept } = await filterBlockedResults(requestId, [
    { title: `${audiobook.title} - ${audiobook.author}.${preferredFormat}`, infoHash: md5 },
  ]);
  if (kept.length === 0) {
    logger.info(`Anna's Archive hit ${md5} is blocklisted for this request — skipping source`);
    return null;
  }

  // Get slow download links
  const slowLinks = await getSlowDownloadLinks(md5, baseUrl, logger, flaresolverrUrl);

  if (slowLinks.length === 0) {
    logger.warn(`Found MD5 ${md5} but no download links available`);
    return null;
  }

  logger.info(`Found ${slowLinks.length} download link(s) for MD5 ${md5}`);

  return {
    md5,
    title: audiobook.title,
    author: audiobook.author,
    format: preferredFormat,
    downloadUrls: slowLinks,
    source: 'annas_archive',
    score: searchMethod === 'asin' ? 100 : 80,
  };
}

/**
 * Search Libgen for an ebook (F5). Returns the job-queue EbookSearchResult shape
 * with source='libgen' and downloadUrls=[ads.php landing URL] (resolved to a
 * real file URL at download time).
 */
async function searchLibgenSource(
  requestId: string,
  audiobook: { title: string; author: string },
  preferredFormat: string,
  logger: RMABLogger
): Promise<EbookSearchResult | null> {
  const configService = getConfigService();
  const baseUrl = await configService.get('ebook_libgen_base_url') || DEFAULT_LIBGEN_MIRROR;

  // Preferred language for a soft ranking boost (reuse the Anna's-Archive lang code).
  const region = await configService.getAudibleRegion() as AudibleRegion;
  const langConfig = getLanguageForRegion(region);
  const preferredLanguage = langConfig.annasArchiveLang;

  const results = await searchLibgen(
    audiobook.title,
    audiobook.author,
    preferredFormat,
    baseUrl,
    logger,
    preferredLanguage
  );

  if (results.length === 0) {
    return null;
  }

  // F6: drop editions this request has blocklisted (quality-gate rejects carry
  // the md5 as releaseHash), then take the best remaining — the edition-level
  // convergence loop: reject → re-search → NEXT edition, bounded by supply.
  const { kept, blockedCount } = await filterBlockedResults(
    requestId,
    results.map((r) => ({ ...r, infoHash: r.md5 }))
  );
  if (blockedCount > 0) {
    logger.info(`Skipped ${blockedCount} blocklisted Libgen edition(s) for this request`);
  }
  if (kept.length === 0) {
    logger.warn(`All ${results.length} Libgen edition(s) are blocklisted for this request — skipping source`);
    return null;
  }

  const best = kept[0];
  return {
    md5: best.md5,
    title: audiobook.title,
    author: audiobook.author,
    format: best.format || preferredFormat,
    fileSize: best.sizeBytes || undefined,
    downloadUrls: [best.adsUrl],
    source: 'libgen',
    score: Math.round(best.score),
  };
}

/**
 * Search indexers for ebook torrents/NZBs
 */
async function searchIndexers(
  requestId: string,
  audiobook: { title: string; author: string },
  preferredFormat: string,
  logger: RMABLogger
): Promise<RankedEbookTorrent | null> {
  const configService = getConfigService();

  // Get enabled indexers from configuration
  const indexersConfigStr = await configService.get('prowlarr_indexers');

  if (!indexersConfigStr) {
    logger.warn('No indexers configured');
    return null;
  }

  const indexersConfig = JSON.parse(indexersConfigStr);

  if (indexersConfig.length === 0) {
    logger.warn('No indexers enabled');
    return null;
  }

  // Build indexer priorities map (indexerId -> priority 1-25, default 10)
  const indexerPriorities = new Map<number, number>(
    indexersConfig.map((indexer: any) => [indexer.id, indexer.priority ?? 10])
  );

  // Get flag configurations
  const flagConfigStr = await configService.get('indexer_flag_config');
  const flagConfigs = flagConfigStr ? JSON.parse(flagConfigStr) : [];

  // Group indexers by their EBOOK category configuration
  const { groups, skippedIndexers } = groupIndexersByCategories(indexersConfig, 'ebook');

  if (skippedIndexers.length > 0) {
    const skippedNames = skippedIndexers.map(idx => idx.name).join(', ');
    logger.info(`Skipping ${skippedIndexers.length} indexer(s) with no ebook categories: ${skippedNames}`);
  }

  logger.info(`Searching ${indexersConfig.length - skippedIndexers.length} enabled indexers in ${groups.length} group${groups.length > 1 ? 's' : ''}`);

  // Log each group for transparency
  groups.forEach((group, index) => {
    logger.info(`Group ${index + 1}: ${getGroupDescription(group)}`);
  });

  // Get Prowlarr service
  const prowlarr = await getProwlarrService();

  // Build search query (title only - cast wide net, let ranking filter)
  const searchQuery = audiobook.title;

  logger.info(`Searching for: "${searchQuery}"`);

  // Search Prowlarr for each group and combine results
  const allResults = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    logger.info(`Searching group ${i + 1}/${groups.length}: ${getGroupDescription(group)}`);

    try {
      const groupResults = await prowlarr.search(searchQuery, {
        categories: group.categories,
        indexerIds: group.indexerIds,
        minSeeders: 0, // Ebooks may have fewer seeders
        maxResults: 100,
      });

      logger.info(`Group ${i + 1} returned ${groupResults.length} results`);
      allResults.push(...groupResults);
    } catch (error) {
      logger.error(`Group ${i + 1} search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Continue with other groups even if one fails
    }
  }

  logger.info(`Found ${allResults.length} total results from ${groups.length} group${groups.length > 1 ? 's' : ''}`);

  if (allResults.length === 0) {
    return null;
  }

  // Strip blocklisted releases before ranking.
  const { kept: nonBlockedResults, blockedCount } = await filterBlockedResults(requestId, allResults);
  if (blockedCount > 0) {
    logger.debug(`Filtered out ${blockedCount} blocklisted release(s) before ranking`);
  }

  if (nonBlockedResults.length === 0) {
    logger.warn(`All ${allResults.length} ebook candidates were blocklisted`);
    return null;
  }

  // F2(a): drop releases matching a per-indexer title-exclude rule (e.g. MAM [VIP]).
  // Automatic path only — interactive search shows everything and lets the user decide.
  const { kept: selectableResults, excluded } = filterExcludedByRules(nonBlockedResults, flagConfigs);
  if (excluded.length > 0) {
    logger.info(summarizeExcluded(excluded));
  }

  if (selectableResults.length === 0) {
    logger.warn(`All ${nonBlockedResults.length} ebook candidate(s) matched an exclude rule`);
    return null;
  }

  // Log filter info (ebooks > 20MB will be filtered)
  const preFilterCount = selectableResults.length;
  const aboveThreshold = selectableResults.filter(r => (r.size / (1024 * 1024)) > 20);
  if (aboveThreshold.length > 0) {
    logger.info(`Will filter ${aboveThreshold.length} results > 20 MB (too large for ebooks)`);
  }

  // Get language-specific stop words for ranking
  const ebookRegion = await configService.getAudibleRegion() as AudibleRegion;
  const ebookLangConfig = getLanguageForRegion(ebookRegion);

  // Rank results with ebook-specific scoring
  // This filters out > 20MB and uses inverted size scoring
  const rankedResults = rankEbookTorrents(selectableResults, {
    title: audiobook.title,
    author: audiobook.author,
    preferredFormat,
  }, {
    indexerPriorities,
    flagConfigs,
    requireAuthor: true, // Automatic mode - prevent wrong authors
    stopWords: ebookLangConfig.stopWords,
    characterReplacements: ebookLangConfig.characterReplacements,
  });

  // Log filter results
  const postFilterCount = rankedResults.length;
  if (postFilterCount < preFilterCount) {
    logger.info(`Filtered out ${preFilterCount - postFilterCount} results > 20 MB`);
  }

  // Dual threshold filtering (same as audiobooks)
  const filteredResults = rankedResults.filter(result =>
    result.score >= 50 && result.finalScore >= 50
  );

  const disqualifiedByNegativeBonus = rankedResults.filter(result =>
    result.score >= 50 && result.finalScore < 50
  ).length;

  logger.info(`Ranked ${rankedResults.length} results, ${filteredResults.length} above threshold (50/100 base + final)`);
  if (disqualifiedByNegativeBonus > 0) {
    logger.info(`${disqualifiedByNegativeBonus} ebooks disqualified by negative flag bonuses`);
  }

  if (filteredResults.length === 0) {
    logger.warn(`No quality matches found (all below 50/100)`);
    return null;
  }

  // Select best result
  const bestResult = filteredResults[0];

  // Log top 3 results with detailed breakdown
  const top3 = filteredResults.slice(0, 3);
  logger.info(`==================== EBOOK RANKING DEBUG ====================`);
  logger.info(`Requested Title: "${audiobook.title}"`);
  logger.info(`Requested Author: "${audiobook.author}"`);
  logger.info(`Preferred Format: ${preferredFormat}`);
  logger.info(`Top ${top3.length} results (out of ${filteredResults.length} above threshold):`);
  logger.info(`--------------------------------------------------------------`);
  for (let i = 0; i < top3.length; i++) {
    const result = top3[i];
    const sizeMB = (result.size / (1024 * 1024)).toFixed(1);

    logger.info(`${i + 1}. "${result.title}"`);
    logger.info(`   Indexer: ${result.indexer}${result.indexerId ? ` (ID: ${result.indexerId})` : ''}`);
    logger.info(``);
    logger.info(`   Base Score: ${result.score.toFixed(1)}/100`);
    logger.info(`   - Title/Author Match: ${result.breakdown.matchScore.toFixed(1)}/60`);
    logger.info(`   - Format Match: ${result.breakdown.formatScore.toFixed(1)}/10`);
    logger.info(`   - Size Quality: ${result.breakdown.sizeScore.toFixed(1)}/15 (${sizeMB} MB)`);
    logger.info(`   - Seeder Count: ${result.breakdown.seederScore.toFixed(1)}/15 (${result.seeders !== undefined ? result.seeders + ' seeders' : 'N/A for Usenet'})`);
    logger.info(``);
    logger.info(`   Bonus Points: +${result.bonusPoints.toFixed(1)}`);
    if (result.bonusModifiers.length > 0) {
      for (const mod of result.bonusModifiers) {
        logger.info(`   - ${mod.reason}: +${mod.points.toFixed(1)}`);
      }
    }
    logger.info(``);
    logger.info(`   Final Score: ${result.finalScore.toFixed(1)}`);
    if (result.breakdown.notes.length > 0) {
      logger.info(`   Notes: ${result.breakdown.notes.join(', ')}`);
    }
    if (i < top3.length - 1) {
      logger.info(`--------------------------------------------------------------`);
    }
  }
  logger.info(`==============================================================`);
  logger.info(`Selected best result: ${bestResult.title} (final score: ${bestResult.finalScore.toFixed(1)})`);

  return bestResult;
}

/**
 * Handle Anna's Archive download (direct HTTP)
 */
async function handleAnnasArchiveDownload(
  requestId: string,
  audiobook: { title: string; author: string },
  result: EbookSearchResult,
  preferredFormat: string,
  logger: RMABLogger
): Promise<any> {
  logger.info(`==================== EBOOK SEARCH RESULT ====================`);
  logger.info(`Source: Anna's Archive`);
  logger.info(`Title: "${audiobook.title}"`);
  logger.info(`Author: "${audiobook.author}"`);
  logger.info(`Format: ${preferredFormat}`);
  logger.info(`MD5: ${result.md5}`);
  logger.info(`Download Links: ${result.downloadUrls.length}`);
  logger.info(`Score: ${result.score}/100`);
  logger.info(`==============================================================`);

  // Create download history record
  const downloadHistory = await prisma.downloadHistory.create({
    data: {
      requestId,
      indexerName: "Anna's Archive",
      torrentName: `${audiobook.title} - ${audiobook.author}.${preferredFormat}`,
      torrentHash: result.md5, // F6: edition identity — lets a quality-gate reject blocklist THIS edition
      torrentSizeBytes: null, // Unknown until download starts
      qualityScore: result.score,
      selected: true,
      downloadClient: 'direct', // Direct HTTP download
      downloadStatus: 'queued',
    },
  });

  // Trigger direct download job
  const jobQueue = getJobQueueService();
  await jobQueue.addStartDirectDownloadJob(
    requestId,
    downloadHistory.id,
    result.downloadUrls[0], // Start with first link
    `${audiobook.title} - ${audiobook.author}.${preferredFormat}`,
    undefined // Size unknown
  );

  // Store all download URLs for retry purposes
  await prisma.downloadHistory.update({
    where: { id: downloadHistory.id },
    data: {
      torrentUrl: JSON.stringify(result.downloadUrls),
    },
  });

  return {
    success: true,
    message: `Found ebook via Anna's Archive, starting download`,
    requestId,
    source: 'annas_archive',
    searchResult: {
      md5: result.md5,
      format: result.format,
      score: result.score,
      downloadLinksCount: result.downloadUrls.length,
    },
  };
}

/**
 * Handle Libgen download (direct HTTP, final file resolved at download time)
 */
async function handleLibgenDownload(
  requestId: string,
  audiobook: { title: string; author: string },
  result: EbookSearchResult,
  preferredFormat: string,
  logger: RMABLogger
): Promise<{
  success: boolean;
  message: string;
  requestId: string;
  source: string;
  searchResult: { md5: string; format: string; score: number };
}> {
  const format = result.format || preferredFormat;
  logger.info(`==================== EBOOK SEARCH RESULT ====================`);
  logger.info(`Source: Libgen`);
  logger.info(`Title: "${audiobook.title}"`);
  logger.info(`Author: "${audiobook.author}"`);
  logger.info(`Format: ${format}`);
  logger.info(`MD5: ${result.md5}`);
  logger.info(`Landing URL: ${result.downloadUrls[0]}`);
  logger.info(`Score: ${result.score}/100`);
  logger.info(`==============================================================`);

  // Create download history record
  const downloadHistory = await prisma.downloadHistory.create({
    data: {
      requestId,
      indexerName: 'Libgen',
      torrentName: `${audiobook.title} - ${audiobook.author}.${format}`,
      torrentHash: result.md5, // F6: edition identity — lets a quality-gate reject blocklist THIS edition
      torrentSizeBytes: result.fileSize ? BigInt(result.fileSize) : null,
      qualityScore: result.score,
      selected: true,
      downloadClient: 'direct', // Direct HTTP download
      downloadStatus: 'queued',
    },
  });

  // Store the landing URL(s) for retry purposes
  await prisma.downloadHistory.update({
    where: { id: downloadHistory.id },
    data: {
      torrentUrl: JSON.stringify(result.downloadUrls),
    },
  });

  // Trigger direct download job with source='libgen' so the processor resolves
  // the ads.php landing → keyed get.php instead of scraping Anna's slow-download.
  const jobQueue = getJobQueueService();
  await jobQueue.addStartDirectDownloadJob(
    requestId,
    downloadHistory.id,
    result.downloadUrls[0],
    `${audiobook.title} - ${audiobook.author}.${format}`,
    result.fileSize,
    'libgen',
    format
  );

  return {
    success: true,
    message: `Found ebook via Libgen, starting download`,
    requestId,
    source: 'libgen',
    searchResult: {
      md5: result.md5,
      format,
      score: result.score,
    },
  };
}

/**
 * Handle indexer download (torrent/NZB via download-torrent processor)
 */
async function handleIndexerDownload(
  requestId: string,
  audiobook: { title: string; author: string },
  result: RankedEbookTorrent,
  preferredFormat: string,
  logger: RMABLogger
): Promise<any> {
  logger.info(`==================== EBOOK SEARCH RESULT ====================`);
  logger.info(`Source: Indexer (${result.indexer})`);
  logger.info(`Title: "${audiobook.title}"`);
  logger.info(`Author: "${audiobook.author}"`);
  logger.info(`Torrent: "${result.title}"`);
  logger.info(`Size: ${(result.size / (1024 * 1024)).toFixed(1)} MB`);
  logger.info(`Seeders: ${result.seeders !== undefined ? result.seeders : 'N/A'}`);
  logger.info(`Final Score: ${result.finalScore.toFixed(1)}/100`);
  logger.info(`==============================================================`);

  // Trigger download job using the SAME processor as audiobooks
  // The download-torrent processor is already generic and handles both torrent and NZB
  const jobQueue = getJobQueueService();

  // Fetch the request to get the parent audiobook ID for the download job
  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { parentRequest: true },
  });

  if (!request) {
    throw new Error(`Request ${requestId} not found`);
  }

  // Use the parent audiobook's ID for the download job, or fall back to request ID
  const audiobookId = request.parentRequest?.id || request.id;

  await jobQueue.addDownloadJob(requestId, {
    id: audiobookId,
    title: audiobook.title,
    author: audiobook.author,
  }, result);

  return {
    success: true,
    message: `Found ebook via indexer search, starting download`,
    requestId,
    source: 'prowlarr',
    resultsCount: 1,
    selectedTorrent: {
      title: result.title,
      score: result.score,
      finalScore: result.finalScore,
      seeders: result.seeders || 0,
      size: result.size,
    },
  };
}
