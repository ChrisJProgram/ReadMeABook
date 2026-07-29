/**
 * Component: Pausable polling helper (B6)
 * Documentation: documentation/admin-dashboard.md
 *
 * The admin request table polled unconditionally every 10s. A large table that
 * re-renders forever never lets the page reach an idle state — which is what made
 * it intermittently fail to render/scroll and made `Page.captureScreenshot` time
 * out — and it kept hammering the API from background tabs indefinitely.
 *
 * This pauses polling when the tab is hidden or the user is mid-interaction
 * (a modal is open), matching the pause-on-interact behaviour the logs page
 * already has, without importing that page's logs-specific registry/storage key.
 */

'use client';

import { useEffect, useState } from 'react';

/** SWR treats refreshInterval=0 as "don't poll". */
export const POLLING_DISABLED = 0;

/**
 * Pure resolver: what refreshInterval should SWR use?
 * Polls only when the document is visible AND nothing has paused it.
 */
export function resolveRefreshInterval(options: {
  baseMs: number;
  visible: boolean;
  paused?: boolean;
}): number {
  const { baseMs, visible, paused = false } = options;
  if (!visible || paused) return POLLING_DISABLED;
  if (!Number.isFinite(baseMs) || baseMs <= 0) return POLLING_DISABLED;
  return baseMs;
}

/**
 * Track document visibility. SSR-safe: assumes visible until the browser says
 * otherwise, so the first client render matches the server's markup.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const sync = () => setVisible(document.visibilityState !== 'hidden');
    sync();

    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  return visible;
}

/**
 * Convenience: the SWR `refreshInterval` for a poll that should stop while the
 * tab is hidden or while `paused` (e.g. a modal is open).
 */
export function usePausablePolling(baseMs: number, paused = false): number {
  const visible = useDocumentVisible();
  return resolveRefreshInterval({ baseMs, visible, paused });
}
