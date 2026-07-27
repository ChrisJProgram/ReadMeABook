/**
 * Component: Homepage - Audiobook Discovery (Dynamic Sections)
 * Documentation: documentation/features/home-sections.md
 */

'use client';

import { useState, useRef, useEffect, useCallback, createRef } from 'react';
import { Header } from '@/components/layout/Header';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { UnifiedPagination, PaginationSection } from '@/components/ui/UnifiedPagination';
import { HomeSection, SECTION_DOT_COLORS } from '@/components/home/HomeSection';
import { HomeSectionConfigModal } from '@/components/home/HomeSectionConfigModal';
import { useHomeSections } from '@/lib/hooks/useHomeSections';
import { usePreferences } from '@/contexts/PreferencesContext';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import { decideScrollForPageChange } from '@/lib/utils/paginationScroll';

const FALLBACK_HEADER_HEIGHT = 64;
const LOCK_SAFETY_RELEASE_MS = 30_000;
const RELEASE_SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

function getSectionTitle(sectionType: string, categoryName?: string | null): string {
  if (sectionType === 'popular') return 'Popular Audiobooks';
  if (sectionType === 'new_releases') return 'New Releases';
  return categoryName || 'Category';
}

function measureHeaderHeight(): number {
  if (typeof document === 'undefined') return FALLBACK_HEADER_HEIGHT;
  const header = document.querySelector<HTMLElement>('header.sticky');
  if (!header) return FALLBACK_HEADER_HEIGHT;
  const h = header.getBoundingClientRect().height;
  return h > 0 ? h : FALLBACK_HEADER_HEIGHT;
}

