import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
beforeAll(async () => {
  host = await createTestHost({ plugins: [plugin], provide: { settings: { async getSecret() { return null; } } } });
});
afterAll(async () => { await host.dispose(); });
const parse = (text: string) => {
  const preview = host.ctx.llmMultimodal.parseAttachmentPreviewJson(text);
  expect(preview).not.toBeUndefined();
  return preview;
};

describe('multimodal page indexer', () => {
  it('test_textbook_preview_camel_case_parsing', () => {
    const json = `{
      "pages": [
        {"pageIndex": 0, "blobHash": "abc123", "width": 100, "height": 200, "mimeType": "image/png"},
        {"pageIndex": 1, "blobHash": "def456", "width": 100, "height": 200, "mimeType": "image/png"}
      ],
      "renderDpi": 150,
      "totalPages": 2,
      "renderedAt": "2026-01-16T12:00:00Z"
    }`;

    const preview = parse(json);
    expect(preview.pages).toHaveLength(2);
    expect(preview.pages[0]!.page_index).toBe(0n);
    expect(preview.pages[0]!.blob_hash).toBe('abc123');
    expect(preview.pages[1]!.page_index).toBe(1n);
    expect(preview.dpi).toBe(150);
    expect(preview.page_count).toBe(2n);
    expect(preview.rendered_at).toBe('2026-01-16T12:00:00Z');

    // Legacy snake_case previews keep parsing after the camelCase aliases.
    const legacy = parse(`{
      "pages": [{"page_index": 3, "blob_hash": "legacy", "mime_type": "image/jpeg", "compressed_blob_hash": "small"}],
      "dpi": 96,
      "page_count": 1
    }`);
    expect(legacy.pages[0]!.page_index).toBe(3n);
    expect(legacy.pages[0]!.compressed_blob_hash).toBe('small');
    expect(legacy.dpi).toBe(96);
    expect(legacy.page_count).toBe(1n);
  });

  it('typed preview reports the first known-field error before later duplicates or syntax', () => {
    for (const [text, detail] of [
      ['{"pages":"bad","dpi":1,"renderDpi":2}', 'invalid type: string "bad", expected a sequence at line 1 column 14'],
      ['{"dpi":1,"renderDpi":2,"pages":"bad"}', 'duplicate field `dpi` at line 1 column 20'],
      ['{"pages":[{"page_index":"bad","pageIndex":0}]}', 'invalid type: string "bad", expected usize at line 1 column 29'],
      ['{"pages":[{"page_index":0,"pageIndex":"bad"}]}', 'duplicate field `page_index` at line 1 column 37'],
      ['{"dpi":"bad","pages":', 'invalid type: string "bad", expected u32 at line 1 column 12'],
      ['{"dpi":null,"renderDpi"', 'duplicate field `dpi` at line 1 column 23'],
      ['{"pages":[{"blobHash":false}]}', 'invalid type: boolean `false`, expected a string at line 1 column 27'],
      ['{"dpi":false}', 'invalid type: boolean `false`, expected u32 at line 1 column 12'],
      ['{"pages":[{}]}', 'missing field `page_index` at line 1 column 12'],
      ['{} trailing', 'missing field `pages` at line 1 column 2'],
    ] as const) {
      expect(() => parse(text), text).toThrow(detail);
    }
  });

  it('typed preview retains serde error cause and UTF-8 position inside its public context', () => {
    // read.rs SliceRead counts UTF-8 bytes, not JS UTF-16 units. The later bad
    // pages token must not replace the duplicate error after a non-ASCII string.
    expect(() => parse('{"renderedAt":"😀","rendered_at":null,"pages":!}')).toThrow(expect.objectContaining({
      message: 'invalid attachment preview: duplicate field `rendered_at` at line 1 column 34',
      cause: expect.objectContaining({ code: 'duplicate field `rendered_at`', line: 1, column: 34 }),
    }));
    expect(() => parse('{\n"pages":[],\n"dpi":-0, "renderDpi":0}')).toThrow(expect.objectContaining({
      message: 'invalid attachment preview: invalid type for `dpi`: invalid type: floating point `-0.0`, expected u32 at line 3 column 8',
      cause: expect.objectContaining({ code: 'invalid type: floating point `-0.0`, expected u32', line: 3, column: 8 }),
    }));
  });

  it('typed preview ignores deep unknown values without applying Value numeric or surrogate limits', () => {
    const deep = '['.repeat(256) + '{"\\ud800":1e400,"v":"\\udc00"}' + ']'.repeat(256);
    expect(parse(`{"x":${deep},"pages":[{"x":${deep},"pageIndex":9007199254740993}],"x":-1e9999,"renderDpi":4294967295}`))
      .toEqual({ pages: [{ page_index: 9007199254740993n }], dpi: 4294967295 });
    expect(parse(`[[{"page_index":0,"unknown":${deep}}]]`)).toEqual({ pages: [{ page_index: 0n }] });
    expect(() => parse('{"pages":[],"renderedAt":"\\ud800"}')).toThrow('unexpected end of hex escape');
    expect(() => parse('{"pages":[],"dpi":1e400}')).toThrow('number out of range');
    expect(() => parse('{"pages":[],"\\ud800":0}')).toThrow('unexpected end of hex escape');
  });

  it('ignored fields still validate JSON syntax before later known fields', () => {
    for (const [unknown, detail] of [
      ['[0,]', 'expected value'], ['{"x":0,}', 'key must be a string'],
      ['01', 'invalid number'], ['1e+', 'invalid number'],
      ['"\\uZZZZ"', 'invalid escape'], ['"\\q"', 'invalid escape'],
      ['{"x" 0}', 'expected `:`'], ['[0 1]', 'expected `,` or `]`'],
    ]) {
      expect(() => parse(`{"unknown":${unknown},"pages":"bad"}`), unknown).toThrow(detail);
    }
    // A prior field error wins even over invalid syntax inside a later unknown.
    expect(() => parse('{"pages":false,"unknown":[0,]}'))
      .toThrow('invalid type: boolean `false`, expected a sequence');
  });

  it('typed struct arrays end without decoding extra values and keep required/default slots', () => {
    for (const tail of ['0', '{', '1e400', '"\\ud800"', '[0,]']) {
      expect(() => parse(`[[],null,null,null,${tail}]`), tail).toThrow('trailing characters at line 1 column 20');
      expect(() => parse(`[[[0,null,null,null,null,null,${tail}]]]`), tail).toThrow('trailing characters at line 1 column 31');
    }
    expect(() => parse('[[],null,null,null,]')).toThrow('trailing comma at line 1 column 20');
    expect(() => parse('[[],null,null,null')).toThrow('EOF while parsing a list at line 1 column 18');
    expect(() => parse('[[],null,null,null 0]')).toThrow('trailing characters at line 1 column 20');
    expect(() => parse('[[[0]]]')).toThrow('invalid length 1, expected struct AttachmentPreviewPage with 6 elements at line 1 column 5');
    expect(() => parse('[[[0,null,true,null,null,null,{]]]'))
      .toThrow('invalid type: boolean `true`, expected u32');
    expect(parse('[[[0,null],[1,null,null],[2,null,null,null],[3,null,null,null,null],[4,null,null,null,null,null]]]'))
      .toEqual({ pages: [0n, 1n, 2n, 3n, 4n].map(page_index => ({ page_index })) });
    expect(parse('[[],null]')).toEqual({ pages: [] });
    expect(parse('[[],null,null]')).toEqual({ pages: [] });
  });

  it('typed preview tracks null aliases as present and preserves every field type', () => {
    for (const [canonical, alias] of [['dpi', 'renderDpi'], ['page_count', 'totalPages'], ['rendered_at', 'renderedAt']]) {
      for (const [first, second] of [[canonical, alias], [alias, canonical]]) {
        expect(() => parse(`{"pages":[],"${first}":null,"${second}":{}`))
          .toThrow(`duplicate field \`${canonical}\``);
      }
    }
    for (const [canonical, alias] of [['blob_hash', 'blobHash'], ['width', 'width'], ['height', 'height'], ['mime_type', 'mimeType'], ['compressed_blob_hash', 'compressedBlobHash']]) {
      for (const [first, second] of [[canonical, alias], [alias, canonical]]) {
        expect(() => parse(`{"pages":[{"page_index":0,"${first}":null,"${second}":{}]}`))
          .toThrow(`duplicate field \`${canonical}\``);
      }
    }
    expect(parse('{"pages":[{"pageIndex":0,"blobHash":null,"width":null,"height":null,"mimeType":null,"compressedBlobHash":null}],"dpi":null,"page_count":null,"rendered_at":null}'))
      .toEqual({ pages: [{ page_index: 0n }] });
    expect(parse('{"renderedAt":"time","totalPages":18446744073709551615,"renderDpi":0,"pages":[{"compressedBlobHash":"small","mimeType":"image/png","height":4294967295,"width":0,"blobHash":"","pageIndex":18446744073709551615}]}'))
      .toEqual({ pages: [{ page_index: 18446744073709551615n, blob_hash: '', width: 0, height: 4294967295, mime_type: 'image/png', compressed_blob_hash: 'small' }], dpi: 0, page_count: 18446744073709551615n, rendered_at: 'time' });
    for (const [field, expected] of [['width', 'u32'], ['height', 'u32'], ['blobHash', 'a string'], ['mimeType', 'a string'], ['compressedBlobHash', 'a string']]) {
      expect(() => parse(`{"pages":[{"pageIndex":0,"${field}":false}]}`)).toThrow(`invalid type: boolean \`false\`, expected ${expected}`);
    }
    for (const field of ['dpi', 'totalPages', 'renderedAt']) {
      expect(() => parse(`{"pages":[],"${field}":false}`)).toThrow('invalid type: boolean `false`');
    }
    expect(() => parse('{"pages":[{"pageIndex":-1}]}')).toThrow('invalid value: integer `-1`, expected usize');
    expect(() => parse('{"pages":[],"dpi":4294967296}')).toThrow('invalid value: integer `4294967296`, expected u32');
    expect(() => parse('{"pages":[{"pageIndex":null}]}')).toThrow('invalid type: null, expected usize');
    expect(() => parse('{"pages":[false]}')).toThrow('invalid type: boolean `false`, expected struct AttachmentPreviewPage');
    expect(() => parse('null')).toThrow('invalid type: null, expected struct AttachmentPreview');
    expect(() => parse('{"pages":[]} false')).toThrow('trailing characters');
  });
});
