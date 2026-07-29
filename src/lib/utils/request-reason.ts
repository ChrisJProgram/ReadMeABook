/**
 * Component: Request Reason Classifier
 * Documentation: documentation/frontend/components.md
 *
 * A request parked in `awaiting_search` can be there for very different reasons —
 * from "a copy exists but your account can't take it" to "actively retrying". The
 * search / download processors already write a specific `errorMessage` for each
 * (see search-indexers, search-ebook, download-torrent, direct-download); this
 * maps those stable phrases to a small, user-facing set of categories so the
 * "My Requests" badge can say WHY a request isn't downloading instead of a
 * generic "Awaiting Search".
 *
 * Text-matching (not a stored enum) is deliberate: the reasons live in one place
 * per processor and a test pins each message to its category, so this stays a
 * pure, dependency-free display helper with no schema change. An unrecognised
 * message falls back to a neutral "Searching" with the raw text as the hint —
 * never worse than today's hidden message.
 */

export type RequestReasonCategory =
  | 'locked'
  | 'held'
  | 'low_quality'
  | 'not_found'
  | 'searching';

/** Drives the badge colour and communicates whether the user must act. */
export type RequestReasonTone = 'blocked' | 'action' | 'waiting' | 'info';

/**
 * Canonical badge colour per tone, shared by every renderer of a reason badge
 * (StatusBadge on "My Requests" and the admin RecentRequestsTable) so the two
 * can't drift. Amber = needs attention / won't self-resolve; indigo = you must
 * act; slate = waiting, no action; blue = actively working.
 */
export const REASON_TONE_BADGE_CLASSES: Record<RequestReasonTone, string> = {
  blocked: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  action: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  waiting: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
};

export interface RequestReason {
  category: RequestReasonCategory;
  /** Short badge label, e.g. "Locked". */
  label: string;
  tone: RequestReasonTone;
  /** One-line human explanation for the reason line / tooltip. */
  hint: string;
}

/**
 * Classify an `awaiting_search` request's errorMessage into a user-facing reason.
 * Returns null when there is nothing to classify (not awaiting_search, or no
 * message) so callers fall back to the generic status label.
 *
 * Rules are ordered most-specific first; each matches a stable phrase authored by
 * a processor. Keep in sync with those messages — `request-reason.test.ts` asserts
 * the mapping for every real one.
 */
export function classifyAwaitingSearchReason(
  errorMessage?: string | null
): RequestReason | null {
  const raw = (errorMessage ?? '').trim();
  if (!raw) return null;
  const m = raw.toLowerCase();

  // ── Locked: a copy exists, but the account can't download it ──────────────
  if (m.includes('matched an exclude rule')) {
    return {
      category: 'locked',
      label: 'Locked',
      tone: 'blocked',
      hint: "A copy exists, but your account can't download it (e.g. it needs VIP). It won't arrive on its own — get access or use another source.",
    };
  }
  if (m.includes('all blocked')) {
    return {
      category: 'locked',
      label: 'Locked',
      tone: 'blocked',
      hint: 'Every copy found has already failed to download, so all are set aside for this request.',
    };
  }

  // ── Held: needs a manual pick ─────────────────────────────────────────────
  if (m.includes('held for manual selection') || m.includes('runtime unknown')) {
    return {
      category: 'held',
      label: 'Held',
      tone: 'action',
      hint: "Runtime is unknown, so quality can't be judged automatically. Pick a copy via interactive search.",
    };
  }

  // ── Below your quality bar: found, but under the floor / score threshold ───
  if (m.includes('bitrate floor')) {
    return {
      category: 'low_quality',
      label: 'Low Quality',
      tone: 'blocked',
      hint: 'Every copy found is below your bitrate floor. Lower the floor or pick a copy manually.',
    };
  }
  if (m.includes('no quality matches')) {
    return {
      category: 'low_quality',
      label: 'Low Quality',
      tone: 'waiting',
      hint: 'Copies were found but none met the quality threshold. Still checking for a better one.',
    };
  }

  // ── Searching: a release failed and we're actively re-selecting ───────────
  if (m.includes('re-search') || /attempt\s*\d/.test(m)) {
    return {
      category: 'searching',
      label: 'Searching',
      tone: 'info',
      hint: 'A copy failed to download; looking for a working alternative.',
    };
  }

  // ── Not found: nothing on any source (yet) ────────────────────────────────
  if (
    m.includes('no torrents') ||
    m.includes('no nzbs') ||
    m.includes('no ebook found') ||
    m.includes('not found')
  ) {
    return {
      category: 'not_found',
      label: 'Not Found',
      tone: 'waiting',
      hint: 'No copy found on any source yet. It keeps re-checking on a schedule.',
    };
  }

  // ── No sources configured (admin action) ──────────────────────────────────
  if (m.includes('sources enabled') || m.includes('enable at least')) {
    return {
      category: 'not_found',
      label: 'Not Found',
      tone: 'waiting',
      hint: raw,
    };
  }

  // ── Unknown awaiting_search message: in-flight, surface the raw text ───────
  return {
    category: 'searching',
    label: 'Searching',
    tone: 'info',
    hint: raw,
  };
}
