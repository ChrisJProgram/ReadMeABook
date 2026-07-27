/**
 * Component: Admin Settings - Tab Validation (B2) Tests
 * Documentation: documentation/settings-pages.md
 *
 * Regression cover for B2: every tab demanded a fresh "Test" before Save became
 * clickable, so toggling a pure behaviour checkbox (Trigger scan after import,
 * chapter merging, remote path mapping) left Save greyed out — users ticked a
 * box, clicked a dead button, and believed it saved.
 *
 * Contract under test: a tab requires a fresh successful test ONLY when its
 * connection-relevant fields changed.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/api', () => ({
  fetchWithAuth: vi.fn(),
}));

const baseSettings: any = {
  backendMode: 'plex',
  hasLocalUsers: true,
  hasLocalAdmins: true,
  audibleRegion: 'us',
  plex: { url: 'http://plex', token: 'token', libraryId: 'lib', triggerScanAfterImport: false },
  audiobookshelf: {
    serverUrl: 'http://abs',
    apiToken: 'abs-token',
    libraryId: 'abs-lib',
    triggerScanAfterImport: false,
  },
  oidc: { enabled: false },
  registration: { enabled: true, requireAdminApproval: false },
  prowlarr: { url: 'http://prowlarr', apiKey: 'key' },
  indexerOptions: { skipUnreleased: true },
  downloadClient: {
    type: 'qbittorrent',
    url: 'http://qb',
    username: 'user',
    password: 'pass',
    disableSSLVerify: false,
    remotePathMappingEnabled: false,
    remotePath: '',
    localPath: '',
  },
  paths: {
    downloadDir: '/downloads',
    mediaDir: '/media',
    audiobookPathTemplate: '',
    ebookPathTemplate: '',
    metadataTaggingEnabled: true,
    plexFormatCoercionEnabled: false,
    chapterMergingEnabled: false,
    fileRenameEnabled: false,
  },
  ebook: {},
};

/** Nothing has been tested this session — the state a user is normally in. */
const nothingValidated = {
  plex: false,
  audiobookshelf: false,
  oidc: false,
  registration: false,
  prowlarr: false,
  download: false,
  paths: false,
};

const clone = (s: any) => JSON.parse(JSON.stringify(s));

async function validate(tab: any, settings: any, original: any, validated = nothingValidated) {
  const { getTabValidation } = await import('@/app/admin/settings/lib/helpers');
  return getTabValidation(tab, settings, original, validated);
}

describe('getTabValidation — B2: behaviour edits must not require a re-test', () => {
  describe('library tab', () => {
    it('allows saving when only triggerScanAfterImport was toggled (Plex)', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.plex.triggerScanAfterImport = true;

      expect(await validate('library', settings, original)).toBe(true);
    });

    it('allows saving when only triggerScanAfterImport was toggled (Audiobookshelf)', async () => {
      const original = clone(baseSettings);
      original.backendMode = 'audiobookshelf';
      const settings = clone(original);
      settings.audiobookshelf.triggerScanAfterImport = true;

      expect(await validate('library', settings, original)).toBe(true);
    });

    it('allows saving when only the library selection changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.plex.libraryId = 'another-lib';

      expect(await validate('library', settings, original)).toBe(true);
    });

    it('still requires a test when the Plex URL changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.plex.url = 'http://plex-new';

      expect(await validate('library', settings, original)).toBe(false);
      expect(
        await validate('library', settings, original, { ...nothingValidated, plex: true })
      ).toBe(true);
    });

    it('still requires a test when the ABS token changed', async () => {
      const original = clone(baseSettings);
      original.backendMode = 'audiobookshelf';
      const settings = clone(original);
      settings.audiobookshelf.apiToken = 'rotated';

      expect(await validate('library', settings, original)).toBe(false);
      expect(
        await validate('library', settings, original, {
          ...nothingValidated,
          audiobookshelf: true,
        })
      ).toBe(true);
    });

    it('requires a test when the backend mode itself changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.backendMode = 'audiobookshelf';

      expect(await validate('library', settings, original)).toBe(false);
    });

    it('falls back to requiring a test when there is no baseline', async () => {
      expect(await validate('library', clone(baseSettings), null)).toBe(false);
    });
  });

  describe('paths tab', () => {
    it('allows saving when only chapter merging was toggled', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.paths.chapterMergingEnabled = true;

      expect(await validate('paths', settings, original)).toBe(true);
    });

    it('allows saving when only a path template changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.paths.audiobookPathTemplate = '{author}/{title}';

      expect(await validate('paths', settings, original)).toBe(true);
    });

    it('still requires a test when a directory changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.paths.mediaDir = '/media/new';

      expect(await validate('paths', settings, original)).toBe(false);
      expect(
        await validate('paths', settings, original, { ...nothingValidated, paths: true })
      ).toBe(true);
    });
  });

  describe('download tab', () => {
    it('allows saving when only remote path mapping changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.downloadClient.remotePathMappingEnabled = true;
      settings.downloadClient.remotePath = '/home/user/downloads/';
      settings.downloadClient.localPath = '/downloads/';

      expect(await validate('download', settings, original)).toBe(true);
    });

    it('still requires a test when the client password changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.downloadClient.password = 'rotated';

      expect(await validate('download', settings, original)).toBe(false);
      expect(
        await validate('download', settings, original, { ...nothingValidated, download: true })
      ).toBe(true);
    });

    it('still requires a test when the client URL changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.downloadClient.url = 'http://qb-new';

      expect(await validate('download', settings, original)).toBe(false);
    });
  });

  describe('unchanged behaviour (guards against over-correction)', () => {
    it('prowlarr still requires a test when the API key changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.prowlarr.apiKey = 'new-key';

      expect(await validate('prowlarr', settings, original)).toBe(false);
    });

    it('prowlarr allows saving when only indexers changed', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);

      expect(await validate('prowlarr', settings, original)).toBe(true);
    });

    it('auth still requires OIDC validation when OIDC is enabled', async () => {
      const original = clone(baseSettings);
      const settings = clone(baseSettings);
      settings.oidc.enabled = true;

      expect(await validate('auth', settings, original)).toBe(false);
      expect(await validate('auth', settings, original, { ...nothingValidated, oidc: true })).toBe(
        true
      );
    });

    it('self-saving tabs remain always-valid', async () => {
      const s = clone(baseSettings);
      expect(await validate('ebook', s, s)).toBe(true);
      expect(await validate('bookdate', s, s)).toBe(true);
      expect(await validate('api', s, s)).toBe(true);
    });
  });
});
