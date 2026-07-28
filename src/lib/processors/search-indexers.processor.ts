/**
 * Component: Search Indexers Job Processor
 * Documentation: documentation/phase3/README.md
 */

import { SearchIndexersPayload, getJobQueueService } from '../services/job-queue.service';
import { prisma } from '../db';
import { getProwlarrService } from '../integrations/prowlarr.service';
import { getRankingAlgorithm } from '../utils/ranking-algorithm';
import { impliedKbps } from '../utils/ranking-algorithm';
import { buildTierMap, selectTopTier } from '../utils/indexer-tiers';
import { groupIndexersByCategories, getGroupDescription } from '../utils/indexer-grouping';
import { RMABLogger } from '../utils/logger';
import { getLanguageForRegion } from '../constants/language-config';
import { filterBlockedResults } from '../utils/filter-blocked-results';
import { filterExcludedByRules, summarizeExcluded } from '../utils/indexer-flag-rules';
import type { AudibleRegion } from '../types/audible';

/**
 * Process search indexers job
 * Searches configured indexers for audiobook torrents
 */
export async function processSearchIndexers(payload: SearchIndexersPayload): Promise<any> {
  const { requestId, audiobook, jobId } = payload;

  const logger = RMABLogger.forJob(jobId, 'SearchIndexers');

  logger.info(`Processing request ${requestId} for "${audiobook.title}"`);

  try {
    // Update request status to searching
    await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'searching',
        searchAttempts: { increment: 1 },
        updatedAt: new Date(),
      },
    });

    // Check for custom search terms override
    const requestRecord = await prisma.request.findUnique({
      where: { id: requestId },
      select: { customSearchTerms: true },
    });
    const effectiveSearchTitle = requestRecord?.customSearchTerms || audiobook.title;

    // Get enabled indexers from configuration
    const { getConfigService } = await import('../services/config.service');
    const configService = getConfigService();

    // ============ F0: resolve runtime (persisted → cache → live) ============
    // Persisted audiobook row first, then AudibleCache, then a live Audnexus
    // call; any remote hit is written back onto the row so the next search
    // (and the UI) never refetches.
    let durationMinutes: number | undefined;
    let runtimeSource = 'none';

    const bookRow = await prisma.audiobook.findUnique({
      where: { id: audiobook.id },
      select: { runtimeMinutes: true },
    });
    if (bookRow?.runtimeMinutes) {
      durationMinutes = bookRow.runtimeMinutes;
      runtimeSource = 'audiobook row';
    }
    if (!durationMinutes && audiobook.asin) {
      const cached = await prisma.audibleCache.findUnique({
        where: { asin: audiobook.asin },
        select: { durationMinutes: true },
      });
      if (cached?.durationMinutes) {
        durationMinutes = cached.durationMinutes;
        runtimeSource = 'AudibleCache';
      }
    }
    if (!durationMinutes && audiobook.asin) {
      const { getAudibleService } = await import('../integrations/audible.service');
      const audibleService = getAudibleService();
      const runtime = await audibleService.getRuntime(audiobook.asin);
      if (runtime) {
        durationMinutes = runtime;
        runtimeSource = 'Audnexus';
      }
    }

    if (durationMinutes) {
      logger.info(`Runtime: ${durationMinutes} min (source: ${runtimeSource})`);
      if (!bookRow?.runtimeMinutes) {
        // Best-effort backfill — a write failure must not fail the search
        await prisma.audiobook
          .update({ where: { id: audiobook.id }, data: { runtimeMinutes: durationMinutes } })
          .catch((e) => logger.debug(`Runtime backfill failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // ============ F1 (D5): unknown runtime → hold for manual pick ============
    // Implied bitrate can't be computed for ANY release of this book, so the
    // AUTOMATIC path never grabs. Interactive search / user-picked releases are
    // unaffected (they don't run through this processor). The normal re-search
    // cadence keeps retrying, so if Audnexus later learns the runtime the
    // request resumes on its own. Placed BEFORE the Prowlarr search so a held
    // request doesn't hammer the indexers every cycle.
    const holdConfig = await configService.get('audiobook_hold_unknown_runtime');
    const holdUnknownRuntime = holdConfig !== 'false'; // default ON
    if (!durationMinutes && holdUnknownRuntime) {
      const errorMessage =
        'Runtime unknown — held for manual selection (implied bitrate cannot be computed). ' +
        'Pick a release via interactive search, or set audiobook_hold_unknown_runtime=false to allow automatic grabs.';
      logger.warn(`${errorMessage} [request ${requestId}]`);

      await prisma.request.update({
        where: { id: requestId },
        data: {
          status: 'awaiting_search',
          errorMessage,
          lastSearchAt: new Date(),
          updatedAt: new Date(),
        },
      });

      return {
        success: false,
        message: 'Runtime unknown, held for manual selection',
        requestId,
      };
    }

    const indexersConfigStr = await configService.get('prowlarr_indexers');

    if (!indexersConfigStr) {
      throw new Error('No indexers configured. Please configure indexers in settings.');
    }

    const indexersConfig = JSON.parse(indexersConfigStr);

    if (indexersConfig.length === 0) {
      throw new Error('No indexers enabled. Please enable at least one indexer in settings.');
    }

    // Build indexer priorities map (indexerId -> priority 1-25, default 10)
    const indexerPriorities = new Map<number, number>(
      indexersConfig.map((indexer: any) => [indexer.id, indexer.priority ?? 10])
    );

    // Get flag configurations
    const flagConfigStr = await configService.get('indexer_flag_config');
    const flagConfigs = flagConfigStr ? JSON.parse(flagConfigStr) : [];

    // Group indexers by their category configuration
    // This minimizes API calls while ensuring each indexer only searches its configured categories
    const { groups, skippedIndexers } = groupIndexersByCategories(indexersConfig);

    if (skippedIndexers.length > 0) {
      const skippedNames = skippedIndexers.map(idx => idx.name).join(', ');
      logger.info(`Skipping ${skippedIndexers.length} indexer(s) with no audiobook categories: ${skippedNames}`);
    }

    logger.info(`Searching ${indexersConfig.length - skippedIndexers.length} enabled indexers in ${groups.length} group${groups.length > 1 ? 's' : ''}`);

    // Log each group for transparency
    groups.forEach((group, index) => {
      logger.info(`Group ${index + 1}: ${getGroupDescription(group)}`);
    });

    // Get Prowlarr service
    const prowlarr = await getProwlarrService();

    if (requestRecord?.customSearchTerms) {
      logger.info(`Searching with custom terms: "${effectiveSearchTitle}" (original: "${audiobook.title}") by "${audiobook.author}"`);
    } else {
      logger.info(`Searching for: "${audiobook.title}" by "${audiobook.author}"`);
    }

    // Search Prowlarr for each group and combine results
    const allResults = [];

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      logger.info(`Searching group ${i + 1}/${groups.length}: ${getGroupDescription(group)}`);

      try {
        const groupResults = await prowlarr.searchWithVariations(effectiveSearchTitle, audiobook.author, {
          categories: group.categories,
          indexerIds: group.indexerIds,
          minSeeders: 1, // Only torrents with at least 1 seeder
          maxResults: 100, // Limit per group
        });

        logger.info(`Group ${i + 1} returned ${groupResults.length} results`);
        allResults.push(...groupResults);
      } catch (error) {
        logger.error(`Group ${i + 1} search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        // Continue with other groups even if one fails
      }
    }

    const preBlocklistCount = allResults.length;
    const { kept: nonBlocked, blockedCount } = await filterBlockedResults(requestId, allResults);
    if (blockedCount > 0) {
      logger.debug(`Filtered out ${blockedCount} blocklisted release(s) before ranking`);
    }

    // F2(a): drop releases matching a per-indexer title-exclude rule (e.g. MAM [VIP]).
    // Automatic path only — interactive search shows everything and lets the user decide.
    const { kept: searchResults, excluded } = filterExcludedByRules(nonBlocked, flagConfigs);
    if (excluded.length > 0) {
      logger.info(summarizeExcluded(excluded));
    }

    logger.info(`Found ${searchResults.length} total results from ${groups.length} group${groups.length > 1 ? 's' : ''}${blockedCount > 0 ? ` (${blockedCount} blocked)` : ''}${excluded.length > 0 ? ` (${excluded.length} excluded)` : ''}`);

    if (searchResults.length === 0) {
      // No usable results. Distinguish the causes so an admin can tell "my exclude
      // rule / blocklist removed everything" from "the book doesn't exist" (the D2
      // confusion the spec calls out). Exclude takes precedence when it emptied the
      // post-blocklist set — it's the actionable, user-authored cause.
      const allExcluded = excluded.length > 0 && nonBlocked.length > 0;
      const allBlocked = !allExcluded && blockedCount > 0 && preBlocklistCount > 0;
      const errorMessage = allExcluded
        ? `No usable releases — ${excluded.length} candidate(s) matched an exclude rule`
        : allBlocked
          ? `No usable releases — ${preBlocklistCount} candidates tried, all blocked`
          : 'No torrents/nzbs found. Will retry automatically.';

      logger.warn(`${errorMessage} for request ${requestId}, marking as awaiting_search`);

      await prisma.request.update({
        where: { id: requestId },
        data: {
          status: 'awaiting_search',
          errorMessage,
          lastSearchAt: new Date(),
          updatedAt: new Date(),
        },
      });

      return {
        success: false,
        message: (allExcluded || allBlocked) ? errorMessage : 'No torrents/nzbs found, queued for re-search',
        requestId,
      };
    }

    // Log filter info
    const sizeMBThreshold = 20;
    const preFilterCount = searchResults.length;
    const belowThreshold = searchResults.filter(r => (r.size / (1024 * 1024)) < sizeMBThreshold);
    if (belowThreshold.length > 0) {
      logger.info(`Will filter ${belowThreshold.length} results < ${sizeMBThreshold} MB (likely ebooks)`);
    }

    // Get ranking algorithm and language-specific stop words
    const ranker = getRankingAlgorithm();
    const region = await configService.getAudibleRegion() as AudibleRegion;
    const langConfig = getLanguageForRegion(region);

    // Rank results with indexer priorities and flag configs
    // Note: rankTorrents now filters out results < 20 MB internally
    // Use effectiveSearchTitle so custom search terms are respected for ranking
    // requireAuthor: true (default) - strict filtering for automatic selection
    const rankedResults = ranker.rankTorrents(searchResults, {
      title: effectiveSearchTitle,
      author: audiobook.author,
      durationMinutes,
    }, {
      indexerPriorities,
      flagConfigs,
      requireAuthor: true,  // Automatic mode - prevent wrong authors
      stopWords: langConfig.stopWords,
      characterReplacements: langConfig.characterReplacements,
    });

    // Log filter results
    const postFilterCount = rankedResults.length;
    if (postFilterCount < preFilterCount) {
      logger.info(`Filtered out ${preFilterCount - postFilterCount} results < ${sizeMBThreshold} MB`);
    }

    // Dual threshold filtering:
    // 1. Base score must be >= 50 (quality minimum)
    // 2. Final score must be >= 50 (not disqualified by negative bonuses)
    const filteredResults = rankedResults.filter(result =>
      result.score >= 50 && result.finalScore >= 50
    );

    const disqualifiedByNegativeBonus = rankedResults.filter(result =>
      result.score >= 50 && result.finalScore < 50
    ).length;

    logger.info(`Ranked ${rankedResults.length} results, ${filteredResults.length} above threshold (50/100 base + final)`);
    if (disqualifiedByNegativeBonus > 0) {
      logger.info(`${disqualifiedByNegativeBonus} torrents disqualified by negative flag bonuses`);
    }

    if (filteredResults.length === 0) {
      // No quality results found - queue for re-search instead of failing
      logger.warn(`No quality matches found for request ${requestId} (all below 50/100), marking as awaiting_search`);

      await prisma.request.update({
        where: { id: requestId },
        data: {
          status: 'awaiting_search',
          errorMessage: 'No quality matches found. Will retry automatically.',
          lastSearchAt: new Date(),
          updatedAt: new Date(),
        },
      });

      return {
        success: false,
        message: 'No quality matches found, queued for re-search',
        requestId,
      };
    }

    // ============ F1 (D1/D2): optional implied-bitrate floor ============
    // Off unless audiobook_min_implied_kbps is set. When enabled and nothing
    // clears it, FAIL VISIBLY (a floor means a floor — no best-effort grabs);
    // the normal re-search cadence retries. Runtime-unknown books never reach
    // here when the hold is on; if the hold is off, the floor is skipped for
    // them (nothing to measure).
    const floorConfigStr = await configService.get('audiobook_min_implied_kbps');
    const minImpliedKbps = floorConfigStr ? parseInt(floorConfigStr, 10) : 0;
    let selectableResults = filteredResults;

    if (minImpliedKbps > 0 && durationMinutes) {
      selectableResults = filteredResults.filter((result) => {
        const kbps = impliedKbps(result.size, durationMinutes);
        return kbps === null || kbps >= minImpliedKbps;
      });

      const dropped = filteredResults.length - selectableResults.length;
      if (dropped > 0) {
        logger.info(`Bitrate floor ${minImpliedKbps} kbps: excluded ${dropped} release(s) below it`);
      }

      if (selectableResults.length === 0) {
        const bestKbps = Math.max(
          ...filteredResults.map((result) => impliedKbps(result.size, durationMinutes) ?? 0)
        );
        const errorMessage =
          `No release met the bitrate floor (${minImpliedKbps} kbps implied) — ` +
          `best candidate ~${bestKbps} kbps. Will retry automatically; ` +
          `pick manually via interactive search or lower audiobook_min_implied_kbps.`;

        logger.warn(`${errorMessage} [request ${requestId}]`);

        await prisma.request.update({
          where: { id: requestId },
          data: {
            status: 'awaiting_search',
            errorMessage,
            lastSearchAt: new Date(),
            updatedAt: new Date(),
          },
        });

        return {
          success: false,
          message: 'No release met the bitrate floor, queued for re-search',
          requestId,
        };
      }
    }

    // ============ F3: strict indexer tiers ============
    // Optional per-indexer `tier` in prowlarr_indexers: every candidate from a
    // lower-numbered tier is taken before ANY candidate from a later tier;
    // scoring only orders candidates WITHIN a tier ("use ABB if it has it at
    // all, otherwise MAM"). Untiered indexers act as the last tier. No tiers
    // configured → weighted behaviour, untouched. Runs AFTER the bitrate floor
    // so a floor miss in tier 1 correctly falls through to tier 2.
    const tierMap = buildTierMap(indexersConfig);
    const tierSelection = selectTopTier(selectableResults, tierMap);
    if (tierSelection.deferred > 0) {
      logger.info(
        `Indexer tiers: tier ${tierSelection.tier} wins — ${tierSelection.deferred} candidate(s) from later tiers deferred`
      );
    }
    selectableResults = tierSelection.selected;

    // Select best result
    const bestResult = selectableResults[0];

    // Log top 3 results with detailed breakdown
    const top3 = selectableResults.slice(0, 3);
    logger.info(`==================== RANKING DEBUG ====================`);
    logger.info(`Ranking Title: "${effectiveSearchTitle}"${effectiveSearchTitle !== audiobook.title ? ` (audiobook: "${audiobook.title}")` : ''}`);
    logger.info(`Requested Author: "${audiobook.author}"`);
    logger.info(`Top ${top3.length} results (out of ${selectableResults.length} selectable${minImpliedKbps > 0 ? `, floor ${minImpliedKbps} kbps` : ''}):`);
    logger.info(`--------------------------------------------------------`);
    for (let i = 0; i < top3.length; i++) {
      const result = top3[i];
      const sizeMB = (result.size / (1024 * 1024)).toFixed(1);
      const mbPerMin = durationMinutes ? ((result.size / (1024 * 1024)) / durationMinutes).toFixed(2) : 'N/A';

      logger.info(`${i + 1}. "${result.title}"`);
      logger.info(`   Indexer: ${result.indexer}${result.indexerId ? ` (ID: ${result.indexerId})` : ''}`);
      logger.info(``);
      logger.info(`   Base Score: ${result.score.toFixed(1)}/100`);
      logger.info(`   - Title/Author Match: ${result.breakdown.matchScore.toFixed(1)}/60`);
      logger.info(`   - Format Quality: ${result.breakdown.formatScore.toFixed(1)}/10 (${result.format || 'unknown'})`);
      logger.info(`   - Size Quality: ${durationMinutes ? `${result.breakdown.sizeScore.toFixed(1)}/15 (${sizeMB} MB, ${mbPerMin} MB/min, ${durationMinutes} min runtime)` : 'N/A (no runtime data)'}`);
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
        logger.info(`--------------------------------------------------------`);
      }
    }
    logger.info(`========================================================`);
    logger.info(`Selected best result: ${bestResult.title} (final score: ${bestResult.finalScore.toFixed(1)})`);

    // Trigger download job with best result
    const jobQueue = getJobQueueService();
    await jobQueue.addDownloadJob(requestId, {
      id: audiobook.id,
      title: audiobook.title,
      author: audiobook.author,
    }, bestResult);

    return {
      success: true,
      message: `Found ${selectableResults.length} quality matches, selected best torrent`,
      requestId,
      resultsCount: selectableResults.length,
      selectedTorrent: {
        title: bestResult.title,
        score: bestResult.score,
        seeders: bestResult.seeders || 0,
        format: bestResult.format,
      },
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);

    await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error during search',
        updatedAt: new Date(),
      },
    });

    throw error;
  }
}
