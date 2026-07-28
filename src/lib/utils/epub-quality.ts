/**
 * Component: EPUB Quality Inspector (F6)
 * Documentation: RMAB2-SPEC.md § F6
 *
 * Post-download, pre-import check that a downloaded EPUB is actual reflowable
 * text with chapters — not a stack of page-scan images wrapped in an EPUB.
 * Chapter/text structure is unknowable from a torrent/Libgen listing, so this
 * runs file-in-hand in [[organize-files.processor]], before the library move.
 *
 * Reuses epub-fixer's exact stack (AdmZip + cheerio-in-XML-mode on the OPF).
 *
 * Verdict semantics (G5 = strict AND-rule, user-ratified):
 *  - scanSuspected  = near-zero spine text AND images dominating the archive.
 *  - noChapters     = TOC (EPUB3 nav or EPUB2 NCX) has < 2 real entries.
 *  - strongVerdict  = scanSuspected AND noChapters — ALL THREE signals. Only this
 *    may reject (G3 'reject' mode); anything weaker only ever flags. Image-heavy
 *    legitimate books (cookbooks, art books, manga) virtually always carry real
 *    text or a TOC, so the AND-rule leaves them at most with a mild note.
 *
 * NEVER throws, and an inspection failure must NEVER fail an import (D6's probe
 * rule) — callers get { ok: false } and proceed.
 */

import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import path from 'path';

// Thresholds — conservative by design (G5). A real novel carries tens of
// thousands of text chars; genuine page-scan wrappers carry almost none.
const NEAR_ZERO_AVG_CHARS_PER_DOC = 200;
const NEAR_ZERO_TOTAL_CHARS = 1000;
const IMAGE_DOMINANCE_BYTE_SHARE = 0.6;
const IMAGE_DOMINANCE_MIN_COUNT = 5;
const MIN_TOC_ENTRIES = 2;

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff'];
const CONTENT_EXTENSIONS = ['.html', '.xhtml', '.htm'];

export interface EpubQualityReport {
  ok: true;
  spineDocCount: number;
  totalTextChars: number;
  avgTextCharsPerDoc: number;
  imageCount: number;
  imageBytes: number;
  archiveBytes: number;
  imageByteShare: number; // 0..1
  tocEntries: number;
  scanSuspected: boolean;
  noChapters: boolean;
  strongVerdict: boolean;
  /** Human-readable summary of everything that tripped (empty when clean). */
  notes: string[];
}

export interface EpubQualityError {
  ok: false;
  error: string;
}

export type EpubQualityResult = EpubQualityReport | EpubQualityError;

/** Strip tags/entities and collapse whitespace; returns visible text length. */
function visibleTextLength(markup: string): number {
  const text = markup
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length;
}

/**
 * Inspect an EPUB for page-scan structure and chapter presence. Never throws.
 */
