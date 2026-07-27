/**
 * Component: Admin Settings - Helper Functions
 * Documentation: documentation/settings-pages.md
 */

import { fetchWithAuth } from '@/lib/utils/api';
import type { Settings, SettingsTab, SavedIndexerConfig } from './types';
import type { IndexerFlagConfig } from '@/lib/utils/ranking-algorithm';

/**
 * Converts JSON array string to comma-separated string for display
 */
export const parseArrayToCommaSeparated = (jsonStr: string): string => {
  try {
    const arr = JSON.parse(jsonStr);
    return Array.isArray(arr) ? arr.join(', ') : '';
  } catch {
    return '';
  }
};

/**
 * Converts comma-separated string to JSON array string for storage
 */
export const parseCommaSeparatedToArray = (str: string): string => {
  if (!str || str.trim() === '') return '[]';
  const items = str.split(',').map(s => s.trim()).filter(s => s.length > 0);
  return JSON.stringify(items);
};

/**
 * Saves settings for a specific tab
 */
export const saveTabSettings = async (
  activeTab: SettingsTab,
  settings: Settings,
  configuredIndexers: SavedIndexerConfig[],
  flagConfigs: IndexerFlagConfig[]
): Promise<void> => {
  switch (activeTab) {
    case 'library':
      // Save Audible region
      await fetchWithAuth('/api/admin/settings/audible', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: settings.audibleRegion }),
      }).then(res => {
        if (!res.ok) throw new Error('Failed to save Audible region settings');
      });

      // Save backend-specific settings
      if (settings.backendMode === 'plex') {
        await fetchWithAuth('/api/admin/settings/plex', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings.plex),
        }).then(res => {
          if (!res.ok) throw new Error('Failed to save Plex settings');
        });
      } else {
        await fetchWithAuth('/api/admin/settings/audiobookshelf', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings.audiobookshelf),
        }).then(res => {
          if (!res.ok) throw new Error('Failed to save Audiobookshelf settings');
        });
      }
      break;

    case 'auth':
      // Always save OIDC settings (including enabled/disabled state)
      const oidcPayload = {
        ...settings.oidc,
        allowedEmails: parseCommaSeparatedToArray(settings.oidc.allowedEmails),
        allowedUsernames: parseCommaSeparatedToArray(settings.oidc.allowedUsernames),
      };

      await fetchWithAuth('/api/admin/settings/oidc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(oidcPayload),
      }).then(res => {
        if (!res.ok) throw new Error('Failed to save OIDC settings');
      });

      // Save registration settings
      await fetchWithAuth('/api/admin/settings/registration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings.registration),
      }).then(res => {
        if (!res.ok) throw new Error('Failed to save registration settings');
      });
      break;

    case 'prowlarr':
      // Save Prowlarr URL and API key
      await fetchWithAuth('/api/admin/settings/prowlarr', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings.prowlarr),
      }).then(res => {
        if (!res.ok) throw new Error('Failed to save Prowlarr settings');
      });

      // Save indexer configuration and flag configs
      const indexersForSave = configuredIndexers.map(idx => ({ ...idx, enabled: true }));
      await fetchWithAuth('/api/admin/settings/prowlarr/indexers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indexers: indexersForSave, flagConfigs }),
      }).then(res => {
        if (!res.ok) throw new Error('Failed to save indexer configuration');
      });

      // Save indexer-wide options (auto-search behavior, etc.)
      await fetchWithAuth('/api/admin/settings/indexer-options', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skipUnreleased: settings.indexerOptions.skipUnreleased,
        }),
      }).then(res => {
        if (!res.ok) throw new Error('Failed to save indexer options');
      });
      break;

    case 'download':
      await fetchWithAuth('/api/admin/settings/download-client', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings.downloadClient),
      }).then(res => {
        if (!res.ok) throw new Error('Failed to save download client settings');
      });
      break;

    case 'paths':
      await fetchWithAuth('/api/admin/settings/paths', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings.paths),
      }).then(res => {
        if (!res.ok) throw new Error('Failed to save paths settings');
      });
      break;

    default:
      throw new Error('Unknown settings tab or tab handles its own saving');
  }
};

/**
 * Validates that authentication is properly configured in Audiobookshelf mode
 */
export const validateAuthSettings = (settings: Settings): { valid: boolean; message?: string } => {
  if (settings.backendMode === 'audiobookshelf') {
    // Case 1: No auth methods enabled and no local users - complete lockout
    if (!settings.oidc.enabled && !settings.registration.enabled && !settings.hasLocalUsers) {
      return {
        valid: false,
        message: 'At least one authentication method must be enabled (OIDC or Manual Registration) since no local users exist. Otherwise, you will be locked out of the system.',
      };
    }

    // Case 2: Only manual registration enabled, but no local admin users
    // This would allow new registrations, but no one can access admin features or approve registrations
    if (!settings.oidc.enabled && settings.registration.enabled && !settings.hasLocalAdmins) {
      return {
        valid: false,
        message: 'Manual registration is enabled but no local admin users exist. New users will be able to register but you will be locked out of admin features. Please enable OIDC or ensure at least one local admin user exists.',
      };
    }
  }
  return { valid: true };
};

