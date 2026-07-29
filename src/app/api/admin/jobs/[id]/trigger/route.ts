/**
 * Component: Admin Job Trigger API
 * Documentation: documentation/backend/services/scheduler.md
 *
 * B3: see the note in ../../route.ts — this endpoint hand-rolled auth and so
 * skipped requireAuth's post-verification (user deleted, session revoked), while
 * also returning non-standard error shapes that the admin UI could not surface.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getSchedulerService } from '@/lib/services/scheduler.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.JobTrigger');

/**
 * POST /api/admin/jobs/:id/trigger
 * Manually trigger a scheduled job
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) =>
    requireAdmin(req, async () => {
      try {
        const { id } = await params;

        logger.info(`Triggering scheduled job: ${id}`);

        const schedulerService = getSchedulerService();
        const jobId = await schedulerService.triggerJobNow(id);

        logger.info(`Job triggered successfully, database job ID: ${jobId}`);

        return NextResponse.json({
          success: true,
          jobId,
          message: 'Job triggered successfully',
        });
      } catch (error) {
        logger.error('Failed to trigger job', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json(
          {
            error: 'InternalError',
            message: error instanceof Error ? error.message : 'Failed to trigger job',
          },
          { status: 500 }
        );
      }
    })
  );
}
