/**
 * Component: MAM Auto-VIP Job Processor (F7 L3)
 * Documentation: RMAB2-SPEC.md § F7 (I1–I5)
 *
 * Hourly, opt-in automation: keep MAM VIP bought while bonus points allow, and keep
 * the F2(a) `[VIP]` exclude rule in sync with the account's actual VIP class (I3 —
 * auto-apply is the ratified behaviour WHEN auto-VIP is enabled; with it disabled
 * the panel stays advise + one-click).
 *
 * This is the first feature that SPENDS an account resource instead of selecting
 * releases, so it is preconditions-first: every run must pass ALL gates or it
 * no-ops with a logged reason. Two independent guards protect the wallet:
 *   1. `mam_auto_vip_dry_run` (config, default TRUE) — logs what it WOULD buy.
 *   2. [[VIP_PURCHASE_ENDPOINT_VERIFIED]] (code, currently false) — purchaseVip()
 *      refuses until the endpoint shape is captured from a real purchase (I4).
 * Plus: 24 h attempt cooldown (spend path only — dry-runs don't consume it),
 * single attempt per run, and a 3-consecutive-failure breaker that disables the
 * feature and surfaces a warning in the panel.
 */

import { getConfigService } from '../services/config.service';
import {
  getMamAccountStatus,
  purchaseVip,
  MamAccountStatus,
  VIP_COST_PER_4_WEEKS,
  VipPurchaseWeeks,
} from '../integrations/mam.service';
import {
  hasMamVipRule,
  shouldExcludeVip,
  withMamVipRule,
  withoutMamVipRule,
} from '../utils/mam-vip-rule';
import type { IndexerFlagConfig } from '../utils/ranking-algorithm';
import { RMABLogger } from '../utils/logger';

export interface MamAutoVipPayload {
  jobId?: string;
  scheduledJobId?: string;
}

export interface MamAutoVipState {
  lastAttemptTs?: number;      // last LIVE spend attempt (success or failure) — owns the cooldown
  lastAttemptResult?: 'success' | 'failure';
  lastAttemptDetail?: string;
  lastDryRunTs?: number;       // dry-runs are recorded but never consume the cooldown
  lastDryRunDetail?: string;
  consecutiveFailures?: number;
}

const ATTEMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BREAKER_LIMIT = 3;

function parseState(raw: string | null): MamAutoVipState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function parseFlagConfigs(raw: string | null): IndexerFlagConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clampWeeks(raw: string | null): VipPurchaseWeeks {
  const n = raw ? parseInt(raw, 10) : 4;
  return n === 8 || n === 12 ? n : 4;
}

/**
 * I3 (ratified): while auto-VIP is enabled, keep the F2(a) [VIP] exclude rule in
 * sync with the account's real VIP class — add it when VIP is not active, remove it
 * while it is. Every change is logged; no-ops when already in sync.
 */
async function reconcileVipRule(
  status: MamAccountStatus,
  logger: ReturnType<typeof RMABLogger.forJob>
): Promise<void> {
  if (status.indexerId == null) return;
  const configService = getConfigService();
  const current = parseFlagConfigs(await configService.get('indexer_flag_config'));
  const present = hasMamVipRule(current, status.indexerId);
  const wanted = shouldExcludeVip(!!status.vipActive);
  if (present === wanted) return;

  const next = wanted
    ? withMamVipRule(current, status.indexerId)
    : withoutMamVipRule(current, status.indexerId);
  await configService.setMany([
    {
      key: 'indexer_flag_config',
      value: JSON.stringify(next),
      category: 'indexer',
      description: 'Indexer flag bonus/penalty configuration',
    },
  ]);
  logger.info(
    `[VIP] exclude rule auto-${wanted ? 'enabled' : 'disabled'} (class "${status.className}", vipActive=${!!status.vipActive}) — auto-VIP mode owns this rule`
  );
}

async function saveState(state: MamAutoVipState): Promise<void> {
  await getConfigService().setMany([
    {
      key: 'mam_auto_vip_state',
      value: JSON.stringify(state),
      category: 'indexer',
      description: 'MAM auto-VIP attempt history (cooldown + failure breaker)',
    },
  ]);
}

export interface MamAutoVipResult {
  success: boolean;
  action:
    | 'disabled'
    | 'breaker-disabled'
    | 'status-unavailable'
    | 'already-vip'
    | 'requires-power-user'
    | 'insufficient-points'
    | 'cooldown'
    | 'dry_run'
    | 'purchase-failed'
    | 'purchased'
    | 'purchase-unverified';
  detail?: string;
  error?: string;
  points?: number;
  cost?: number;
  reserve?: number;
}

