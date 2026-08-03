import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { loadEpubBook, renderEpubChapter, resolveEpubNavigation, searchEpubBook } from '../epubReaderModel';

async function createMinimalEpub(): Promise<string> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file('OPS/package.opf', `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Reader Test</dc:title><dc:creator>Deep Student</dc:creator>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="c1" href="text/chapter-1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="text/chapter-2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
    </package>`);
  zip.file('OPS/nav.xhtml', `<!doctype html><html xmlns:epub="http://www.idpf.org/2007/ops"><body>
    <nav epub:type="toc"><ol><li><a href="text/chapter-1.xhtml">Opening</a></li>
    <li><a href="text/chapter-2.xhtml#part">Details</a></li></ol></nav>
  </body></html>`);
  zip.file('OPS/text/chapter-1.xhtml', '<html><head><title>One</title></head><body><h1>Chapter One</h1><p>A searchable phrase.</p><svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="../missing.png" href="../missing.png"/><text>Vector emblem</text></svg><script>window.bad = true</script></body></html>');
  zip.file('OPS/text/chapter-2.xhtml', '<html><body><h1 id="part">Chapter Two</h1><p>More searchable text.</p><p>Another searchable line.</p></body></html>');
  return zip.generateAsync({ type: 'base64' });
}

describe('epubReaderModel', () => {
  it('loads metadata, spine and EPUB 3 navigation', async () => {
    const book = await loadEpubBook(await createMinimalEpub());

    expect(book.title).toBe('Reader Test');
    expect(book.author).toBe('Deep Student');
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(['Opening', 'Details']);
    expect(book.toc).toMatchObject([
      { title: 'Opening', chapterIndex: 0 },
      { title: 'Details', chapterIndex: 1, fragment: 'part' },
    ]);
  });

  it('searches all spine chapters and sanitizes active content', async () => {
    const book = await loadEpubBook(await createMinimalEpub());
    const results = await searchEpubBook(book, 'searchable');
    const rendered = await renderEpubChapter(book, 0, { theme: 'dark', fontScale: 1.2 });

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ chapterIndex: 0, title: 'Opening' });
    expect(rendered.srcDoc).not.toContain('<script');
    expect(rendered.srcDoc).toContain("script-src 'none'");
    expect(rendered.srcDoc).toContain('font-size: 120%');
  });

  it('reports per-chapter match ordinals so hits can be focused in order', async () => {
    const book = await loadEpubBook(await createMinimalEpub());
    const results = await searchEpubBook(book, 'searchable');

    expect(results.map((result) => [result.chapterIndex, result.matchIndex])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it('keeps text inside SVG searchable', async () => {
    const book = await loadEpubBook(await createMinimalEpub());
    const results = await searchEpubBook(book, 'emblem');

    expect(results).toMatchObject([{ chapterIndex: 0, matchIndex: 0 }]);
  });

  it('strips unresolvable SVG image references including xlink:href', async () => {
    const book = await loadEpubBook(await createMinimalEpub());
    const rendered = await renderEpubChapter(book, 0, { theme: 'light', fontScale: 1 });

    expect(rendered.srcDoc).not.toContain('xlink:href');
    expect(rendered.srcDoc).not.toContain('missing.png');
  });

  it('applies typography options to the injected reader styles', async () => {
    const book = await loadEpubBook(await createMinimalEpub());
    const rendered = await renderEpubChapter(book, 0, {
      theme: 'sepia',
      fontScale: 1,
      fontFamily: 'sans',
      lineHeight: 1.9,
      pageMargin: 1,
    });

    expect(rendered.srcDoc).toContain('font-size: 100%');
    expect(rendered.srcDoc).toContain('line-height: 1.9');
    expect(rendered.srcDoc).toContain('sans-serif');
    expect(rendered.srcDoc).toContain('mark[data-epub-search]');
  });

  it('resolves internal chapter links without treating external links as book navigation', async () => {
    const book = await loadEpubBook(await createMinimalEpub());

    expect(resolveEpubNavigation(book, 0, 'chapter-2.xhtml#part')).toEqual({
      chapterIndex: 1,
      fragment: 'part',
    });
    expect(resolveEpubNavigation(book, 0, '#local')).toEqual({ chapterIndex: 0, fragment: 'local' });
    expect(resolveEpubNavigation(book, 0, 'https://example.com')).toBeNull();
  });
});
