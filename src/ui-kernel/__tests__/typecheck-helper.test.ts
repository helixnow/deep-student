// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTypeTest } from './typecheck-helper';
import { TYPE_HELPER_TIMEOUT_MS } from './typecheck-budget';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

let directory: string;
let file: string;
let dependency: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-typecheck-helper-'));
  file = path.join(directory, 'contract.ts');
  dependency = path.join(directory, 'dependency.ts');
  fs.writeFileSync(dependency, 'export interface Item { name: string }\n');
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('typecheck helper program reuse', () => {
  it('accepts legal values and still diagnoses the annotated illegal value after stripping', async () => {
    fs.writeFileSync(file, [
      "import type { Item } from './dependency';",
      "const valid: Item = { name: 'ok' };",
      '// @ts-expect-error [wrong-field]',
      'const invalid: Item = { name: 42 };',
    ].join('\n'));
    const heartbeat = vi.fn();
    const timer = setInterval(heartbeat, 10);
    let result;
    try {
      result = await runTypeTest(file);
    } finally {
      clearInterval(timer);
    }
    expect(heartbeat).toHaveBeenCalled();
    expect(result.clean).toEqual([]);
    expect(result.tags).toEqual(['wrong-field']);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.errors['wrong-field']).toMatch(/Type 'number' is not assignable to type 'string'/);
  }, TYPE_HELPER_TIMEOUT_MS);

  it('reports unused directives and unannotated errors rather than treating either as a contract success', async () => {
    fs.writeFileSync(file, [
      "import type { Item } from './dependency';",
      '// @ts-expect-error [unused]',
      "const valid: Item = { name: 'ok' };",
      'const invalid: Item = { name: 42 };',
    ].join('\n'));
    const result = await runTypeTest(file);
    expect(result.clean).toHaveLength(2);
    expect(result.clean.some(error => error.includes('TS2578'))).toBe(true);
    expect(result.clean.some(error => error.includes('TS2322'))).toBe(true);
    expect(result.unexpected).toHaveLength(1);
    expect(result.unexpected[0]).toMatch(/contract.ts:4 TS2322/);
    expect(result.missing).toEqual(['unused']);
    expect(result.errors).toEqual({});
  }, TYPE_HELPER_TIMEOUT_MS);

  it('retains dependency diagnostics and reads changed dependencies in the next invocation', async () => {
    fs.writeFileSync(file, "import type { Item } from './dependency';\nconst valid: Item = { name: 'ok' };\n");
    expect((await runTypeTest(file)).clean).toEqual([]);
    fs.writeFileSync(dependency, 'export interface Item { name: number }\nexport const invalid: string = 42;\n');
    const result = await runTypeTest(file);
    expect(result.clean).toHaveLength(2);
    expect(result.unexpected).toHaveLength(2);
    for (const errors of [result.clean, result.unexpected]) {
      expect(errors.some(error => /dependency.ts:2 TS2322/.test(error))).toBe(true);
      expect(errors.some(error => /contract.ts:2 TS2322/.test(error))).toBe(true);
    }
    expect(result.missing).toEqual([]);
  }, TYPE_HELPER_TIMEOUT_MS);

  it('strips real comments, including template expressions, but preserves template and block-comment text', async () => {
    fs.writeFileSync(file, [
      "const literal: '\\n// @ts-expect-error [fake-template]\\ntext' = `",
      '// @ts-expect-error [fake-template]',
      'text`;',
      '/**',
      '// @ts-expect-error [fake-jsdoc]',
      '*/',
      '/*',
      '// @ts-expect-error [fake-block]',
      '*/',
      'export const valid: number = 1;',
      '// @ts-expect-error [real-comment]',
      "const invalid: number = 'bad';",
      'const interpolated = `prefix ${(() => {',
      '// @ts-expect-error [real-template-expression]',
      "const invalid: number = 'bad';",
      'return invalid; })()}`;',
    ].join('\n'));
    const result = await runTypeTest(file);
    expect(result.clean).toEqual([]);
    expect(result.tags).toEqual(['real-comment', 'real-template-expression']);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(Object.values(result.errors)).toHaveLength(2);
    for (const error of Object.values(result.errors)) expect(error).toMatch(/Type 'string' is not assignable to type 'number'/);
  }, TYPE_HELPER_TIMEOUT_MS);

  it('retains diagnostics without a source file from the complete clean pass', async () => {
    fs.writeFileSync(file, 'export const valid = 1;\n');
    // A real missing-types config crosses the process boundary; a parent ts.sys spy would not.
    const configPath = path.join(directory, 'tsconfig.json');
    fs.writeFileSync(configPath, JSON.stringify({
      extends: path.resolve(__dirname, '../../../tsconfig.json'),
      compilerOptions: { types: ['typecheck-regression-missing-types'] },
    }));
    const result = await runTypeTest(file, configPath);
    const global = result.clean.filter(error => error.startsWith('<global>'));
    expect(global.length).toBeGreaterThan(0);
    expect(result.unexpected.filter(error => error.startsWith('<global>'))).toEqual(global);
  }, TYPE_HELPER_TIMEOUT_MS);

  it('fails with the child stderr when compilation crashes instead of returning a result', async () => {
    await expect(runTypeTest(path.join(directory, 'missing.ts'))).rejects.toThrow(/TypeScript compiler child.*failed:[\s\S]*stderr:[\s\S]*TypeError/);
  }, TYPE_HELPER_TIMEOUT_MS);

  it.each(['not-json', '{}'])('rejects malformed child output %s and preserves stderr', async (stdout) => {
    vi.mocked(execFile).mockImplementationOnce(((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, stdout, 'fixture child stderr'));
      return new ChildProcess();
    }) as typeof execFile);
    await expect(runTypeTest(file)).rejects.toThrow(/invalid JSON\/result:[\s\S]*stderr:\nfixture child stderr/);
  });
});