export function inspectEpubQuality(epubPath: string): EpubQualityResult {
  try {
    const zip = new AdmZip(epubPath);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);

    // ---- Locate + parse the OPF (same discovery rule as epub-fixer) ----
    const opfEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.opf'));
    if (!opfEntry) {
      return { ok: false, error: 'No OPF package document found (not a valid EPUB?)' };
    }
    const opfDir = path.posix.dirname(opfEntry.entryName);
    const $opf = cheerio.load(opfEntry.getData().toString('utf8'), { xmlMode: true });

    // Manifest: id → href (hrefs are OPF-relative)
    const manifest = new Map<string, { href: string; properties: string }>();
    $opf('manifest > item').each((_, el) => {
      const id = $opf(el).attr('id');
      const href = $opf(el).attr('href');
      if (id && href) {
        manifest.set(id, { href, properties: $opf(el).attr('properties') ?? '' });
      }
    });

    const resolveHref = (href: string): string => {
      const clean = href.split('#')[0];
      return opfDir === '.' ? clean : path.posix.join(opfDir, clean);
    };

    const entryByPath = new Map(entries.map((e) => [e.entryName, e]));
    const findEntry = (zipPath: string): AdmZip.IZipEntry | undefined =>
      entryByPath.get(zipPath) ??
      // Tolerate case drift between manifest hrefs and zip entry names.
      entries.find((e) => e.entryName.toLowerCase() === zipPath.toLowerCase());

    // ---- Spine text volume ----
    let spineDocCount = 0;
    let totalTextChars = 0;
    $opf('spine > itemref').each((_, el) => {
      const idref = $opf(el).attr('idref');
      const item = idref ? manifest.get(idref) : undefined;
      if (!item) return;
      const docEntry = findEntry(resolveHref(item.href));
      if (!docEntry) return;
      const ext = path.posix.extname(docEntry.entryName).toLowerCase();
      if (!CONTENT_EXTENSIONS.includes(ext) && ext !== '.xml') return;
      spineDocCount++;
      totalTextChars += visibleTextLength(docEntry.getData().toString('utf8'));
    });
    const avgTextCharsPerDoc = spineDocCount > 0 ? totalTextChars / spineDocCount : 0;

    // ---- Image share of the archive ----
    let imageCount = 0;
    let imageBytes = 0;
    let archiveBytes = 0;
    for (const e of entries) {
      const size = e.header.size; // uncompressed
      archiveBytes += size;
      if (IMAGE_EXTENSIONS.includes(path.posix.extname(e.entryName).toLowerCase())) {
        imageCount++;
        imageBytes += size;
      }
    }
    const imageByteShare = archiveBytes > 0 ? imageBytes / archiveBytes : 0;

    // ---- TOC entries: EPUB3 nav doc, else EPUB2 NCX ----
    let tocEntries = 0;

    const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.properties));
    if (navItem) {
      const navEntry = findEntry(resolveHref(navItem.href));
      if (navEntry) {
        const $nav = cheerio.load(navEntry.getData().toString('utf8'), { xmlMode: true });
        // The toc nav specifically (epub:type="toc"); fall back to the first nav.
        let $toc = $nav('nav').filter((_, el) => $nav(el).attr('epub:type') === 'toc');
        if ($toc.length === 0) $toc = $nav('nav').first();
        tocEntries = $toc.find('li').length;
      }
    }

    if (tocEntries === 0) {
      const ncxEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.ncx'));
      if (ncxEntry) {
        const $ncx = cheerio.load(ncxEntry.getData().toString('utf8'), { xmlMode: true });
        tocEntries = $ncx('navPoint').length;
      }
    }

    // ---- Verdicts (G5: strict AND-rule) ----
    const textNearZero =
      avgTextCharsPerDoc < NEAR_ZERO_AVG_CHARS_PER_DOC && totalTextChars < NEAR_ZERO_TOTAL_CHARS;
    const imagesDominate =
      imageByteShare > IMAGE_DOMINANCE_BYTE_SHARE && imageCount >= IMAGE_DOMINANCE_MIN_COUNT;

    const scanSuspected = textNearZero && imagesDominate;
    const noChapters = tocEntries < MIN_TOC_ENTRIES;
    const strongVerdict = scanSuspected && noChapters;

    const notes: string[] = [];
    if (scanSuspected) {
      notes.push(
        `possibly scanned pages (images ${(imageByteShare * 100).toFixed(0)}% of archive across ${imageCount} files; ~${Math.round(avgTextCharsPerDoc)} text chars/page over ${spineDocCount} pages)`
      );
    }
    if (noChapters) {
      notes.push(`no chapter TOC (${tocEntries} entr${tocEntries === 1 ? 'y' : 'ies'})`);
    }

    return {
      ok: true,
      spineDocCount,
      totalTextChars,
      avgTextCharsPerDoc,
      imageCount,
      imageBytes,
      archiveBytes,
      imageByteShare,
      tocEntries,
      scanSuspected,
      noChapters,
      strongVerdict,
      notes,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
