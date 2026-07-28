/**
 * Component: MAM account service tests (F7 / L1)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosGetMock = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: axiosGetMock } }));

const getIndexersMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/integrations/prowlarr.service', () => ({
  getProwlarrService: async () => ({ getIndexers: getIndexersMock }),
}));

import { getMamAccountStatus, getMamIndexerRef } from '@/lib/integrations/mam.service';

const MAM_INDEXER = {
  id: 5,
  name: 'MyAnonamouse',
  fields: [
    { name: 'baseUrl', value: 'https://www.myanonamouse.net' },
    { name: 'mamId', value: 'cookie-abc' },
  ],
};

const baseSummary = {
  classname: 'User',
  username: 'AnonUser123',
  seedbonus: 10876,
  wedges: 12,
  ratio: 1.9,
  uploaded_bytes: 35139732286,
  downloaded_bytes: 17781956484,
  sSat: { count: 9 },
  seedHnr: { count: 0 },
  inactHnr: { count: 0 },
  unsat: { count: 8, limit: 50 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getMamIndexerRef', () => {
  it('finds the indexer carrying a mamId cookie', async () => {
    getIndexersMock.mockResolvedValue([{ id: 6, name: 'ABB', fields: [] }, MAM_INDEXER]);
    expect(await getMamIndexerRef()).toEqual({ id: 5, cookie: 'cookie-abc' });
  });

  it('returns null when no indexer has a mamId', async () => {
    getIndexersMock.mockResolvedValue([{ id: 6, name: 'ABB', fields: [{ name: 'x', value: 'y' }] }]);
    expect(await getMamIndexerRef()).toBeNull();
  });
});

describe('getMamAccountStatus', () => {
  it('reports not-configured when MAM is absent', async () => {
    getIndexersMock.mockResolvedValue([{ id: 6, name: 'ABB', fields: [] }]);
    const s = await getMamAccountStatus();
    expect(s.configured).toBe(false);
    expect(s.ok).toBe(false);
    expect(axiosGetMock).not.toHaveBeenCalled();
  });

  it('parses a healthy summary: class "User" → no active VIP, not points-eligible', async () => {
    getIndexersMock.mockResolvedValue([MAM_INDEXER]);
    axiosGetMock.mockResolvedValue({ data: baseSummary });
    const s = await getMamAccountStatus();
    expect(s.ok).toBe(true);
    expect(s.indexerId).toBe(5);
    expect(s.className).toBe('User');
    expect(s.vipActive).toBe(false);   // VIP is a class; "User" is not it
    expect(s.vipPossible).toBe(false); // below Power User
    expect(s.seedbonus).toBe(10876);
    expect(s.hnr).toBe(0);
    expect(s.warnings).toEqual([]);
    // cookie was sent
    expect(axiosGetMock).toHaveBeenCalledWith(
      expect.stringContaining('jsonLoad.php'),
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'mam_id=cookie-abc' }) }),
    );
  });

  it('detects active VIP from the class name (FAQ: VIP is a member class)', async () => {
    getIndexersMock.mockResolvedValue([MAM_INDEXER]);
    axiosGetMock.mockResolvedValue({ data: { ...baseSummary, classname: 'VIP' } });
    expect((await getMamAccountStatus()).vipActive).toBe(true);

    axiosGetMock.mockResolvedValue({ data: { ...baseSummary, classname: 'Elite VIP' } });
    expect((await getMamAccountStatus()).vipActive).toBe(true);

    // case-insensitive (defensive against display-case drift)
    axiosGetMock.mockResolvedValue({ data: { ...baseSummary, classname: 'vip' } });
    expect((await getMamAccountStatus()).vipActive).toBe(true);
  });

  it('does NOT report VIP for non-VIP classes, including Power User and Elite', async () => {
    getIndexersMock.mockResolvedValue([MAM_INDEXER]);
    axiosGetMock.mockResolvedValue({ data: { ...baseSummary, classname: 'Power User' } });
    let s = await getMamAccountStatus();
    expect(s.vipActive).toBe(false);
    expect(s.vipPossible).toBe(true); // PU can buy VIP with points

    axiosGetMock.mockResolvedValue({ data: { ...baseSummary, classname: 'Elite' } });
    s = await getMamAccountStatus();
    expect(s.vipActive).toBe(false); // Elite is above VIP in the ladder but is not a VIP class
  });

  it('treats an unrecognised class conservatively (no VIP, no points-eligibility)', async () => {
    getIndexersMock.mockResolvedValue([MAM_INDEXER]);
    axiosGetMock.mockResolvedValue({ data: { ...baseSummary, classname: 'Wombat' } });
    const s = await getMamAccountStatus();
    expect(s.classRank).toBeNull();
    expect(s.vipActive).toBe(false);
    expect(s.vipPossible).toBe(false);
  });

  it('raises the expected warnings (HnR, point cap, unsat, ratio)', async () => {
    getIndexersMock.mockResolvedValue([MAM_INDEXER]);
    axiosGetMock.mockResolvedValue({
      data: {
        ...baseSummary,
        seedbonus: 99999,
        ratio: 0.8,
        seedHnr: { count: 2 },
        unsat: { count: 46, limit: 50 },
      },
    });
    const s = await getMamAccountStatus();
    expect(s.warnings.join(' | ')).toMatch(/Hit-and-run/);
    expect(s.warnings.join(' | ')).toMatch(/cap/);
    expect(s.warnings.join(' | ')).toMatch(/Unsatisfied 46\/50/);
    expect(s.warnings.join(' | ')).toMatch(/Ratio is below 1\.0/);
  });

  it('returns ok:false (never throws) when MAM does not respond', async () => {
    getIndexersMock.mockResolvedValue([MAM_INDEXER]);
    axiosGetMock.mockRejectedValue(new Error('ETIMEDOUT'));
    const s = await getMamAccountStatus();
    expect(s.configured).toBe(true);
    expect(s.ok).toBe(false);
    expect(s.indexerId).toBe(5);
    expect(s.error).toMatch(/did not respond/i);
  });
});
