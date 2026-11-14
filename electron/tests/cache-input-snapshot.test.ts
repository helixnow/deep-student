import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sameCacheInput, snapshotCacheInput } from '../scripts/cache-input-snapshot.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('existing-cache verification detects changed, added and removed files, not just directory existence', () => {
  const root = mkdtempSync(join(tmpdir(), 'cache-input-'));
  dirs.push(root);
  mkdirSync(join(root, 'version'));
  writeFileSync(join(root, 'version', 'entry'), 'original');
  const before = snapshotCacheInput(root);
  expect(sameCacheInput(before, snapshotCacheInput(root))).toBe(true);
  writeFileSync(join(root, 'version', 'entry'), 'modified');
  expect(sameCacheInput(before, snapshotCacheInput(root))).toBe(false);
  const changed = snapshotCacheInput(root);
  writeFileSync(join(root, 'version', 'new'), 'extra');
  expect(sameCacheInput(changed, snapshotCacheInput(root))).toBe(false);
  const added = snapshotCacheInput(root);
  rmSync(join(root, 'version', 'entry'));
  expect(sameCacheInput(added, snapshotCacheInput(root))).toBe(false);
});
