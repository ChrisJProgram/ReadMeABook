/**
 * Component: Ebook Source Order Resolver
 * Documentation: documentation/integrations/ebook-sidecar.md
 *
 * Single source of truth for F5's config-driven ebook source ordering (decision
 * G1: per-source priority integers, mirroring F3's per-indexer tier model). The
 * automatic search processor and both auto-grab gate checks call this so
 * "is any source enabled?" and "in what order?" are answered identically
 * everywhere.
 *
 * Three sources:
 *  - 'libgen'         — direct Libgen mirror (F5 primary)
 *  - 'indexer'        — Prowlarr indexer search (MAM is the ebook indexer)
 *  - 'annas_archive'  — Anna's Archive direct (G2: kept as last-resort fallback,
 *                       default OFF)
 *
 * Lower priority number = tried first. Enabled sources are returned sorted
 * ascending by priority; ties fall back to a stable default order.
 */

export type EbookSourceId = 'libgen' | 'indexer' | 'annas_archive';

export interface EbookSourceConfig {
  id: EbookSourceId;
  enabled: boolean;
  priority: number;
}

/** Default priorities: Libgen first, indexer (MAM) second, Anna's last. */
export const DEFAULT_EBOOK_PRIORITY: Record<EbookSourceId, number> = {
  libgen: 10,
  indexer: 20,
  annas_archive: 30,
};

/** Stable tiebreak when two enabled sources share a priority. */
const TIEBREAK_ORDER: Record<EbookSourceId, number> = {
  libgen: 0,
  indexer: 1,
  annas_archive: 2,
};

export interface EbookSourceOrderResult {
  /** Enabled sources, sorted by priority ascending (first = tried first). */
  ordered: EbookSourceConfig[];
  anyEnabled: boolean;
  libgenEnabled: boolean;
  indexerEnabled: boolean;
  annasEnabled: boolean;
}

// Minimal shape we need from the config service (keeps this unit-testable).
interface ConfigReader {
  getMany(keys: string[]): Promise<Record<string, string | null>>;
}

function parsePriority(raw: string | null | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read the ebook source configuration and produce the ordered, enabled list.
 */
export async function resolveEbookSourceOrder(
  configService: ConfigReader
): Promise<EbookSourceOrderResult> {
  const cfg = await configService.getMany([
    'ebook_libgen_enabled',
    'ebook_libgen_priority',
    'ebook_indexer_search_enabled',
    'ebook_indexer_priority',
    'ebook_annas_archive_enabled',
    'ebook_annas_archive_priority',
    // Legacy back-compat: pre-F5 installs used ebook_sidecar_enabled to mean
    // "Anna's Archive on" before the granular key existed.
    'ebook_sidecar_enabled',
  ]);

  const libgenEnabled = cfg['ebook_libgen_enabled'] === 'true';
  const indexerEnabled = cfg['ebook_indexer_search_enabled'] === 'true';
  const annasEnabled =
    cfg['ebook_annas_archive_enabled'] === 'true' ||
    (cfg['ebook_annas_archive_enabled'] == null && cfg['ebook_sidecar_enabled'] === 'true');

  const all: EbookSourceConfig[] = [
    {
      id: 'libgen',
      enabled: libgenEnabled,
      priority: parsePriority(cfg['ebook_libgen_priority'], DEFAULT_EBOOK_PRIORITY.libgen),
    },
    {
      id: 'indexer',
      enabled: indexerEnabled,
      priority: parsePriority(cfg['ebook_indexer_priority'], DEFAULT_EBOOK_PRIORITY.indexer),
    },
    {
      id: 'annas_archive',
      enabled: annasEnabled,
      priority: parsePriority(
        cfg['ebook_annas_archive_priority'],
        DEFAULT_EBOOK_PRIORITY.annas_archive
      ),
    },
  ];

  const ordered = all
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority || TIEBREAK_ORDER[a.id] - TIEBREAK_ORDER[b.id]);

  return {
    ordered,
    anyEnabled: ordered.length > 0,
    libgenEnabled,
    indexerEnabled,
    annasEnabled,
  };
}

/** Human-readable source label for logs and user-facing "no results" messages. */
export function ebookSourceLabel(id: EbookSourceId): string {
  switch (id) {
    case 'libgen':
      return 'Libgen';
    case 'indexer':
      return 'Indexer Search';
    case 'annas_archive':
      return "Anna's Archive";
  }
}
