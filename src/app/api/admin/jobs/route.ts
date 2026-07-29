/**
 * Component: Admin Jobs Management API
 * Documentation: documentation/backend/services/scheduler.md
 *
 * B3: these routes previously hand-rolled auth (raw verifyAccessToken on a
 * `.replace('Bearer ', '')` header). That skipped everything requireAuth does
 * after signature verification — the user-still-exists/not-soft-deleted check and
 * the sessionsInvalidatedAt revocation check — so a deleted or logged-out admin's
 * unexpired token still drove the scheduler, and a malformed Authorization header
 * was forwarded as a token instead of being rejected. Now routed through the same
 * middleware as every other admin endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getSchedulerService } from '@/lib/services/scheduler.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.Jobs');

/**
 * GET /api/admin/jobs
 * Get all scheduled jobs
 */
export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) =>
    requireAdmin(req, async () => {
      try {
        const schedulerService = getSchedulerService();
        const jobs = await schedulerService.getScheduledJobs();

        return NextResponse.json({
          jobs,
        });
      } catch (error) {
        logger.error('Failed to get scheduled jobs', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json(
          {
            error: 'InternalError',
            message: 'Failed to retrieve scheduled jobs',
          },
          { status: 500 }
        );
      }
    })
  );
}

/**
 * POST /api/admin/jobs
 * Create a new scheduled job
 */
export async function POST(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) =>
    requireAdmin(req, async () => {
      try {
        const body = await req.json();
        const schedulerService = getSchedulerService();

        const job = await schedulerService.createScheduledJob({
          name: body.name,
          type: body.type,
          schedule: body.schedule,
          enabled: body.enabled,
          payload: body.payload,
        });

        return NextResponse.json({
          job,
        });
      } catch (error) {
        logger.error('Failed to create scheduled job', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json(
          {
            error: 'InternalError',
            message: error instanceof Error ? error.message : 'Failed to create scheduled job',
          },
          { status: 500 }
        );
      }
    })
  );
}
