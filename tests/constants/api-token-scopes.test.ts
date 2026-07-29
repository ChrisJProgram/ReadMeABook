/**
 * Component: API Token Scope Tests (B8)
 */

import { describe, expect, it } from 'vitest';
import {
  isEndpointAllowed,
  requiredScopeFor,
  parseTokenScopes,
  serializeTokenScopes,
  LEGACY_TOKEN_SCOPES,
  API_TOKEN_ALLOWED_ENDPOINTS,
  API_TOKEN_ENDPOINT_DOCS,
} from '@/lib/constants/api-tokens';

describe('parseTokenScopes (B8)', () => {
  it('treats a legacy token (NULL/empty scopes) as read+write — no breakage', () => {
    expect(parseTokenScopes(null)).toEqual([...LEGACY_TOKEN_SCOPES]);
    expect(parseTokenScopes(undefined)).toEqual([...LEGACY_TOKEN_SCOPES]);
    expect(parseTokenScopes('  ')).toEqual([...LEGACY_TOKEN_SCOPES]);
  });

  it('parses, trims and lowercases stored scopes', () => {
    expect(parseTokenScopes('read, WRITE')).toEqual(['read', 'write']);
  });

  it('drops unknown scopes rather than trusting them', () => {
    expect(parseTokenScopes('read,superuser')).toEqual(['read']);
  });
});

describe('serializeTokenScopes (B8)', () => {
  it('defaults to read-only when nothing valid is supplied', () => {
    expect(serializeTokenScopes(undefined)).toBe('read');
    expect(serializeTokenScopes([])).toBe('read');
    expect(serializeTokenScopes(['nonsense'])).toBe('read');
  });

  it('normalizes and de-duplicates', () => {
    expect(serializeTokenScopes(['Write', 'write', 'read'])).toBe('write,read');
  });
});

describe('scope-aware allowlist (B8)', () => {
  it('still rejects anything off the allowlist regardless of scopes', () => {
    expect(isEndpointAllowed('DELETE', '/api/requests/abc', ['read', 'write', 'admin'])).toBe(false);
    expect(isEndpointAllowed('POST', '/api/admin/settings/ebook', ['admin'])).toBe(false);
  });

  it('a read-only token cannot write or reach admin operations', () => {
    const read = ['read'] as const;
    expect(isEndpointAllowed('GET', '/api/requests', read)).toBe(true);
    expect(isEndpointAllowed('POST', '/api/requests', read)).toBe(false);
    expect(isEndpointAllowed('POST', '/api/requests/abc/select-torrent', read)).toBe(false);
    expect(isEndpointAllowed('POST', '/api/admin/jobs/j1/trigger', read)).toBe(false);
  });

  it('a write token can override a release but not trigger jobs (B5 vs B3 surfaces)', () => {
    const write = ['read', 'write'] as const;
    expect(isEndpointAllowed('POST', '/api/requests/abc/select-torrent', write)).toBe(true);
    expect(isEndpointAllowed('POST', '/api/admin/jobs/j1/trigger', write)).toBe(false);
  });

  it('an admin-scoped token can drive the recovery endpoints', () => {
    const admin = ['read', 'write', 'admin'] as const;
    expect(isEndpointAllowed('GET', '/api/admin/jobs', admin)).toBe(true);
    expect(isEndpointAllowed('POST', '/api/admin/jobs/j1/trigger', admin)).toBe(true);
    expect(isEndpointAllowed('GET', '/api/admin/blocklist', admin)).toBe(true);
  });

  it('legacy tokens keep exactly their old power: the pre-B8 allowlist', () => {
    const legacy = parseTokenScopes(null);
    // everything that was allowed before scopes existed
    expect(isEndpointAllowed('GET', '/api/requests', legacy)).toBe(true);
    expect(isEndpointAllowed('POST', '/api/requests', legacy)).toBe(true);
    expect(isEndpointAllowed('GET', '/api/requests/abc', legacy)).toBe(true);
    expect(isEndpointAllowed('GET', '/api/admin/metrics', legacy)).toBe(true);
    // …but NOT the newly added admin-scoped recovery endpoints
    expect(isEndpointAllowed('POST', '/api/admin/jobs/j1/trigger', legacy)).toBe(false);
  });

  it('omitting scopes keeps the pre-B8 allowlist-only semantics', () => {
    expect(isEndpointAllowed('POST', '/api/requests')).toBe(true);
    expect(isEndpointAllowed('POST', '/api/nope')).toBe(false);
  });

  it('requiredScopeFor reports the gate, or null when not allowlisted', () => {
    expect(requiredScopeFor('GET', '/api/requests')).toBe('read');
    expect(requiredScopeFor('POST', '/api/requests')).toBe('write');
    expect(requiredScopeFor('POST', '/api/admin/jobs/j1/trigger')).toBe('admin');
    expect(requiredScopeFor('DELETE', '/api/requests/abc')).toBeNull();
  });

  it('path placeholders still match exactly one segment', () => {
    const admin = ['admin'] as const;
    expect(isEndpointAllowed('POST', '/api/admin/jobs/j1/trigger', admin)).toBe(true);
    expect(isEndpointAllowed('POST', '/api/admin/jobs/j1/extra/trigger', admin)).toBe(false);
  });

  it('every allowlist entry declares a scope and is documented', () => {
    for (const ep of API_TOKEN_ALLOWED_ENDPOINTS) {
      expect(ep.scope).toBeTruthy();
      const doc = API_TOKEN_ENDPOINT_DOCS.find((d) => d.method === ep.method && d.path === ep.path);
      expect(doc, `missing /api-docs entry for ${ep.method} ${ep.path}`).toBeDefined();
    }
  });
});
