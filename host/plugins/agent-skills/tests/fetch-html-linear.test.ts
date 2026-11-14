import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanHtmlContent, htmlToMarkdownText, tryExtractMainContent } from '../src/tools/fetch-executor.ts';

/*
 * Frozen copy of the regex implementation that `htmlToMarkdownText` used before the linear
 * rewrite (fetch-executor.ts at 68d37526). It is the differential oracle: on every input it can
 * finish, the new scanner must produce byte-identical output.
 */
function legacyLargestCapture(html: string, pattern: RegExp): string | undefined {
  let best: string | undefined;
  for (const match of html.matchAll(pattern)) {
    const text = match[1];
    if (text === undefined) continue;
    if (best === undefined || text.length > best.length) best = text;
  }
  return best;
}

function legacyTryExtractMainContent(html: string): string | undefined {
  let best = legacyLargestCapture(html, /<article[^>]*>(.*?)<\/article>/gis);
  if (best === undefined) best = legacyLargestCapture(html, /<main[^>]*>(.*?)<\/main>/gis);
  if (best === undefined || Buffer.byteLength(best, 'utf8') <= 200) return undefined;
  return best;
}

const LEGACY_CLEAN_HTML_PATTERNS: readonly RegExp[] = [
  /<script[^>]*>.*?<\/script>/gis,
  /<style[^>]*>.*?<\/style>/gis,
  /<noscript[^>]*>.*?<\/noscript>/gis,
  /<!--.*?-->/gs,
  /<nav[^>]*>.*?<\/nav>/gis,
  /<header[^>]*>.*?<\/header>/gis,
  /<footer[^>]*>.*?<\/footer>/gis,
  /<aside[^>]*>.*?<\/aside>/gis,
  /<iframe[^>]*>.*?<\/iframe>/gis,
  /<svg[^>]*>.*?<\/svg>/gis,
  /<form[^>]*>.*?<\/form>/gis,
  /<dialog[^>]*>.*?<\/dialog>/gis,
  /<template[^>]*>.*?<\/template>/gis,
  /<object[^>]*>.*?<\/object>/gis,
  /<embed[^>]*(?:\/>|>.*?<\/embed>)/gis,
  /<applet[^>]*>.*?<\/applet>/gis,
];

function legacyCleanHtmlContent(html: string): string {
  let result = html;
  for (const pattern of LEGACY_CLEAN_HTML_PATTERNS) result = result.replace(pattern, '');
  return result;
}

function legacyCleanMarkdownContent(markdown: string): string {
  return markdown.replace(/\n{3,}/g, '\n\n');
}

const LEGACY_ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function legacyDecodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return LEGACY_ENTITY_MAP[body.toLowerCase()] ?? whole;
  });
}

function legacyHtmlToMarkdownText(html: string): string {
  const source = legacyTryExtractMainContent(html) ?? html;
  let text = legacyCleanHtmlContent(source);
  text = text.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_whole, level: string, body: string) =>
    `\n\n${'#'.repeat(Number(level))} ${body.trim()}\n\n`);
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gis, (_whole, body: string) => `\n- ${body.trim()}`);
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div|section|table|tr|ul|ol)>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, '');
  text = legacyDecodeEntities(text);
  return legacyCleanMarkdownContent(text.split('\n').map(line => line.trimEnd()).join('\n').trim());
}

const LOREM = 'Deep Student keeps study notes, review cards and source documents together so the '
  + 'assistant can cite them. This paragraph is long enough to cross the 200 byte extraction threshold.';

