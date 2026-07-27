/**
 * Component: SearchBar (reusable)
 * Documentation: documentation/frontend/components.md
 *
 * Presentational, fully-controlled search input extracted from the search page
 * (F4) so the same control can be reused in the header on every page. The parent
 * owns the query state and decides what typing/submit does — live results on the
 * search page, navigate to /search?q=… from the header.
 */

'use client';

import React from 'react';

export type SearchBarVariant = 'page' | 'header';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Called on form submit. If omitted, submit is a no-op (preventDefault only). */
  onSubmit?: (e: React.FormEvent) => void;
  /** Called when the clear (×) button is clicked. Defaults to onChange(''). */
  onClear?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  variant?: SearchBarVariant;
  className?: string;
  ariaLabel?: string;
}

const INPUT_STYLES: Record<SearchBarVariant, string> = {
  page: 'w-full pl-12 pr-12 py-4 text-lg border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400',
  header: 'w-full pl-10 pr-9 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 dark:bg-gray-700/60 text-gray-900 dark:text-gray-100 placeholder-gray-400',
};

const ICON_WRAP: Record<SearchBarVariant, string> = { page: 'pl-4', header: 'pl-3' };
const ICON_SIZE: Record<SearchBarVariant, string> = { page: 'h-5 w-5', header: 'h-4 w-4' };
const CLEAR_WRAP: Record<SearchBarVariant, string> = { page: 'pr-4', header: 'pr-2.5' };

export function SearchBar({
  value,
  onChange,
  onSubmit,
  onClear,
  placeholder = 'Search by title, author, or narrator...',
  autoFocus = false,
  variant = 'page',
  className = '',
  ariaLabel = 'Search audiobooks',
}: SearchBarProps) {
  const handleSubmit = (e: React.FormEvent) => {
    if (onSubmit) {
      onSubmit(e);
    } else {
      e.preventDefault();
    }
  };

  const handleClear = () => {
    if (onClear) {
      onClear();
    } else {
      onChange('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className={className} role="search">
      <div className="relative">
        <div
          className={`absolute inset-y-0 left-0 ${ICON_WRAP[variant]} flex items-center pointer-events-none`}
        >
          <svg
            className={`${ICON_SIZE[variant]} text-gray-400`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={INPUT_STYLES[variant]}
          autoFocus={autoFocus}
        />
        {value && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear search"
            className={`absolute inset-y-0 right-0 ${CLEAR_WRAP[variant]} flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200`}
          >
            <svg
              className={ICON_SIZE[variant]}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
