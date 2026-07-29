/**
 * Component: BlocklistToolbar sticky-anchor test
 * Documentation: documentation/admin-features/release-blocklist.md
 *
 * With the site Header mounted over /admin (admin layout), every admin sticky
 * bar must anchor to `var(--rmab-header-h)` instead of `top-0`, or it slides
 * under the sticky header on scroll — the exact regression F4 fixed site-wide.
 * This pins the pattern on one representative admin toolbar.
 */

// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, ...props }: ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));

vi.mock('@/app/admin/blocklist/hooks/useBlocklistUrlState', () => ({
  useBlocklistUrlState: () => ({
    filters: {},
    searchInput: '',
    setSearchInput: () => {},
    removeFilter: () => {},
  }),
}));

vi.mock('@/app/admin/blocklist/types', () => ({
  BlocklistFilterState: {},
  buildBulkClearQueryString: () => '',
  hasActiveFilters: () => false,
  hasActiveSearch: () => false,
}));

vi.mock('@/app/admin/blocklist/components/ClearFilteredConfirmModal', () => ({
  ClearFilteredConfirmModal: () => null,
}));

import { BlocklistToolbar } from '@/app/admin/blocklist/components/BlocklistToolbar';

describe('BlocklistToolbar sticky anchor', () => {
  it('anchors below the site header via --rmab-header-h, never top-0', () => {
    const { container } = render(<BlocklistToolbar total={0} onCleared={() => {}} />);

    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('sticky');
    expect(root.className).not.toMatch(/\btop-0\b/);
    expect(root.style.top).toBe('var(--rmab-header-h, 4rem)');
  });

  it('paints the app background (bg-background), matching the rest of the site — not gray-900', () => {
    const { container } = render(<BlocklistToolbar total={0} onCleared={() => {}} />);

    const root = container.firstChild as HTMLElement;
    // Opaque fill so scrolling content is masked, but the SAME token the body
    // uses (var(--background)) so admin no longer diverges to the blue-tinted
    // gray-900 the rest of the site never shows.
    expect(root.className).toContain('bg-background');
    expect(root.className).not.toMatch(/\bdark:bg-gray-900\b/);
  });
});
