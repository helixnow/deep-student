import { describe, expect, it } from 'vitest';

import {
  CHAT_HTML_PREVIEW_SANDBOX,
  INITIAL_HTML_PREVIEW_BUFFER,
  buildChatHtmlPreviewDocument,
  htmlPreviewBufferReducer,
  htmlUsesScripts,
  looksLikeHtmlDocument,
  repairPartialHtml,
  shouldAutoPreviewHtml,
  type HtmlPreviewBufferState,
} from '../chatHtmlPreviewDocument';

const PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=https://evil.test">
  <title>Demo</title>
  <style>body { background: #fafafa; } .card { padding: 8px; }</style>
  <link rel="stylesheet" href="https://cdn.test/x.css">
</head>
<body class="theme" onload="boot()">
  <div class="card">Hi <a href="https://example.com" target="_blank">ext</a> <a href="#sec">jump</a></div>
  <script>boot()</script>
</body>
</html>`;

describe('repairPartialHtml', () => {
  it('drops a half-written trailing tag', () => {
    expect(repairPartialHtml('<div class="a">Hello <span sty').html).toBe('<div class="a">Hello ');
  });

  it('holds back unterminated raw-text elements and comments', () => {
    expect(repairPartialHtml('<p>x</p><style>.a{color:r').html).toBe('<p>x</p>');
    expect(repairPartialHtml('<p>x</p><!-- todo').html).toBe('<p>x</p>');
    expect(repairPartialHtml('<p>x</p><script>if (a < b').html).toBe('<p>x</p>');
  });

  it('keeps completed raw text containing "<"', () => {
    const src = '<style>a::before{content:"<"}</style><p>ok</p>';
    expect(repairPartialHtml(src).html).toBe(src);
  });

  it('strips a trailing partial entity but keeps bare "<" in text', () => {
    expect(repairPartialHtml('<p>a &amp b &nbs').html).toBe('<p>a &amp b ');
    expect(repairPartialHtml('<p>1 < 2').html).toBe('<p>1 < 2');
  });

  it('only advances stableLength when more markup completes', () => {
    const a = repairPartialHtml('<p>x</p><div cl');
    const b = repairPartialHtml('<p>x</p><div class="y');
    const c = repairPartialHtml('<p>x</p><div class="y">');
    expect(a.stableLength).toBe(b.stableLength);
    expect(c.stableLength).toBeGreaterThan(b.stableLength);
  });
});

describe('document detection', () => {
  it('detects full documents including streaming prefixes', () => {
    expect(looksLikeHtmlDocument(PAGE)).toBe(true);
    expect(looksLikeHtmlDocument('<!DOC')).toBe(true);
    expect(looksLikeHtmlDocument('<htm')).toBe(true);
    expect(looksLikeHtmlDocument('<h1>Title</h1>')).toBe(false);
    expect(looksLikeHtmlDocument('<div>x</div>')).toBe(false);
  });

  it('auto previews documents and styled fragments only', () => {
    expect(shouldAutoPreviewHtml(PAGE)).toBe(true);
    expect(shouldAutoPreviewHtml('<style>.a{}</style><div class="a">x</div>')).toBe(true);
    expect(shouldAutoPreviewHtml('<ul><li>tutorial snippet</li></ul>')).toBe(false);
  });

  it('flags script usage', () => {
    expect(htmlUsesScripts(PAGE)).toBe(true);
    expect(htmlUsesScripts('<button onclick="go()">go</button>')).toBe(true);
    expect(htmlUsesScripts('<p>plain</p>')).toBe(false);
  });
});

describe('buildChatHtmlPreviewDocument', () => {
  const doc = buildChatHtmlPreviewDocument(PAGE);

  it('wraps content in a script-free CSP document', () => {
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("connect-src 'none'");
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/onload=/i);
    expect(doc).not.toContain('<link');
    expect(doc).not.toContain('http-equiv="refresh"');
  });

  it('keeps head styles, title and html/body attributes of full documents', () => {
    expect(doc).toContain('.card { padding: 8px; }');
    expect(doc).toContain('<title>Demo</title>');
    expect(doc).toContain('<html lang="zh">');
    expect(doc).toMatch(/<body class="theme">/);
    expect(doc).not.toContain('<body class="ds-fragment"');
  });

  it('keeps link targets for parent-side interception, with the URL as tooltip', () => {
    expect(doc).toContain('href="https://example.com"');
    expect(doc).toContain('title="https://example.com"');
    expect(doc).not.toContain('target=');
    expect(doc).toContain('href="#sec"');
  });

  it('uses a same-origin sandbox that never allows scripts', () => {
    expect(CHAT_HTML_PREVIEW_SANDBOX.split(/\s+/)).toContain('allow-same-origin');
    expect(CHAT_HTML_PREVIEW_SANDBOX).not.toMatch(/allow-scripts|allow-popups|allow-forms|allow-top-navigation/);
  });

  it('gives fragments a typographic body', () => {
    const fragment = buildChatHtmlPreviewDocument('<p>hello</p>');
    expect(fragment).toContain('<body class="ds-fragment">');
    expect(fragment).toContain('<p>hello</p>');
  });
});

describe('htmlPreviewBufferReducer (double buffering)', () => {
  const submit = (state: HtmlPreviewBufferState, doc: string) => htmlPreviewBufferReducer(state, { type: 'submit', doc });
  const loaded = (state: HtmlPreviewBufferState, key: number) => htmlPreviewBufferReducer(state, { type: 'loaded', key });

  it('shows the first document immediately', () => {
    const s = submit(INITIAL_HTML_PREVIEW_BUFFER, 'a');
    expect(s.front?.doc).toBe('a');
    expect(s.loading).toBeNull();
  });

  it('loads updates behind the visible frame and swaps on load', () => {
    let s = submit(INITIAL_HTML_PREVIEW_BUFFER, 'a');
    const frontKey = s.front!.key;
    s = submit(s, 'b');
    expect(s.front).toEqual({ key: frontKey, doc: 'a' });
    expect(s.loading?.doc).toBe('b');
    s = loaded(s, s.loading!.key);
    expect(s.front?.doc).toBe('b');
    expect(s.loading).toBeNull();
  });

  it('coalesces updates that arrive mid-load to the latest one', () => {
    let s = submit(submit(INITIAL_HTML_PREVIEW_BUFFER, 'a'), 'b');
    s = submit(s, 'c');
    s = submit(s, 'd');
    expect(s.pending).toBe('d');
    const bKey = s.loading!.key;
    s = loaded(s, bKey);
    expect(s.front?.doc).toBe('b');
    expect(s.loading?.doc).toBe('d');
    expect(s.pending).toBeNull();
    s = loaded(s, s.loading!.key);
    expect(s.front?.doc).toBe('d');
    expect(s.loading).toBeNull();
  });

  it('ignores duplicate submits and stale load events', () => {
    const s = submit(INITIAL_HTML_PREVIEW_BUFFER, 'a');
    expect(submit(s, 'a')).toBe(s);
    expect(loaded(s, 999)).toBe(s);
  });
});
