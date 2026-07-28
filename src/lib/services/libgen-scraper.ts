/**
 * Component: Libgen E-book Source Service
 * Documentation: documentation/integrations/ebook-sidecar.md
 *
 * Direct e-book source using a Library Genesis (".li" fork) mirror. Unlike
 * Anna's Archive (ebook-scraper.ts), Libgen mirrors carry no Cloudflare, so no
 * FlareSolverr is required, and there is no per-IP slow-download waitlist.
 *
 * Empirically-verified mirror mechanics (2026-07-28, home IP):
 *  - Search: GET {base}/index.php?req=<title author>&res=100 returns ONE HTML
 *    table (id="tablelibgen") covering fiction AND non-fiction together — the
 *    old split fiction/ vs non-fiction endpoints are gone. json.php is a
 *    per-md5 LOOKUP api only ("No Request keys" on free-text), so search must
 *    parse the results table.
 *  - Download: the file URL is NOT stable. {base}/get.php?md5=X with no key
 *    307-redirects back to the ads.php landing page, and the key ROTATES on
 *    every ads.php fetch. So the durable per-book handle is the ads.php URL;
 *    the real file URL is resolved at download time (resolveLibgenDownloadUrl):
 *    fetch ads.php → extract get.php?md5=X&key=<rotating> → that 307s to a CDN
 *    (cdn*.booksdl.lc) which streams the file (verified 206 + Content-Range).
 */

import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { RMAB_USER_AGENT } from '../utils/user-agent';
import { RMABLogger } from '../utils/logger';

const moduleLogger = RMABLogger.create('LibgenScraper');

/** Default mirror — chosen empirically: plain nginx, no Cloudflare, renders the
 *  ads.php download block reliably. libgen.li's ads.php did NOT render it, and
 *  books.ms is a JS-redirect anti-bot page — both rejected during probing. */
export const DEFAULT_LIBGEN_MIRROR = 'https://libgen.bz';

const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;
const MAX_ROWS = 60; // cap on result rows parsed/scored per search

// Minimal language code → Libgen language-column name map. Used only as a soft
// ranking preference (never a hard filter — we never drop the sole match just
// because its language column disagrees).
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'english',
  de: 'german',
  es: 'spanish',
  fr: 'french',
};

export interface LibgenResult {
  md5: string;
  title: string;
  author: string;
  format: string; // extension, lowercase (epub, pdf, mobi, …)
  sizeBytes: number; // 0 when unparseable
  language: string;
  collection: string; // libgen topic badge: 'l' (non-fiction), 'f' (fiction), …
  /** Stable per-book download landing page ({base}/ads.php?md5=…). */
  adsUrl: string;
  /** Ranking score assigned by searchLibgen (higher = better match). */
  score: number;
}

export interface LibgenDownload {
  url: string;
  format: string;
}

/**
 * Build the stable ads.php landing URL for an md5 on a given mirror base.
 */
