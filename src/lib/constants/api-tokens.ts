/**
 * Component: API Token Constants
 * Documentation: documentation/backend/services/api-tokens.md
 *
 * Centralized API token constants used across authentication middleware and token routes.
 */

/** Prefix prepended to all generated API tokens for identification */
export const API_TOKEN_PREFIX = 'rmab_';

/** Number of random bytes used to generate the token's random portion */
export const TOKEN_RANDOM_BYTES = 32;

/** Length of the token prefix stored in the database for display (first 12 chars: "rmab_" + 7 hex chars) */
export const TOKEN_PREFIX_LENGTH = 12;

/** Maximum number of active (non-expired) API tokens a single user may hold */
export const MAX_TOKENS_PER_USER = 25;

// ---------------------------------------------------------------------------
// Endpoint allowlist — restricts which routes API tokens may access
// ---------------------------------------------------------------------------

/**
 * B8: token scopes. A token may only reach an allowlisted endpoint if it also
 * holds that endpoint's required scope, so a token minted for one job stays
 * narrow even though the allowlist is global.
 *
 *   read   — GET endpoints (list/inspect)
 *   write  — mutate the caller's own requests (create, pick a release)
 *   admin  — operational control (trigger scheduled jobs, inspect admin state);
 *            still additionally gated by the token's `role`, so a user-role token
 *            with the admin scope gains nothing.
 */
