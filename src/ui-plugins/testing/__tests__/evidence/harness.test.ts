import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVIDENCE_DIR, describeTextDiff, expectGolden } from './harness';

describe('describeTextDiff', () => {
  it('shows the differing region with line numbers and context', () => {
    const golden = ['{', '  "a": 1,', '  "b": 2,', '  "c": 3,', '  "d": 4', '}', ''].join('\n');
    const actual = ['{', '  "a": 1,', '  "b": 20,', '  "c": 3,', '  "d": 4', '}', ''].join('\n');
    expect(describeTextDiff(golden, actual, { context: 1 })).toBe([
      'first difference at line 3: golden lines 3–3, actual lines 3–3',
      '  2   "a": 1,',
      '- 3   "b": 2,',
      '+ 3   "b": 20,',
      '  4   "c": 3,',
    ].join('\n'));
  });

  it('reports pure insertions and deletions with an empty side', () => {
    expect(describeTextDiff('x\nz\n', 'x\ny\nz\n', { context: 0 })).toBe('first difference at line 2: golden lines 2–1, actual lines 2–2\n+ 2 y');
    expect(describeTextDiff('x\ny\nz\n', 'x\nz\n', { context: 0 })).toBe('first difference at line 2: golden lines 2–2, actual lines 2–1\n- 2 y');
  });

  it('caps each side and says how much was left out', () => {
    const golden = Array.from({ length: 10 }, (_, i) => `g${i}`).join('\n');
    const actual = Array.from({ length: 10 }, (_, i) => `a${i}`).join('\n');
    const text = describeTextDiff(golden, actual, { context: 0, maxLines: 3 });
    expect(text.split('\n')).toEqual([
      'first difference at line 1: golden lines 1–10, actual lines 1–10',
      '-  1 g0', '-  2 g1', '-  3 g2', '- … 7 more line(s)',
      '+  1 a0', '+  2 a1', '+  3 a2', '+ … 7 more line(s)',
    ]);
  });

  it('says so when the texts are equal', () => {
    expect(describeTextDiff('a\n', 'a\n')).toBe('(texts are equal)');
  });
});

describe('expectGolden', () => {
  const name = '__harness-self-test__.json';
  const file = path.join(EVIDENCE_DIR, name);
  afterEach(() => {
    fs.rmSync(file, { force: true });
    fs.rmSync(path.resolve('tests/visual/.out/evidence', name), { force: true });
  });

  it('puts the differing lines into the assertion message, which is all a JSON reporter keeps', () => {
    fs.writeFileSync(file, `${JSON.stringify({ keys: { 'Mod-b': '#3 strong$' } }, null, 2)}\n`);
    let message = '';
    try {
      expectGolden(name, { keys: { 'Mod-b': 'unhandled' } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`golden ${name} differs`);
    expect(message).toContain('- 3     "Mod-b": "#3 strong$"');
    expect(message).toContain('+ 3     "Mod-b": "unhandled"');
  });

  it('passes without a message when the value matches', () => {
    fs.writeFileSync(file, `${JSON.stringify({ a: 1 }, null, 2)}\n`);
    expect(() => expectGolden(name, { a: 1 })).not.toThrow();
  });
});
