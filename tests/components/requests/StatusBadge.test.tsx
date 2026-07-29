/**
 * Component: Status Badge Tests
 * Documentation: documentation/frontend/components.md
 */

// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from '@/components/requests/StatusBadge';

describe('StatusBadge', () => {
  it('uses the initializing label for zero-progress downloads', () => {
    render(<StatusBadge status="downloading" progress={0} />);
    expect(screen.getByText('Initializing...')).toBeInTheDocument();
  });

  it('falls back to the raw status when unknown', () => {
    render(<StatusBadge status="custom_status" />);
    expect(screen.getByText('custom_status')).toBeInTheDocument();
  });

  it('renders the awaiting_release label with teal styling', () => {
    render(<StatusBadge status="awaiting_release" />);
    const badge = screen.getByText('Awaiting Release');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('bg-teal-100');
    expect(badge.className).toContain('text-teal-800');
    expect(badge.className).toContain('dark:bg-teal-900');
    expect(badge.className).toContain('dark:text-teal-200');
  });

  // awaiting_search now says WHY it isn't downloading, keyed to the errorMessage.
  it('shows the generic Awaiting Search label when no errorMessage is given (back-compat)', () => {
    render(<StatusBadge status="awaiting_search" />);
    expect(screen.getByText('Awaiting Search')).toBeInTheDocument();
  });

  it('renders a Locked badge (amber) for a VIP/exclude-rule awaiting_search', () => {
    render(
      <StatusBadge
        status="awaiting_search"
        errorMessage="No usable releases — 2 candidate(s) matched an exclude rule"
      />
    );
    const badge = screen.getByText('Locked');
    expect(badge).toBeInTheDocument();
    expect(screen.queryByText('Awaiting Search')).not.toBeInTheDocument();
    expect(badge.className).toContain('bg-amber-100');
    expect(badge.className).toContain('dark:text-amber-200');
    // The full reason is available as a tooltip.
    expect(badge).toHaveAttribute('title');
  });

  it('renders a Searching badge (blue) while re-selecting after a failed download', () => {
    render(
      <StatusBadge
        status="awaiting_search"
        errorMessage='Download fetch failed (HTTP 500) — blocklisted "X", re-searching for an alternative.'
      />
    );
    const badge = screen.getByText('Searching');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('bg-blue-100');
  });
});
