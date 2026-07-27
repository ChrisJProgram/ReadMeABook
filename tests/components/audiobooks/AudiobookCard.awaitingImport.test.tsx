/**
 * Component: Audiobook Card - awaiting_import status (B4) Tests
 * Documentation: documentation/frontend/components.md
 *
 * Regression cover for B4: `awaiting_import` was lumped into `processingStatuses`,
 * so an idle or failed record rendered a spinning "Processing" badge — implying
 * work was in flight when nothing had run for over an hour. It must render as a
 * distinct, non-animated "Awaiting Import" state (matching StatusBadge, which
 * always labelled it correctly).
 */

// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createRequestMock = vi.hoisted(() => vi.fn());
const authState = {
  user: null as null | { id: string; username: string },
};

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/hooks/useRequests', () => ({
  useCreateRequest: () => ({ createRequest: createRequestMock, isLoading: false }),
}));

vi.mock('@/components/audiobooks/AudiobookDetailsModal', () => ({
  AudiobookDetailsModal: ({ isOpen }: { isOpen: boolean }) => (
    <div data-testid="details-modal" data-open={String(isOpen)} />
  ),
}));

vi.mock('next/image', () => ({
  __esModule: true,
  default: (props: any) => <img {...props} />,
}));

const baseAudiobook = {
  asin: 'asin-1',
  title: 'Test Book',
  author: 'Author',
};

/** Count elements carrying Tailwind's spin animation. */
const spinnerCount = (container: HTMLElement) =>
  container.querySelectorAll('.animate-spin').length;

describe('AudiobookCard — B4: awaiting_import is a waiting state', () => {
  beforeEach(() => {
    authState.user = { id: 'user-1', username: 'user' };
    createRequestMock.mockReset();
  });

  it('labels awaiting_import as "Awaiting Import", not "Processing"', async () => {
    const { AudiobookCard } = await import('@/components/audiobooks/AudiobookCard');

    render(
      <AudiobookCard audiobook={{ ...baseAudiobook, requestStatus: 'awaiting_import' }} />
    );

    expect(screen.getByText('Awaiting Import')).toBeTruthy();
    expect(screen.queryByText('Processing')).toBeNull();
  });

  it('renders NO spinner for awaiting_import', async () => {
    const { AudiobookCard } = await import('@/components/audiobooks/AudiobookCard');

    const { container } = render(
      <AudiobookCard audiobook={{ ...baseAudiobook, requestStatus: 'awaiting_import' }} />
    );

    expect(spinnerCount(container)).toBe(0);
  });

  it('still shows a spinning "Processing" for genuinely active statuses', async () => {
    const { AudiobookCard } = await import('@/components/audiobooks/AudiobookCard');

    for (const status of ['downloading', 'processing', 'downloaded']) {
      const { container, unmount } = render(
        <AudiobookCard audiobook={{ ...baseAudiobook, requestStatus: status }} />
      );

      expect(screen.getByText('Processing')).toBeTruthy();
      expect(spinnerCount(container)).toBeGreaterThan(0);
      unmount();
    }
  });

  it('does not offer a Request button while awaiting import', async () => {
    const { AudiobookCard } = await import('@/components/audiobooks/AudiobookCard');

    render(
      <AudiobookCard audiobook={{ ...baseAudiobook, requestStatus: 'awaiting_import' }} />
    );

    expect(screen.queryByRole('button', { name: 'Request' })).toBeNull();
  });

  it('leaves the other status families untouched', async () => {
    const { AudiobookCard } = await import('@/components/audiobooks/AudiobookCard');

    const { unmount: u1 } = render(
      <AudiobookCard audiobook={{ ...baseAudiobook, requestStatus: 'pending' }} />
    );
    expect(screen.getByText('Requested')).toBeTruthy();
    u1();

    // `denied` is re-requestable (canRequest includes it), so the card offers the
    // Request button rather than a "Request Denied" label. Asserted here so this
    // deliberate asymmetry with awaiting_import can't be broken silently.
    const { unmount: u2 } = render(
      <AudiobookCard audiobook={{ ...baseAudiobook, requestStatus: 'denied' }} />
    );
    expect(screen.getByRole('button', { name: 'Request' })).toBeTruthy();
    u2();

    render(<AudiobookCard audiobook={{ ...baseAudiobook, isAvailable: true }} />);
    expect(screen.getByText('In Your Library')).toBeTruthy();
  });
});
