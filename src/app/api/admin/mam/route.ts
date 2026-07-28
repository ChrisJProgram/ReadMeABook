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
import { getMamAccountStatus, getMamIndexerRef } from '@/lib/integrations/mam.service';
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

/** Assemble the panel bundle: account status + rule/VIP state. */
async function buildBundle() {
  const account = await getMamAccountStatus();
  const configService = getConfigService();

  const vipUntil = (await configService.get('mam_vip_until')) || null;
  const vipActive = !!vipUntil && !Number.isNaN(Date.parse(vipUntil)) && new Date(vipUntil) > new Date();

  const flagConfigs = await readFlagConfigs();
  const present =
    account.indexerId != null ? hasMamVipRule(flagConfigs, account.indexerId) : false;
  const recommendedPresent = shouldExcludeVip(!!account.vipPossible, vipActive);

  return {
    account,
    vipRule: {
      present,
      recommendedPresent,
      inSync: present === recommendedPresent,
      vipUntil,
      vipActive,
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

        if (action === 'set-vip-until') {
          const until = body.until;
          if (until != null && until !== '' && Number.isNaN(Date.parse(String(until)))) {
            return NextResponse.json({ success: false, error: 'Invalid date.' }, { status: 400 });
          }
          await getConfigService().setMany([
            {
              key: 'mam_vip_until',
              value: until == null ? '' : String(until),
              category: 'indexer',
              description: 'MAM VIP expiry (personal freeleech); lifts the [VIP] exclude rule while active',
            },
          ]);
          logger.info(`MAM VIP-until set to "${until ?? ''}"`);
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
