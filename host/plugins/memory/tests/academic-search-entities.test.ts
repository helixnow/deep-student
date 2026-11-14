import { describe, expect, it } from 'vitest';
import { parseArxivAtom } from '../src/academic-search.ts';

const feed = (title: string, id = 'http://arxiv.org/abs/2401.00001v2') => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>${id}</id>
    <title>${title}</title>
    <summary>Abstract with &lt;b&gt; &amp; &#x4E2D; &#65;</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>Ada</name></author>
    <category term="cs.LG"/>
  </entry>
</feed>`;

describe('arXiv Atom character references (L2)', () => {
  it('RF-S01-arxiv-invalid-char-ref-drops-text: an invalid reference becomes U+FFFD and keeps the rest of the field', () => {
    // Rust `e.unescape().unwrap_or_default()` turns the whole text node into "" on such a
    // reference: the title would be blank, and a bad <id> silently drops the paper.
    const [paper] = parseArxivAtom(feed('Bad &#x110000; ref, NUL &#0; and &#xD800; and &#99999999999999999999;'));
    expect(paper).toMatchObject({ id: '2401.00001', title: 'Bad \uFFFD ref, NUL \uFFFD and \uFFFD and \uFFFD' });
    expect(parseArxivAtom(feed('ok', 'http://arxiv.org/abs/2401.00002&#x110000;'))).toHaveLength(1);
  });

  it('RF-S01-arxiv-invalid-char-ref-drops-text: quick-xml number grammar (lowercase x, no sign, digits only) — anything else is an invalid reference', () => {
    const [paper] = parseArxivAtom(feed('U &#X41; S &#+65; E &#; H &#x; D &#12a; ok &#x41;'));
    expect(paper!.title).toBe('U \uFFFD S \uFFFD E \uFFFD H \uFFFD D \uFFFD ok A');
  });

  it('references decode in one left-to-right pass like quick-xml unescape, so a decoded & never starts another one', () => {
    const [paper] = parseArxivAtom(feed('A &#38;lt; B &#x26;#65; C &#38;amp; D &amp;lt; E'));
    expect(paper!.title).toBe('A &lt; B &#65; C &amp; D &lt; E');
  });

  it('RF-S01-arxiv-unrecognized-entity-drops-text: an unrecognized entity or a bare & stays literal and the rest of the field still decodes', () => {
    expect(parseArxivAtom(feed('Tom &amp; Jerry &nbsp; x'))[0]!.title).toBe('Tom & Jerry &nbsp; x');
    expect(parseArxivAtom(feed('AT&T &amp; co'))[0]!.title).toBe('AT&T & co');
    expect(parseArxivAtom(feed('x & y; &lt; z &'))[0]!.title).toBe('x & y; < z &');
    expect(parseArxivAtom(feed('&constructor; &#x41;'))[0]!.title).toBe('&constructor; A');
    expect(parseArxivAtom(feed('ok', 'http://arxiv.org/abs/2401.00003&bogus;'))).toHaveLength(1);
  });

  it('attribute values stay raw like from_utf8_lossy(&attr.value) (academic_search_executor.rs:375-433)', () => {
    const xml = feed('t').replace('<category term="cs.LG"/>', `<category term="a&amp;b"/><category term='single'/>
    <link title="pdf" href="http://arxiv.org/pdf/x?a=1&amp;b=2" rel="related"/><link title="pdf" href=""/>`);
    const [paper] = parseArxivAtom(xml);
    expect(paper!.categories).toEqual(['a&amp;b', 'single']);
    expect(paper!.pdfUrl).toBe('http://arxiv.org/pdf/x?a=1&amp;b=2');
  });

  it('valid references decode as before', () => {
    const [paper] = parseArxivAtom(feed('Max &#x10FFFF; &#1114111; &#x1F600;'));
    expect(paper!.title).toBe('Max \u{10FFFF} \u{10FFFF} 😀');
    expect(paper!.abstract).toBe('Abstract with <b> & 中 A');
  });
});