export async function processMamAutoVip(payload: MamAutoVipPayload): Promise<MamAutoVipResult> {
  const logger = RMABLogger.forJob(payload.jobId, 'MamAutoVip');
  const configService = getConfigService();

  // Gate 1: feature enabled at all?
  const enabled = (await configService.get('mam_auto_vip_enabled')) === 'true';
  if (!enabled) {
    return { success: true, action: 'disabled' };
  }

  const state = parseState(await configService.get('mam_auto_vip_state'));

  // Gate 2: failure breaker — 3 consecutive live failures disables the feature.
  if ((state.consecutiveFailures ?? 0) >= BREAKER_LIMIT) {
    logger.warn(
      `Auto-VIP breaker tripped (${state.consecutiveFailures} consecutive failures) — disabling. Re-enable in the MAM panel after investigating.`
    );
    await configService.setMany([
      {
        key: 'mam_auto_vip_enabled',
        value: 'false',
        category: 'indexer',
        description: 'MAM auto-VIP purchase (opt-in)',
      },
    ]);
    return { success: false, action: 'breaker-disabled' };
  }

  // Gate 3: a real account reading — never act on missing data. A failed fetch is
  // NOT a breaker failure (network blips must not disable the feature).
  const status = await getMamAccountStatus();
  if (!status.ok) {
    logger.warn(`MAM status unavailable (${status.error}) — skipping this run`);
    return { success: true, action: 'status-unavailable' };
  }

  // I3: rule reconciliation runs on every enabled pass, independent of purchasing.
  await reconcileVipRule(status, logger);

  // Gate 4: nothing to buy while VIP is active (v1 buys no top-ups — I1).
  if (status.vipActive) {
    return { success: true, action: 'already-vip' };
  }

  // Gate 5: the points path requires Power User exactly (store: "Requires rank of
  // Power user or VIP"). Anything else (User, Elite, staff, unknown) → not armable.
  const isPowerUser = (status.className ?? '').trim().toLowerCase() === 'power user';
  if (!isPowerUser) {
    logger.info(`Not armable: class "${status.className}" (requires Power User) — no-op`);
    return { success: true, action: 'requires-power-user' };
  }

  // Gate 6: affordability with reserve.
  const weeks = clampWeeks(await configService.get('mam_auto_vip_duration_weeks'));
  const cost = (VIP_COST_PER_4_WEEKS * weeks) / 4;
  const reserveRaw = await configService.get('mam_auto_vip_reserve_points');
  const reserve = reserveRaw != null && reserveRaw !== '' ? Math.max(0, parseInt(reserveRaw, 10) || 0) : 2000;
  const points = status.seedbonus ?? 0;
  if (points < cost + reserve) {
    logger.info(`Insufficient points: ${points} < ${cost} (cost ${weeks}wk) + ${reserve} (reserve) — no-op`);
    return { success: true, action: 'insufficient-points', points, cost, reserve };
  }

  // Gate 7: spend cooldown — one live attempt per 24 h, success OR failure.
  const now = Date.now();
  if (state.lastAttemptTs && now - state.lastAttemptTs < ATTEMPT_COOLDOWN_MS) {
    return { success: true, action: 'cooldown' };
  }

  // Gate 8: dry-run (default ON) — log the exact spend, touch nothing.
  const dryRun = (await configService.get('mam_auto_vip_dry_run')) !== 'false';
  if (dryRun) {
    const detail = `WOULD buy ${weeks} weeks of VIP for ${cost} points (points ${points} → ${points - cost}, reserve ${reserve})`;
    logger.info(`[DRY RUN] ${detail}`);
    await saveState({ ...state, lastDryRunTs: now, lastDryRunDetail: detail });
    return { success: true, action: 'dry_run', detail };
  }

  // LIVE purchase — single attempt; purchaseVip() itself still refuses until the
  // endpoint is verified (I4), which lands here as a normal failure.
  logger.info(`Attempting VIP purchase: ${weeks} weeks for ${cost} points (points ${points})`);
  const result = await purchaseVip(weeks);

  if (!result.ok) {
    const failures = (state.consecutiveFailures ?? 0) + 1;
    logger.error(`VIP purchase failed (${failures}/${BREAKER_LIMIT}): ${result.error}`);
    await saveState({
      ...state,
      lastAttemptTs: now,
      lastAttemptResult: 'failure',
      lastAttemptDetail: result.error,
      consecutiveFailures: failures,
    });
    return { success: false, action: 'purchase-failed', error: result.error };
  }

  // Post-verify: the purchase proof is the points drop on a fresh reading. The
  // class flip to VIP may lag; later runs (and the rule reconciler) pick it up.
  const after = await getMamAccountStatus();
  const pointsAfter = after.ok ? after.seedbonus ?? null : null;
  const dropped = pointsAfter != null ? points - pointsAfter : null;
  const verified = dropped != null && dropped >= cost * 0.9; // tolerate concurrent BP accrual
  const detail = `bought ${weeks} weeks for ${cost}; points ${points} → ${pointsAfter ?? '?'}${verified ? '' : ' (drop NOT confirmed — check manually)'}`;

  if (verified) {
    logger.info(`VIP purchase verified: ${detail}`);
  } else {
    logger.warn(`VIP purchase response ok but unverified: ${detail}`);
  }

  await saveState({
    ...state,
    lastAttemptTs: now,
    lastAttemptResult: verified ? 'success' : 'failure',
    lastAttemptDetail: detail,
    consecutiveFailures: verified ? 0 : (state.consecutiveFailures ?? 0) + 1,
  });

  if (after.ok) {
    await reconcileVipRule(after, logger);
  }

  return { success: verified, action: verified ? 'purchased' : 'purchase-unverified', detail };
}
