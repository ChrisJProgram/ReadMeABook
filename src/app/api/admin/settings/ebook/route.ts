/**
 * Component: E-book Sidecar Settings API
 * Documentation: documentation/integrations/ebook-sidecar.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.Settings.Ebook');

export async function PUT(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        // Parse request body - new structure with separate source toggles
        const {
          annasArchiveEnabled, indexerSearchEnabled, format, baseUrl, flaresolverrUrl,
          autoGrabEnabled, kindleFixEnabled,
          // F5: Libgen source + per-source priority ordering (G1)
          libgenEnabled, libgenBaseUrl, libgenPriority, indexerPriority, annasArchivePriority,
          // F6: quality gate action (off | flag | reject)
          qualityGate,
        } = await request.json();

        // F6: validate gate action
        const validGateActions = ['off', 'flag', 'reject'];
        if (qualityGate !== undefined && !validGateActions.includes(qualityGate)) {
          return NextResponse.json(
            { error: `Invalid qualityGate. Must be one of: ${validGateActions.join(', ')}` },
            { status: 400 }
          );
        }

        // Enforce: auto-grab must be false if no sources are enabled
        const effectiveAutoGrabEnabled =
          (libgenEnabled || annasArchiveEnabled || indexerSearchEnabled)
            ? (autoGrabEnabled ?? true)
            : false;

        // Normalize priorities to sane integers (1-99); fall back to defaults.
        const clampPriority = (v: unknown, fallback: number): number => {
          const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
          if (!Number.isFinite(n)) return fallback;
          return Math.min(99, Math.max(1, Math.trunc(n)));
        };
        const libgenPri = clampPriority(libgenPriority, 10);
        const indexerPri = clampPriority(indexerPriority, 20);
        const annasPri = clampPriority(annasArchivePriority, 30);

        // Validate libgenBaseUrl if provided
        if (libgenEnabled && libgenBaseUrl && !String(libgenBaseUrl).startsWith('http')) {
          return NextResponse.json(
            { error: 'Libgen base URL must start with http:// or https://' },
            { status: 400 }
          );
        }

        // Validate format
        const validFormats = ['epub', 'pdf', 'mobi', 'azw3', 'any'];
        if (format && !validFormats.includes(format)) {
          return NextResponse.json(
            { error: `Invalid format. Must be one of: ${validFormats.join(', ')}` },
            { status: 400 }
          );
        }

        // Validate baseUrl (basic check) - only required if Anna's Archive is enabled
        if (annasArchiveEnabled && baseUrl && !baseUrl.startsWith('http')) {
          return NextResponse.json(
            { error: 'Base URL must start with http:// or https://' },
            { status: 400 }
          );
        }

        // Validate flaresolverrUrl if provided
        if (flaresolverrUrl && !flaresolverrUrl.startsWith('http')) {
          return NextResponse.json(
            { error: 'FlareSolverr URL must start with http:// or https://' },
            { status: 400 }
          );
        }

        // Save configuration
        const { getConfigService } = await import('@/lib/services/config.service');
        const configService = getConfigService();

        const configs = [
          // New granular source toggles
          {
            key: 'ebook_libgen_enabled',
            value: libgenEnabled ? 'true' : 'false',
            category: 'ebook',
            description: 'Enable e-book downloads from Libgen (direct mirror)',
          },
          {
            key: 'ebook_annas_archive_enabled',
            value: annasArchiveEnabled ? 'true' : 'false',
            category: 'ebook',
            description: 'Enable e-book downloads from Anna\'s Archive',
          },
          {
            key: 'ebook_indexer_search_enabled',
            value: indexerSearchEnabled ? 'true' : 'false',
            category: 'ebook',
            description: 'Enable e-book downloads via indexer search (Prowlarr)',
          },
          // Per-source priority (lower = tried first). F5 G1.
          {
            key: 'ebook_libgen_priority',
            value: String(libgenPri),
            category: 'ebook',
            description: 'Libgen source priority (lower is tried first)',
          },
          {
            key: 'ebook_indexer_priority',
            value: String(indexerPri),
            category: 'ebook',
            description: 'Indexer-search source priority (lower is tried first)',
          },
          {
            key: 'ebook_annas_archive_priority',
            value: String(annasPri),
            category: 'ebook',
            description: 'Anna\'s Archive source priority (lower is tried first)',
          },
          // Libgen mirror base URL
          {
            key: 'ebook_libgen_base_url',
            value: libgenBaseUrl || 'https://libgen.bz',
            category: 'ebook',
            description: 'Base URL for the Libgen mirror',
          },
          // General settings
          {
            key: 'ebook_sidecar_preferred_format',
            value: format || 'epub',
            category: 'ebook',
            description: 'Preferred e-book format',
          },
          {
            key: 'ebook_auto_grab_enabled',
            value: effectiveAutoGrabEnabled ? 'true' : 'false',
            category: 'ebook',
            description: 'Automatically create ebook requests after audiobook downloads complete',
          },
          // Anna's Archive specific settings
          {
            key: 'ebook_sidecar_base_url',
            value: baseUrl || 'https://annas-archive.gl',
            category: 'ebook',
            description: 'Base URL for Anna\'s Archive',
          },
          {
            key: 'ebook_sidecar_flaresolverr_url',
            value: flaresolverrUrl || '',
            category: 'ebook',
            description: 'FlareSolverr URL for bypassing Cloudflare protection',
          },
          // Kindle compatibility
          {
            key: 'ebook_kindle_fix_enabled',
            value: kindleFixEnabled ? 'true' : 'false',
            category: 'ebook',
            description: 'Apply compatibility fixes to EPUB files for Kindle import',
          },
          // F6: quality gate (page-scan / no-chapters detection at import)
          {
            key: 'ebook_quality_gate',
            value: qualityGate || 'flag',
            category: 'ebook',
            description: 'Ebook quality gate action: off, flag (annotate record), or reject (blocklist + re-search on strong page-scan verdict)',
          },
        ];

        await configService.setMany(configs);

        return NextResponse.json({ success: true });
      } catch (error) {
        logger.error('Failed to save e-book settings', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json(
          { error: 'Failed to save settings' },
          { status: 500 }
        );
      }
    });
  });
}
