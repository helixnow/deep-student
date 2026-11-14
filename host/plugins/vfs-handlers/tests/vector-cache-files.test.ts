import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { clearVectorCacheDirectory, type VectorCacheFiles } from '../src/vector-cache-files.ts';

let root: string;
let files: VectorCacheFiles;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'l13b-vector-cache-'));
  files = createNodeFiles({ roots: [{ name: 'temp', path: root }] });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('removes the supplied Lance directory and reports its recursive byte size', async () => {
  const lance = join(root, 'lance', 'vfs');
  fs.mkdirSync(join(lance, 'nested'), { recursive: true });
  fs.writeFileSync(join(lance, 'one'), Buffer.from('abc'));
  fs.writeFileSync(join(lance, 'nested', 'two'), Buffer.from('中文'));
  fs.writeFileSync(join(root, 'outside'), 'keep');
  expect(await clearVectorCacheDirectory(files, lance)).toEqual({ existed: true, removed: true, bytesFreed: 9 });
  expect(fs.existsSync(lance)).toBe(false);
  expect(fs.readFileSync(join(root, 'outside'), 'utf8')).toBe('keep');
});

it('reports an absent directory without creating or removing files', async () => {
  expect(await clearVectorCacheDirectory(files, join(root, 'absent'))).toEqual({ existed: false, removed: false, bytesFreed: 0 });
  expect(fs.readdirSync(root)).toEqual([]);
});

it('preserves a regular file at the directory path when remove_dir_all rejects it', async () => {
  const lance = join(root, 'vfs');
  fs.writeFileSync(lance, 'not a directory');
  await expect(clearVectorCacheDirectory(files, lance)).rejects.toThrow();
  expect(fs.readFileSync(lance, 'utf8')).toBe('not a directory');
});

it('keeps Rust calculate_dir_size unwrap_or(0) and still removes after a size-read error', async () => {
  const lance = join(root, 'vfs');
  fs.mkdirSync(lance);
  fs.writeFileSync(join(lance, 'page'), 'data');
  vi.spyOn(files, 'readDir').mockRejectedValueOnce(new Error('size read failed'));
  expect(await clearVectorCacheDirectory(files, lance)).toEqual({ existed: true, removed: true, bytesFreed: 0 });
  expect(fs.existsSync(lance)).toBe(false);
});

it('propagates removal failure to the owner warning branch without claiming freed bytes', async () => {
  const lance = join(root, 'vfs');
  fs.mkdirSync(lance);
  fs.writeFileSync(join(lance, 'page'), 'data');
  const failure = new Error('remove failed');
  vi.spyOn(files, 'rm').mockRejectedValueOnce(failure);
  await expect(clearVectorCacheDirectory(files, lance)).rejects.toBe(failure);
  expect(fs.readFileSync(join(lance, 'page'), 'utf8')).toBe('data');
});
