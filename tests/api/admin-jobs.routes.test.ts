/**
 * Component: Admin Jobs API Route Tests
 * Documentation: documentation/testing.md
 *
 * B3: these routes used to hand-roll auth (raw verifyAccessToken on the header),
 * which skipped requireAuth's user-deleted and session-revoked checks. They now
 * go through the shared middleware like every other admin endpoint, so these
 * tests mock requireAuth/requireAdmin (the house pattern) and assert the routes
 * actually delegate to them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let authRequest: any;

const requireAuthMock = vi.hoisted(() => vi.fn());
const requireAdminMock = vi.hoisted(() => vi.fn());
const schedulerMock = vi.hoisted(() => ({
  getScheduledJobs: vi.fn(),
  createScheduledJob: vi.fn(),
  updateScheduledJob: vi.fn(),
  deleteScheduledJob: vi.fn(),
  triggerJobNow: vi.fn(),
}));

vi.mock('@/lib/middleware/auth', () => ({
  requireAuth: requireAuthMock,
  requireAdmin: requireAdminMock,
}));

vi.mock('@/lib/services/scheduler.service', () => ({
  getSchedulerService: () => schedulerMock,
}));

const makeRequest = (body?: any) => ({
  headers: { get: () => null },
  json: vi.fn().mockResolvedValue(body || {}),
});

/** Simulate the middleware rejecting (unauthenticated / non-admin / revoked). */
const rejectAuthWith = (status: number, error: string) =>
  requireAuthMock.mockImplementation(async () =>
    new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })
  );
const rejectAdminWith = (status: number, error: string) =>
  requireAdminMock.mockImplementation(async () =>
    new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })
  );

