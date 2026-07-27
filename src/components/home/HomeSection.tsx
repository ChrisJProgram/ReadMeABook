/**
 * Component: Home Section — renders a single audiobook discovery section
 * Documentation: documentation/features/home-sections.md
 *
 * Handles popular, new_releases, and category section types with unified rendering.
 */

'use client';

import React, { useEffect } from 'react';
import { AudiobookGrid } from '@/components/audiobooks/AudiobookGrid';
import { SectionToolbar } from '@/components/ui/SectionToolbar';
import { useAudiobooks } from '@/lib/hooks/useAudiobooks';
import { useCategoryAudiobooks } from '@/lib/hooks/useHomeSections';
import { Cog6ToothIcon, ClockIcon } from '@heroicons/react/24/outline';

const SECTION_COLORS = [
  'from-blue-500 to-indigo-500',
  'from-emerald-500 to-teal-500',
  'from-violet-500 to-purple-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-cyan-500 to-sky-500',
  'from-fuchsia-500 to-pink-500',
  'from-lime-500 to-green-500',
  'from-orange-500 to-red-500',
  'from-teal-500 to-emerald-500',
];

export const SECTION_DOT_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500',
  'bg-cyan-500', 'bg-fuchsia-500', 'bg-lime-500', 'bg-orange-500', 'bg-teal-500',
];

function getSectionTitle(sectionType: string, categoryName?: string | null): string {
  if (sectionType === 'popular') return 'Popular Audiobooks';
  if (sectionType === 'new_releases') return 'New Releases';
  return categoryName || 'Category';
}

/**
 * Formats a nextRefresh ISO timestamp into a friendly, readable string.
 * Examples: "today at 6:00 PM", "tomorrow at 2:00 AM", "Saturday at 9:00 AM"
 */
function formatNextRefresh(isoString: string): string {
  const refreshDate = new Date(isoString);
  const now = new Date();

  const refreshMidnight = new Date(refreshDate);
  refreshMidnight.setHours(0, 0, 0, 0);

  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);

  const tomorrowMidnight = new Date(todayMidnight);
  tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);

  const dayAfterMidnight = new Date(tomorrowMidnight);
  dayAfterMidnight.setDate(dayAfterMidnight.getDate() + 1);

  const timeStr = refreshDate.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (refreshMidnight.getTime() === todayMidnight.getTime()) {
    return `today at ${timeStr}`;
  }
  if (refreshMidnight.getTime() === tomorrowMidnight.getTime()) {
    return `tomorrow at ${timeStr}`;
  }
  if (refreshMidnight.getTime() < dayAfterMidnight.getTime()) {
    const dayName = refreshDate.toLocaleDateString(undefined, { weekday: 'long' });
    return `${dayName} at ${timeStr}`;
  }

  const dateStr = refreshDate.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return `${dateStr} at ${timeStr}`;
}

interface HomeSectionProps {
  sectionType: 'popular' | 'new_releases' | 'category';
  categoryId: string | null;
  categoryName: string | null;
  colorIndex: number;
  page: number;
  sectionRef: React.RefObject<HTMLElement | null>;
  cardSize: number;
  squareCovers: boolean;
  hideAvailable: boolean;
  onToggleHideAvailable: (v: boolean) => void;
  onToggleSquareCovers: (v: boolean) => void;
  onCardSizeChange: (v: number) => void;
  onConfigOpen?: () => void;
  onTotalPagesChange?: (totalPages: number) => void;
  nextRefresh: string | null;
}

function PopularOrNewSection({
  type,
  page,
  hideAvailable,
  onTotalPagesChange,
  ...renderProps
}: {
  type: 'popular' | 'new-releases';
  page: number;
  hideAvailable: boolean;
  onTotalPagesChange?: (totalPages: number) => void;
} & RenderSectionProps) {
  const { audiobooks, isLoading, totalPages, message } = useAudiobooks(type, 20, page, hideAvailable);

  useEffect(() => {
    onTotalPagesChange?.(totalPages);
  }, [totalPages, onTotalPagesChange]);

  return (
    <RenderSection
      audiobooks={audiobooks}
      isLoading={isLoading}
      totalPages={totalPages}
      message={message}
      {...renderProps}
    />
  );
}

function CategorySection({
  categoryId,
  page,
  hideAvailable,
  onTotalPagesChange,
  ...renderProps
}: {
  categoryId: string;
  page: number;
  hideAvailable: boolean;
  onTotalPagesChange?: (totalPages: number) => void;
} & RenderSectionProps) {
  const { audiobooks, isLoading, totalPages, message } = useCategoryAudiobooks(
    categoryId,
    20,
    page,
    hideAvailable
  );

  useEffect(() => {
    onTotalPagesChange?.(totalPages);
  }, [totalPages, onTotalPagesChange]);

  return (
    <RenderSection
      audiobooks={audiobooks}
      isLoading={isLoading}
      totalPages={totalPages}
      message={message}
      {...renderProps}
    />
  );
}

