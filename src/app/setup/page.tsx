/**
 * Component: Setup Wizard Page
 * Documentation: documentation/setup-wizard.md
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { WizardLayout } from './components/WizardLayout';
import { WelcomeStep } from './steps/WelcomeStep';
import { BackendSelectionStep } from './steps/BackendSelectionStep';
import { AdminAccountStep } from './steps/AdminAccountStep';
import { PlexStep } from './steps/PlexStep';
import { AudiobookshelfStep } from './steps/AudiobookshelfStep';
import { AuthMethodStep } from './steps/AuthMethodStep';
import { OIDCConfigStep } from './steps/OIDCConfigStep';
import { RegistrationSettingsStep } from './steps/RegistrationSettingsStep';
import { ProwlarrStep } from './steps/ProwlarrStep';
import { DownloadClientStep } from './steps/DownloadClientStep';
import { PathsStep } from './steps/PathsStep';
import { BookDateStep } from './steps/BookDateStep';
import { ReviewStep } from './steps/ReviewStep';
import { FinalizeStep } from './steps/FinalizeStep';
import { buildSetupPayload, type SetupState } from './lib/buildSetupPayload';

export default function SetupWizard() {
  const router = useRouter();
  const [state, setState] = useState<SetupState>({
    currentStep: 1,

    // Backend selection
    backendMode: 'plex',
    audibleRegion: 'us',

    // Admin account
    adminUsername: 'admin',
    adminPassword: '',

    // Plex config
    plexUrl: '',
    plexToken: '',
    plexLibraryId: '',
    plexTriggerScanAfterImport: false,

    // Audiobookshelf config
    absUrl: '',
    absApiToken: '',
    absLibraryId: '',
    absTriggerScanAfterImport: false,

    // Auth config
    authMethod: 'oidc',

    // OIDC config
    oidcProviderName: 'Authentik',
    oidcIssuerUrl: '',
    oidcClientId: '',
    oidcClientSecret: '',
    oidcAccessControlMethod: 'open',
    oidcAccessGroupClaim: 'groups',
    oidcAccessGroupValue: '',
    oidcAllowedEmails: '',
    oidcAllowedUsernames: '',
    oidcAdminClaimEnabled: false,
    oidcAdminClaimName: 'groups',
    oidcAdminClaimValue: '',

    // Manual registration config
    requireAdminApproval: true,

    // Common config
    prowlarrUrl: '',
    prowlarrApiKey: '',
    prowlarrIndexers: [],
    downloadClients: [], // Empty array - user will add clients in wizard
    downloadDir: '/downloads',
    mediaDir: '/media/audiobooks',
    metadataTaggingEnabled: true,
    plexFormatCoercionEnabled: true,
    chapterMergingEnabled: false,
    bookdateProvider: 'openai',
    bookdateApiKey: '',
    bookdateModel: '',
    bookdateConfigured: false,

    // Cached UI state for back-navigation persistence
    plexLibraries: [],
    absLibraries: [],
    oidcTested: false,
    pathsTested: false,
    bookdateModels: [],

    validated: {
      plex: false,
      prowlarr: false,
      downloadClient: false,
      paths: false,
    },
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupHasAdminTokens, setSetupHasAdminTokens] = useState(false);

  // Calculate total steps based on backend mode and auth method
  const getTotalSteps = () => {
    if (state.backendMode === 'plex') {
      // Plex mode: Welcome, Backend, Admin, Plex, Prowlarr, Download, Paths, BookDate, Review, Finalize
      return 10;
    } else {
      // ABS mode: base steps + conditional auth steps
      let steps = 10; // Welcome, Backend, ABS, Auth Method, Prowlarr, Download, Paths, BookDate, Review, Finalize
      if (state.authMethod === 'oidc' || state.authMethod === 'both') {
        steps += 1; // OIDC Config
      }
      if (state.authMethod === 'manual' || state.authMethod === 'both') {
        steps += 2; // Registration Settings + Admin Account
      }
      return steps;
    }
  };

  const totalSteps = getTotalSteps();

  const updateState = (updates: Partial<SetupState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  };

  const updateField = (field: string, value: any) => {
    setState((prev) => ({ ...prev, [field]: value }));
  };

  const goToStep = (step: number) => {
    setState((prev) => ({ ...prev, currentStep: step }));
    setError(null);
  };

  const completeSetup = async () => {
    setLoading(true);
    setError(null);

    try {
      const payload = buildSetupPayload(state);

      const response = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to complete setup');
      }

      const data = await response.json();

      // Store admin auth tokens (if provided)
      if (data.accessToken && data.refreshToken) {
        // Clear any old tokens first to avoid conflicts
        localStorage.clear();

        localStorage.setItem('accessToken', data.accessToken);
        localStorage.setItem('refreshToken', data.refreshToken);
        localStorage.setItem('user', JSON.stringify(data.user));

        // Mark that we have admin tokens for FinalizeStep
        setSetupHasAdminTokens(true);

        // Go to finalize step to run initial jobs
        goToStep(totalSteps);
      } else {
        // OIDC-only mode - clear localStorage to remove stale tokens
        localStorage.clear();

        // Mark that we don't have admin tokens
        setSetupHasAdminTokens(false);

        // Go to finalize step (will show OIDC-only UI)
        goToStep(totalSteps);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  const renderStep = () => {
    let currentStepNumber = 1;

    // Step 1: Welcome
    if (state.currentStep === currentStepNumber) {
      return <WelcomeStep onNext={() => goToStep(currentStepNumber + 1)} />;
    }
    currentStepNumber++;

    // Step 2: Backend Selection
    if (state.currentStep === currentStepNumber) {
      return (
        <BackendSelectionStep
          value={state.backendMode}
          onChange={(value) => updateField('backendMode', value)}
          audibleRegion={state.audibleRegion}
          onAudibleRegionChange={(region) => updateField('audibleRegion', region)}
          onNext={() => goToStep(currentStepNumber + 1)}
          onBack={() => goToStep(currentStepNumber - 1)}
        />
      );
    }
    currentStepNumber++;

    // Conditional flow based on backend mode
    if (state.backendMode === 'plex') {
      // Plex Mode: Admin → Plex → Prowlarr → Download → Paths → BookDate → Review → Finalize

      // Step 3: Admin Account
      if (state.currentStep === currentStepNumber) {
        return (
          <AdminAccountStep
            adminUsername={state.adminUsername}
            adminPassword={state.adminPassword}
            onUpdate={updateField}
            onNext={() => goToStep(currentStepNumber + 1)}
            onBack={() => goToStep(currentStepNumber - 1)}
          />
        );
      }
      currentStepNumber++;

      // Step 4: Plex
      if (state.currentStep === currentStepNumber) {
        return (
          <PlexStep
            plexUrl={state.plexUrl}
            plexToken={state.plexToken}
            plexLibraryId={state.plexLibraryId}
            plexTriggerScanAfterImport={state.plexTriggerScanAfterImport}
            plexLibraries={state.plexLibraries}
            onUpdate={updateField}
            onNext={() => goToStep(currentStepNumber + 1)}
            onBack={() => goToStep(currentStepNumber - 1)}
          />
        );
      }
      currentStepNumber++;
    } else {
      // Audiobookshelf Mode: ABS → Auth Method → [OIDC Config] → [Registration Settings] → [Admin Account] → Prowlarr → ...

      // Step 3: Audiobookshelf
      if (state.currentStep === currentStepNumber) {
        return (
          <AudiobookshelfStep
            absUrl={state.absUrl}
            absApiToken={state.absApiToken}
            absLibraryId={state.absLibraryId}
            absTriggerScanAfterImport={state.absTriggerScanAfterImport}
            absLibraries={state.absLibraries}
            onUpdate={updateField}
            onNext={() => goToStep(currentStepNumber + 1)}
            onBack={() => goToStep(currentStepNumber - 1)}
          />
        );
      }
      currentStepNumber++;

      // Step 4: Auth Method Selection
      if (state.currentStep === currentStepNumber) {
        return (
          <AuthMethodStep
            value={state.authMethod}
            onChange={(value) => updateField('authMethod', value)}
            onNext={() => goToStep(currentStepNumber + 1)}
            onBack={() => goToStep(currentStepNumber - 1)}
          />
        );
      }
      currentStepNumber++;

      // Conditional: OIDC Config (if authMethod is 'oidc' or 'both')
      if (state.authMethod === 'oidc' || state.authMethod === 'both') {
        if (state.currentStep === currentStepNumber) {
          return (
            <OIDCConfigStep
              oidcProviderName={state.oidcProviderName}
              oidcIssuerUrl={state.oidcIssuerUrl}
              oidcClientId={state.oidcClientId}
              oidcClientSecret={state.oidcClientSecret}
              oidcAccessControlMethod={state.oidcAccessControlMethod}
              oidcAccessGroupClaim={state.oidcAccessGroupClaim}
              oidcAccessGroupValue={state.oidcAccessGroupValue}
              oidcAllowedEmails={state.oidcAllowedEmails}
              oidcAllowedUsernames={state.oidcAllowedUsernames}
              oidcAdminClaimEnabled={state.oidcAdminClaimEnabled}
              oidcAdminClaimName={state.oidcAdminClaimName}
              oidcAdminClaimValue={state.oidcAdminClaimValue}
              oidcTested={state.oidcTested}
              onUpdate={updateField}
              onNext={() => goToStep(currentStepNumber + 1)}
              onBack={() => goToStep(currentStepNumber - 1)}
            />
          );
        }
        currentStepNumber++;
      }

      // Conditional: Registration Settings (if authMethod is 'manual' or 'both')
      if (state.authMethod === 'manual' || state.authMethod === 'both') {
        if (state.currentStep === currentStepNumber) {
          return (
            <RegistrationSettingsStep
              requireAdminApproval={state.requireAdminApproval}
              onUpdate={updateField}
              onNext={() => goToStep(currentStepNumber + 1)}
              onBack={() => goToStep(currentStepNumber - 1)}
            />
          );
        }
        currentStepNumber++;

        // Step: Admin Account (for manual auth)
        if (state.currentStep === currentStepNumber) {
          return (
            <AdminAccountStep
              adminUsername={state.adminUsername}
              adminPassword={state.adminPassword}
              onUpdate={updateField}
              onNext={() => goToStep(currentStepNumber + 1)}
              onBack={() => goToStep(currentStepNumber - 1)}
            />
          );
        }
        currentStepNumber++;
      }
    }

    // Common steps for both modes: Prowlarr → Download → Paths → BookDate → Review → Finalize

    // Step: Prowlarr
    if (state.currentStep === currentStepNumber) {
      return (
        <ProwlarrStep
          prowlarrUrl={state.prowlarrUrl}
          prowlarrApiKey={state.prowlarrApiKey}
          prowlarrIndexers={state.prowlarrIndexers}
          onUpdate={updateField}
          onNext={() => goToStep(currentStepNumber + 1)}
          onBack={() => goToStep(currentStepNumber - 1)}
        />
      );
    }
    currentStepNumber++;

    // Step: Download Client
    if (state.currentStep === currentStepNumber) {
      return (
        <DownloadClientStep
          downloadClients={state.downloadClients}
          downloadDir={state.downloadDir}
          onUpdate={updateField}
          onNext={() => goToStep(currentStepNumber + 1)}
          onBack={() => goToStep(currentStepNumber - 1)}
        />
      );
    }
    currentStepNumber++;

    // Step: Paths
    if (state.currentStep === currentStepNumber) {
      return (
        <PathsStep
          downloadDir={state.downloadDir}
          mediaDir={state.mediaDir}
          metadataTaggingEnabled={state.metadataTaggingEnabled}
          plexFormatCoercionEnabled={state.plexFormatCoercionEnabled}
          chapterMergingEnabled={state.chapterMergingEnabled}
          pathsTested={state.pathsTested}
          onUpdate={updateField}
          onNext={() => goToStep(currentStepNumber + 1)}
          onBack={() => goToStep(currentStepNumber - 1)}
        />
      );
    }
    currentStepNumber++;

    // Step: BookDate
    if (state.currentStep === currentStepNumber) {
      return (
        <BookDateStep
          bookdateProvider={state.bookdateProvider}
          bookdateApiKey={state.bookdateApiKey}
          bookdateModel={state.bookdateModel}
          bookdateConfigured={state.bookdateConfigured}
          bookdateModels={state.bookdateModels}
          onUpdate={updateField}
          onNext={() => goToStep(currentStepNumber + 1)}
          onSkip={() => goToStep(currentStepNumber + 1)}
          onBack={() => goToStep(currentStepNumber - 1)}
        />
      );
    }
    currentStepNumber++;

    // Step: Review
    if (state.currentStep === currentStepNumber) {
      return (
        <ReviewStep
          config={state}
          loading={loading}
          error={error}
          onComplete={completeSetup}
          onBack={() => goToStep(currentStepNumber - 1)}
        />
      );
    }
    currentStepNumber++;

    // Step: Finalize
    if (state.currentStep === currentStepNumber) {
      return (
        <FinalizeStep
          hasAdminTokens={setupHasAdminTokens}
          onComplete={() => {
            // OIDC-only mode: redirect to login
            if (!setupHasAdminTokens) {
              window.location.href = '/login';
              return;
            }

            // Normal mode: Force full page reload to initialize auth context with new tokens
            window.location.href = '/';
          }}
          onBack={() => goToStep(currentStepNumber - 1)}
        />
      );
    }

    return null;
  };

  return (
    <WizardLayout
      currentStep={state.currentStep}
      totalSteps={totalSteps}
      backendMode={state.backendMode}
      authMethod={state.authMethod}
    >
      {renderStep()}
    </WizardLayout>
  );
}
