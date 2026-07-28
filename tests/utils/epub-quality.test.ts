/**
 * Component: EPUB Quality Inspector Tests (F6)
 *
 * Builds real EPUB archives with AdmZip and inspects them — no mocks. The
 * cookbook case is the load-bearing one: image-heavy but with real text and a
 * TOC, it must NEVER trip the scan verdict (G5 strict AND-rule).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { inspectEpubQuality } from '@/lib/utils/epub-quality';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'epub-quality-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** ~5 KB of fake image bytes (raw buffer; content irrelevant to the inspector). */
const fakeImage = () => Buffer.alloc(5 * 1024, 0xab);

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

interface BuildOptions {
  /** [id, href, text-content] triples that become spine documents. */
  docs: Array<[string, string, string]>;
  images?: number;
  ncxNavPoints?: number; // EPUB2 TOC entries (0 = no ncx file)
  nav?: { tocEntries: number }; // EPUB3 nav document
}

async function buildEpub(name: string, opts: BuildOptions): Promise<string> {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER_XML));

  const manifestItems: string[] = [];
  const spineRefs: string[] = [];

  for (const [id, href, text] of opts.docs) {
    manifestItems.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
    spineRefs.push(`<itemref idref="${id}"/>`);
    zip.addFile(
      `OEBPS/${href}`,
      Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${text}</p></body></html>`)
    );
  }

  for (let i = 0; i < (opts.images ?? 0); i++) {
    manifestItems.push(`<item id="img${i}" href="images/page${i}.jpg" media-type="image/jpeg"/>`);
    zip.addFile(`OEBPS/images/page${i}.jpg`, fakeImage());
  }

  if (opts.nav) {
    const lis = Array.from({ length: opts.nav.tocEntries }, (_, i) => `<li><a href="doc${i}.xhtml">Ch ${i + 1}</a></li>`).join('');
    manifestItems.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    zip.addFile(
      'OEBPS/nav.xhtml',
      Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${lis}</ol></nav></body></html>`)
    );
  }

  if (opts.ncxNavPoints && opts.ncxNavPoints > 0) {
    const points = Array.from(
      { length: opts.ncxNavPoints },
      (_, i) => `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>Chapter ${i + 1}</text></navLabel><content src="doc${i}.xhtml"/></navPoint>`
    ).join('');
    manifestItems.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
    zip.addFile(
      'OEBPS/toc.ncx',
      Buffer.from(`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${points}</navMap></ncx>`)
    );
  }

  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Test</dc:title></metadata>
  <manifest>${manifestItems.join('')}</manifest>
  <spine>${spineRefs.join('')}</spine>
</package>`;
  zip.addFile('OEBPS/content.opf', Buffer.from(opf));

  const out = path.join(dir, name);
  zip.writeZip(out);
  return out;
}

const CHAPTER_TEXT = 'It was the best of times, it was the worst of times. '.repeat(40); // ~2.1k chars

describe('inspectEpubQuality', () => {
  it('passes a normal text book with an NCX TOC clean', async () => {
    const file = await buildEpub('clean.epub', {
      docs: Array.from({ length: 8 }, (_, i) => [`d${i}`, `doc${i}.xhtml`, CHAPTER_TEXT] as [string, string, string]),
      ncxNavPoints: 8,
      images: 1, // a cover
    });
    const r = inspectEpubQuality(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scanSuspected).toBe(false);
    expect(r.noChapters).toBe(false);
    expect(r.strongVerdict).toBe(false);
    expect(r.notes).toEqual([]);
    expect(r.tocEntries).toBe(8);
  });

  it('flags a pure page-scan wrapper with the STRONG verdict', async () => {
    const file = await buildEpub('scan.epub', {
      // Pages are just <img> wrappers — near-zero text
      docs: Array.from({ length: 10 }, (_, i) => [`d${i}`, `doc${i}.xhtml`, ''] as [string, string, string]),
      images: 10,
      // no nav, no ncx
    });
    const r = inspectEpubQuality(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scanSuspected).toBe(true);
    expect(r.noChapters).toBe(true);
    expect(r.strongVerdict).toBe(true);
    expect(r.notes.join(' ')).toMatch(/possibly scanned/);
    expect(r.notes.join(' ')).toMatch(/no chapter TOC/);
  });

  it('never calls an image-heavy book WITH real text and a TOC a scan (cookbook case)', async () => {
    const file = await buildEpub('cookbook.epub', {
      docs: Array.from({ length: 6 }, (_, i) => [`d${i}`, `doc${i}.xhtml`, CHAPTER_TEXT] as [string, string, string]),
      images: 40, // images dominate the archive bytes
      ncxNavPoints: 6,
    });
    const r = inspectEpubQuality(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.imageByteShare).toBeGreaterThan(0.6); // images DO dominate…
    expect(r.scanSuspected).toBe(false); // …but real text vetoes the scan verdict
    expect(r.strongVerdict).toBe(false);
  });

  it('reports missing chapters alone as a weak (flag-only) finding', async () => {
    const file = await buildEpub('no-toc.epub', {
      docs: Array.from({ length: 5 }, (_, i) => [`d${i}`, `doc${i}.xhtml`, CHAPTER_TEXT] as [string, string, string]),
      // no nav, no ncx
    });
    const r = inspectEpubQuality(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.noChapters).toBe(true);
    expect(r.scanSuspected).toBe(false);
    expect(r.strongVerdict).toBe(false); // chapters alone can never reject
    expect(r.notes).toHaveLength(1);
  });

  it('counts an EPUB3 nav TOC', async () => {
    const file = await buildEpub('epub3.epub', {
      docs: Array.from({ length: 4 }, (_, i) => [`d${i}`, `doc${i}.xhtml`, CHAPTER_TEXT] as [string, string, string]),
      nav: { tocEntries: 4 },
    });
    const r = inspectEpubQuality(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tocEntries).toBe(4);
    expect(r.noChapters).toBe(false);
  });

  it('returns ok:false on a file that is not a zip (and never throws)', async () => {
    const bad = path.join(dir, 'not-a-zip.epub');
    await writeFile(bad, 'this is not an epub');
    const r = inspectEpubQuality(bad);
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when the archive has no OPF', async () => {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/epub+zip'));
    zip.addFile('some.txt', Buffer.from('hello'));
    const out = path.join(dir, 'no-opf.epub');
    zip.writeZip(out);
    const r = inspectEpubQuality(out);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/OPF/i);
  });
});
