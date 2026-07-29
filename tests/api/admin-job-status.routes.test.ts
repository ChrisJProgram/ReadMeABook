/**
 * Component: Admin Job Status API Route Tests
 * Documentation: documentation/testing.md
 *
 * B3: converted from hand-rolled auth to the shared requireAuth/requireAdmin
 * middleware (see admin-jobs.routes.test.ts for the rationale).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let authRequest: any;

const requireAuthMock = vi.hoisted(() => vi.fn());
const requireAdminMock = vi.hoisted(() => vi.fn());
const jobQueueMock = vi.hoisted(() => ({ getJob: vi.fn() }));

vi.mock('@/lib/middleware/auth', () => ({
  requireAuth: requireAuthMock,
  requireAdmin: requireAdminMock,
}));

vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => jobQueueMock,
}));

const makeRequest = () => ({ headers: { get: () => null } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('Admin job status route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRequest = { user: { id: 'admin-1', role: 'admin' } };
    requireAuthMock.mockImplementation((_req: any, handler: any) => handler(authRequest));
    requireAdminMock.mockImplementation((_req: any, handler: any) => handler());
  });

  it('is gated by requireAuth + requireAdmin (B3)', async () => {
    jobQueueMock.getJob.mockResolvedValue(null);
    const { GET } = await import('@/app/api/admin/job-status/[id]/route');

    await GET(makeRequest() as any, params('1'));

    expect(requireAuthMock).toHaveBeenCalledTimes(1);
    expect(requireAdminMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unauthenticated/revoked session before touching the queue (B3)', async () => {
    requireAuthMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
    );
    const { GET } = await import('@/app/api/admin/job-status/[id]/route');

    const response = await GET(makeRequest() as any, params('1'));

    expect(response.status).toBe(401);
    expect(jobQueueMock.getJob).not.toHaveBeenCalled();
  });

  it('rejects non-admin users', async () => {
    requireAdminMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
    );
    const { GET } = await import('@/app/api/admin/job-status/[id]/route');

    const response = await GET(makeRequest() as any, params('1'));

    expect(response.status).toBe(403);
    expect(jobQueueMock.getJob).not.toHaveBeenCalled();
  });

  it('returns job status for an admin', async () => {
    jobQueueMock.getJob.mockResolvedValue({
      id: '1',
      type: 'search',
      status: 'completed',
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      result: null,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 3,
    });

    const { GET } = await import('@/app/api/admin/job-status/[id]/route');
    const response = await GET(makeRequest() as any, params('1'));
    const payload = await response.json();

    expect(payload.success).toBe(true);
    expect(payload.job.status).toBe('completed');
  });

  it('returns 404 when job is missing', async () => {
    jobQueueMock.getJob.mockResolvedValue(null);

    const { GET } = await import('@/app/api/admin/job-status/[id]/route');
    const response = await GET(makeRequest() as any, params('missing'));
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error).toBe('Job not found');
  });

  it('returns 500 when job lookup fails', async () => {
    jobQueueMock.getJob.mockRejectedValue(new Error('lookup failed'));

    const { GET } = await import('@/app/api/admin/job-status/[id]/route');
    const response = await GET(makeRequest() as any, params('1'));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toBe('InternalError');
  });
});
