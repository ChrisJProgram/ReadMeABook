/**
 * Component: MyAnonamouse Account Panel (F7 / L1+L2)
 * Documentation: RMAB2-SPEC.md § F7
 *
 * In-app MAM standing (class / points / cap / HnR / ratio) plus class-gated
 * advice for the F2(a) `[VIP]` exclude rule: recommends keeping it while the
 * account can't fetch `[VIP]`, with a one-click apply (never a silent edit).
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/utils/api';
import { Button } from '@/components/ui/Button';

interface MamAccount {
  configured: boolean;
  ok: boolean;
  error?: string;
  indexerId?: number;
  username?: string;
  className?: string;
  vipPossible?: boolean;
  seedbonus?: number;
  pointCap: number;
  wedges?: number;
  ratio?: number | null;
  uploadedBytes?: number;
  downloadedBytes?: number;
  hnr?: number;
  unsat?: number;
  unsatLimit?: number;
  warnings: string[];
}

interface VipRuleState {
  present: boolean;
  recommendedPresent: boolean;
  inSync: boolean;
  vipUntil: string | null;
  vipActive: boolean;
}

interface Bundle {
  account: MamAccount;
  vipRule: VipRuleState;
}

const gib = (bytes?: number) => ((bytes ?? 0) / 1024 ** 3).toFixed(1);

export function MamAccountPanel() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [vipUntilInput, setVipUntilInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchWithAuth('/api/admin/mam');
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load MAM status');
      setBundle({ account: data.account, vipRule: data.vipRule });
      setVipUntilInput(data.vipRule?.vipUntil || '');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load MAM status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const res = await fetchWithAuth('/api/admin/mam', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Action failed');
        setBundle({ account: data.account, vipRule: data.vipRule });
        setVipUntilInput(data.vipRule?.vipUntil || '');
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const Section = ({ children }: { children: React.ReactNode }) => (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
      <div className="mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">MyAnonamouse Account</h3>
      </div>
      {children}
    </div>
  );

  if (loading) {
    return (
      <Section>
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">Loading MAM account status…</p>
      </Section>
    );
  }

  if (loadError && !bundle) {
    return (
      <Section>
        <p className="text-sm text-red-600 dark:text-red-400">⚠️ {loadError}</p>
        <Button onClick={load} variant="outline" size="sm" className="mt-3">Retry</Button>
      </Section>
    );
  }

  const account = bundle?.account;
  const vipRule = bundle?.vipRule;

  if (!account?.configured) {
    return (
      <Section>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {account?.error || 'No MyAnonamouse indexer is configured in Prowlarr.'}
        </p>
      </Section>
    );
  }

  if (!account.ok) {
    return (
      <Section>
        <p className="text-sm text-amber-600 dark:text-amber-400">⚠️ {account.error}</p>
        <Button onClick={load} variant="outline" size="sm" className="mt-3">Retry</Button>
      </Section>
    );
  }

  const points = account.seedbonus ?? 0;
  const cap = account.pointCap || 99999;
  const pointPct = Math.min(100, Math.round((points / cap) * 100));

  const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  );

  return (
    <Section>
      {/* Standing grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        <Stat
          label="Class"
          value={
            <>
              {account.className ?? '—'}{' '}
              <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                {account.vipPossible ? '(VIP-eligible)' : '(below Power User)'}
              </span>
            </>
          }
        />
        <Stat label="Ratio" value={account.ratio ?? '—'} />
        <Stat label="Wedges" value={account.wedges ?? 0} />
        <Stat label="Hit-and-run" value={account.hnr ?? 0} />
        <Stat label="Unsatisfied" value={`${account.unsat ?? 0} / ${account.unsatLimit ?? 0}`} />
        <Stat label="Uploaded" value={`${gib(account.uploadedBytes)} GiB`} />
        <Stat label="Downloaded" value={`${gib(account.downloadedBytes)} GiB`} />
        <Stat label="Username" value={account.username ?? '—'} />
      </div>

      {/* Bonus points with cap bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
          <span>Bonus points</span>
          <span>{points.toLocaleString()} / {cap.toLocaleString()}</span>
        </div>
        <div className="w-full h-2 rounded bg-gray-200 dark:bg-gray-700 overflow-hidden">
          <div
            className={`h-full ${pointPct >= 90 ? 'bg-red-500' : pointPct >= 70 ? 'bg-amber-500' : 'bg-blue-500'}`}
            style={{ width: `${pointPct}%` }}
          />
        </div>
      </div>

      {/* Warnings */}
      {account.warnings.length > 0 && (
        <ul className="mb-4 space-y-1">
          {account.warnings.map((w, i) => (
            <li key={i} className="text-xs text-amber-600 dark:text-amber-400">⚠️ {w}</li>
          ))}
        </ul>
      )}

      {/* VIP exclude-rule advisory (L2) */}
      {vipRule && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-800">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                MAM <code className="px-1 rounded bg-gray-200 dark:bg-gray-700">[VIP]</code> exclude rule:{' '}
                <span className={vipRule.present ? 'text-green-700 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'}>
                  {vipRule.present ? 'ON' : 'OFF'}
                </span>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                {vipRule.vipActive
                  ? 'You marked VIP as active — VIP releases are freeleech-gettable, so the rule should be OFF.'
                  : account.vipPossible
                    ? 'You are VIP-eligible. If you have active VIP, set its expiry below and the rule lifts automatically.'
                    : 'Class is below Power User, so VIP releases are ungettable — the rule should stay ON.'}
              </p>
            </div>
            {!vipRule.inSync && (
              <Button
                onClick={() => post({ action: 'apply-vip-rule', present: vipRule.recommendedPresent })}
                loading={busy}
                variant="outline"
                size="sm"
                className="flex-shrink-0"
              >
                Turn rule {vipRule.recommendedPresent ? 'ON' : 'OFF'}
              </Button>
            )}
          </div>
          {vipRule.inSync && (
            <p className="text-xs text-green-700 dark:text-green-400 mt-2">✓ In sync with the recommendation.</p>
          )}

          {/* VIP-until override — only meaningful once VIP-eligible (Power User+) */}
          {account.vipPossible && (
            <div className="mt-4 flex items-end gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">VIP active until</label>
                <input
                  type="date"
                  value={vipUntilInput}
                  onChange={(e) => setVipUntilInput(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 dark:text-gray-100"
                />
              </div>
              <Button onClick={() => post({ action: 'set-vip-until', until: vipUntilInput })} loading={busy} variant="outline" size="sm">
                Save
              </Button>
              {vipRule.vipUntil && (
                <Button onClick={() => post({ action: 'set-vip-until', until: '' })} loading={busy} variant="ghost" size="sm">
                  Clear
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <Button onClick={load} variant="ghost" size="sm" loading={loading}>Refresh</Button>
      </div>
    </Section>
  );
}
