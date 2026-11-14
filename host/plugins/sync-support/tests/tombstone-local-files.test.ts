/** `applyBlobTombstones` 的本地文件操作全部经异步端口：热路径上没有同步 fs，端口可替换（ctx.files 的前置）。 */
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BlobTombstoneEntry, BlobTombstones } from '../api.ts';
import { applyBlobTombstones, type TombstoneLocalFiles } from '../src/tombstone-files.ts';
import type { TombstoneLogger } from '../src/tombstone-model.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { MemoryStorage } from './memory-storage.ts';
import { tempDirLocalFiles } from './local-files.ts';

const logger: TombstoneLogger = { warn: vi.fn(), info: vi.fn() };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function entry(extra: Partial<BlobTombstoneEntry> = {}): BlobTombstoneEntry {
  const deletedAt = toRfc3339(BigInt(Date.now() + 30_000) * 1_000_000n);
  return { deleted_at: deletedAt, device_id: 'device-a', ...extra } as BlobTombstoneEntry;
}

it('applying blob tombstones makes no synchronous fs calls (relative path, hash lookup, missing bucket)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-support-tombstone-async-'));
  dirs.push(dir);
  const withPath = 'aa'.repeat(32);
  const byHash = 'bb'.repeat(32);
  const missing = 'cc'.repeat(32);
  fs.mkdirSync(path.join(dir, 'aa'));
  fs.mkdirSync(path.join(dir, 'bb'));
  fs.writeFileSync(path.join(dir, 'aa', `${withPath}.png`), 'a');
  fs.writeFileSync(path.join(dir, 'bb', `${byHash}.jpg`), 'b');
  const tombstones: BlobTombstones = {
    entries: {
      [withPath]: entry({ relative_path: `aa/${withPath}.png` }),
      [byHash]: entry(),
      [missing]: entry(),
    },
    updated_at: '',
  };

  const cjs = createRequire(import.meta.url)('node:fs') as Record<string, (...args: unknown[]) => unknown>;
  const names = ['statSync', 'lstatSync', 'readdirSync', 'existsSync', 'rmSync', 'unlinkSync'] as const;
  const originals = Object.fromEntries(names.map(name => [name, cjs[name]!]));
  const syncCalls: string[] = [];
  for (const name of names) {
    cjs[name] = (...args: unknown[]) => { syncCalls.push(`${name}(${String(args[0])})`); return originals[name]!(...args); };
  }
  syncBuiltinESMExports();
  let affected: string[];
  try {
    affected = await applyBlobTombstones(new MemoryStorage(), tombstones, dir, 'blobs', false, logger, tempDirLocalFiles());
  } finally {
    for (const name of names) cjs[name] = originals[name]!;
    syncBuiltinESMExports();
  }
  expect(syncCalls).toEqual([]);
  expect(affected.sort()).toEqual([withPath, byHash, missing].sort());
  expect(fs.readdirSync(path.join(dir, 'aa'))).toEqual([]);
  expect(fs.readdirSync(path.join(dir, 'bb'))).toEqual([]);
});

/** 内存端口：只认识给定的目录与文件，记录删除。 */
function memoryFiles(tree: Record<string, { dir?: true; symlink?: true; mtimeMs?: number }>): TombstoneLocalFiles & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    async mtimeMs(target) { return tree[target]?.mtimeMs ?? null; },
    async lstat(target) {
      const node = tree[target];
      return node === undefined ? null : { symlink: node.symlink === true, directory: node.dir === true };
    },
    async readDir(target) {
      return Object.keys(tree).filter(key => path.dirname(key) === target && key !== target).map(key => path.basename(key));
    },
    async exists(target) { return target in tree && !removed.includes(target); },
    async remove(target) { removed.push(target); },
  };
}

it('an injected local-files port carries every lookup and delete; symlink checks keep the Rust error text', async () => {
  const root = path.join(path.sep, 'blobs-root');
  const hash = 'dd'.repeat(32);
  const target = path.join(root, 'dd', `${hash}.bin`);
  const files = memoryFiles({ [path.join(root, 'dd')]: { dir: true }, [target]: { mtimeMs: 0 } });
  const affected = await applyBlobTombstones(
    new MemoryStorage(), { entries: { [hash]: entry() }, updated_at: '' }, root, 'blobs', false, logger, files,
  );
  expect(affected).toEqual([hash]);
  expect(files.removed).toEqual([target]);

  const linked = memoryFiles({ [path.join(root, 'dd')]: { symlink: true } });
  await expect(applyBlobTombstones(
    new MemoryStorage(), { entries: { [hash]: entry({ relative_path: `dd/${hash}.bin` }) }, updated_at: '' },
    root, 'blobs', false, logger, linked,
  )).rejects.toThrow(`blob tombstone 目标桶不能是符号链接: ${path.join(root, 'dd')}`);
  expect(linked.removed).toEqual([]);

  const newer = memoryFiles({ [path.join(root, 'dd')]: { dir: true }, [target]: { mtimeMs: Date.now() + 3_600_000 } });
  await expect(applyBlobTombstones(
    new MemoryStorage(), { entries: { [hash]: entry({ relative_path: `dd/${hash}.bin` }) }, updated_at: '' },
    root, 'blobs', false, logger, newer,
  )).resolves.toEqual([]);
  expect(newer.removed).toEqual([]);
});