export function buildLibgenAdsUrl(baseUrl: string, md5: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/ads.php?md5=${md5}`;
}

/**
 * Normalize a string for fuzzy title/author matching: lowercase, strip
 * diacritics, drop punctuation, collapse whitespace.
 */
function normalizeForMatch(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const MATCH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with',
]);

function contentTokens(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t && !MATCH_STOP_WORDS.has(t));
}

/**
 * Parse a human-readable Libgen size string ("640 kB", "1.2 MB", "1 GB") to
 * bytes. Returns 0 when unparseable.
 */
export function parseLibgenSize(text: string): number {
  const m = text.trim().match(/([\d.]+)\s*(b|kb|mb|gb)/i);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = m[2].toLowerCase();
  const mult = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
  return Math.round(value * mult);
}

/**
 * Score a candidate against the request. Author match is REQUIRED (returns null
 * when the requested author's surname is absent) — mirrors the automatic-mode
 * requireAuthor guard used for indexer ebooks, and prevents same-title wrong-
 * author spam rows from being auto-grabbed.
 */
function scoreCandidate(
  req: { title: string; author: string; preferredFormat: string; preferredLanguage?: string },
  row: { title: string; author: string; format: string; sizeBytes: number; language: string }
): number | null {
  const reqTitle = normalizeForMatch(req.title);
  const reqAuthorNorm = normalizeForMatch(req.author);
  const rowTitle = normalizeForMatch(row.title);
  const rowAuthor = normalizeForMatch(row.author);

  // ----- Author gate (required) -----
  const authorTokens = reqAuthorNorm.split(' ').filter(Boolean);
  const surname = authorTokens[authorTokens.length - 1];
  const authorMatches =
    !!reqAuthorNorm &&
    (rowAuthor.includes(reqAuthorNorm) ||
      (!!surname && surname.length >= 2 && rowAuthor.split(' ').includes(surname)));
  if (!authorMatches) return null;

  // ----- Title overlap -----
  const reqTokens = contentTokens(reqTitle);
  const rowTokenSet = new Set(rowTitle.split(' '));
  const present = reqTokens.filter((t) => rowTokenSet.has(t)).length;
  const overlap = reqTokens.length > 0 ? present / reqTokens.length : 0;
  if (overlap < 0.5) return null; // too little of the requested title is present

  let score = overlap * 60; // up to 60 for title match
  if (rowTitle === reqTitle) score += 15; // exact-title bonus (beats supersets)

  // ----- Format preference -----
  const fmt = row.format.toLowerCase();
  const pref = req.preferredFormat.toLowerCase();
  if (pref === 'any' || !pref) score += 8;
  else if (fmt === pref) score += 12;
  else if (fmt === 'epub') score += 6; // universally convertible fallback
  else if (fmt === 'pdf') score += 2;

  // ----- Size preference (smaller ebooks are cleaner; huge = likely scans) -----
  if (row.sizeBytes > 0) {
    const mb = row.sizeBytes / (1024 * 1024);
    if (mb <= 5) score += 8;
    else if (mb <= 15) score += 5;
    else if (mb <= 50) score += 2;
  }

  // ----- Language soft preference -----
  if (req.preferredLanguage) {
    const wantName = LANGUAGE_NAMES[req.preferredLanguage.toLowerCase()];
    if (wantName && normalizeForMatch(row.language).includes(wantName)) score += 6;
  }

  return score;
}

async function fetchWithRetry(url: string): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<string>(url, {
        headers: { 'User-Agent': RMAB_USER_AGENT },
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'text',
        // ads.php/index.php are HTML; some mirrors 403 without an Accept header
        // resembling a browser.
        maxRedirects: 5,
      });
      return response.data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');
      const retryable =
        error instanceof AxiosError &&
        (error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          (error.response && error.response.status >= 500));
      if (!retryable || attempt === MAX_RETRIES - 1) throw lastError;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastError || new Error('Request failed after retries');
}

/**
 * Parse a Libgen results-page HTML string into raw rows. Exported for testing
 * against fixture HTML.
 */
export function parseLibgenResults(html: string, baseUrl: string): Omit<LibgenResult, 'score'>[] {
  const $ = cheerio.load(html);
  const rows: Omit<LibgenResult, 'score'>[] = [];

  $('#tablelibgen tbody tr').each((_i, tr) => {
    if (rows.length >= MAX_ROWS) return false;
    const tds = $(tr).find('> td');
    if (tds.length < 9) return; // header/malformed rows

    const titleCell = tds.eq(0);
    // Title = text of the first edition.php/file.php anchor in the cell.
    let titleLink = titleCell.find('a[href*="edition.php"]').first();
    if (titleLink.length === 0) titleLink = titleCell.find('a[href*="file.php"]').first();
    const title = (titleLink.text() || '').replace(/\s+/g, ' ').trim();
    if (!title) return;

    // md5 from the libgen-native ads.php mirror link; fall back to any 32-hex.
    let md5 = '';
    const adsLink = tds.eq(8).find('a[href*="ads.php?md5="]').attr('href') || '';
    const adsMatch = adsLink.match(/md5=([a-f0-9]{32})/i);
    if (adsMatch) {
      md5 = adsMatch[1].toLowerCase();
    } else {
      const anyHex = (tds.eq(8).html() || '').match(/[a-f0-9]{32}/i);
      if (anyHex) md5 = anyHex[0].toLowerCase();
    }
    if (!md5) return;

    const author = (tds.eq(1).text() || '').replace(/\s+/g, ' ').trim();
    const language = (tds.eq(4).text() || '').replace(/\s+/g, ' ').trim();
    const sizeBytes = parseLibgenSize(tds.eq(6).text() || '');
    const format = (tds.eq(7).text() || '').replace(/\s+/g, ' ').trim().toLowerCase();

    // collection/topic badge, e.g. "l 3192620" → "l"
    const badge = (titleCell.find('.badge-secondary').first().text() || '').trim();
    const collection = badge.split(/\s+/)[0] || '';

    rows.push({
      md5,
      title,
      author,
      format,
      sizeBytes,
      language,
      collection,
      adsUrl: buildLibgenAdsUrl(baseUrl, md5),
    });
  });

  return rows;
}

/**
 * Search a Libgen mirror for an ebook. Returns author-matched candidates sorted
 * best-first (empty array on no match / error). Covers fiction AND non-fiction
 * in one query.
 */
export async function searchLibgen(
  title: string,
  author: string,
  preferredFormat: string,
  baseUrl: string = DEFAULT_LIBGEN_MIRROR,
  logger?: RMABLogger,
  preferredLanguage?: string
): Promise<LibgenResult[]> {
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const query = [title, author].filter(Boolean).join(' ');
    const searchUrl = `${base}/index.php?req=${encodeURIComponent(query)}&res=100`;
    moduleLogger.debug(`Libgen search URL: ${searchUrl}`);

    const html = await fetchWithRetry(searchUrl);
    const rawRows = parseLibgenResults(html, base);
    moduleLogger.debug(`Libgen parsed ${rawRows.length} raw rows`);

    const scored: LibgenResult[] = [];
    for (const row of rawRows) {
      const score = scoreCandidate(
        { title, author, preferredFormat, preferredLanguage },
        row
      );
      if (score === null) continue;
      scored.push({ ...row, score });
    }

    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      await logger?.info(`No Libgen matches for "${title}" by ${author}`);
    } else {
      await logger?.info(
        `Libgen: ${scored.length} match(es); best "${scored[0].title}" (${scored[0].format}, score ${scored[0].score.toFixed(1)})`
      );
    }
    return scored;
  } catch (error) {
    await logger?.error(
      `Libgen search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return [];
  }
}