describe('Admin jobs routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRequest = { user: { id: 'admin-1', role: 'admin' }, json: vi.fn().mockResolvedValue({}) };
    requireAuthMock.mockImplementation((_req: any, handler: any) => handler(authRequest));
    requireAdminMock.mockImplementation((_req: any, handler: any) => handler());
  });

  // ---------- B3 regression: the routes must go THROUGH the middleware ----------

  it('every job route delegates to requireAuth + requireAdmin (B3)', async () => {
    schedulerMock.getScheduledJobs.mockResolvedValue([]);
    schedulerMock.triggerJobNow.mockResolvedValue('job-x');
    schedulerMock.updateScheduledJob.mockResolvedValue({});
    schedulerMock.deleteScheduledJob.mockResolvedValue(undefined);

    const { GET, POST } = await import('@/app/api/admin/jobs/route');
    const { PUT, DELETE } = await import('@/app/api/admin/jobs/[id]/route');
    const { POST: TRIGGER } = await import('@/app/api/admin/jobs/[id]/trigger/route');
    const params = { params: Promise.resolve({ id: 'job-1' }) };

    await GET(makeRequest() as any);
    await POST(makeRequest({ name: 'J', type: 't', schedule: '* * * * *' }) as any);
    await PUT(makeRequest({ name: 'J' }) as any, params);
    await DELETE(makeRequest() as any, params);
    await TRIGGER(makeRequest() as any, params);

    // 5 endpoints, each gated by BOTH middlewares — this is what closes the
    // session-revocation and deleted-user holes the hand-rolled checks missed.
    expect(requireAuthMock).toHaveBeenCalledTimes(5);
    expect(requireAdminMock).toHaveBeenCalledTimes(5);
  });

  it('a revoked session blocks Trigger Now before the scheduler is touched (B3)', async () => {
    rejectAuthWith(401, 'Unauthorized');
    const { POST: TRIGGER } = await import('@/app/api/admin/jobs/[id]/trigger/route');

    const response = await TRIGGER(makeRequest() as any, { params: Promise.resolve({ id: 'job-1' }) });

    expect(response.status).toBe(401);
    expect(schedulerMock.triggerJobNow).not.toHaveBeenCalled();
  });

  it('a non-admin cannot trigger jobs (B3)', async () => {
    rejectAdminWith(403, 'Forbidden');
    const { POST: TRIGGER } = await import('@/app/api/admin/jobs/[id]/trigger/route');

    const response = await TRIGGER(makeRequest() as any, { params: Promise.resolve({ id: 'job-1' }) });

    expect(response.status).toBe(403);
    expect(schedulerMock.triggerJobNow).not.toHaveBeenCalled();
  });

  // ---------- behaviour ----------

  it('lists scheduled jobs', async () => {
    schedulerMock.getScheduledJobs.mockResolvedValue([{ id: 'job-1' }]);
    const { GET } = await import('@/app/api/admin/jobs/route');

    const response = await GET(makeRequest() as any);
    const payload = await response.json();

    expect(payload.jobs).toHaveLength(1);
  });

  it('returns 500 when job list fails', async () => {
    schedulerMock.getScheduledJobs.mockRejectedValue(new Error('boom'));
    const { GET } = await import('@/app/api/admin/jobs/route');
    const response = await GET(makeRequest() as any);
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toBe('InternalError');
  });

  it('creates a scheduled job', async () => {
    schedulerMock.createScheduledJob.mockResolvedValue({ id: 'job-2' });
    authRequest.json.mockResolvedValue({ name: 'Job', type: 'type', schedule: '* * * * *' });
    const { POST } = await import('@/app/api/admin/jobs/route');

    const response = await POST(makeRequest() as any);
    const payload = await response.json();

    expect(payload.job.id).toBe('job-2');
    expect(schedulerMock.createScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Job', schedule: '* * * * *' })
    );
  });

  it('returns 500 when job creation fails', async () => {
    schedulerMock.createScheduledJob.mockRejectedValue(new Error('create failed'));
    const { POST } = await import('@/app/api/admin/jobs/route');
    const response = await POST(makeRequest() as any);
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.message).toMatch(/create failed/);
  });

  it('updates a scheduled job', async () => {
    schedulerMock.updateScheduledJob.mockResolvedValue({ id: 'job-3' });
    authRequest.json.mockResolvedValue({ name: 'Job' });
    const { PUT } = await import('@/app/api/admin/jobs/[id]/route');

    const response = await PUT(makeRequest() as any, { params: Promise.resolve({ id: 'job-3' }) });
    const payload = await response.json();

    expect(payload.success).toBe(true);
    expect(schedulerMock.updateScheduledJob).toHaveBeenCalledWith('job-3', expect.objectContaining({ name: 'Job' }));
  });

  it('returns 500 when job update fails', async () => {
    schedulerMock.updateScheduledJob.mockRejectedValue(new Error('update failed'));
    const { PUT } = await import('@/app/api/admin/jobs/[id]/route');
    const response = await PUT(makeRequest() as any, { params: Promise.resolve({ id: 'job-3' }) });
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.message).toMatch(/update failed/);
  });

  it('deletes a scheduled job', async () => {
    schedulerMock.deleteScheduledJob.mockResolvedValue(undefined);
    const { DELETE } = await import('@/app/api/admin/jobs/[id]/route');

    const response = await DELETE(makeRequest() as any, { params: Promise.resolve({ id: 'job-4' }) });
    const payload = await response.json();

    expect(payload.success).toBe(true);
    expect(schedulerMock.deleteScheduledJob).toHaveBeenCalledWith('job-4');
  });

  it('returns 500 when job deletion fails', async () => {
    schedulerMock.deleteScheduledJob.mockRejectedValue(new Error('delete failed'));
    const { DELETE } = await import('@/app/api/admin/jobs/[id]/route');
    const response = await DELETE(makeRequest() as any, { params: Promise.resolve({ id: 'job-4' }) });
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.message).toMatch(/delete failed/);
  });

  it('triggers a scheduled job', async () => {
    schedulerMock.triggerJobNow.mockResolvedValue('job-5');
    const { POST } = await import('@/app/api/admin/jobs/[id]/trigger/route');

    const response = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'job-5' }) });
    const payload = await response.json();

    expect(payload.jobId).toBe('job-5');
    expect(schedulerMock.triggerJobNow).toHaveBeenCalledWith('job-5');
  });

  it('surfaces a trigger failure as 500 with the reason (never a silent no-op)', async () => {
    schedulerMock.triggerJobNow.mockRejectedValue(new Error('Unknown job type: bogus'));
    const { POST } = await import('@/app/api/admin/jobs/[id]/trigger/route');

    const response = await POST(makeRequest() as any, { params: Promise.resolve({ id: 'job-6' }) });
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.message).toMatch(/Unknown job type/);
  });
});
