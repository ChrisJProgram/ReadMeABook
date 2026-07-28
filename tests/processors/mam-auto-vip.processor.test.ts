/**
 * Component: MAM Auto-VIP Processor Tests (F7 L3)
 *
 * The spend path is the risk — every gate that stands between an hourly cron run
 * and 5000 points leaving the account is tested here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({ get: vi.fn(), getMany: vi.fn(), setMany: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => configMock,
}));

const statusMock = vi.hoisted(() => vi.fn());
const purchaseMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/integrations/mam.service', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/integrations/mam.service')>();
  return {
    ...orig,
    getMamAccountStatus: statusMock,
    purchaseVip: purchaseMock,
  };
});

import { processMamAutoVip } from '@/lib/processors/mam-auto-vip.processor';

const puStatus = (over: Record<string, unknown> = {}) => ({
  configured: true,
  ok: true,
  indexerId: 5,
  className: 'Power User',
  vipActive: false,
  seedbonus: 20000,
  pointCap: 99999,
  warnings: [],
  ...over,
});

/** config.get responder: pass overrides keyed by config key; unlisted keys → null. */
const config = (over: Record<string, string | null> = {}) => {
  configMock.get.mockImplementation(async (key: string) => {
    if (key in over) return over[key];
    if (key === 'mam_auto_vip_enabled') return 'true';
    return null;
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  configMock.setMany.mockResolvedValue(undefined);
});

describe('processMamAutoVip — gates', () => {
  it('disabled (default): does nothing, does not even fetch status', async () => {
    config({ mam_auto_vip_enabled: null });
    const r = await processMamAutoVip({});
    expect(r.action).toBe('disabled');
    expect(statusMock).not.toHaveBeenCalled();
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it('breaker: 3 consecutive failures disables the feature and skips the run', async () => {
    config({ mam_auto_vip_state: JSON.stringify({ consecutiveFailures: 3 }) });
    const r = await processMamAutoVip({});
    expect(r.action).toBe('breaker-disabled');
    expect(purchaseMock).not.toHaveBeenCalled();
    // it wrote enabled=false
    expect(configMock.setMany).toHaveBeenCalledWith([
      expect.objectContaining({ key: 'mam_auto_vip_enabled', value: 'false' }),
    ]);
  });

  it('status unavailable: skips without purchasing and without counting a failure', async () => {
    config();
    statusMock.mockResolvedValue({ configured: true, ok: false, pointCap: 99999, warnings: [], error: 'down' });
    const r = await processMamAutoVip({});
    expect(r.action).toBe('status-unavailable');
    expect(purchaseMock).not.toHaveBeenCalled();
    expect(configMock.setMany).not.toHaveBeenCalled(); // no state write, no rule write
  });

  it('already VIP: no purchase, and the [VIP] rule is auto-REMOVED (I3)', async () => {
    config({
      indexer_flag_config: JSON.stringify([
        { name: 'MAM VIP', modifier: 0, action: 'exclude', pattern: '\\[VIP\\]', indexerId: 5 },
      ]),
    });
    statusMock.mockResolvedValue(puStatus({ className: 'VIP', vipActive: true }));
    const r = await processMamAutoVip({});
    expect(r.action).toBe('already-vip');
    expect(purchaseMock).not.toHaveBeenCalled();
    // rule removed
    const write = configMock.setMany.mock.calls.find(
      (c) => c[0]?.[0]?.key === 'indexer_flag_config'
    );
    expect(write).toBeDefined();
    expect(JSON.parse(write![0][0].value)).toEqual([]);
  });

  it('not VIP + rule missing: rule is auto-ADDED (I3 symmetric)', async () => {
    config({ indexer_flag_config: JSON.stringify([]) });
    statusMock.mockResolvedValue(puStatus({ className: 'User' }));
    const r = await processMamAutoVip({});
    expect(r.action).toBe('requires-power-user');
    const write = configMock.setMany.mock.calls.find(
      (c) => c[0]?.[0]?.key === 'indexer_flag_config'
    );
    expect(write).toBeDefined();
    const rules = JSON.parse(write![0][0].value);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ action: 'exclude', indexerId: 5 });
  });

  it('class below Power User: never purchases', async () => {
    config();
    statusMock.mockResolvedValue(puStatus({ className: 'User' }));
    const r = await processMamAutoVip({});
    expect(r.action).toBe('requires-power-user');
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it('insufficient points (cost + reserve): never purchases', async () => {
    config(); // default reserve 2000; cost 5000 → needs 7000
    statusMock.mockResolvedValue(puStatus({ seedbonus: 6900 }));
    const r = await processMamAutoVip({});
    expect(r.action).toBe('insufficient-points');
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it('cooldown: a live attempt in the last 24h blocks another', async () => {
    config({
      mam_auto_vip_dry_run: 'false',
      mam_auto_vip_state: JSON.stringify({ lastAttemptTs: Date.now() - 60 * 60 * 1000 }),
    });
    statusMock.mockResolvedValue(puStatus());
    const r = await processMamAutoVip({});
    expect(r.action).toBe('cooldown');
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it('dry run (the default): logs the would-buy, never calls purchase, does NOT consume the cooldown', async () => {
    config(); // dry_run unset → default true
    statusMock.mockResolvedValue(puStatus());
    const r = await processMamAutoVip({});
    expect(r.action).toBe('dry_run');
    expect(r.detail).toMatch(/WOULD buy 4 weeks .* 5000/);
    expect(purchaseMock).not.toHaveBeenCalled();
    const stateWrite = configMock.setMany.mock.calls.find((c) => c[0]?.[0]?.key === 'mam_auto_vip_state');
    expect(stateWrite).toBeDefined();
    const saved = JSON.parse(stateWrite![0][0].value);
    expect(saved.lastDryRunTs).toBeDefined();
    expect(saved.lastAttemptTs).toBeUndefined(); // cooldown untouched
  });
});

describe('processMamAutoVip — live path', () => {
  it('live + purchase refused (endpoint unverified): records a failure, counts toward the breaker', async () => {
    config({ mam_auto_vip_dry_run: 'false' });
    statusMock.mockResolvedValue(puStatus());
    purchaseMock.mockResolvedValue({ ok: false, error: 'endpoint not yet verified' });
    const r = await processMamAutoVip({});
    expect(r.action).toBe('purchase-failed');
    expect(purchaseMock).toHaveBeenCalledTimes(1); // single attempt, no retry
    const stateWrite = configMock.setMany.mock.calls.find((c) => c[0]?.[0]?.key === 'mam_auto_vip_state');
    const saved = JSON.parse(stateWrite![0][0].value);
    expect(saved.consecutiveFailures).toBe(1);
    expect(saved.lastAttemptTs).toBeDefined(); // failure consumes the cooldown — no rapid re-spend attempts
  });

  it('live + success verified by points drop: resets the breaker', async () => {
    config({ mam_auto_vip_dry_run: 'false', mam_auto_vip_state: JSON.stringify({ consecutiveFailures: 2 }) });
    statusMock
      .mockResolvedValueOnce(puStatus({ seedbonus: 20000 })) // pre-purchase reading
      .mockResolvedValueOnce(puStatus({ seedbonus: 15000, className: 'VIP', vipActive: true })); // post-purchase
    purchaseMock.mockResolvedValue({ ok: true, raw: {} });
    const r = await processMamAutoVip({});
    expect(r.action).toBe('purchased');
    const stateWrite = configMock.setMany.mock.calls.filter((c) => c[0]?.[0]?.key === 'mam_auto_vip_state').pop();
    const saved = JSON.parse(stateWrite![0][0].value);
    expect(saved.lastAttemptResult).toBe('success');
    expect(saved.consecutiveFailures).toBe(0);
  });

  it('live + response ok but points did NOT drop: treated as failure (no silent maybe-spend)', async () => {
    config({ mam_auto_vip_dry_run: 'false' });
    statusMock
      .mockResolvedValueOnce(puStatus({ seedbonus: 20000 }))
      .mockResolvedValueOnce(puStatus({ seedbonus: 20000 })); // unchanged
    purchaseMock.mockResolvedValue({ ok: true, raw: {} });
    const r = await processMamAutoVip({});
    expect(r.action).toBe('purchase-unverified');
    expect(r.success).toBe(false);
    const stateWrite = configMock.setMany.mock.calls.filter((c) => c[0]?.[0]?.key === 'mam_auto_vip_state').pop();
    const saved = JSON.parse(stateWrite![0][0].value);
    expect(saved.consecutiveFailures).toBe(1);
  });
});

describe('purchaseVip endpoint guard (real implementation)', () => {
  it('refuses to spend while the endpoint is unverified', async () => {
    // Import the REAL module (bypassing this file's mock) to prove the code-level guard.
    const real = await vi.importActual<typeof import('@/lib/integrations/mam.service')>(
      '@/lib/integrations/mam.service'
    );
    expect(real.VIP_PURCHASE_ENDPOINT_VERIFIED).toBe(false);
    const result = await real.purchaseVip(4);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not yet verified/i);
  });
});
