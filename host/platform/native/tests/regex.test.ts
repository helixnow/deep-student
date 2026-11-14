import { describe, expect, it } from 'vitest';
import { NativeRegexCompileError, regex } from '../regex/index.ts';

/**
 * Rust oracle (regex 1.12.3).  The compile error text is `regex::Error`'s
 * `Display` output, not a re-worded JS message.
 */
describe('nativeRegex (regex crate 1.12.3)', () => {
  it('regex::Regex::new: keeps regex::Error Display text verbatim', async () => {
    await expect(regex.compile('a(')).rejects.toMatchObject({
      name: 'NativeRegexCompileError',
      message: 'regex parse error:\n    a(\n     ^\nerror: unclosed group',
    });
    await expect(regex.compile('a(')).rejects.toBeInstanceOf(NativeRegexCompileError);
  });

  it('regex::Regex: uses Rust Unicode character classes instead of RegExp ASCII classes', async () => {
    const word = await regex.compile('(?P<w>\\w+)');
    // Rust `\w` is Unicode-aware: `数学` matches, JavaScript /\w/ would not.
    expect(await regex.isMatch(word, '数学')).toBe(true);
    expect(await regex.captures(word, '数学')).toMatchObject({
      start: 0, end: 2, text: '数学',
      groups: [
        { start: 0, end: 2, text: '数学', name: null },
        { start: 0, end: 2, text: '数学', name: 'w' },
      ],
    });
  });

  it('regex::find_iter: reports UTF-16 offsets for non-BMP input', async () => {
    const emoji = await regex.compile('\\p{So}+');
    const text = 'a😀b';
    expect(await regex.findIter(emoji, text)).toEqual([
      { start: 1, end: 3, text: '😀' },
    ]);
  });

  it('regex::captures: returns null for optional groups and null when nothing matches', async () => {
    const pattern = await regex.compile('(?P<key>\\w+)=(\\d+)?');
    const captures = await regex.captures(pattern, 'a=');
    expect(captures?.groups[2]).toBeNull();
    expect(await regex.captures(pattern, '???')).toBeNull();
    expect(await regex.findIter(pattern, '???')).toEqual([]);
  });

  it('regex::replace/replace_all: expands Rust $name / ${1} / $$ and only the first match for replace()', async () => {
    const pattern = await regex.compile('(?P<w>\\w+)');
    expect(await regex.replaceAll(pattern, 'a b', '${w}-$w-$$')).toBe('a-a-$ b-b-$');
    expect(await regex.replace(pattern, 'a b', '[$w]')).toBe('[a] b');
    // Unknown group names expand to an empty string, as `Captures::expand` does.
    expect(await regex.replaceAll(pattern, 'a b', '$missing')).toBe(' ');
  });

  it('regex::split: keeps the trailing empty piece', async () => {
    const comma = await regex.compile(',');
    expect(await regex.split(comma, 'a,b,')).toEqual(['a', 'b', '']);
    expect(await regex.split(comma, '')).toEqual(['']);
    const empty = await regex.compile('');
    expect(await regex.split(empty, 'ab')).toEqual(['', 'a', 'b', '']);
  });

  it('regex::Regex: honours inline flags and multi-line anchors that differ in JS', async () => {
    const pattern = await regex.compile('(?i)^hello$');
    expect(await regex.isMatch(pattern, 'HeLLo')).toBe(true);
    const caseSensitive = await regex.compile('^b$');
    expect(await regex.isMatch(caseSensitive, 'a\nb')).toBe(false);
    const multiline = await regex.compile('(?m)^b$');
    expect(await regex.isMatch(multiline, 'a\nb')).toBe(true);
  });

  it('full-text captures retain word-boundary context, while captures() still returns only the first match', async () => {
    const boundary = await regex.compile('(?P<suffix>\\Bb)');
    expect(await regex.findIter(boundary, 'xb')).toEqual([{ start: 1, end: 2, text: 'b' }]);
    expect(await regex.captures(boundary, 'xb')).toMatchObject({ start: 1, end: 2, text: 'b',
      groups: [{ start: 1, end: 2, text: 'b', name: null }, { start: 1, end: 2, text: 'b', name: 'suffix' }] });
    // These are distinct complete inputs, not a proposed sliced replacement algorithm.
    expect(await regex.captures(boundary, 'b')).toBeNull();
    const captures = await regex.compile('(?P<letter>[a-z])|(?P<number>[0-9])');
    expect(await regex.findIter(captures, 'ab12')).toHaveLength(4);
    expect(await regex.captures(captures, 'ab12')).toMatchObject({ text: 'a',
      groups: [{ text: 'a', name: null }, { text: 'a', name: 'letter' }, null] });
    // Existing replaceAll correctly expands captures, but has no pre-allocation limit.
    expect(await regex.replaceAll(captures, 'ab12', '${letter}${number}$$')).toBe('a$b$1$2$');
  });

  it('full-text zero-width matching uses Rust Unicode advancement and Rust replacement references', async () => {
    const empty = await regex.compile('');
    expect(await regex.findIter(empty, '数😀')).toEqual([
      { start: 0, end: 0, text: '' }, { start: 1, end: 1, text: '' }, { start: 3, end: 3, text: '' },
    ]);
    expect(await regex.replaceAll(empty, '数😀', '${0}$$')).toBe('$数$😀$');
    const named = await regex.compile('(?P<w>\\w+)');
    expect(await regex.replaceAll(named, '数学 a', '$1/${w}/$$')).toBe('数学/数学/$ a/a/$');
  });
});
