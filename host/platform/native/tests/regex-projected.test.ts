import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';

/**
 * `chatanki_transform.rs::bounded_regex_replace` (regex 1.12.3 `captures_iter` +
 * `expanded_replacement_len` + `add_projected_bytes`) through `ctx.nativeRegex`.
 * Vectors are the acceptance table in host/plugins/chatanki/native-needs.md §1, each derived
 * from the Rust algorithm (first cumulative count strictly above the limit, before replace_all).
 */
type Host = Awaited<ReturnType<typeof createTestHost>>;
let host: Host;
beforeAll(async () => { host = await createTestHost({ plugins: [native] }); });
afterAll(async () => { await host.dispose(); });

const MIB = 1_048_576;
async function projected(text: string, pattern: string, replacement: string, limit: number) {
  const compiled = await host.ctx.nativeRegex.compile(pattern);
  return host.ctx.nativeRegex.replaceAllProjected(compiled, text, replacement, limit);
}

describe('nativeRegex.replaceAllProjected (chatanki_transform.rs bounded_regex_replace)', () => {
  it.each([
    ['afoo', '\\B(foo)', '<$1>', MIB, { ok: true, value: 'a<foo>', bytes: 6 }],
    ['aaaa', 'a', 'XXXX', 5, { ok: false, bytes: 8 }],
    // native-needs.md lists bytes 7 here; the value is 6 UTF-8 bytes and Rust's
    // debug_assert_eq!(after.len(), projected) (chatanki_transform.rs:593) pins projected to 6.
    ['abc', '(b)', '$$[$1]', MIB, { ok: true, value: 'a$[b]c', bytes: 6 }],
    ['abc', '(b)', '${missing}', MIB, { ok: true, value: 'ac', bytes: 2 }],
    ['abc', '(b)', '$1x$1', MIB, { ok: true, value: 'abc', bytes: 3 }],
    ['abc', '(b)', '${1x', MIB, { ok: true, value: 'a${1xc', bytes: 6 }],
    ['abc', '(b)', '<$1>', 4, { ok: false, bytes: 5 }],
    ['xbZ', '(?P<suffix>\\Bb)', '${suffix}${suffix}${suffix}', 3, { ok: false, bytes: 4 }],
  ] as const)('%j /%s/ -> %j (limit %d)', async (text, pattern, replacement, limit, expected) => {
    expect(await projected(text, pattern, replacement, limit)).toEqual(expected);
  });

  it('counts UTF-8 bytes, keeps the full-text context, and matches replaceAll on success', async () => {
    const text = '数学 math 数学';
    const compiled = await host.ctx.nativeRegex.compile('(?P<w>\\p{Han}+)');
    const result = await host.ctx.nativeRegex.replaceAllProjected(compiled, text, '[$w]', MIB);
    const expected = await host.ctx.nativeRegex.replaceAll(compiled, text, '[$w]');
    expect(result).toEqual({ ok: true, value: expected, bytes: Buffer.byteLength(expected, 'utf8') });
  });

  it('stops at the first over-limit count for >1 MiB capture growth without returning a value', async () => {
    const text = 'x'.repeat(600_000);
    const result = await projected(text, '(x+)', '$1$1', Math.max(MIB, text.length));
    // gap 0, then expansion 1_200_000 > 1 MiB: the very first add overflows.
    expect(result).toEqual({ ok: false, bytes: 1_200_000 });
    expect('value' in result).toBe(false);
  });

  it('rejects a limit that is not a non-negative safe integer', async () => {
    const compiled = await host.ctx.nativeRegex.compile('a');
    for (const limit of [-1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(host.ctx.nativeRegex.replaceAllProjected(compiled, 'a', 'b', limit)).rejects.toBeInstanceOf(TypeError);
    }
  });
});
