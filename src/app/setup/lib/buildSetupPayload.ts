/**
 * Component: Setup Wizard Payload Builder
 * Documentation: documentation/setup-wizard.md
 *
 * Pure construction of the POST /api/setup/complete body from wizard state.
 *
 * Extracted from setup/page.tsx so it can be unit-tested. The wizard previously
 * built this inline and silently omitted `trigger_scan_after_import` for BOTH
 * backends (B1): the checkbox stayed ticked in the UI while the route read
 * `undefined`, evaluated `=== true` as false, and persisted 'false'. The route
 * side was always correct and covered by tests — nothing covered the client
 * payload, which is why the bug survived two clean installs.
 */

import { AudibleRegion } from '@/lib/types/audible';

export interface SelectedIndexer {
  id: number;
  name: string;
  protocol: string;
  priority: number;
  seedingTimeMinutes?: number;
  removeAfterProcessing?: boolean;
  rssEnabled: boolean;
  audiobookCategories: number[];
  ebookCategories: number[];
}

export interface SetupState {
  currentStep: number;

  // Backend selection
  backendMode: 'plex' | 'audiobookshelf';
  audibleRegion: AudibleRegion;

  // Admin account (for Plex mode and ABS + Manual mode)
  adminUsername: string;
  adminPassword: string;

  // Plex config (if mode=plex)
  plexUrl: string;
  plexToken: string;
  plexLibraryId: string;
  plexTriggerScanAfterImport: boolean;

  // Audiobookshelf config (if mode=audiobookshelf)
  absUrl: string;
  absApiToken: string;
  absLibraryId: string;
  absTriggerScanAfterImport: boolean;

  // Auth config (if mode=audiobookshelf)
  authMethod: 'oidc' | 'manual' | 'both';

  // OIDC config
  oidcProviderName: string;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcAccessControlMethod: string;
  oidcAccessGroupClaim: string;
  oidcAccessGroupValue: string;
  oidcAllowedEmails: string;
  oidcAllowedUsernames: string;
  oidcAdminClaimEnabled: boolean;
  oidcAdminClaimName: string;
  oidcAdminClaimValue: string;

  // Manual registration config
  requireAdminApproval: boolean;

  // Prowlarr, download client, paths, bookdate (common to both modes)
  prowlarrUrl: string;
  prowlarrApiKey: string;
  prowlarrIndexers: SelectedIndexer[];
  // Carried over verbatim from the wizard's original state shape; each step
  // writes its own client config object and retyping them is out of scope here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  downloadClients: any[]; // Array of download client configs
  downloadDir: string;
  mediaDir: string;
  metadataTaggingEnabled: boolean;
  plexFormatCoercionEnabled: boolean;
  chapterMergingEnabled: boolean;
  bookdateProvider: string;
  bookdateApiKey: string;
  bookdateModel: string;
  bookdateConfigured: boolean;

  // Cached UI state for back-navigation persistence
  plexLibraries: { id: string; title: string; type: string }[];
  absLibraries: { id: string; name: string; itemCount: number }[];
  oidcTested: boolean;
  pathsTested: boolean;
  bookdateModels: { id: string; name: string }[];

  validated: {
    plex: boolean;
    prowlarr: boolean;
    downloadClient: boolean;
    paths: boolean;
  };
}

/** Parse a comma-separated string into a JSON array string. */
export function parseCommaSeparatedToArray(str: string): string {
  if (!str || str.trim() === '') return '[]';
  const items = str.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return JSON.stringify(items);
}

/**
 * Build the request body for POST /api/setup/complete.
 *
 * The route reads snake_case keys off `payload.plex` / `payload.audiobookshelf`,
 * so the field names here are load-bearing — they must match
 * src/app/api/setup/complete/route.ts exactly.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the request body is a
   heterogeneous JSON document assembled conditionally per backend/auth mode;
   the server parses it dynamically, so a narrow static type here would only be
   re-widened at the fetch boundary. */
export function buildSetupPayload(state: SetupState): Record<string, any> {
  const payload: Record<string, any> = {
    backendMode: state.backendMode,
    audibleRegion: state.audibleRegion,
    prowlarr: {
      url: state.prowlarrUrl,
      api_key: state.prowlarrApiKey,
      indexers: state.prowlarrIndexers,
    },
    downloadClient: state.downloadClients, // Send array of clients
    paths: {
      download_dir: state.downloadDir,
      media_dir: state.mediaDir,
      metadata_tagging_enabled: state.metadataTaggingEnabled,
      plex_format_coercion_enabled: state.plexFormatCoercionEnabled,
      chapter_merging_enabled: state.chapterMergingEnabled,
    },
    bookdate: state.bookdateConfigured
      ? {
          provider: state.bookdateProvider,
          apiKey: state.bookdateApiKey,
          model: state.bookdateModel,
        }
      : null,
  };

  if (state.backendMode === 'plex') {
    // Plex mode configuration
    payload.admin = {
      username: state.adminUsername,
      password: state.adminPassword,
    };
    payload.plex = {
      url: state.plexUrl,
      token: state.plexToken,
      audiobook_library_id: state.plexLibraryId,
      // B1: must be sent, or the route persists 'false' despite a ticked box.
      trigger_scan_after_import: state.plexTriggerScanAfterImport === true,
    };
  } else {
    // Audiobookshelf mode configuration
    payload.audiobookshelf = {
      server_url: state.absUrl,
      api_token: state.absApiToken,
      library_id: state.absLibraryId,
      // B1: on this backend the flag is the ONLY way ABS learns about imports
      // when its filesystem watcher is dead (9p/DrvFs mounts), so silently
      // storing 'false' here breaks every import notification.
      trigger_scan_after_import: state.absTriggerScanAfterImport === true,
    };

    payload.authMethod = state.authMethod;

    // OIDC configuration
    if (state.authMethod === 'oidc' || state.authMethod === 'both') {
      payload.oidc = {
        provider_name: state.oidcProviderName,
        issuer_url: state.oidcIssuerUrl,
        client_id: state.oidcClientId,
        client_secret: state.oidcClientSecret,
        access_control_method: state.oidcAccessControlMethod,
        access_group_claim: state.oidcAccessGroupClaim,
        access_group_value: state.oidcAccessGroupValue,
        allowed_emails: parseCommaSeparatedToArray(state.oidcAllowedEmails),
        allowed_usernames: parseCommaSeparatedToArray(state.oidcAllowedUsernames),
        admin_claim_enabled: state.oidcAdminClaimEnabled ? 'true' : 'false',
        admin_claim_name: state.oidcAdminClaimName,
        admin_claim_value: state.oidcAdminClaimValue,
      };
    }

    // Manual registration configuration
    if (state.authMethod === 'manual' || state.authMethod === 'both') {
      payload.registration = {
        enabled: true,
        require_admin_approval: state.requireAdminApproval,
      };

      // Create admin account for manual auth
      payload.admin = {
        username: state.adminUsername,
        password: state.adminPassword,
      };
    }
  }

  return payload;
}
