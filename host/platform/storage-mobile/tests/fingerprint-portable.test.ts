/** 指纹哈希与名字排序改为可移植实现后，与 `node:crypto` / `Buffer.compare` 逐例一致。 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SortedNameSet, hashCanonicalSchema } from '../../storage/migration/fingerprint.ts';

const SAMPLES = [
  '',
  'table:a\n',
  'table:chat_v2_sessions\ncol:0:id:TEXT:1::1\nidx:idx_x:CREATE INDEX idx_x ON t(a)\n',
  '中文表名:列\n',
  'emoji 😀 and astral 𝄞\r\n',
  'nul \u0000 inside',
  'x'.repeat(100_000),
];

describe('portable fingerprint primitives', () => {
  it('hashCanonicalSchema equals node:crypto sha256 hex', () => {
    for (const text of SAMPLES) {
      expect(hashCanonicalSchema(text), text.slice(0, 40)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });

  it('SortedNameSet orders by UTF-8 bytes like Buffer.compare (Rust BTreeSet<String>)', () => {
    const names = ['b', 'a', 'B', 'ab', 'a', '_x', 'é', 'z', '中', '😀', '\uffff', 'a\u0000', ''];
    const expected = [...new Set(names)].sort((x, y) => Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')));
    expect([...new SortedNameSet(names)]).toEqual(expected);
    expect(expected.indexOf('\uffff')).toBeLessThan(expected.indexOf('😀'));
  });
});
