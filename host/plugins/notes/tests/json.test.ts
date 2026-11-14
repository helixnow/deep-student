import { describe, expect, it } from 'vitest';
import { decodeJson } from '../repository/json.ts';

describe('note_transfer_repo::decode serde_json failure mapping', () => {
  it('retains value structure, duplicate-key last-write behavior and escaped Unicode', () => {
    expect(decodeJson('{"x":1,"x":2,"s":"\\ud83d\\ude00","v":[true,null,-1.25e+2]}'))
      .toEqual({ x: 2, s: '😀', v: [true, null, -125] });
  });
  it('returns Serialization errors rather than a command panic for invalid stored JSON', () => {
    for (const [input, reason, column] of [
      ['', 'EOF while parsing a value', 0],
      ['wat', 'expected value', 1],
      ['{', 'EOF while parsing an object', 1],
      ['{"a" 1}', 'expected `:`', 6],
      ['[1,]', 'trailing comma', 4],
      ['{"a":1,}', 'trailing comma', 8],
      ['{"a":1 "b":2}', 'expected `,` or `}`', 8],
      ['"\\q"', 'invalid escape', 3],
      ['"\\udc00"', 'lone leading surrogate in hex escape', 7],
      ['1 2', 'trailing characters', 3],
    ] as const) expect(() => decodeJson(input)).toThrow(`${reason} at line 1 column ${column}`);
  });
});
