import { describe, expect, it } from 'vitest';
import {
  MAX_TITLE_CHARS, argumentsObject, boundedText, formatWebpageMarkdown, indexToolCanHandle,
  indexToolConcurrency, indexToolSensitivity, optionalU32, parseOcrPages, requiredString,
  validateWebUrl, yamlScalar,
} from '../src/index-webpage.ts';

describe('src/chat_v2/tools/index_webpage_executor.rs::tests', () => {
  it('validates_only_http_urls_without_credentials', () => {
    // Use IP literals so a local proxy cannot change DNS results.
    expect(() => validateWebUrl('https://1.1.1.1/a')).not.toThrow();
    expect(() => validateWebUrl('http://127.0.0.1/a')).not.toThrow();
    expect(() => validateWebUrl('http://10.0.0.1/a')).toThrow();
    expect(() => validateWebUrl('file:///tmp/a')).toThrow();
    expect(() => validateWebUrl('https://user:pass@example.com/a')).toThrow();
  });

  it('index_and_webpage_arguments_are_closed_and_bounded', () => {
    const statusArguments = { resource_id: 'res_1', page: 1, page_size: 20 };
    const status = argumentsObject(statusArguments, ['resource_id', 'page', 'page_size']);
    expect(optionalU32(status, 'page_size', 20, 1, 20)).toBe(20);
    expect(() => optionalU32(
      argumentsObject({ page_size: 21 }, ['page_size']), 'page_size', 20, 1, 20,
    )).toThrow();
    expect(() => argumentsObject({ unexpected: true }, ['resource_id'])).toThrow();
    expect(() => requiredString(
      argumentsObject({ title: 'x'.repeat(MAX_TITLE_CHARS + 1) }, ['title']), 'title',
      MAX_TITLE_CHARS,
    )).toThrow();
  });

  it('webpage_markdown_contains_source_and_title', () => {
    const markdown = formatWebpageMarkdown('A title', 'https://example.com/a', 'Body');
    expect(markdown).toContain("source: 'https://example.com/a'");
    expect(markdown).toContain('# A title');
    expect(markdown.endsWith('Body\n')).toBe(true);
  });

  it('yaml_scalar_escapes_newlines_quotes_and_control_characters', () => {
    // No control characters: keep the historical single-quoted style.
    expect(yamlScalar("It's fine")).toBe("'It''s fine'");
    // Newlines/tabs switch to JSON double-quoted escaping.
    expect(yamlScalar('line1\nline2')).toBe('"line1\\nline2"');
    expect(yamlScalar('tab\there "q"')).toBe('"tab\\there \\"q\\""');
    const markdown = formatWebpageMarkdown('Multi\nline: title', 'https://example.com/a', 'Body');
    const lines = markdown.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('title: "Multi\\nline: title"');
    expect(lines[2]!.startsWith('source: ')).toBe(true);
    expect(lines[3]).toBe('---');
    expect(markdown).toContain('# Multi line: title');
  });

  it('bounded_text_is_utf8_safe_and_reports_truncation', () => {
    const [value, truncated] = boundedText('中文内容', 2);
    expect(value).toBe('中文');
    expect(truncated).toBe(true);
  });

  it('parses_legacy_and_object_ocr_pages', () => {
    const legacy = parseOcrPages('["one", null, "[OCR_FAILED]"]');
    expect(legacy?.length).toBe(3);
    expect(legacy![1]!.failed).toBe(true);
    const object = parseOcrPages('{"pages":[{"text":"two"}]}');
    expect(object![0]!.text).toBe('two');
  });

  it('sensitivity_and_routing_are_explicit', () => {
    expect(indexToolCanHandle('builtin-index_status')).toBe(true);
    expect(indexToolCanHandle('index_rebuild')).toBe(true);
    expect(indexToolSensitivity('index_rebuild')).toBe('high');
    expect(indexToolSensitivity('webpage_save')).toBe('medium');
    expect(indexToolConcurrency('index_status')).toBe('read_only');
  });
});

describe('index webpage helpers beyond the Rust unit tests', () => {
  it('rejects malformed OCR payloads and unknown fields', () => {
    expect(parseOcrPages('not json')).toBeNull();
    expect(parseOcrPages('[1]')).toBeNull();
    expect(parseOcrPages('{"pages":"nope"}')).toBeNull();
    expect(() => argumentsObject(null, [])).toThrow();
    expect(() => optionalU32({ page: 1.5 }, 'page', 1, 1, 20)).toThrow();
    expect(() => optionalU32({ page: 0 }, 'page', 1, 1, 20)).toThrow();
  });
});
