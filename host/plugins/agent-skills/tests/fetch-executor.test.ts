import { describe, expect, it } from 'vitest';
import {
  FetchExecutor, binaryHeaderFamilyMatches, cleanMarkdownContent,
  collectDownloadStreamLimited, decodeBytesWithCharset, deepseekFetchSettingEnabled,
  deepseekFetchSuccessResult, describeDeepseekFetchFailure, detectCharsetFromContentType,
  detectCharsetFromHtmlMeta, filenameFromHeadersOrUrl, looksLikeHtml,
  parseDeepseekFetchResponse, shouldUseDeepseekFetch, sniffBinaryKind, tryExtractMainContent,
} from '../src/tools/fetch-executor.ts';
import { buildZip } from '../src/zip.ts';
import { isBlockedInternalIp, isInternalIp } from '../../../platform/net-policy/index.ts';
import { stripToolNamespace } from '../src/tools/naming.ts';

describe('fetch_executor.rs', () => {
  it('web_04_binary_magic_and_mime_contract', () => {
    const pdf = sniffBinaryKind(Buffer.from('%PDF-1.7\n'))!;
    expect(pdf.mime).toBe('application/pdf');
    expect(binaryHeaderFamilyMatches('application/pdf', pdf)).toBe(true);
    expect(binaryHeaderFamilyMatches('application/octet-stream', pdf)).toBe(true);
    expect(binaryHeaderFamilyMatches('image/png', pdf)).toBe(false);

    const png = sniffBinaryKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))!;
    expect(png.mime).toBe('image/png');
    expect(binaryHeaderFamilyMatches('application/pdf', png)).toBe(false);
  });

  it('web_04_docx_requires_ooxml_structure', () => {
    const zip = buildZip([
      { name: '[Content_Types].xml', bytes: Buffer.from('<Types/>') },
      { name: 'word/document.xml', bytes: Buffer.from('<document/>') },
    ]);
    const docx = sniffBinaryKind(zip)!;
    expect(docx.extension).toBe('docx');
    expect(binaryHeaderFamilyMatches('application/zip', docx)).toBe(true);
    expect(sniffBinaryKind(Buffer.from('PK\x03\x04not-a-complete-zip'))).toBeUndefined();
  });

  it('web_05_redirect_metadata_filename_is_safe_and_typed', () => {
    const kind = sniffBinaryKind(Buffer.from('%PDF-1.7\n'))!;
    const filename = filenameFromHeadersOrUrl(
      { 'content-disposition': 'attachment; filename=../../quarterly.exe' },
      'https://cdn.example.test/files/fallback',
      kind,
    );
    expect(filename).toBe('quarterly.pdf');
  });

  it('chunked_download_is_rejected_before_retaining_over_limit_body', async () => {
    const chunks = [
      Uint8Array.from([0x61, 0x62, 0x63]),
      Uint8Array.from([0x64, 0x65, 0x66]),
      Uint8Array.from([0x6e, 0x65, 0x76, 0x65, 0x72, 0x2d, 0x72, 0x65, 0x61, 0x64]),
    ];
    await expect(collectDownloadStreamLimited(chunks, 5, 0))
      .rejects.toThrow('6 bytes > 5 bytes');
    const within = [Uint8Array.from([0x61, 0x62]), Uint8Array.from([0x63, 0x64, 0x65])];
    expect(await collectDownloadStreamLimited(within, 5, 5)).toEqual(
      Uint8Array.from([0x61, 0x62, 0x63, 0x64, 0x65]),
    );
  });

  it('test_can_handle', () => {
    const executor = new FetchExecutor();
    expect(executor.canHandle('builtin-web_fetch')).toBe(true);
    expect(executor.canHandle('web_fetch')).toBe(true);
    expect(executor.canHandle('builtin-web_search')).toBe(false);
    expect(executor.canHandle('builtin-rag_search')).toBe(false);
  });

  it('test_strip_namespace', () => {
    expect(stripToolNamespace('builtin-web_fetch')).toBe('web_fetch');
    expect(stripToolNamespace('web_fetch')).toBe('web_fetch');
  });

  it('test_paginate_content', () => {
    const executor = new FetchExecutor();
    const content = 'Hello, World! This is a test.';

    const first = executor.paginateContent(content, 0, 5);
    expect(first.content.startsWith('Hello')).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.truncationNotice).toBeDefined();

    const middle = executor.paginateContent(content, 7, 5);
    expect(middle.content.startsWith('World')).toBe(true);
    expect(middle.hasMore).toBe(true);

    const past = executor.paginateContent(content, 100, 5);
    expect(past.content).toContain('No more content');
    expect(past.hasMore).toBe(false);
    expect(past.truncationNotice).toBeUndefined();

    const all = executor.paginateContent(content, 0, 100);
    expect(all.content).toBe(content);
    expect(all.hasMore).toBe(false);
    expect(all.truncationNotice).toBeUndefined();
  });

  it('test_paginate_content_huge_max_length_does_not_panic', () => {
    const executor = new FetchExecutor();
    const content = 'Hello, World!';
    const result = executor.paginateContent(content, 1, Number.MAX_SAFE_INTEGER);
    expect(result.content).toBe('ello, World!');
    expect(result.hasMore).toBe(false);
    expect(result.truncationNotice).toBeUndefined();

    const past = executor.paginateContent(content, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(past.content).toContain('No more content');
    expect(past.hasMore).toBe(false);
  });

  it('test_sensitivity_level', () => {
    expect(new FetchExecutor().sensitivityLevel('builtin-web_fetch')).toBe('low');
  });

  it('test_clean_html', () => {
    const executor = new FetchExecutor();
    const html = `
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
        `;
    const cleaned = executor.cleanHtml(html);
    expect(cleaned).not.toContain('<script>');
    expect(cleaned).not.toContain('<style>');
    expect(cleaned).not.toContain('<nav>');
    expect(cleaned).not.toContain('<footer>');
    expect(cleaned).toContain('Hello World');
  });

  it('test_is_internal_ip_ipv4', () => {
    expect(isInternalIp('127.0.0.1')).toBe(true);
    expect(isInternalIp('10.0.0.1')).toBe(true);
    expect(isInternalIp('172.16.0.1')).toBe(true);
    expect(isInternalIp('192.168.1.1')).toBe(true);
    expect(isInternalIp('169.254.1.1')).toBe(true);
    expect(isInternalIp('169.254.169.254')).toBe(true);
    expect(isInternalIp('8.8.8.8')).toBe(false);
    expect(isInternalIp('1.1.1.1')).toBe(false);
  });

  it('test_is_internal_ip_ipv6', () => {
    expect(isInternalIp('::1')).toBe(true);
    expect(isInternalIp('fc00::1')).toBe(true);
    expect(isInternalIp('fd00::1')).toBe(true);
    expect(isInternalIp('fe80::1')).toBe(true);
    expect(isInternalIp('fec0::1')).toBe(true);
    expect(isInternalIp('2002:c0a8:0101::1')).toBe(true);
    expect(isInternalIp('2002:7f00:0001::1')).toBe(true);
    expect(isInternalIp('2002:0808:0808::1')).toBe(false);
    expect(isInternalIp('::ffff:192.168.1.1')).toBe(true);
    expect(isInternalIp('::ffff:127.0.0.1')).toBe(true);
    expect(isInternalIp('2001:4860:4860::8888')).toBe(false);
  });

  it('test_is_blocked_internal_ip_loopback_exempt', () => {
    expect(isBlockedInternalIp('127.0.0.1')).toBe(false);
    expect(isBlockedInternalIp('127.1.2.3')).toBe(false);
    expect(isBlockedInternalIp('::1')).toBe(false);
    expect(isBlockedInternalIp('::ffff:127.0.0.1')).toBe(false);

    expect(isBlockedInternalIp('10.0.0.1')).toBe(true);
    expect(isBlockedInternalIp('192.168.1.1')).toBe(true);
    expect(isBlockedInternalIp('169.254.169.254')).toBe(true);
    expect(isBlockedInternalIp('::ffff:192.168.1.1')).toBe(true);

    expect(isBlockedInternalIp('8.8.8.8')).toBe(false);
  });

  it('test_detect_charset_from_content_type', () => {
    expect(detectCharsetFromContentType('text/html; charset=gbk')).toBe('gbk');
    expect(detectCharsetFromContentType('text/html; charset="UTF-8"')).toBe('UTF-8');
    expect(detectCharsetFromContentType('text/html')).toBeUndefined();
    expect(detectCharsetFromContentType('text/html; CHARSET=gb2312')).toBe('gb2312');
  });

  it('test_detect_charset_from_html_meta', () => {
    expect(detectCharsetFromHtmlMeta(Buffer.from('<html><head><meta charset="gbk"></head>')))
      .toBe('gbk');
    expect(detectCharsetFromHtmlMeta(Buffer.from(
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head>',
    ))).toBe('gb2312');
    expect(detectCharsetFromHtmlMeta(Buffer.from('<html><head><title>Test</title></head>')))
      .toBeUndefined();
  });

  it('test_decode_bytes_with_charset_utf8', () => {
    const [decoded, charset] = decodeBytesWithCharset(
      Buffer.from('Hello World'), 'text/html; charset=utf-8',
    );
    expect(decoded).toBe('Hello World');
    expect(charset).toBe('UTF-8');
  });

  it('test_decode_bytes_with_charset_gbk', () => {
    const encoded = Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]);
    const [decoded, charset] = decodeBytesWithCharset(encoded, 'text/html; charset=gbk');
    expect(decoded).toBe('你好');
    expect(charset).toBe('GBK');
  });

  it('test_looks_like_html', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html>...')).toBe(true);
    expect(looksLikeHtml('  \n  <html lang="en">...')).toBe(true);
    expect(looksLikeHtml('  <HTML><HEAD>...')).toBe(true);
    expect(looksLikeHtml('<head><title>Test</title></head><body>')).toBe(true);
    expect(looksLikeHtml('{"key": "value"}')).toBe(false);
    expect(looksLikeHtml('Hello, plain text')).toBe(false);
  });

  it('test_clean_html_extended_tags', () => {
    const executor = new FetchExecutor();
    const html = `
        <html><body>
            <form action="/submit"><input type="text"></form>
            <dialog open>Dialog content</dialog>
            <template>Template content</template>
            <p>Main content here</p>
            <object data="flash.swf">Object content</object>
        </body></html>
        `;
    const cleaned = executor.cleanHtml(html);
    expect(cleaned).not.toContain('<form');
    expect(cleaned).not.toContain('<dialog');
    expect(cleaned).not.toContain('<template');
    expect(cleaned).not.toContain('<object');
    expect(cleaned).toContain('Main content here');
  });

  it('test_try_extract_main_content', () => {
    const html = `
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
        `;
    const extracted = tryExtractMainContent(html);
    expect(extracted).toBeDefined();
    expect(extracted!).toContain('Article Title');
    expect(extracted!).not.toContain('Navigation');
    expect(extracted!).not.toContain('Sidebar');
  });

  it('test_try_extract_main_content_short', () => {
    expect(tryExtractMainContent('<html><body><article><p>Short</p></article></body></html>'))
      .toBeUndefined();
  });

  it('test_clean_markdown_precompiled', () => {
    expect(cleanMarkdownContent('Line 1\n\n\n\n\nLine 2\n\n\nLine 3'))
      .toBe('Line 1\n\nLine 2\n\nLine 3');
  });

  it('deepseek_fetch_setting_enabled_only_accepts_true', () => {
    expect(deepseekFetchSettingEnabled('true')).toBe(true);
    expect(deepseekFetchSettingEnabled(' TRUE ')).toBe(true);
    expect(deepseekFetchSettingEnabled('false')).toBe(false);
    expect(deepseekFetchSettingEnabled('1')).toBe(false);
    expect(deepseekFetchSettingEnabled('')).toBe(false);
    expect(deepseekFetchSettingEnabled(null)).toBe(false);
  });

  it('deepseek_fetch_should_use_requires_enabled_key_and_http_url', () => {
    expect(shouldUseDeepseekFetch(true, 'sk-test', 'https://example.com/a')).toBe(true);
    expect(shouldUseDeepseekFetch(true, 'sk-test', 'http://example.com/a')).toBe(true);
    expect(shouldUseDeepseekFetch(false, 'sk-test', 'https://example.com/a')).toBe(false);
    expect(shouldUseDeepseekFetch(true, null, 'https://example.com/a')).toBe(false);
    expect(shouldUseDeepseekFetch(true, '   ', 'https://example.com/a')).toBe(false);
    expect(shouldUseDeepseekFetch(true, 'sk-test', 'file:///etc/passwd')).toBe(false);
    expect(shouldUseDeepseekFetch(true, 'sk-test', 'not a url')).toBe(false);
  });

  it('deepseek_fetch_response_parses_markdown_body', () => {
    const [title, content] = parseDeepseekFetchResponse({
      title: 'Rust', content: '\n# Heading\n\n正文内容\n',
    });
    expect(title).toBe('Rust');
    expect(content).toBe('# Heading\n\n正文内容');

    const [optionalTitle] = parseDeepseekFetchResponse({ content: 'ok' });
    expect(optionalTitle).toBeNull();

    expect(() => parseDeepseekFetchResponse({ content: '   \n ' })).toThrow();
    expect(() => parseDeepseekFetchResponse({ title: 'only title' })).toThrow();
  });

  it('deepseek_fetch_failure_messages_are_actionable', () => {
    const balance = describeDeepseekFetchFailure(402, '');
    expect(balance).toContain('余额不足');
    expect(balance).not.toContain('可重试');

    expect(describeDeepseekFetchFailure(429, '')).toContain('可重试');
    expect(describeDeepseekFetchFailure(500, '')).toContain('可重试');
    expect(describeDeepseekFetchFailure(503, '')).toContain('可重试');
    expect(describeDeepseekFetchFailure(404, '')).toContain('404');
    expect(describeDeepseekFetchFailure(401, '')).toContain('API Key');

    const withBody = describeDeepseekFetchFailure(500, 'upstream exploded');
    expect(withBody).toContain('upstream exploded');
  });

  it('deepseek_fetch_success_result_matches_local_fetch_shape', () => {
    const executor = new FetchExecutor();
    const content = 'Hello, DeepSeek Fetch! 这是 Markdown 正文。';
    const result = deepseekFetchSuccessResult({
      url: 'https://example.com/page',
      host: 'example.com',
      content,
      startIndex: 0,
      maxLength: 10,
      durationMs: 42,
    });
    for (const key of [
      'success', 'url', 'finalUrl', 'redirected', 'finalDomain', 'content', 'contentType',
      'totalLength', 'startIndex', 'returnedLength', 'hasMore', 'nextStartIndex', 'durationMs',
    ]) {
      expect(result).toHaveProperty(key);
    }
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://example.com/page');
    expect(result.finalUrl).toBe('https://example.com/page');
    expect(result.redirected).toBe(false);
    expect(result.finalDomain).toBe('example.com');
    expect(result.contentType).toBe('text/markdown; deepseek-fetch');
    expect(result.totalLength).toBe(Array.from(content).length);
    expect(result.startIndex).toBe(0);
    expect(result.hasMore).toBe(true);
    expect(result.nextStartIndex).toBe(10);
    expect(result.durationMs).toBe(42);
    const paginated = result.content as string;
    expect(paginated.startsWith('Hello, Dee')).toBe(true);
    expect(paginated).toContain('<truncated>');
    expect(result.returnedLength).toBe(Array.from(paginated).length);
  });
});
