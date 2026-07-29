/**
 * Component: Version Badge Tests
 * Documentation: documentation/frontend/components.md
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { VersionBadge } from '@/components/ui/VersionBadge';

const originalVersion = process.env.NEXT_PUBLIC_APP_VERSION;
const originalCommit = process.env.NEXT_PUBLIC_GIT_COMMIT;

describe('VersionBadge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalVersion === undefined) {
      delete process.env.NEXT_PUBLIC_APP_VERSION;
    } else {
      process.env.NEXT_PUBLIC_APP_VERSION = originalVersion;
    }
    if (originalCommit === undefined) {
      delete process.env.NEXT_PUBLIC_GIT_COMMIT;
    } else {
      process.env.NEXT_PUBLIC_GIT_COMMIT = originalCommit;
    }
  });

  it('renders semantic version from build-time env var', async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = '1.0.0';
    process.env.NEXT_PUBLIC_GIT_COMMIT = 'abcdef1234';
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ version: '1.0.0' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<VersionBadge />);

    expect(await screen.findByText('v1.0.0')).toBeInTheDocument();
    // Should not call /api/version since build-time version is available
    expect(fetchMock).not.toHaveBeenCalledWith('/api/version');
  });

  it('falls back to API when build-time version is unavailable', async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = 'unknown';
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ version: 'v1.2.3', commit: 'abc1234' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<VersionBadge />);

    expect(await screen.findByText('v1.2.3')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/version');
  });

  it('shows dev version when API fetch fails', async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = 'unknown';
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'));
    const errorMock = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    render(<VersionBadge />);

    await waitFor(() => {
      expect(screen.getByText('vDEV')).toBeInTheDocument();
    });
    expect(errorMock).toHaveBeenCalledWith('Failed to fetch version:', expect.any(Error));
  });

  // Fork: the badge is the AGPL §13 Corresponding Source offer — it must link to
  // the fork repository at the exact deployed commit, in every state. The update
  // check stays on upstream (the fork cuts no releases, so "update available"
  // means "upstream has moved past our base").
  describe('fork source offer (AGPL §13)', () => {
    it('links to the fork repo at the exact deployed commit', async () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '1.2.1';
      process.env.NEXT_PUBLIC_GIT_COMMIT = '3e722cd48ed1bffb58f43de85f4fc328dd66c73b';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ json: async () => ({ version: '1.2.1' }) })
      );

      render(<VersionBadge />);

      const link = await screen.findByRole('link');
      expect(link).toHaveAttribute(
        'href',
        'https://github.com/ChrisJProgram/ReadMeABook/tree/3e722cd'
      );
    });

    it('falls back to the fork repo root when no commit is known', async () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '1.2.1';
      process.env.NEXT_PUBLIC_GIT_COMMIT = 'unknown';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ json: async () => ({ version: '1.2.1' }) })
      );

      render(<VersionBadge />);

      const link = await screen.findByRole('link');
      expect(link).toHaveAttribute('href', 'https://github.com/ChrisJProgram/ReadMeABook');
    });

    it('keeps the fork source link and upstream update-check even when an update exists', async () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '1.2.1';
      process.env.NEXT_PUBLIC_GIT_COMMIT = '3e722cd48ed1bffb58f43de85f4fc328dd66c73b';
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ json: async () => ({ version: '9.9.9' }) });
      vi.stubGlobal('fetch', fetchMock);

      render(<VersionBadge />);
      await screen.findByRole('link');

      await waitFor(() => {
        const updateCheckUrls = fetchMock.mock.calls
          .map((c) => String(c[0]))
          .filter((u) => u.includes('raw.githubusercontent.com'));
        expect(updateCheckUrls.length).toBeGreaterThan(0);
        updateCheckUrls.forEach((u) => {
          expect(u).toContain('kikootwo/ReadMeABook');
          expect(u).not.toContain('ChrisJProgram');
        });
      });

      // Even in the update-available state the badge must keep offering the
      // fork's source, not upstream's release page.
      expect(screen.getByRole('link')).toHaveAttribute(
        'href',
        'https://github.com/ChrisJProgram/ReadMeABook/tree/3e722cd'
      );
    });
  });
});
