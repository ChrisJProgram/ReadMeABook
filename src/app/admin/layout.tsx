/**
 * Component: Admin Layout
 * Documentation: documentation/frontend/components.md
 *
 * Mounts the site-wide Header over every /admin route so the admin section
 * shares the same banner as the rest of the app (upstream mounts Header
 * per-page and the admin pages never did). Admin sticky bars must anchor to
 * `var(--rmab-header-h)`, never `top-0`, or they slide under this header.
 */

import { Header } from '@/components/layout/Header';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Header />
      {children}
    </>
  );
}
