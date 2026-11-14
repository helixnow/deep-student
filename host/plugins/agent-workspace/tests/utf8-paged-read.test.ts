import { expect, it } from 'vitest';
import { applyToolResultBudget, type AgentJson } from '../../../kernel/api.ts';
import { pageUtf8Text, checkExpectedHash, parseOffset, parseMaxBytes, fitPagedContentToBudget, serializedCharLen,
  DEFAULT_READ_MAX_BYTES, MAX_READ_MAX_BYTES, decodeUtf8Window } from '../src/utf8-paged-read.ts';
import { sha256Hex } from '../src/runtime-paths.ts';

it('page_rejects_mid_char_offset', () => {
  const text = 'ab你cd';
  expect((Buffer.from(text)[3]! & 0xc0) === 0x80).toBe(true);
  expect(() => pageUtf8Text(text, 3, 8)).toThrow('character boundary');
});
it('page_rejects_offset_past_eof', () => { expect(() => pageUtf8Text('hi', 3, 8)).toThrow('exceeds'); });
it('page_at_eof_returns_empty_block', () => {
  const page = pageUtf8Text('hi', 2, 8);
  expect(page.content).toBe(''); expect(page.returned_bytes).toBe(0); expect(page.next_offset).toBe(2);
  expect(page.eof).toBe(true); expect(page.truncated).toBe(false);
});
it('page_snaps_end_to_char_boundary_and_makes_progress', () => {
  const page = pageUtf8Text('你我', 0, 1);
  expect(page.content).toBe('你'); expect(page.returned_bytes).toBe(3);
  expect(page.next_offset).toBe(3); expect(page.eof).toBe(false);
});
it('expected_hash_is_case_insensitive', () => {
  const hash = sha256Hex(Buffer.from('abc'));
  expect(() => checkExpectedHash(hash.toUpperCase(), hash)).not.toThrow();
  expect(() => checkExpectedHash('deadbeef', hash)).toThrow();
});
it('budget_fit_keeps_cursor_on_final_body', () => {
  const body = '你'.repeat(20_000) + 'x'.repeat(20_000);
  const output: Record<string, AgentJson> = {
    content: body, sha256: 'abc', contentLength: Buffer.byteLength(body), contentTruncated: false,
  };
  const total = Buffer.byteLength(body);
  expect(fitPagedContentToBudget(output, 'content', 0, total, 30_000)).toBe(true);
  const content = output.content as string;
  expect(body.startsWith(content)).toBe(true);
  expect(output.returned_bytes).toBe(Buffer.byteLength(content));
  expect(output.next_offset).toBe(Buffer.byteLength(content));
  expect(output.eof).toBe(false);
  expect(output.truncated).toBe(true);
  expect(output.contentLength).toBe(Buffer.byteLength(content));
  expect(output.contentTruncated).toBe(true);
  expect(serializedCharLen(output)).toBeLessThanOrEqual(30_000);
  expect(Buffer.byteLength(content)).toBeLessThan(total);
  // Rust utf8_paged_read.rs:311–315 asserts the real outer budget leaves the result intact.
  expect(applyToolResultBudget(structuredClone(output), 30_000)).toEqual(output);
});
it('successive_pages_reconstruct_full_text', () => {
  const text = 'hello你world'; let offset = 0; let acc = '';
  for (;;) {
    const page = pageUtf8Text(text, offset, 4); acc += page.content;
    if (page.eof) break;
    expect(page.next_offset).toBe(offset + page.returned_bytes); offset = page.next_offset;
  }
  expect(acc).toBe(text);
});
it('parse_offset_and_max_bytes_defaults', () => {
  expect(parseOffset({})).toBe(0); expect(parseMaxBytes({})).toBe(DEFAULT_READ_MAX_BYTES);
  expect(() => parseOffset({ offset: -1 })).toThrow();
  expect(() => parseMaxBytes({ max_bytes: 0 })).toThrow();
  expect(() => parseMaxBytes({ max_bytes: MAX_READ_MAX_BYTES + 10 })).toThrow();
  expect(() => parseMaxBytes({ max_bytes: '4' })).toThrow();
});
it('budget_fit_refuses_a_non_advancing_page', () => {
  const body = '你好'; const output: Record<string, unknown> = { content: body, metadata: 'x'.repeat(2000) };
  expect(fitPagedContentToBudget(output, 'content', 0, Buffer.byteLength(body), 1000)).toBe(false);
  expect(output.content).toBe(body); expect(output.next_offset).toBe(Buffer.byteLength(body));
});
it('decode_utf8_window distinguishes incomplete suffix from invalid bytes', () => {
  const bytes = Buffer.from('a你');
  expect(decodeUtf8Window(bytes.subarray(0, 3), true)).toBe('a');
  expect(() => decodeUtf8Window(bytes.subarray(0, 3), false)).toThrow('UTF-8');
  expect(() => decodeUtf8Window(Buffer.from([0xff, 0xe4]), true)).toThrow('UTF-8');
  expect(decodeUtf8Window(Buffer.from('\ufeffa'), false)).toBe('\ufeffa');
});
