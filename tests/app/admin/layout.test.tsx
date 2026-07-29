/**
 * Component: Admin Layout Tests
 * Documentation: documentation/frontend/components.md
 *
 * The admin section must render under the same site Header as every other
 * page. The layout is the single mount point for all /admin routes — if the
 * Header disappears from it, the admin section loses the site banner again.
 */

// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/Header', () => ({
  Header: () => <div data-testid="site-header" />,
}));

import AdminLayout from '@/app/admin/layout';

describe('AdminLayout', () => {
  it('mounts the site Header above the admin page content', () => {
    render(
      <AdminLayout>
        <div data-testid="admin-content" />
      </AdminLayout>
    );

    const header = screen.getByTestId('site-header');
    const content = screen.getByTestId('admin-content');
    expect(header).toBeInTheDocument();
    expect(content).toBeInTheDocument();
    expect(
      header.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
