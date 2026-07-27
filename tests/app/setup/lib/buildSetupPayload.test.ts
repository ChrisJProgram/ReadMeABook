/**
 * Component: Setup Wizard Payload Builder Tests
 * Documentation: documentation/setup-wizard.md
 *
 * Regression cover for B1: the wizard built its payload inline and omitted
 * `trigger_scan_after_import` for both backends, so /api/setup/complete read
 * `undefined`, evaluated `=== true` as false, and persisted 'false' while the
 * checkbox stayed visibly ticked. The route was always correct and tested;
 * the client payload was not, which is why B1 survived two clean installs.
 */

import { describe, expect, it } from 'vitest';
import { buildSetupPayload, parseCommaSeparatedToArray, type SetupState } from '@/app/setup/lib/buildSetupPayload';

function makeState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    currentStep: 1,
    backendMode: 'audiobookshelf',
    audibleRegion: 'us' as SetupState['audibleRegion'],
    adminUsername: 'admin',
    adminPassword: 'hunter2',
    plexUrl: 'http://plex:32400',
    plexToken: 'plex-token',
    plexLibraryId: '1',
    plexTriggerScanAfterImport: false,
    absUrl: 'http://audiobookshelf:80',
    absApiToken: 'abs-token',
    absLibraryId: 'lib-1',
    absTriggerScanAfterImport: false,
    authMethod: 'manual',
    oidcProviderName: '',
    oidcIssuerUrl: '',
    oidcClientId: '',
    oidcClientSecret: '',
    oidcAccessControlMethod: '',
    oidcAccessGroupClaim: '',
    oidcAccessGroupValue: '',
    oidcAllowedEmails: '',
    oidcAllowedUsernames: '',
    oidcAdminClaimEnabled: false,
    oidcAdminClaimName: '',
    oidcAdminClaimValue: '',
    requireAdminApproval: true,
    prowlarrUrl: 'http://prowlarr:9696',
    prowlarrApiKey: 'key',
    prowlarrIndexers: [],
    downloadClients: [],
    downloadDir: '/downloads',
    mediaDir: '/audiobooks/_INBOX',
    metadataTaggingEnabled: true,
    plexFormatCoercionEnabled: true,
    chapterMergingEnabled: true,
    bookdateProvider: '',
    bookdateApiKey: '',
    bookdateModel: '',
    bookdateConfigured: false,
    plexLibraries: [],
    absLibraries: [],
    oidcTested: false,
    pathsTested: false,
    bookdateModels: [],
    validated: { plex: false, prowlarr: false, downloadClient: false, paths: false },
    ...overrides,
  } as SetupState;
}

