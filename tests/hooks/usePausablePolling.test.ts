/**
 * Component: Pausable polling tests (B6)
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  resolveRefreshInterval,
  useDocumentVisible,
  usePausablePolling,
  POLLING_DISABLED,
} from '@/lib/hooks/usePausablePolling';

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
};

afterEach(() => {
  setVisibility('visible');
  vi.restoreAllMocks();
});

describe('resolveRefreshInterval (B6)', () => {
  it('polls at the base cadence when visible and not paused', () => {
    expect(resolveRefreshInterval({ baseMs: 10_000, visible: true })).toBe(10_000);
  });

  it('stops polling while the tab is hidden — the background-tab burn', () => {
    expect(resolveRefreshInterval({ baseMs: 10_000, visible: false })).toBe(POLLING_DISABLED);
  });

  it('stops polling while paused (a dialog is open)', () => {
    expect(resolveRefreshInterval({ baseMs: 10_000, visible: true, paused: true })).toBe(POLLING_DISABLED);
  });

  it('treats a non-positive or non-finite cadence as disabled', () => {
    expect(resolveRefreshInterval({ baseMs: 0, visible: true })).toBe(POLLING_DISABLED);
    expect(resolveRefreshInterval({ baseMs: -1, visible: true })).toBe(POLLING_DISABLED);
    expect(resolveRefreshInterval({ baseMs: Number.NaN, visible: true })).toBe(POLLING_DISABLED);
  });
});

describe('useDocumentVisible (B6)', () => {
  it('starts visible (SSR-safe) and tracks visibilitychange', () => {
    const { result } = renderHook(() => useDocumentVisible());
    expect(result.current).toBe(true);

    act(() => setVisibility('hidden'));
    expect(result.current).toBe(false);

    act(() => setVisibility('visible'));
    expect(result.current).toBe(true);
  });

  it('removes its listener on unmount (no leak across page navigations)', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useDocumentVisible());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});

describe('usePausablePolling (B6)', () => {
  it('returns the cadence when visible and unpaused, 0 otherwise', () => {
    const { result, rerender } = renderHook(
      ({ paused }: { paused: boolean }) => usePausablePolling(10_000, paused),
      { initialProps: { paused: false } }
    );
    expect(result.current).toBe(10_000);

    // A dialog opens → polling stops so rows can't shift underneath it.
    rerender({ paused: true });
    expect(result.current).toBe(POLLING_DISABLED);

    // Dialog closed but tab hidden → still stopped.
    rerender({ paused: false });
    act(() => setVisibility('hidden'));
    expect(result.current).toBe(POLLING_DISABLED);

    // Back in view → resumes.
    act(() => setVisibility('visible'));
    expect(result.current).toBe(10_000);
  });
});