/** Pages already used as fixtures by the fetch tests, verbatim. */
const EXISTING_FIXTURES: readonly string[] = [
  '<html><body><nav>menu</nav><article><h1>Title</h1><p>Hello world body.</p></article><script>x()</script></body></html>',
  `
        <html>
        <head>
            <script>alert('test');</script>
            <style>.test { color: red; }</style>
        </head>
        <body>
            <nav>Navigation</nav>
            <p>Hello World</p>
            <footer>Footer</footer>
        </body>
        </html>
        `,
  `
        <html><body>
            <form action="/submit"><input type="text"></form>
            <dialog open>Dialog content</dialog>
            <template>Template content</template>
            <p>Main content here</p>
            <object data="flash.swf">Object content</object>
        </body></html>
        `,
  `
        <html><body>
            <nav>Navigation</nav>
            <article>
                <h1>Article Title</h1>
                <p>This is the main article content that should be extracted.
                It needs to be long enough to pass the 200 character threshold
                for extraction to work properly. Adding more text here to ensure
                we exceed the minimum length requirement.</p>
            </article>
            <aside>Sidebar</aside>
        </body></html>
        `,
  '<html><body><article><p>Short</p></article></body></html>',
];

const CRAFTED_SAMPLES: readonly string[] = [
  `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><title>Spaced repetition &amp; you</title>
  <style>body { font: 14px/1.4 sans-serif } .a > .b { color: red }</style>
  <script type="module">if (a < b && c > d) { document.write('</div><!-- not a comment -->'); }</script>
  <script src="/analytics.js" async></script>
  <!--[if lt IE 9]><script src="html5shiv.js"></script><![endif]-->
</head>
<body class="post">
  <header class="site"><a href="/">Home</a><nav><ul><li><a href="/a">A</a></li><li>B</li></ul></nav></header>
  <main id="content">
    <article class="entry">
      <h1 class="title">Why <em>spacing</em> works</h1>
      <p>${LOREM}</p>
      <p>Read the <a href="https://example.com/paper?id=1&amp;v=2" title="a > b">original paper</a> &mdash; or the
      <a href='/summary'>summary</a>.&nbsp;Costs &lt;5&nbsp;min/day&#8212;really. &#x4E2D;&#25991; &#x1F600;</p>
      <h2>Steps</h2>
      <ol>
        <li>Pick a <strong>deck</strong><ul><li>nested one</li><li>nested two</li></ul></li>
        <li data-step='2'>Review daily</li>
      </ol>
      <h3 id="table">Results</h3>
      <table class="data">
        <thead><tr><th>Interval</th><th>Recall</th></tr></thead>
        <tbody><tr><td>1d</td><td>90%</td></tr><tr><td>7d</td><td>80%</td></tr></tbody>
      </table>
      <blockquote><p>Memory is the residue of thought.</p></blockquote>
      <pre><code>let x = a &lt; b;
console.log(x);</code></pre>
      <img src="chart.png" alt="chart"><br><hr/><br />
      <svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>
      <form method="post"><input name="q"><button>Go</button></form>
      <noscript>Enable JS</noscript>
      <iframe src="https://video.example/embed"></iframe>
      <template><p>hidden</p></template>
      <dialog>modal</dialog>
      <embed src="old.swf"><embed src="new.swf" />
      <object data="x.swf"><param name="a"></object>
      <applet code="A.class">Java</applet>
      <h4>Notes</h4><h5>Minor</h5><h6>Tiny</h6>
    </article>
    <aside>Related posts</aside>
  </main>
  <footer>&copy; 2026 Deep Student</footer>
  <script>window.__STATE__ = {"html":"<li>not a list</li>"};</script>
</body>
</html>`,
  '<HTML><HEAD><TITLE>Legacy</TITLE></HEAD><BODY><H1>Title</H1><UL><LI>One<LI>Two</UL>'
    + '<TABLE><TR><TD>a</TD><TD>b</TD></TR></TABLE><P>Para<BR>break</P><SCRIPT>x</SCRIPT></BODY></HTML>',
  `<html><body><div class="doc"><h2>二、学习方法</h2><p>间隔重复&ldquo;有效&rdquo;：复习&#x95F4;&#38548;逐渐变长。</p>
<ul><li>第一天</li><li>第三天</li><li>第七天</li></ul><p>公式：a &lt; b &gt; c，&quot;引号&quot; &apos;单引号&apos;</p></div></body></html>`,
  `<html><body><article><p>tiny</p></article><article><h1>Big</h1><p>${LOREM}</p></article>
<article><article><p>${LOREM}</p></article></article><main><p>${LOREM}${LOREM}</p></main></body></html>`,
  `<html><body><article><p>short article</p></article><main role="main"><h2>From main</h2><p>${LOREM}</p></main>
<main><p>second main</p></main></body></html>`,
  '<div data-x=\'>\' title="x > y"><a href="#" onclick="return a>b">link</a> 1 < 2 and 3 > 2, x<y, a<>b</div>',
  '<h2>Intro</h3>still intro</h2><h1>One</h1 ><h7>not a heading</h7><H3 CLASS="x">Upper</h3>',
  '<p>a</p><embed src="a.swf"><p>b</p><embed src="b.swf"/><p>c</p><EMBED>inner</EMBED><p>d</p><embed/>',
  '<html><body><p>Truncated page</p><script>var a = 1; // connection dropped here',
  '<html><body><p>Open comment <!-- never closed <p>tail</p></body></html>',
  `<ul>${Array.from({ length: 200 }, (_, index) => `<li class="i${index}">item ${index}</li>`).join('\n')}</ul>`,
  '<p>Emoji 😀 and astral 𝒳 and combining é, İstanbul, ſtraße, \u212Aelvin</p><ſcript>kept</ſcript>',
  '<p>&#65;&#x42;&#X43;&unknown;&amp&amp;amp;&#12ab;&#xZZ;&NBSP;&Amp;</p>',
  'plain text with no tags at all\n\n\n\nand blank lines   \n  trailing   ',
  '',
];

