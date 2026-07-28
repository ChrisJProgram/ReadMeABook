/**
 * Component: MAM VIP exclude-rule helpers (F7 / L2)
 * Documentation: documentation/phase3/ranking-algorithm.md
 *
 * The canonical shape of the F2(a) exclude rule that drops MyAnonamouse `[VIP]`
 * releases, plus pure add/remove/recognise helpers so the MAM account panel can
 * reconcile `indexer_flag_config` without duplicating the rule's structure.
 *
 * "Recommended present" is the class-gated decision (see [[F7]]): keep the rule
 * unless the account can actually fetch `[VIP]` — i.e. it is VIP-eligible by class
 * AND has active VIP. Everything else keeps the rule (the safe default).
 */

import type { IndexerFlagConfig } from '@/lib/utils/ranking-algorithm';

/** Case-insensitive regex (as stored/escaped in JSON) matching MAM's `[VIP]` title token. */
export const MAM_VIP_PATTERN = '\\[VIP\\]';
export const MAM_VIP_LABEL = 'MAM VIP';

/** The exclude entry F7 manages, scoped to the given MAM Prowlarr indexer id. */
export function makeMamVipRule(mamIndexerId: number): IndexerFlagConfig {
  return {
    name: MAM_VIP_LABEL,
    modifier: 0,
    action: 'exclude',
    pattern: MAM_VIP_PATTERN,
    indexerId: mamIndexerId,
  };
}

/**
 * Recognise the MAM VIP entry: an exclude rule scoped to the MAM indexer whose
 * pattern targets VIP. Tolerant of minor hand-edits to the label/pattern (matches
 * any exclude rule on that indexer mentioning "vip") so we never leave a duplicate.
 */
export function isMamVipRule(cfg: IndexerFlagConfig, mamIndexerId: number): boolean {
  return (
    cfg.action === 'exclude' &&
    cfg.indexerId === mamIndexerId &&
    !!cfg.pattern &&
    /vip/i.test(cfg.pattern)
  );
}

export function hasMamVipRule(configs: IndexerFlagConfig[], mamIndexerId: number): boolean {
  return configs.some((c) => isMamVipRule(c, mamIndexerId));
}

/** Add the rule if absent (idempotent — never creates a duplicate). */
export function withMamVipRule(configs: IndexerFlagConfig[], mamIndexerId: number): IndexerFlagConfig[] {
  if (hasMamVipRule(configs, mamIndexerId)) return configs;
  return [...configs, makeMamVipRule(mamIndexerId)];
}

/** Remove every MAM VIP entry for this indexer (idempotent). */
export function withoutMamVipRule(configs: IndexerFlagConfig[], mamIndexerId: number): IndexerFlagConfig[] {
  return configs.filter((c) => !isMamVipRule(c, mamIndexerId));
}

/**
 * Should the `[VIP]` exclude rule be present?
 *
 * PRESENT unless VIP is currently active. Per the MAM FAQ, VIP is itself a member
 * CLASS ("VIP: Can be bought with bonus points or donations. VIP members have …
 * special VIP freeleech torrents"), so `classname` reports it directly and reverts
 * when VIP lapses — no separate eligibility signal is needed (donations can grant
 * VIP without Power User).
 */
export function shouldExcludeVip(vipActive: boolean): boolean {
  return !vipActive;
}
