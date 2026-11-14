import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKUP_SPECIAL_SEED_NAMES, INVALID_VFS_BYTES, SYMLINK_BACKUP } from './__fixtures__/backup-seeds.ts';
import { compareDatabaseStates, enumerateDatabases, snapshotDirectory } from './__fixtures__/database-state.ts';
import { cleanup, tempDir } from './__fixtures__/fixtures.ts';
import { appDataRoot, copySeed, createSeed, resolveSeed, SEED_NAMES, type SeedDirectory } from './__fixtures__/scenario-seeds.ts';
import { seedFingerprintDifferences, timedBuild } from './__fixtures__/seed-determinism.ts';

let root: string, catalog: string;
const seeds = new Map<string, SeedDirectory>();
const app = (name: string) => appDataRoot(seeds.get(name)!);
beforeAll(() => {
  root = tempDir(); catalog = join(root, 'catalog');
  for (const name of BACKUP_SPECIAL_SEED_NAMES) seeds.set(name, createSeed(name, catalog));
}, 120_000);
afterAll(() => { if (root) cleanup(root); });

describe('L21 special-entry seeds (static fixtures, not A-produced or a G3 pass)', () => {
  it('registers all five fixtures and resolves the six existing pending scenarios', () => {
    for (const [name, seed] of seeds) {
      expect(SEED_NAMES).toContain(name);
      expect(resolveSeed(name, catalog)).toEqual(seed);
      expect(seed.provenance).toBe('sql-constructed');
      expect(existsSync(join(seed.directory, 'PROVENANCE.json'))).toBe(false);
    }
    const names = ['assets-seeded', 'inventory-seeded', 'diagnostics-seeded', 'metadata-seeded'];
    const scenarios = names.flatMap(name => JSON.parse(readFileSync(resolve(import.meta.dirname,
      `../../plugins/backup/equivalence/pending-seed/${name}.json`), 'utf8')).scenarios)
      .filter(s => seeds.has(s.seed));
    expect(scenarios).toHaveLength(6);
    expect(new Set(scenarios.map(s => s.seed)).size).toBe(5);
  });

  it('uses real root/nested links, a FIFO and an escape from the backup root', () => {
    const slot = (name: string) => join(app(name), 'slots/slotA');
    expect(readlinkSync(join(slot('l21-assets-root-symlink'), 'images'))).toBe('asset-target');
    expect(readlinkSync(join(slot('l21-assets-nested-symlink'), 'images/link'))).toBe('../asset-target');
    expect(lstatSync(join(slot('l21-assets-nested-fifo'), 'images/pipe')).isFIFO()).toBe(true);
    const backupRoot = join(app('l21-backups-symlink-escape'), 'recovery/backups');
    const link = join(backupRoot, SYMLINK_BACKUP);
    expect(readlinkSync(link)).toBe('../outside-backup');
    expect(realpathSync(link).startsWith(`${realpathSync(backupRoot)}/`)).toBe(false);
    const manifest = JSON.parse(readFileSync(join(realpathSync(link), 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ version: '3.0.0', backup_id: SYMLINK_BACKUP, files: [] });
  });

  it('copies A1/A2/B with identical snapshots and unchanged link text/FIFO kind', async () => {
    // Exercise W13's existing public digest API without changing recorder code.
    // The recorder module has no type declarations; a non-literal specifier keeps tsc from requiring one.
    const g3InputsModule = '../../../scripts/electron-migration/record/g3-inputs.mjs';
    const { seedDirectoryDigest } = (await import(g3InputsModule)) as {
      seedDirectoryDigest(root: string, directory: string, window: { from: number; to: number }): Promise<{ sha256: string; clockCells: Record<string, number> }>;
    };
    const repository = resolve(import.meta.dirname, '../../..');
    for (const [name, source] of seeds) {
      const before = snapshotDirectory(source.directory);
      const digest = await seedDirectoryDigest(repository, source.directory, { from: 0, to: 0 });
      for (const side of ['A1', 'A2', 'B']) {
        const copy = copySeed(name, catalog, join(root, side, name));
        expect(snapshotDirectory(copy.directory)).toEqual(before);
        expect(await seedDirectoryDigest(repository, copy.directory, { from: 0, to: 0 })).toEqual(digest);
        if (name === 'l21-assets-nested-fifo') expect(lstatSync(join(appDataRoot(copy), 'slots/slotA/images/pipe')).isFIFO()).toBe(true);
        if (name === 'l21-backups-symlink-escape') {
          expect(realpathSync(join(appDataRoot(copy), 'recovery/backups', SYMLINK_BACKUP)))
            .toBe(join(appDataRoot(copy), 'recovery/outside-backup'));
        }
      }
    }
  }, 120_000);

  it('retains invalid VFS bytes without opening them as SQLite, and compares changes', () => {
    const seed = seeds.get('l21-live-vfs-not-sqlite')!;
    const path = 'app-data/com.deepstudent.differential/slots/slotA/databases/vfs.db';
    const before = snapshotDirectory(seed.directory);
    expect(readFileSync(join(seed.directory, path), 'utf8')).toBe(INVALID_VFS_BYTES);
    expect(enumerateDatabases(seed.directory)).not.toContain(path);
    expect(before.files?.[path]).toEqual({ kind: 'unreadable', size: Buffer.byteLength(INVALID_VFS_BYTES),
      sha256: createHash('sha256').update(INVALID_VFS_BYTES).digest('hex') });
    const copy = copySeed(seed.name, catalog, join(root, 'changed'));
    writeFileSync(join(copy.directory, path), `${INVALID_VFS_BYTES}changed`);
    expect(compareDatabaseStates(before, snapshotDirectory(copy.directory))).toEqual([
      expect.objectContaining({ kind: 'file', db: path }),
    ]);
  });

  it('detects link changes and corrupt SQLite-header files without dereferencing external links', () => {
    const dir = join(root, 'evidence'); mkdirSync(dir);
    symlinkSync('/not-a-readable-seed-target', join(dir, 'outside.db'));
    writeFileSync(join(dir, 'corrupt.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(120, 0xff)]));
    const before = snapshotDirectory(dir);
    expect(before.databases).toEqual({});
    expect(before.files?.['outside.db']).toEqual({ kind: 'symlink', target: '/not-a-readable-seed-target' });
    expect(before.files?.['corrupt.db']).toMatchObject({ kind: 'unreadable', size: 136 });
    const after = structuredClone(before); after.files!['outside.db'] = { kind: 'symlink', target: '/another-target' };
    expect(compareDatabaseStates(before, after)).toEqual([expect.objectContaining({ kind: 'file', db: 'outside.db' })]);
  });

  it('fingerprints independent builds without reading links or FIFOs', () => {
    for (const name of BACKUP_SPECIAL_SEED_NAMES) {
      const a = timedBuild(() => createSeed(name, join(root, 'build-a')).directory);
      const b = timedBuild(() => createSeed(name, join(root, 'build-b')).directory);
      expect(seedFingerprintDifferences(a, b), name).toEqual([]);
    }
  }, 120_000);

  it('never opens a FIFO even with a .db suffix (isolated process has a hard deadline)', () => {
    const dir = join(root, 'fifo-deadline'); mkdirSync(dir);
    const fixtures = resolve(import.meta.dirname, '__fixtures__');
    execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import { createSeedFifo, copySeedTree } from ${JSON.stringify(`file://${fixtures}/seed-files.ts`)};
      import { snapshotDirectory } from ${JSON.stringify(`file://${fixtures}/database-state.ts`)};
      import { lstatSync } from 'node:fs';
      const dir = ${JSON.stringify(dir)};
      createSeedFifo(dir + '/pipe.db');
      copySeedTree(dir, dir + '-copy');
      const state = snapshotDirectory(dir + '-copy');
      if (!lstatSync(dir + '-copy/pipe.db').isFIFO() || state.files['pipe.db'].kind !== 'special') process.exit(1);
    `], { timeout: 15_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' });
  });
});
