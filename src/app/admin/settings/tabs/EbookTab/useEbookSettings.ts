/**
 * Component: E-book Settings Tab - Custom Hook
 * Documentation: documentation/settings-pages.md
 */

'use client';

import { useState } from 'react';
import { fetchWithAuth } from '@/lib/utils/api';
import type { EbookSettings, TestResult } from '../../lib/types';

interface UseEbookSettingsProps {
  ebook: EbookSettings;
  onChange: (ebook: EbookSettings) => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  markAsSaved: () => void;
}

export function useEbookSettings({ ebook, onChange, onSuccess, onError, markAsSaved }: UseEbookSettingsProps) {
  const [saving, setSaving] = useState(false);
  const [testingFlaresolverr, setTestingFlaresolverr] = useState(false);
  const [flaresolverrTestResult, setFlaresolverrTestResult] = useState<TestResult | null>(null);

  /**
   * Update a single ebook field
   */
  const updateEbook = (field: keyof EbookSettings, value: string | boolean | number) => {
    onChange({ ...ebook, [field]: value });
    if (field === 'flaresolverrUrl') {
      setFlaresolverrTestResult(null);
    }
  };

  /**
   * Test FlareSolverr connection
   */
  const testFlaresolverrConnection = async () => {
    if (!ebook.flaresolverrUrl) {
      setFlaresolverrTestResult({
        success: false,
        message: 'Please enter a FlareSolverr URL first',
      });
      return;
    }

    setTestingFlaresolverr(true);
    setFlaresolverrTestResult(null);

    try {
      const response = await fetchWithAuth('/api/admin/settings/ebook/test-flaresolverr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ebook.flaresolverrUrl,
          baseUrl: ebook.baseUrl || 'https://annas-archive.gl',
        }),
      });

      const result = await response.json();
      setFlaresolverrTestResult(result);
    } catch (error) {
      setFlaresolverrTestResult({
        success: false,
        message: error instanceof Error ? error.message : 'Test failed',
      });
    } finally {
      setTestingFlaresolverr(false);
    }
  };

  /**
   * Save e-book settings to API
   */
  const saveSettings = async () => {
    setSaving(true);

    try {
      const response = await fetchWithAuth('/api/admin/settings/ebook', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          libgenEnabled: ebook.libgenEnabled || false,
          libgenBaseUrl: ebook.libgenBaseUrl || 'https://libgen.bz',
          annasArchiveEnabled: ebook.annasArchiveEnabled || false,
          indexerSearchEnabled: ebook.indexerSearchEnabled || false,
          libgenPriority: ebook.libgenPriority ?? 10,
          indexerPriority: ebook.indexerPriority ?? 20,
          annasArchivePriority: ebook.annasArchivePriority ?? 30,
          format: ebook.preferredFormat || 'epub',
          baseUrl: ebook.baseUrl || 'https://annas-archive.gl',
          flaresolverrUrl: ebook.flaresolverrUrl || '',
          autoGrabEnabled: ebook.autoGrabEnabled ?? true,
          kindleFixEnabled: ebook.kindleFixEnabled ?? false,
          qualityGate: ebook.qualityGate || 'flag',
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save e-book settings');
      }

      onSuccess('E-book sidecar settings saved successfully!');
      markAsSaved();
      setTimeout(() => onSuccess(''), 3000);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Failed to save e-book settings');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Helper to check if any ebook source is enabled
   */
  const isAnySourceEnabled = ebook.libgenEnabled || ebook.annasArchiveEnabled || ebook.indexerSearchEnabled;

  return {
    saving,
    testingFlaresolverr,
    flaresolverrTestResult,
    updateEbook,
    testFlaresolverrConnection,
    saveSettings,
    isAnySourceEnabled,
  };
}
