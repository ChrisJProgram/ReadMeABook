/**
 * Component: Libgen E-book Source Service Tests
 * Documentation: documentation/integrations/ebook-sidecar.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

const AxiosErrorMock = vi.hoisted(() =>
  class MockAxiosError extends Error {
    code?: string;
    response?: { status?: number };
    constructor(message?: string) {
      super(message);
      this.name = 'AxiosError';
    }
  }
);

vi.mock('axios', () => ({
  default: axiosMock,
  ...axiosMock,
  AxiosError: AxiosErrorMock,
}));

import {
  parseLibgenResults,
  parseLibgenSize,
  extractLibgenGetUrl,
  buildLibgenAdsUrl,
  buildLibgenQuery,
  primaryAuthorSurname,
  searchLibgen,
  resolveLibgenDownloadUrl,
  DEFAULT_LIBGEN_MIRROR,
} from '@/lib/services/libgen-scraper';

// Minimal fixture mirroring the real libgen.bz #tablelibgen structure:
// td0=title(+badge), td1=author, td2=publisher, td3=year, td4=language,
// td5=pages, td6=size, td7=extension, td8=mirrors(ads.php?md5=).
const SEARCH_HTML = `
<table class="table table-striped" id="tablelibgen">
  <thead><tr><th>ID</th></tr></thead>
  <tbody>
    <tr>
      <td>
        <a href="edition.php?id=1">Come As You Are : The Science That Will Transform Your Sex Life</a>
        <nobr><span class="badge badge-primary"><a>b</a></span>
        <span class="badge badge-secondary">l 3192620</span></nobr>
      </td>
      <td>Emily Nagoski</td>
      <td>Simon &amp; Schuster</td>
      <td>2015</td>
      <td>English</td>
      <td>400</td>
      <td><nobr><a href="/file.php?id=1">1.2 MB</a></nobr></td>
      <td>epub</td>
      <td>
        <a title="libgen" href="/ads.php?md5=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"><span class="badge badge-primary">1</span></a>
        <a title="anna's archive" href="https://annas-archive.gl/md5/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">3</a>
      </td>
    </tr>
    <tr>
      <td>
        <a href="edition.php?id=2">Downloaden Come as You Are PDF Gratis</a>
        <nobr><span class="badge badge-secondary">f 7895518</span></nobr>
      </td>
      <td>Spam Uploader</td>
      <td></td>
      <td></td>
      <td>English</td>
      <td>2</td>
      <td><nobr><a href="/file.php?id=2">81 kB</a></nobr></td>
      <td>pdf</td>
      <td>
        <a title="libgen" href="/ads.php?md5=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"><span class="badge">1</span></a>
      </td>
    </tr>
  </tbody>
</table>`;

const ADS_HTML = `
<html><body>
  <div class="row"><h1>Come As You Are</h1></div>
  <a href="get.php?md5=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&key=V2B6AD60D9GICWVN" class="btn">GET</a>
</body></html>`;

describe('libgen-scraper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseLibgenSize', () => {
    it('parses kB/MB/GB to bytes', () => {
      expect(parseLibgenSize('81 kB')).toBe(81 * 1024);
      expect(parseLibgenSize('1.2 MB')).toBe(Math.round(1.2 * 1024 * 1024));
      expect(parseLibgenSize('1 GB')).toBe(1024 ** 3);
    });
    it('returns 0 when unparseable', () => {
      expect(parseLibgenSize('')).toBe(0);
      expect(parseLibgenSize('unknown')).toBe(0);
    });
  });

  describe('buildLibgenAdsUrl', () => {
    it('builds a stable ads.php URL and strips trailing slashes', () => {
      expect(buildLibgenAdsUrl('https://libgen.bz/', 'abc')).toBe('https://libgen.bz/ads.php?md5=abc');
    });
  });

  describe('parseLibgenResults', () => {
    it('extracts md5, title, author, format and size from the results table', () => {
      const rows = parseLibgenResults(SEARCH_HTML, 'https://libgen.bz');
      expect(rows).toHaveLength(2);
      const first = rows[0];
      expect(first.md5).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(first.title).toContain('Come As You Are');
      expect(first.author).toBe('Emily Nagoski');
      expect(first.format).toBe('epub');
      expect(first.sizeBytes).toBe(Math.round(1.2 * 1024 * 1024));
      expect(first.collection).toBe('l');
      expect(first.adsUrl).toBe('https://libgen.bz/ads.php?md5=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });
  });

  describe('extractLibgenGetUrl', () => {
    it('extracts the keyed get.php link and makes it absolute', () => {
      const url = extractLibgenGetUrl(ADS_HTML, 'https://libgen.bz/ads.php?md5=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(url).toBe('https://libgen.bz/get.php?md5=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&key=V2B6AD60D9GICWVN');
    });
    it('returns null when no get.php link is present', () => {
      expect(extractLibgenGetUrl('<html><body>no link</body></html>', 'https://libgen.bz/ads.php?md5=x')).toBeNull();
    });
  });

  describe('buildLibgenQuery', () => {
    it('strips subtitle, parentheticals, narrator and honorifics for the search query', () => {
      // Libgen req= is AND-matched; the raw audiobook strings return 0 rows live.
      expect(buildLibgenQuery('Come As You Are: Revised and Updated', 'Emily Nagoski Ph.D., Nicholas Boulton'))
        .toBe('Come As You Are Emily Nagoski');
      expect(buildLibgenQuery('The Way of Kings (Unabridged)', 'Brandon Sanderson'))
        .toBe('The Way of Kings Brandon Sanderson');
    });
  });

  describe('primaryAuthorSurname', () => {
    it('takes the primary author surname, ignoring appended narrator + honorifics', () => {
      // Real rmab2 case: audiobook author field carries the narrator + a Ph.D.
      expect(primaryAuthorSurname('Emily Nagoski Ph.D., Nicholas Boulton')).toBe('nagoski');
      expect(primaryAuthorSurname('Emily Nagoski')).toBe('nagoski');
      expect(primaryAuthorSurname('Brandon Sanderson; Michael Kramer')).toBe('sanderson');
    });
  });

  describe('searchLibgen', () => {
    it('returns author-matched results best-first and excludes wrong-author rows', async () => {
      axiosMock.get.mockResolvedValue({ data: SEARCH_HTML });

      const results = await searchLibgen('Come As You Are', 'Emily Nagoski', 'epub');

      // Only the Emily Nagoski row survives the required-author gate; the
      // "Spam Uploader" row is dropped.
      expect(results).toHaveLength(1);
      expect(results[0].md5).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(results[0].author).toBe('Emily Nagoski');
      expect(results[0].format).toBe('epub');
    });

    it('matches when the request author has an appended narrator (audiobook author field)', async () => {
      axiosMock.get.mockResolvedValue({ data: SEARCH_HTML });

      // The audiobook author field pollutes the name with a narrator; the primary
      // author's surname ("Nagoski") must still match the Libgen row.
      const results = await searchLibgen(
        'Come As You Are: Revised and Updated',
        'Emily Nagoski Ph.D., Nicholas Boulton',
        'epub'
      );

      expect(results).toHaveLength(1);
      expect(results[0].md5).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    it('returns an empty array on request failure', async () => {
      axiosMock.get.mockRejectedValue(new Error('network down'));
      const results = await searchLibgen('Whatever', 'Someone', 'epub');
      expect(results).toEqual([]);
    });

    it('defaults to the empirically-chosen mirror', () => {
      expect(DEFAULT_LIBGEN_MIRROR).toBe('https://libgen.bz');
    });
  });

  describe('resolveLibgenDownloadUrl', () => {
    it('fetches the ads.php landing and returns the freshly-keyed get.php URL + format', async () => {
      axiosMock.get.mockResolvedValue({ data: ADS_HTML });

      const resolved = await resolveLibgenDownloadUrl(
        'https://libgen.bz/ads.php?md5=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'epub'
      );

      expect(resolved).not.toBeNull();
      expect(resolved!.url).toContain('get.php?md5=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&key=');
      expect(resolved!.format).toBe('epub');
    });

    it('returns null when the landing page has no download link', async () => {
      axiosMock.get.mockResolvedValue({ data: '<html><body>nothing here</body></html>' });
      const resolved = await resolveLibgenDownloadUrl('https://libgen.bz/ads.php?md5=x', 'epub');
      expect(resolved).toBeNull();
    });
  });
});