interface RenderSectionProps {
  cardSize: number;
  squareCovers: boolean;
  nextRefresh?: string | null;
}

function CategoryEmptyState({ nextRefresh }: { nextRefresh?: string | null }) {
  const refreshLabel = nextRefresh ? formatNextRefresh(nextRefresh) : null;

  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
      <div className="flex items-center justify-center w-11 h-11 rounded-full bg-gray-100 dark:bg-gray-700/60 mb-4">
        <ClockIcon className="w-5 h-5 text-gray-400 dark:text-gray-500" />
      </div>
      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        No audiobooks yet
      </p>
      <p className="text-sm text-gray-400 dark:text-gray-500 max-w-xs leading-relaxed">
        {refreshLabel
          ? <>This section will fill in after the next data refresh, scheduled for <span className="text-gray-500 dark:text-gray-400">{refreshLabel}</span>.</>
          : 'This section will fill in after the next scheduled data refresh.'}
      </p>
    </div>
  );
}

function RenderSection({
  audiobooks,
  isLoading,
  totalPages,
  message,
  cardSize,
  squareCovers,
  nextRefresh,
}: RenderSectionProps & {
  audiobooks: any[];
  isLoading: boolean;
  totalPages: number;
  message: string | null;
}) {
  if (message && !isLoading && audiobooks.length === 0) {
    return <CategoryEmptyState nextRefresh={nextRefresh} />;
  }

  return (
    <AudiobookGrid
      audiobooks={audiobooks}
      isLoading={isLoading}
      emptyMessage="No audiobooks available"
      cardSize={cardSize}
      squareCovers={squareCovers}
    />
  );
}

export function HomeSection({
  sectionType,
  categoryId,
  categoryName,
  colorIndex,
  page,
  sectionRef,
  cardSize,
  squareCovers,
  hideAvailable,
  onToggleHideAvailable,
  onToggleSquareCovers,
  onCardSizeChange,
  onConfigOpen,
  onTotalPagesChange,
  nextRefresh,
}: HomeSectionProps) {
  const gradient = SECTION_COLORS[colorIndex % SECTION_COLORS.length];
  const title = getSectionTitle(sectionType, categoryName);

  const renderProps: RenderSectionProps = { cardSize, squareCovers, nextRefresh };

  return (
    <section ref={sectionRef} className="relative">
      {/* Sticky Section Header */}
      <div className="sticky z-30 mb-4 sm:mb-6" style={{ top: 'var(--rmab-header-h, 4rem)' }}>
        <div className="bg-white/90 dark:bg-gray-800/90 backdrop-blur-md rounded-2xl px-4 sm:px-6 py-3 border border-gray-200/50 dark:border-gray-700/50 shadow-sm">
          <div className="flex items-center gap-3">
            <div className={`w-1 h-6 bg-gradient-to-b ${gradient} rounded-full`} />
            <h2 className="text-xl sm:text-2xl md:text-3xl font-bold text-gray-900 dark:text-gray-100 truncate">
              {title}
            </h2>
            <SectionToolbar
              hideAvailable={hideAvailable}
              onToggleHideAvailable={onToggleHideAvailable}
              squareCovers={squareCovers}
              onToggleSquareCovers={onToggleSquareCovers}
              cardSize={cardSize}
              onCardSizeChange={onCardSizeChange}
            />
            {onConfigOpen && (
              <button
                onClick={onConfigOpen}
                className="p-1.5 rounded-lg text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
                aria-label="Customize home page"
                title="Customize sections"
              >
                <Cog6ToothIcon className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Section Content */}
      <div className="bg-white/40 dark:bg-gray-800/40 backdrop-blur-sm rounded-2xl p-4 sm:p-6 border border-gray-200/50 dark:border-gray-700/50 shadow-sm">
        {sectionType === 'popular' && (
          <PopularOrNewSection
            type="popular"
            page={page}
            hideAvailable={hideAvailable}
            onTotalPagesChange={onTotalPagesChange}
            {...renderProps}
          />
        )}
        {sectionType === 'new_releases' && (
          <PopularOrNewSection
            type="new-releases"
            page={page}
            hideAvailable={hideAvailable}
            onTotalPagesChange={onTotalPagesChange}
            {...renderProps}
          />
        )}
        {sectionType === 'category' && categoryId && (
          <CategorySection
            categoryId={categoryId}
            page={page}
            hideAvailable={hideAvailable}
            onTotalPagesChange={onTotalPagesChange}
            {...renderProps}
          />
        )}
      </div>
    </section>
  );
}
