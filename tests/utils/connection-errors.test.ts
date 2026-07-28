/**
 * Component: Connection Error Classification Tests
 * Documentation: documentation/phase3/README.md
 */

import { describe, expect, it } from 'vitest';
import { isTransientConnectionError } from '@/lib/utils/connection-errors';

describe('isTransientConnectionError', () => {
  it('classifies connection error codes as transient', () => {
    expect(isTransientConnectionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('classifies gateway 5xx statuses as transient', () => {
    expect(isTransientConnectionError({ response: { status: 502 } })).toBe(true);
    expect(isTransientConnectionError({ response: { status: 503 } })).toBe(true);
    expect(isTransientConnectionError({ response: { status: 504 } })).toBe(true);
  });

  // F2(b): a 429 is a rate limit, not an ungettable release — must be transient
  // (retry with backoff) so it NEVER triggers a blocklist.
  it('classifies HTTP 429 (rate limit) as transient via structured status', () => {
    expect(isTransientConnectionError({ response: { status: 429 } })).toBe(true);
  });

  it('classifies a 429 rate-limit message string as transient', () => {
    expect(isTransientConnectionError(new Error('[QBittorrent] HTTP error 429'))).toBe(true);
    expect(isTransientConnectionError(new Error('Too Many Requests'))).toBe(true);
    expect(isTransientConnectionError(new Error('indexer rate limit exceeded'))).toBe(true);
  });

  it('does NOT classify release-specific permanent failures as transient', () => {
    // These SHOULD lead to blocklist + re-select, so they must be non-transient.
    expect(isTransientConnectionError({ response: { status: 403 } })).toBe(false);
    expect(isTransientConnectionError({ response: { status: 404 } })).toBe(false);
    expect(isTransientConnectionError({ response: { status: 500 } })).toBe(false);
    expect(isTransientConnectionError(new Error('Download failed'))).toBe(false);
    expect(isTransientConnectionError(new Error('Forbidden'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isTransientConnectionError(null)).toBe(false);
    expect(isTransientConnectionError(undefined)).toBe(false);
  });
});