export const API_TOKEN_SCOPES = ['read', 'write', 'admin'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** Scopes granted to pre-scopes tokens (`scopes` column NULL) — exactly the
 *  behaviour the allowlist had before scopes existed, so nothing breaks. */
export const LEGACY_TOKEN_SCOPES: readonly ApiTokenScope[] = ['read', 'write'];

/** Default for newly-minted tokens when the caller does not specify scopes. */
export const DEFAULT_TOKEN_SCOPES: readonly ApiTokenScope[] = ['read'];

export function isApiTokenScope(value: string): value is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** Parse the stored comma-separated scopes column. NULL/empty → legacy grant. */
export function parseTokenScopes(stored: string | null | undefined): ApiTokenScope[] {
  if (stored === null || stored === undefined || stored.trim() === '') {
    return [...LEGACY_TOKEN_SCOPES];
  }
  return stored
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(isApiTokenScope);
}

/** Normalize a caller-supplied scope list for storage; invalid entries dropped. */
export function serializeTokenScopes(scopes: readonly string[] | undefined | null): string {
  const valid = (scopes ?? [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(isApiTokenScope);
  const unique = [...new Set(valid.length > 0 ? valid : DEFAULT_TOKEN_SCOPES)];
  return unique.join(',');
}

/**
 * Shape of an allowed endpoint entry.
 * `path` may be a literal (e.g. `/api/requests`) or contain `:name` placeholders
 * that match a single path segment (e.g. `/api/requests/:id`).
 * `scope` is the scope a token must hold to call it (B8).
 */
export interface AllowedEndpoint {
  method: string;
  path: string;
  scope: ApiTokenScope;
}

/** Extended metadata used by the interactive API docs page */
export interface EndpointDoc {
  method: string;
  path: string;
  title: string;
  description: string;
  requiresAdmin: boolean;
  /** True for endpoints that mutate state. Surfaced in the /api-docs UI. */
  isWrite?: boolean;
}

/**
 * Endpoints that API tokens are permitted to call.
 * JWT-authenticated sessions are NOT restricted by this list.
 */
export const API_TOKEN_ALLOWED_ENDPOINTS: readonly AllowedEndpoint[] = [
  { method: 'GET', path: '/api/auth/me', scope: 'read' },
  { method: 'GET', path: '/api/audiobooks/search', scope: 'read' },
  { method: 'GET', path: '/api/requests', scope: 'read' },
  { method: 'POST', path: '/api/requests', scope: 'write' },
  { method: 'GET', path: '/api/requests/:id', scope: 'read' },
  { method: 'GET', path: '/api/admin/metrics', scope: 'read' },
  { method: 'GET', path: '/api/admin/downloads/active', scope: 'read' },
  { method: 'GET', path: '/api/admin/requests/recent', scope: 'read' },
  // B8 recovery set — the operations this stack actually needed when the UI
  // misbehaved. All are additionally role-gated by the endpoints themselves.
  { method: 'POST', path: '/api/requests/:id/select-torrent', scope: 'write' },
  { method: 'GET', path: '/api/admin/jobs', scope: 'admin' },
  { method: 'POST', path: '/api/admin/jobs/:id/trigger', scope: 'admin' },
  { method: 'GET', path: '/api/admin/blocklist', scope: 'admin' },
] as const;

/**
 * Full documentation metadata for each allowed endpoint.
 * Consumed by the /api-docs interactive page.
 */
export const API_TOKEN_ENDPOINT_DOCS: readonly EndpointDoc[] = [
  {
    method: 'GET',
    path: '/api/auth/me',
    title: 'Get current user',
    description:
      'Returns the authenticated user\'s profile information including username, role, and account details.',
    requiresAdmin: false,
  },
  {
    method: 'GET',
    path: '/api/audiobooks/search',
    title: 'Search audiobooks',
    description:
      'Search Audible for audiobooks by title or author. Query params: `q` (required), `page` (optional). Returns enriched results including per-user request and library availability status.',
    requiresAdmin: false,
  },
  {
    method: 'GET',
    path: '/api/requests',
    title: 'List requests',
    description:
      'Returns all audiobook requests visible to the authenticated user. Admins see all requests, users see their own.',
    requiresAdmin: false,
  },
  {
    method: 'POST',
    path: '/api/requests',
    title: 'Create request',
    description:
      'Create a new audiobook request on behalf of the token owner. Body: `{ "audiobook": { "asin", "title", "author", "narrator?", "description?", "coverArtUrl?" } }`. Follows the user\'s normal auto-approve rules; returns named error codes (`already_available`, `being_processed`, `duplicate`, `ignored`, `user_not_found`) on rejection.',
    requiresAdmin: false,
    isWrite: true,
  },
  {
    method: 'GET',
    path: '/api/requests/:id',
    title: 'Get request by ID',
    description:
      'Returns a single audiobook request including audiobook details, download history, and recent job state. Users may only fetch requests they own; admins may fetch any.',
    requiresAdmin: false,
  },
  {
    method: 'GET',
    path: '/api/admin/metrics',
    title: 'System metrics',
    description:
      'Returns system health metrics including request counts, download statistics, and library size.',
    requiresAdmin: true,
  },
  {
    method: 'GET',
    path: '/api/admin/downloads/active',
    title: 'Active downloads',
    description:
      'Returns currently active downloads including progress, speed, and ETA.',
    requiresAdmin: true,
  },
  {
    method: 'GET',
    path: '/api/admin/requests/recent',
    title: 'Recent requests',
    description:
      'Returns the most recent audiobook requests across all users.',
    requiresAdmin: true,
  },
  {
    method: 'POST',
    path: '/api/requests/:id/select-torrent',
    title: 'Select a release for a request',
    description:
      'Override the automatic pick on an existing request. Body: `{ "torrent": { … } }` as returned by interactive search. Use when auto-selection chose an ungettable or stalled release. Requires the `write` scope; users may only act on their own requests.',
    requiresAdmin: false,
    isWrite: true,
  },
  {
    method: 'GET',
    path: '/api/admin/jobs',
    title: 'List scheduled jobs',
    description:
      'Returns all scheduled jobs with their cron schedule, enabled state and last run. Requires the `admin` scope.',
    requiresAdmin: true,
  },
  {
    method: 'POST',
    path: '/api/admin/jobs/:id/trigger',
    title: 'Trigger a scheduled job',
    description:
      'Runs a scheduled job immediately (e.g. Retry Failed Imports, Retry Missing Torrents). Returns the queued job id. Requires the `admin` scope.',
    requiresAdmin: true,
    isWrite: true,
  },
  {
    method: 'GET',
    path: '/api/admin/blocklist',
    title: 'List blocked releases',
    description:
      'Returns per-request blocklist entries with their reason (download_fail, organize_fail), so automation can see which releases were rejected and why. Requires the `admin` scope.',
    requiresAdmin: true,
  },
] as const;

/**
 * Compiled allowlist used by `isEndpointAllowed`. Patterns with `:name`
 * placeholders are compiled to anchored regexes that match a single path
 * segment (`[^/]+`); literal paths use string equality.
 */
interface CompiledEndpoint {
  method: string;
  literal: string | null;
  pattern: RegExp | null;
  scope: ApiTokenScope;
}

function compileEndpoint(ep: AllowedEndpoint): CompiledEndpoint {
  const method = ep.method.toUpperCase();
  if (!ep.path.includes(':')) {
    return { method, literal: ep.path, pattern: null, scope: ep.scope };
  }
  const escaped = ep.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexSource = escaped.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+');
  return { method, literal: null, pattern: new RegExp(`^${regexSource}$`), scope: ep.scope };
}

const COMPILED_ENDPOINTS: readonly CompiledEndpoint[] = API_TOKEN_ALLOWED_ENDPOINTS.map(compileEndpoint);

/** The allowlist entry matching this method+path, or null. */
function matchEndpoint(method: string, path: string): CompiledEndpoint | null {
  const upperMethod = method.toUpperCase();
  return (
    COMPILED_ENDPOINTS.find((ep) => {
      if (ep.method !== upperMethod) return false;
      if (ep.literal !== null) return ep.literal === path;
      return ep.pattern!.test(path);
    }) ?? null
  );
}

/** The scope required to call an allowlisted endpoint, or null if not allowlisted. */
export function requiredScopeFor(method: string, path: string): ApiTokenScope | null {
  return matchEndpoint(method, path)?.scope ?? null;
}

/**
 * Check whether a given method + path is on the API token allowlist AND the
 * caller's scopes cover it. Method comparison is case-insensitive. Supports
 * dynamic single-segment placeholders (`:id`) compiled at module load.
 *
 * `scopes` omitted → allowlist-only check (pre-B8 behaviour), used by callers
 * that have no token context such as the /api-docs page.
 */
export function isEndpointAllowed(
  method: string,
  path: string,
  scopes?: readonly ApiTokenScope[]
): boolean {
  const match = matchEndpoint(method, path);
  if (!match) return false;
  if (!scopes) return true;
  return scopes.includes(match.scope);
}
