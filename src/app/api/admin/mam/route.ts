/**
 * Component: MAM Account API Route (F7)
 * Documentation: RMAB2-SPEC.md § F7
 *
 * GET  → account standing + the [VIP] exclude-rule state (present / recommended).
 * POST → one-click reconcile of the rule, or set the "VIP until" override.
 * Admin-only. Reads the MAM session from Prowlarr (see [[mam.service]]).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getConfigService } from '@/lib/services/config.service';
import {
  getMamAccountStatus,
  getMamIndexerRef,
  VIP_PURCHASE_ENDPOINT_VERIFIED,
  VIP_COST_PER_4_WEEKS,
} from '@/lib/integrations/mam.service';
import {
  hasMamVipRule,
  withMamVipRule,
  withoutMamVipRule,
  shouldExcludeVip,
} from '@/lib/utils/mam-vip-rule';
import type { IndexerFlagConfig } from '@/lib/utils/ranking-algorithm';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.MAM');

async function readFlagConfigs(): Promise<IndexerFlagConfig[]> {
  const raw = await getConfigService().get('indexer_flag_config');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeFlagConfigs(configs: IndexerFlagConfig[]): Promise<void> {
  await getConfigService().setMany([
    {
      key: 'indexer_flag_config',
      value: JSON.stringify(configs),
      category: 'indexer',
      description: 'Indexer flag bonus/penalty configuration',
    },
  ]);
}

/** Assemble the panel bundle: account status + rule state.
 *  VIP-active comes straight from the account's CLASS (per the MAM FAQ, VIP is a
 *  member class that reverts when it lapses) — no separate stored override. */
async function buildBundle() {
  const account = await getMamAccountStatus();

  const flagConfigs = await readFlagConfigs();
  const present =
    account.indexerId != null ? hasMamVipRule(flagConfigs, account.indexerId) : false;
  // Only recommend on a real reading: if the status fetch failed, recommend the
  // status quo (never advise dropping the rule on missing data).
  const recommendedPresent = account.ok ? shouldExcludeVip(!!account.vipActive) : present;

  // F7 L3: auto-VIP settings + attempt state for the panel card.
  const configService = getConfigService();
  const autoCfg = await configService.getMany([
    'mam_auto_vip_enabled',
    'mam_auto_vip_dry_run',
    'mam_auto_vip_duration_weeks',
    'mam_auto_vip_reserve_points',
    'mam_auto_vip_state',
  ]);
  let autoState: Record<string, unknown> = {};
  try {
    autoState = autoCfg.mam_auto_vip_state ? JSON.parse(autoCfg.mam_auto_vip_state) : {};
  } catch {
    autoState = {};
  }

  return {
    account,
    vipRule: {
      present,
      recommendedPresent,
      inSync: present === recommendedPresent,
      vipActive: !!account.vipActive,
    },
    autoVip: {
      enabled: autoCfg.mam_auto_vip_enabled === 'true',
      dryRun: autoCfg.mam_auto_vip_dry_run !== 'false', // default TRUE
      durationWeeks: [8, 12].includes(parseInt(autoCfg.mam_auto_vip_duration_weeks ?? '', 10))
        ? parseInt(autoCfg.mam_auto_vip_duration_weeks as string, 10)
        : 4,
      reservePoints:
        autoCfg.mam_auto_vip_reserve_points != null && autoCfg.mam_auto_vip_reserve_points !== ''
          ? Math.max(0, parseInt(autoCfg.mam_auto_vip_reserve_points, 10) || 0)
          : 2000,
      costPer4Weeks: VIP_COST_PER_4_WEEKS,
      endpointVerified: VIP_PURCHASE_ENDPOINT_VERIFIED,
      state: autoState,
    },
  };
}

export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) =>
    requireAdmin(req, async () => {
      try {
        return NextResponse.json({ success: true, ...(await buildBundle()) });
      } catch (error) {
        logger.error('Failed to build MAM bundle', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json(
          { success: false, error: 'Failed to read MAM account status' },
          { status: 500 },
        );
      }
    }),
  );
}

export async function POST(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) =>
    requireAdmin(req, async () => {
      try {
        const body = await request.json();
        const action = body?.action;

        if (action === 'apply-vip-rule') {
          const present = !!body.present;
          const ref = await getMamIndexerRef();
          if (!ref) {
            return NextResponse.json(
              { success: false, error: 'No MyAnonamouse indexer is configured in Prowlarr.' },
              { status: 400 },
            );
          }
          const current = await readFlagConfigs();
          const next = present
            ? withMamVipRule(current, ref.id)
            : withoutMamVipRule(current, ref.id);
          await writeFlagConfigs(next);
          logger.info(`MAM [VIP] exclude rule ${present ? 'enabled' : 'disabled'} for indexer ${ref.id}`);
          return NextResponse.json({ success: true, ...(await buildBundle()) });
        }

        if (action === 'set-auto-vip') {
          const updates: Array<{ key: string; value: string; category: string; description: string }> = [];
          const push = (key: string, value: string, description: string) =>
            updates.push({ key, value, category: 'indexer', description });

          if (typeof body.enabled === 'boolean') {
            push('mam_auto_vip_enabled', String(body.enabled), 'MAM auto-VIP purchase (opt-in)');
            // Re-arming clears the failure breaker so the feature can run again.
            if (body.enabled) {
              push('mam_auto_vip_state', '{}', 'MAM auto-VIP attempt history (cooldown + failure breaker)');
            }
          }
          if (typeof body.dryRun === 'boolean') {
            push('mam_auto_vip_dry_run', String(body.dryRun), 'MAM auto-VIP dry-run mode (log only, never spend)');
          }
          if (body.durationWeeks !== undefined) {
            const weeks = parseInt(String(body.durationWeeks), 10);
            if (![4, 8, 12].includes(weeks)) {
              return NextResponse.json({ success: false, error: 'durationWeeks must be 4, 8 or 12.' }, { status: 400 });
            }
            push('mam_auto_vip_duration_weeks', String(weeks), 'MAM auto-VIP purchase duration (weeks)');
          }
          if (body.reservePoints !== undefined) {
            const reserve = parseInt(String(body.reservePoints), 10);
            if (Number.isNaN(reserve) || reserve < 0) {
              return NextResponse.json({ success: false, error: 'reservePoints must be a non-negative integer.' }, { status: 400 });
            }
            push('mam_auto_vip_reserve_points', String(reserve), 'MAM auto-VIP: bonus points to keep untouched');
          }

          if (updates.length === 0) {
            return NextResponse.json({ success: false, error: 'No auto-VIP fields to update.' }, { status: 400 });
          }
          await getConfigService().setMany(updates);
          logger.info(`Auto-VIP settings updated: ${updates.map((u) => `${u.key}=${u.value}`).join(', ')}`);
          return NextResponse.json({ success: true, ...(await buildBundle()) });
        }

        return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
      } catch (error) {
        logger.error('MAM action failed', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ success: false, error: 'MAM action failed' }, { status: 500 });
      }
    }),
  );
}
