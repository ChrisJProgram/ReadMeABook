/**
 * Component: Request Status Constants
 * Documentation: documentation/backend/database.md
 */

/** Terminal statuses indicating a request has been fulfilled and files are ready */
export const COMPLETED_STATUSES = ['available', 'downloaded'] as const;

/** Statuses from which a request can be cancelled (server-enforced and UI-gated) */
export const CANCELLABLE_STATUSES = [
  'pending',
  'searching',
  'downloading',
  'awaiting_search',
  'awaiting_approval',
  'awaiting_release',
] as const;

/**
 * Statuses where an own (or admin-acted) request can be advanced via Interactive
 * Search → Download by routing to /api/requests/[id]/select-torrent.
 * Outside this set, the modal falls back to the create-new-request path.
 *
 * B5: the in-flight statuses below were missing, which broke the documented manual
 * override in exactly the cases that need it most — a release that is downloading
 * but ungettable/stalled (0 seeders, VIP-gated), a stuck import, or a request that
 * exhausted its import retries. Two distinct failures resulted:
 *   - searching/downloading/processing/awaiting_import → the create path rejects
 *     with 409 "You have already requested this audiobook" (no override possible);
 *   - warn → the create path DELETES the existing request instead, and the
 *     BlockedRelease cascade silently wipes everything F2(b) learned about which
 *     releases are ungettable, so the fresh request can re-pick the bad release.
 *
 * Deliberately excluded: `awaiting_approval` (select-torrent gates it with a 403 by
 * design), `available`/`downloaded` (terminal success — re-grabbing a fulfilled
 * request is a separate upgrade feature), and `cancelled` (the user opted out; a
 * fresh request is the right semantic and there is no in-flight state to preserve).
 */
export const ADVANCEABLE_FROM_INTERACTIVE_SEARCH = [
  'pending',
  'failed',
  'awaiting_search',
  'awaiting_release',
  // B5 additions — in-flight/stuck states where overriding is the whole point
  'searching',
  'downloading',
  'processing',
  'awaiting_import',
  'warn',
] as const;
