import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildOwnerDatabase, cleanup, HERE, tempDir } from './__fixtures__/fixtures.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) cleanup(dir); });
function cli(...args: string[]) {
  return spawnSync(process.execPath, [join(HERE, '__fixtures__/scenario-cli.ts'), ...args], { encoding: 'utf8' });
}

it('Node CLI loads the real TS API and emits seed/copy/snapshot/equal JSON without a transpiler dependency', () => {
  const root = tempDir(); dirs.push(root);
  const catalog = join(root, 'catalog'), a = join(root, 'A1'), b = join(root, 'B');
  const source = cli('seed', 'empty', catalog);
  expect(source.status, source.stderr).toBe(0);
  expect(JSON.parse(source.stdout)).toEqual({ name: 'empty', provenance: 'empty', directory: join(catalog, 'empty'),
    dataDir: join(catalog, 'empty/app-data'), dataLocalDir: join(catalog, 'empty/local-data') });
  for (const dir of [a, b]) {
    const copy = cli('copy', 'empty', catalog, dir);
    expect(copy.status, copy.stderr).toBe(0);
    expect(JSON.parse(copy.stdout)).toMatchObject({ directory: dir, dataDir: join(dir, 'app-data'), dataLocalDir: join(dir, 'local-data') });
  }
  const snapshot = cli('snapshot', a);
  expect(snapshot.status, snapshot.stderr).toBe(0);
  expect(JSON.parse(snapshot.stdout)).toEqual({ version: 0, databases: {} });
  const equal = cli('compare', a, b);
  expect(equal.status, equal.stderr).toBe(0);
  expect(JSON.parse(equal.stdout)).toEqual({ equal: true, before: { version: 0, databases: {} }, after: { version: 0, databases: {} }, differences: [] });
});

it('Node CLI distinguishes actual data differences (exit 1) from invalid invocation/seed/read errors (exit 2)', () => {
  const a = tempDir(), b = tempDir(); dirs.push(a, b);
  buildOwnerDatabase(join(b, 'data.db'), 'CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT)', { data: [{ id: 1, value: 'actual' }] });
  const changed = cli('compare', a, b);
  expect(changed.status, changed.stderr).toBe(1);
  expect(JSON.parse(changed.stdout)).toMatchObject({ equal: false, differences: [{ kind: 'database', db: 'data.db', before: null }] });
  for (const args of [[], ['seed', 'unknown', a], ['snapshot', join(a, 'missing')]]) {
    const invalid = cli(...args);
    expect(invalid.status, invalid.stderr).toBe(2);
    expect(invalid.stderr.length).toBeGreaterThan(0);
    expect(invalid.stdout).toBe('');
  }
});