/**
 * Fields whose change genuinely invalidates a previous connection test.
 *
 * B2: every tab used to demand a fresh "Test" before Save became clickable, so
 * toggling a pure behaviour checkbox (e.g. "Trigger scan after import", "Chapter
 * merging") left Save greyed out with its reason rendered far below the fold —
 * users ticked a box, clicked a dead button, and believed it saved. Only the
 * fields below are actually exercised by a connection/path test; everything else
 * on these tabs is a local preference that the test never touched.
 *
 * The `prowlarr` tab already worked this way; this generalises that precedent.
 */
const CONNECTION_FIELDS = {
  plex: ['url', 'token'] as const,
  audiobookshelf: ['serverUrl', 'apiToken'] as const,
  prowlarr: ['url', 'apiKey'] as const,
  downloadClient: ['type', 'url', 'username', 'password', 'disableSSLVerify'] as const,
  paths: ['downloadDir', 'mediaDir'] as const,
};

/** True when any connection-relevant field differs between current and original. */
const connectionChanged = <T>(
  current: T,
  original: T,
  fields: readonly (keyof T)[]
): boolean => fields.some((field) => current[field] !== original[field]);

/**
 * Gets validation status for the current tab.
 *
 * Contract: a tab requires a fresh successful test ONLY when its connection
 * details changed. Behaviour-only edits save immediately.
 */
export const getTabValidation = (
  activeTab: SettingsTab,
  settings: Settings,
  originalSettings: Settings | null,
  validated: {
    plex: boolean;
    audiobookshelf: boolean;
    oidc: boolean;
    registration: boolean;
    prowlarr: boolean;
    download: boolean;
    paths: boolean;
  }
): boolean => {
  switch (activeTab) {
    case 'library': {
      const isPlex = settings.backendMode === 'plex';
      const tabValidated = isPlex ? validated.plex : validated.audiobookshelf;

      // No baseline to compare against -> fall back to requiring a test.
      if (!originalSettings) return tabValidated;

      // Switching backend mode entirely always needs a test.
      if (settings.backendMode !== originalSettings.backendMode) return tabValidated;

      const changed = isPlex
        ? connectionChanged(settings.plex, originalSettings.plex, CONNECTION_FIELDS.plex)
        : connectionChanged(
            settings.audiobookshelf,
            originalSettings.audiobookshelf,
            CONNECTION_FIELDS.audiobookshelf
          );

      // libraryId / triggerScanAfterImport are picked or toggled AFTER a good
      // connection - they don't invalidate it.
      return changed ? tabValidated : true;
    }
    case 'auth':
      // If OIDC is enabled, it must be validated
      // If OIDC is disabled, we don't require validation for it
      // Registration doesn't require explicit validation (just a toggle)
      if (settings.oidc.enabled) {
        return validated.oidc;
      }
      // If OIDC is disabled, allow saving without validation
      return true;
    case 'prowlarr': {
      // Only require validation if URL or API key changed
      // If only indexers/flags changed, allow saving without test
      if (!originalSettings) return validated.prowlarr;

      const changed = connectionChanged(
        settings.prowlarr,
        originalSettings.prowlarr,
        CONNECTION_FIELDS.prowlarr
      );

      return changed ? validated.prowlarr : true;
    }
    case 'download': {
      if (!originalSettings) return validated.download;

      // Remote path mapping is a translation setting, not part of the client
      // handshake - the connection test never exercises it.
      const changed = connectionChanged(
        settings.downloadClient,
        originalSettings.downloadClient,
        CONNECTION_FIELDS.downloadClient
      );

      return changed ? validated.download : true;
    }
    case 'paths': {
      if (!originalSettings) return validated.paths;

      // Only the directories are probed for existence/writability; templates and
      // processing toggles are not.
      const changed = connectionChanged(
        settings.paths,
        originalSettings.paths,
        CONNECTION_FIELDS.paths
      );

      return changed ? validated.paths : true;
    }
    case 'ebook':
    case 'bookdate':
    case 'api':
      return true; // These tabs handle their own saving
    default:
      return false;
  }
};

/**
 * Gets tab configuration based on backend mode
 */
export const getTabs = (backendMode: 'plex' | 'audiobookshelf') => [
  { id: 'library' as const, label: backendMode === 'plex' ? 'Plex' : 'Audiobookshelf', icon: '📺' },
  ...(backendMode === 'audiobookshelf' ? [{ id: 'auth' as const, label: 'Authentication', icon: '🔐' }] : []),
  { id: 'prowlarr' as const, label: 'Indexers', icon: '🔍' },
  { id: 'download' as const, label: 'Download Client', icon: '⬇️' },
  { id: 'paths' as const, label: 'Paths', icon: '📁' },
  { id: 'ebook' as const, label: 'E-book Sidecar', icon: '📖' },
  { id: 'bookdate' as const, label: 'BookDate', icon: '📚' },
  { id: 'notifications' as const, label: 'Notifications', icon: '🔔' },
  { id: 'api' as const, label: 'API', icon: '🔑' },
];