const REPO_PAGES: readonly string[] = [
  'index.html', 'demo.html', 'hero.html', 'pelican-jetski.html', 'button-audit.html', 'preview-charts.html',
  'mobile/index.html', 'mobile/spike.html', 'electron/tests/fixtures/browser-main.html',
  'electron/tests/fixtures/smoke.html', 'host/plugins/media/assets/bilibili/pair.html',
  'scripts/electron-migration/dashboard/index.html', 'playwright/index.html', 'demo-app.html',
];

function repoPages(): string[] {
  return REPO_PAGES.filter(file => existsSync(file)).map(file => readFileSync(file, 'utf8'));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_TOKENS: readonly string[] = [
  '<', '>', '/', '/>', ' ', '\n', '\n\n\n', 'a', 'Text', '中文', '😀', 'İ', 'ſ', '\u212A', '=', '"', "'", '-',
  '<script', '<script>', '</script>', '<SCRIPT type=x>', '</Script>', '<style>', '</style>', '<noscript>', '</noscript>',
  '<!--', '-->', '<!-->', '<nav>', '</nav>', '<header>', '</header>', '<footer>', '</footer>', '<aside>', '</aside>',
  '<iframe>', '</iframe>', '<svg>', '</svg>', '<form>', '</form>', '<dialog>', '</dialog>', '<template>', '</template>',
  '<object>', '</object>', '<embed', '<embed>', '<embed src=x/>', '<EMBED/', '</embed>', '<applet>', '</applet>',
  '<article>', '<article class="x">', '</article>', '</ARTICLE>', '<main>', '</main>', LOREM,
  '<h1>', '</h1>', '<h2 id=x>', '</h2>', '</H2>', '<h3', '</h3>', '<h6>', '</h6>', '<h7>', '<h', '<hr>', '<hr/>',
  '<br>', '<br />', '<BR/>', '<li>', '<LI class=a>', '</li>', '<link rel=x>', '<p>', '</p>', '</DIV>', '</tr>', '</ol>',
  '&amp;', '&lt;', '&gt;', '&nbsp;', '&#65;', '&#x4E2D;', '&#X1F600;', '&bogus;', '&', '#',
];

function fuzzDocument(next: () => number): string {
  const length = 1 + Math.floor(next() * 40);
  let document = '';
  for (let index = 0; index < length; index++) document += FUZZ_TOKENS[Math.floor(next() * FUZZ_TOKENS.length)]!;
  return document;
}

function expectSameAsLegacy(html: string): void {
  expect(tryExtractMainContent(html)).toBe(legacyTryExtractMainContent(html));
  expect(cleanHtmlContent(html)).toBe(legacyCleanHtmlContent(html));
  expect(htmlToMarkdownText(html)).toBe(legacyHtmlToMarkdownText(html));
}

/** Characters examined by `String.prototype.indexOf` while `run` executes. */
function indexOfScanCost(run: () => void): number {
  const original = String.prototype.indexOf;
  let scanned = 0;
  String.prototype.indexOf = function indexOf(this: string, needle: string, from?: number): number {
    const start = Math.max(0, from ?? 0);
    const at = original.call(this, needle, start);
    scanned += Math.max(0, (at < 0 ? this.length : at + needle.length) - start);
    return at;
  };
  try { run(); }
  finally { String.prototype.indexOf = original; }
  return scanned;
}

function fastestMs(run: () => void, repeats: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < repeats; index++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

const KB = 1024;
const sized = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

/** Unclosed-tag payloads that made the former regexes backtrack quadratically. */
const ADVERSARIAL_UNITS: readonly [string, string][] = [
  ['unclosed <script', '<script'],
  ['unclosed <li>', '<li>'],
  ['unclosed <li', '<li'],
  ['unclosed comments', '<!--'],
  ['bare <', '<'],
  ['<a without >', '<a'],
  ['unclosed <h1>', '<h1>'],
  ['mismatched heading close', '<h1>x</h2>'],
  ['unclosed <article>', '<article>'],
  ['unclosed <main', '<main'],
  ['unclosed <embed>', '<embed>'],
  ['mixed openers', '<script<style<nav<!--<li<h2<article<main<embed<svg<form<'],
];

describe('web_fetch HTML→Markdown linear scanner (M1)', () => {
  it('matches the former regex implementation on existing fixtures, crafted pages and repo pages', () => {
    const pages = repoPages();
    expect(pages.length).toBeGreaterThanOrEqual(10);
    for (const html of [...EXISTING_FIXTURES, ...CRAFTED_SAMPLES, ...pages]) expectSameAsLegacy(html);
  });

  it('crafted pages exercise every rewrite path', () => {
    const markdown = htmlToMarkdownText(CRAFTED_SAMPLES[0]!);
    expect(markdown).toContain('# Why spacing works');
    expect(markdown).toContain('###### Tiny');
    expect(markdown).toContain('- nested two');
    expect(markdown).toContain('Costs <5 min/day—really. 中文 😀');
    expect(markdown).not.toMatch(/analytics|Related posts|Enable JS|modal|hidden|Java|not a list/);
  });

  it('matches the former regex implementation on 4000 seeded random tag soups', () => {
    const next = mulberry32(0x5eed01);
    for (let index = 0; index < 4000; index++) expectSameAsLegacy(fuzzDocument(next));
  });

  it.each(ADVERSARIAL_UNITS)('%s: indexOf work grows linearly from 256 KB to 1 MB', (_label, unit) => {
    const small = sized(unit, 256 * KB);
    const large = sized(unit, 1024 * KB);
    const smallCost = indexOfScanCost(() => htmlToMarkdownText(small));
    const largeCost = indexOfScanCost(() => htmlToMarkdownText(large));
    expect(largeCost / large.length).toBeLessThanOrEqual(80);
    expect(largeCost / smallCost).toBeLessThan(4.5);
  });

  it.each(ADVERSARIAL_UNITS)('%s: wall time scales linearly and 1 MB finishes well under a second', (_label, unit) => {
    const small = sized(unit, 256 * KB);
    const large = sized(unit, 1024 * KB);
    htmlToMarkdownText(small);
    const smallMs = Math.max(fastestMs(() => htmlToMarkdownText(small), 5), 1);
    const largeMs = fastestMs(() => htmlToMarkdownText(large), 5);
    expect(largeMs).toBeLessThan(1000);
    expect(largeMs / smallMs).toBeLessThan(10);
  });
});
