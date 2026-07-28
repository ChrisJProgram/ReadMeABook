/**
 * Component: Exclusion Rule Row (F2(a))
 * Documentation: documentation/phase3/ranking-algorithm.md
 *
 * Authoring UI for a declarative title-pattern exclude rule. A release whose TITLE
 * matches the (case-insensitive) regex is HARD-EXCLUDED from automatic selection —
 * e.g. `\[VIP\]` on MyAnonamouse for a non-VIP account. Optionally scoped to one
 * indexer. Stored in the same `indexer_flag_config` array as scoring rules, tagged
 * `action: 'exclude'`.
 */

'use client';

import React from 'react';
import { IndexerFlagConfig } from '@/lib/utils/ranking-algorithm';
import { TrashIcon } from '@heroicons/react/24/outline';

interface IndexerOption {
  id: number;
  name: string;
}

interface ExcludeRuleRowProps {
  config: IndexerFlagConfig;
  indexers: IndexerOption[];
  onChange: (config: IndexerFlagConfig) => void;
  onRemove: () => void;
}

/** Validate a user-supplied regex without throwing. */
function regexError(pattern: string): string | null {
  if (!pattern.trim()) return null; // empty is "inert", flagged separately
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid regular expression';
  }
}

export function ExcludeRuleRow({ config, indexers, onChange, onRemove }: ExcludeRuleRowProps) {
  const pattern = config.pattern ?? '';
  const error = regexError(pattern);
  const isEmpty = !pattern.trim();

  const scopedIndexer =
    config.indexerId != null ? indexers.find((i) => i.id === config.indexerId) : undefined;
  const scopeLabel = config.indexerId == null
    ? 'all indexers'
    : (scopedIndexer ? scopedIndexer.name : `indexer #${config.indexerId}`);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800">
      <div className="flex items-start gap-4">
        {/* Label */}
        <div className="flex-shrink-0 w-40">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Label
          </label>
          <input
            type="text"
            value={config.name}
            onChange={(e) => onChange({ ...config, name: e.target.value })}
            placeholder="e.g. MAM VIP"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100"
          />
        </div>

        {/* Title pattern (regex) */}
        <div className="flex-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Title pattern (regex)
          </label>
          <input
            type="text"
            value={pattern}
            onChange={(e) => onChange({ ...config, pattern: e.target.value })}
            placeholder="e.g. \[VIP\]"
            aria-invalid={!!error}
            className={`w-full px-3 py-2 border rounded-md shadow-sm font-mono text-sm dark:bg-gray-700 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500 ${
              error
                ? 'border-red-400 dark:border-red-600'
                : 'border-gray-300 dark:border-gray-600'
            }`}
          />
          {error ? (
            <p className="text-xs text-red-600 dark:text-red-400 mt-1">⚠️ Invalid regex: {error}</p>
          ) : isEmpty ? (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              No pattern yet — this rule is inactive until you add one.
            </p>
          ) : (
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
              Case-insensitive. Releases matching this on {scopeLabel} are excluded from automatic
              selection (interactive search still shows them).
            </p>
          )}
        </div>

        {/* Indexer scope */}
        <div className="flex-shrink-0 w-48">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Indexer
          </label>
          <select
            value={config.indexerId ?? ''}
            onChange={(e) =>
              onChange({
                ...config,
                indexerId: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100"
          >
            <option value="">All indexers</option>
            {indexers.map((indexer) => (
              <option key={indexer.id} value={indexer.id}>
                {indexer.name}
              </option>
            ))}
            {/* Preserve a stale/unknown scope so saving never silently drops it */}
            {config.indexerId != null && !scopedIndexer && (
              <option value={config.indexerId}>indexer #{config.indexerId} (not configured)</option>
            )}
          </select>
        </div>

        {/* Remove */}
        <button
          onClick={onRemove}
          className="flex-shrink-0 mt-7 p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
          title="Remove exclusion rule"
        >
          <TrashIcon className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