describe('buildSetupPayload', () => {
  describe('B1: trigger_scan_after_import must reach the server', () => {
    it('sends trigger_scan_after_import=true for Audiobookshelf when the box is ticked', () => {
      const payload = buildSetupPayload(
        makeState({ backendMode: 'audiobookshelf', absTriggerScanAfterImport: true })
      );

      // The exact key the route reads (snake_case, on the audiobookshelf object).
      expect(payload.audiobookshelf).toHaveProperty('trigger_scan_after_import');
      expect(payload.audiobookshelf.trigger_scan_after_import).toBe(true);
    });

    it('sends trigger_scan_after_import=false for Audiobookshelf when unticked', () => {
      const payload = buildSetupPayload(
        makeState({ backendMode: 'audiobookshelf', absTriggerScanAfterImport: false })
      );

      expect(payload.audiobookshelf.trigger_scan_after_import).toBe(false);
    });

    it('sends trigger_scan_after_import=true for Plex when the box is ticked', () => {
      const payload = buildSetupPayload(
        makeState({ backendMode: 'plex', plexTriggerScanAfterImport: true })
      );

      expect(payload.plex).toHaveProperty('trigger_scan_after_import');
      expect(payload.plex.trigger_scan_after_import).toBe(true);
    });

    it('sends trigger_scan_after_import=false for Plex when unticked', () => {
      const payload = buildSetupPayload(
        makeState({ backendMode: 'plex', plexTriggerScanAfterImport: false })
      );

      expect(payload.plex.trigger_scan_after_import).toBe(false);
    });

    it('survives the route\'s `=== true` check (the exact B1 failure mode)', () => {
      // complete/route.ts stores: value === true ? 'true' : 'false'
      // Before the fix the key was absent -> undefined === true -> 'false'.
      const ticked = buildSetupPayload(
        makeState({ backendMode: 'audiobookshelf', absTriggerScanAfterImport: true })
      );
      const stored =
        ticked.audiobookshelf.trigger_scan_after_import === true ? 'true' : 'false';

      expect(stored).toBe('true');
    });
  });

  describe('payload shape (guards against silent field renames)', () => {
    it('builds the Audiobookshelf branch with the keys the route reads', () => {
      const payload = buildSetupPayload(makeState({ backendMode: 'audiobookshelf' }));

      expect(payload.backendMode).toBe('audiobookshelf');
      expect(payload.audiobookshelf.server_url).toBe('http://audiobookshelf:80');
      expect(payload.audiobookshelf.api_token).toBe('abs-token');
      expect(payload.audiobookshelf.library_id).toBe('lib-1');
      expect(payload.plex).toBeUndefined();
    });

    it('builds the Plex branch with the keys the route reads', () => {
      const payload = buildSetupPayload(makeState({ backendMode: 'plex' }));

      expect(payload.plex.url).toBe('http://plex:32400');
      expect(payload.plex.token).toBe('plex-token');
      expect(payload.plex.audiobook_library_id).toBe('1');
      expect(payload.audiobookshelf).toBeUndefined();
      expect(payload.admin).toEqual({ username: 'admin', password: 'hunter2' });
    });

    it('includes registration + admin for manual auth, and omits oidc', () => {
      const payload = buildSetupPayload(
        makeState({ backendMode: 'audiobookshelf', authMethod: 'manual' })
      );

      expect(payload.registration).toEqual({ enabled: true, require_admin_approval: true });
      expect(payload.admin).toEqual({ username: 'admin', password: 'hunter2' });
      expect(payload.oidc).toBeUndefined();
    });

    it('includes oidc for oidc auth, and omits registration', () => {
      const payload = buildSetupPayload(
        makeState({
          backendMode: 'audiobookshelf',
          authMethod: 'oidc',
          oidcIssuerUrl: 'https://idp.example.com',
          oidcAllowedEmails: 'a@example.com, b@example.com',
          oidcAdminClaimEnabled: true,
        })
      );

      expect(payload.oidc.issuer_url).toBe('https://idp.example.com');
      expect(payload.oidc.allowed_emails).toBe('["a@example.com","b@example.com"]');
      expect(payload.oidc.admin_claim_enabled).toBe('true');
      expect(payload.registration).toBeUndefined();
    });

    it('sends both oidc and registration for "both"', () => {
      const payload = buildSetupPayload(
        makeState({ backendMode: 'audiobookshelf', authMethod: 'both' })
      );

      expect(payload.oidc).toBeDefined();
      expect(payload.registration).toBeDefined();
    });

    it('sends bookdate only when configured', () => {
      expect(buildSetupPayload(makeState({ bookdateConfigured: false })).bookdate).toBeNull();

      const configured = buildSetupPayload(
        makeState({
          bookdateConfigured: true,
          bookdateProvider: 'anthropic',
          bookdateApiKey: 'k',
          bookdateModel: 'm',
        })
      );
      expect(configured.bookdate).toEqual({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    });

    it('passes paths and prowlarr through with snake_case keys', () => {
      const payload = buildSetupPayload(makeState());

      expect(payload.paths.download_dir).toBe('/downloads');
      expect(payload.paths.media_dir).toBe('/audiobooks/_INBOX');
      expect(payload.paths.metadata_tagging_enabled).toBe(true);
      expect(payload.prowlarr.api_key).toBe('key');
    });
  });
});

describe('parseCommaSeparatedToArray', () => {
  it('returns an empty JSON array for empty input', () => {
    expect(parseCommaSeparatedToArray('')).toBe('[]');
    expect(parseCommaSeparatedToArray('   ')).toBe('[]');
  });

  it('trims and drops empty entries', () => {
    expect(parseCommaSeparatedToArray(' a , ,b ')).toBe('["a","b"]');
  });
});