/**
 * Extract a keyed get.php download URL from an ads.php landing page's HTML.
 * Exported for testing against fixture HTML. Returns an absolute URL.
 */
export function extractLibgenGetUrl(adsHtml: string, adsUrl: string): string | null {
  const $ = cheerio.load(adsHtml);
  // The download button links to get.php?md5=…&key=… (relative on most mirrors).
  let href =
    $('a[href*="get.php?md5="]').attr('href') ||
    $('a[href*="/get.php?md5="]').attr('href') ||
    '';
  if (!href) {
    const m = adsHtml.match(/get\.php\?md5=[a-f0-9]{32}&key=[A-Za-z0-9]+/i);
    href = m ? m[0] : '';
  }
  if (!href) return null;

  const origin = new URL(adsUrl).origin;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return `${origin}${href}`;
  return `${origin}/${href}`;
}

/**
 * Resolve a Libgen ads.php landing URL to a streamable file URL. Fetches the
 * landing page and extracts the freshly-keyed get.php URL (the key rotates each
 * fetch, so this MUST run at download time, not search time). The returned URL
 * 307-redirects to a CDN that streams the file — axios follows that itself.
 *
 * `knownFormat` is the extension captured at search time (get.php carries no
 * extension); it's echoed back so the caller names the file correctly.
 */
export async function resolveLibgenDownloadUrl(
  adsUrl: string,
  knownFormat: string,
  logger?: RMABLogger
): Promise<LibgenDownload | null> {
  try {
    const html = await fetchWithRetry(adsUrl);
    const url = extractLibgenGetUrl(html, adsUrl);
    if (!url) {
      await logger?.warn(`No get.php link on Libgen landing page: ${adsUrl}`);
      return null;
    }
    return { url, format: (knownFormat || '').toLowerCase() || 'epub' };
  } catch (error) {
    await logger?.error(
      `Failed to resolve Libgen download URL: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return null;
  }
}