export default function HomePage() {
  const { sections, nextRefresh, isLoading: sectionsLoading, saveSections } = useHomeSections();
  const { cardSize, setCardSize, squareCovers, setSquareCovers, hideAvailable, setHideAvailable } = usePreferences();

  // Per-section pagination state
  const [pages, setPages] = useState<Record<string, number>>({});
  const [totalPagesMap, setTotalPagesMap] = useState<Record<string, number>>({});
  const [configOpen, setConfigOpen] = useState(false);

  // Controlled paginator-pill state
  const [activeIndex, setActiveIndex] = useState(0);
  const [lockedTo, setLockedTo] = useState<number | null>(null);
  const lockedToRef = useRef<number | null>(null);
  lockedToRef.current = lockedTo;

  const footerRef = useRef<HTMLElement>(null);

  // Create stable refs for each section
  const sectionRefsMap = useRef<Map<string, React.RefObject<HTMLElement | null>>>(new Map());

  const getSectionKey = (s: { sectionType: string; categoryId: string | null }) =>
    s.sectionType === 'category' ? `category:${s.categoryId}` : s.sectionType;

  // Ensure refs exist for current sections
  sections.forEach((s) => {
    const key = getSectionKey(s);
    if (!sectionRefsMap.current.has(key)) {
      sectionRefsMap.current.set(key, createRef<HTMLElement>());
    }
  });

  // Reset pages and totalPages when hideAvailable changes
  useEffect(() => {
    setPages({});
    setTotalPagesMap({});
  }, [hideAvailable]);

  // Clamp activeIndex if the section list shrinks
  useEffect(() => {
    if (sections.length === 0) return;
    if (activeIndex >= sections.length) {
      setActiveIndex(0);
      setLockedTo(null);
    }
  }, [sections.length, activeIndex]);

  // Release the lock on the user's next intentional scroll input.
  // wheel / touchstart always release; keydown releases only for known page-scroll keys.
  useEffect(() => {
    if (lockedTo === null) return;

    const release = () => setLockedTo(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (RELEASE_SCROLL_KEYS.has(e.key)) release();
    };

    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    const safetyTimer = window.setTimeout(release, LOCK_SAFETY_RELEASE_MS);

    return () => {
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(safetyTimer);
    };
  }, [lockedTo]);

  const getPage = (key: string) => pages[key] || 1;
  const setPage = useCallback((key: string, page: number) => {
    setPages((prev) => ({ ...prev, [key]: page }));
  }, []);
  const handleTotalPagesChange = useCallback((key: string, totalPages: number) => {
    setTotalPagesMap((prev) => {
      if (prev[key] === totalPages) return prev;
      return { ...prev, [key]: totalPages };
    });
  }, []);

  // Pill-driven Prev/Next/jump. Fit-aware scroll, lock pill to this section.
  const handlePageChange = useCallback(
    (index: number, key: string, page: number, ref: React.RefObject<HTMLElement | null>) => {
      setPage(key, page);
      setActiveIndex(index);
      setLockedTo(index);

      const section = ref.current;
      if (!section || typeof window === 'undefined') return;

      const rect = section.getBoundingClientRect();
      const headerHeight = measureHeaderHeight();
      const maxScrollY = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      );

      const decision = decideScrollForPageChange({
        sectionTop: rect.top,
        sectionHeight: rect.height,
        viewportHeight: window.innerHeight,
        headerHeight,
        scrollY: window.scrollY,
        maxScrollY,
      });

      if (decision.action === 'scroll') {
        window.scrollTo({ top: decision.targetY, behavior: 'smooth' });
      }
    },
    [setPage]
  );

  // Dot click on a non-active section. Always scrolls (intentional navigation).
  // Releases any active lock and immediately switches the pill to that section.
  const handleScrollToSection = useCallback(
    (index: number, ref: React.RefObject<HTMLElement | null>) => {
      setLockedTo(null);
      setActiveIndex(index);

      const section = ref.current;
      if (!section || typeof window === 'undefined') return;

      const rect = section.getBoundingClientRect();
      const headerHeight = measureHeaderHeight();
      const maxScrollY = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      );
      const desired = rect.top + window.scrollY - headerHeight - 8;
      const targetY = Math.min(Math.max(0, desired), maxScrollY);
      window.scrollTo({ top: targetY, behavior: 'smooth' });
    },
    []
  );

  // Observer-driven "dominant section" guess from the pill. Honored only when unlocked.
  const handleDominantSectionChange = useCallback((index: number) => {
    if (lockedToRef.current !== null) return;
    setActiveIndex(index);
  }, []);

  // Build pagination sections for the floating pill
  const paginationSections: PaginationSection[] = sections.map((s, i) => {
    const key = getSectionKey(s);
    const ref = sectionRefsMap.current.get(key)!;
    return {
      label: getSectionTitle(s.sectionType, s.categoryName),
      accentColor: SECTION_DOT_COLORS[i % SECTION_DOT_COLORS.length],
      currentPage: getPage(key),
      totalPages: totalPagesMap[key] || 1,
      onPageChange: (page: number) => handlePageChange(i, key, page, ref),
      sectionRef: ref,
      onScrollToSection: () => handleScrollToSection(i, ref),
    };
  });

  return (
    <ProtectedRoute>
      <div className="min-h-screen">
        <Header />

        <main className="container mx-auto px-4 py-6 sm:py-8 max-w-7xl space-y-8 sm:space-y-12">
          {/* Loading state */}
          {sectionsLoading && (
            <div className="flex justify-center py-20">
              <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
            </div>
          )}

          {/* Empty state */}
          {!sectionsLoading && sections.length === 0 && (
            <div className="text-center py-20">
              <p className="text-gray-500 dark:text-gray-400 mb-4">
                No sections configured. Click Customize to add sections to your home page.
              </p>
              <button
                onClick={() => setConfigOpen(true)}
                className="inline-flex items-center px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Cog6ToothIcon className="w-4 h-4 mr-2" />
                Customize Home
              </button>
            </div>
          )}

          {/* Dynamic sections */}
          {!sectionsLoading &&
            sections.map((section, index) => {
              const key = getSectionKey(section);
              const ref = sectionRefsMap.current.get(key)!;

              return (
                <HomeSection
                  key={key}
                  sectionType={section.sectionType as 'popular' | 'new_releases' | 'category'}
                  categoryId={section.categoryId}
                  categoryName={section.categoryName}
                  colorIndex={index}
                  page={getPage(key)}
                  sectionRef={ref}
                  cardSize={cardSize}
                  squareCovers={squareCovers}
                  hideAvailable={hideAvailable}
                  onToggleHideAvailable={setHideAvailable}
                  onToggleSquareCovers={setSquareCovers}
                  onCardSizeChange={setCardSize}
                  onConfigOpen={index === 0 ? () => setConfigOpen(true) : undefined}
                  onTotalPagesChange={(tp) => handleTotalPagesChange(key, tp)}
                  nextRefresh={nextRefresh}
                />
              );
            })}

          {/* The "Can't find what you're looking for?" CTA card used to sit here.
              Removed now that the header carries a persistent search bar on every
              page — it linked to /search, which is one keystroke away. */}
        </main>

        {/* Footer */}
        <footer ref={footerRef} className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 mt-16">
          <div className="container mx-auto px-4 py-6 max-w-7xl">
            <div className="text-center text-sm text-gray-600 dark:text-gray-400">
              <p>ReadMeABook - Audiobook Library Management System</p>
            </div>
          </div>
        </footer>

        {/* Unified Pagination — dynamic sections */}
        {paginationSections.length > 0 && (
          <UnifiedPagination
            footerRef={footerRef}
            sections={paginationSections}
            activeIndex={Math.min(activeIndex, paginationSections.length - 1)}
            onDominantSectionChange={handleDominantSectionChange}
          />
        )}

        {/* Config Modal */}
        <HomeSectionConfigModal
          isOpen={configOpen}
          onClose={() => setConfigOpen(false)}
          sections={sections}
          onSave={saveSections}
        />
      </div>
    </ProtectedRoute>
  );
}
