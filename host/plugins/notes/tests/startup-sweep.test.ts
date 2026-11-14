// V04-07 — lib.rs:3646-3768 startup sweep: one DeletePropagation permit, Rust step order,
// every failure only warns, nothing runs before the startup gate opens.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { regex as nativeRegex } from '../../../platform/native/regex/index.ts';
import { hashFile, insertPreparedIntent } from '../../../platform/storage/file-deletion-queue.ts';
import paths from '../../../platform/paths/index.ts';
import { OperationGuardError } from '../../backup/api.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import notes from '../index.ts';
import { configureNotesRepository } from '../repository/notes.ts';
import {
  NOTES_STARTUP_SWEEP_FINALIZER, RETRIEVAL_SWEEP_GRACE_MS, registerNotesStartupSweep, runStartupSweep,
  type StartupSweepDeps,
} from '../src/startup-sweep.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Permits { acquired: string[]; released: number; busy: OperationGuardError | null }

async function sweepHost(options: { gate?: () => Promise<boolean>; vfsDatabase?: boolean } = {}) {
  const logs: string[] = [];
  const host = await createTestHost();
  host.ctx.logger.exporter({
    // Cordis drops warn below WARN (2) by default; mirror kernel/log-export.ts.
    levels: { default: 2 },
    export(message) {
      if (message.name === 'notes') logs.push(`${message.type} ${String((message.args as unknown[])[0])}`);
    },
  });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  const permits: Permits = { acquired: [], released: 0, busy: null };
  host.ctx.provide('storage', storage);
  host.ctx.provide('nativeRegex', nativeRegex);
  host.ctx.provide('governance', {
    tryAcquireOperationGuard(kind: string) {
      if (permits.busy !== null) throw permits.busy;
      permits.acquired.push(kind);
      return { release() { permits.released += 1; } };
    },
  } as never);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  }));
  const activeDir = storage.locations.activeDir;
  const blobsDir = path.join(activeDir, 'vfs_blobs');
  if (options.vfsDatabase !== false) {
    host.ctx.provide('vfsDatabase', {
      getConnSafe: () => storage.database('vfs'),
      blobsDir: () => blobsDir,
    } as never);
  }
  if (options.gate !== undefined) host.ctx.provide('startupGate', { waitStartupReady: options.gate } as never);
  await host.install(paths, vfsRepos, notes);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    configureNotesRepository(null);
    await host.dispose();
    storage.dispose();
  };
  cleanup.push(dispose);
  return { host, storage, activeDir, blobsDir, permits, logs, dispose, vfs: storage.database('vfs') };
}

type Fixture = Awaited<ReturnType<typeof sweepHost>>;

function seedSweepTargets(fixture: Fixture): { assetFile: string; blobFile: string } {
  const { vfs, activeDir, blobsDir } = fixture;
  const old = Date.now() - RETRIEVAL_SWEEP_GRACE_MS - 60_000;
  const fresh = Date.now() - 60_000;
  const resource = (id: string, type: string, refCount: number, updatedAt: number) => vfs.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'inline', 'x', ?4, ?5, ?5)`, [id, `h_${id}`, type, refCount, updatedAt]);
  resource('ret_old', 'retrieval', 0, old);
  resource('ret_fresh', 'retrieval', 0, fresh);
  resource('ret_used', 'retrieval', 1, old);
  resource('note_orphan', 'note', 0, old);
  resource('mindmap_orphan', 'mindmap', 0, old);
  resource('note_owned', 'note', 0, old);
  vfs.run(`INSERT INTO notes (id, resource_id, title, created_at, updated_at)
           VALUES ('note_1', 'note_owned', 'kept', '2026-01-01', '2026-01-01')`);
  vfs.exec('PRAGMA foreign_keys=OFF');
  vfs.run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, text_required, text_state,
             mm_required, mm_state, created_at, updated_at)
           VALUES ('unit_orphan', 'res_gone', 0, 'x', 1, 'indexed', 0, 'disabled', 0, 0)`);
  vfs.run(`INSERT INTO vfs_index_segments (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
             created_at, updated_at)
           VALUES ('seg_orphan', 'unit_orphan', 0, 'text', 3, 'lance_orphan', 0, 0)`);
  vfs.exec('PRAGMA foreign_keys=ON');

  const repos = fixture.host.ctx.get('vfsRepo') as VfsReposService;
  const blob = repos.blobs.storeBlob(vfs, blobsDir, new TextEncoder().encode('orphan blob'), 'text/plain', 'txt');
  vfs.run('UPDATE blobs SET ref_count = 0 WHERE hash = ?1', [blob.hash]);
  const blobFile = path.join(blobsDir, blob.relativePath);
  expect(fs.existsSync(blobFile)).toBe(true);

  const assetFile = path.join(activeDir, 'notes_assets', 'a.bin');
  fs.mkdirSync(path.dirname(assetFile), { recursive: true });
  fs.writeFileSync(assetFile, 'prepared asset');
  insertPreparedIntent(vfs, 'asset', 'active/notes_assets/a.bin', 'notes_assets/a.bin',
    hashFile(assetFile), fs.statSync(assetFile).size, 'op-startup-sweep');
  return { assetFile, blobFile };
}

const sweepLogs = (fixture: Fixture) => fixture.logs
  .filter(line => line.includes('[AppSetup]') && !line.includes('note links backfill'));
const ids = (fixture: Fixture, sql: string) => fixture.vfs.all<{ id: string }>(sql).map(row => row.id);

describe('V04-07 notes startup sweep (lib.rs:3646-3768)', () => {
  it('runs every Rust sweep step under one DeletePropagation permit once startup is ready', async () => {
    const fixture = await sweepHost();
    const { assetFile, blobFile } = seedSweepTargets(fixture);

    expect(fixture.host.ctx.storage.finalizerNames()).toContain(NOTES_STARTUP_SWEEP_FINALIZER);
    await fixture.host.ctx.storage.runStartupFinalizers();
    await vi.waitFor(() => { expect(fixture.permits.released === 1).toBe(true); });

    expect(fixture.permits.acquired).toEqual(['delete_propagation']);
    expect(fs.existsSync(assetFile)).toBe(false);
    expect(fs.existsSync(blobFile)).toBe(false);
    expect(fixture.vfs.pluck('SELECT COUNT(*) FROM blobs WHERE ref_count = 0')).toBe(0);
    expect(ids(fixture, 'SELECT id FROM resources ORDER BY id'))
      .toEqual(['note_owned', 'ret_fresh', 'ret_used']);
    expect(ids(fixture, 'SELECT id FROM vfs_index_units')).toEqual([]);
    expect(fixture.vfs.pluck("SELECT resource_id FROM __lance_orphan_queue WHERE lance_row_id = 'lance_orphan'"))
      .toBe('res_gone');
    expect(sweepLogs(fixture)).toEqual([
      'info [AppSetup] Recovered 1 prepared asset deletions',
      'info [AppSetup] Swept 1 unreferenced blobs',
      'info [AppSetup] Swept 1 unreferenced retrieval resources',
      'info [AppSetup] Swept 2 orphan note/mindmap resources',
      'info [AppSetup] Swept 1 orphan index units (lance rows enqueued)',
    ]);
  }, 60_000);

  it('waits for the startup gate and does nothing if the plugin unloads first', async () => {
    let markReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
    const fixture = await sweepHost({ gate: () => ready });
    seedSweepTargets(fixture);

    await fixture.host.ctx.storage.runStartupFinalizers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.permits.acquired).toEqual([]);
    expect(ids(fixture, "SELECT id FROM resources WHERE id = 'ret_old'")).toEqual(['ret_old']);

    await fixture.dispose();
    markReady(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.permits.acquired).toEqual([]);
  }, 60_000);

  it('runs after the gate opens', async () => {
    let markReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
    const fixture = await sweepHost({ gate: () => ready });
    seedSweepTargets(fixture);
    await fixture.host.ctx.storage.runStartupFinalizers();
    expect(fixture.permits.acquired).toEqual([]);
    markReady(true);
    await vi.waitFor(() => { expect(fixture.permits.released === 1).toBe(true); });
    expect(ids(fixture, "SELECT id FROM resources WHERE id = 'ret_old'")).toEqual([]);
  }, 60_000);

  it('a startup gate that is never marked ready still runs the sweep (lib.rs:3646 does not wait for the gate)', async () => {
    const fixture = await sweepHost({ gate: async () => false });
    seedSweepTargets(fixture);
    await fixture.host.ctx.storage.runStartupFinalizers();
    await vi.waitFor(() => { expect(fixture.permits.released === 1).toBe(true); });
    expect(fixture.permits.acquired).toEqual(['delete_propagation']);
    expect(ids(fixture, "SELECT id FROM resources WHERE id = 'ret_old'")).toEqual([]);
    expect(fixture.logs).toContain('warn [AppSetup] startup gate was not marked ready; running startup sweep anyway');
  }, 60_000);

  it('skips the whole sweep when another governance operation holds the permit', async () => {
    const fixture = await sweepHost();
    const { assetFile } = seedSweepTargets(fixture);
    fixture.permits.busy = new OperationGuardError('busy', '另一数据治理操作正在运行');

    await fixture.host.ctx.storage.runStartupFinalizers();
    await vi.waitFor(() => { expect(fixture.logs.some(line => line.includes('跳过启动删除恢复'))).toBe(true); });

    expect(fs.existsSync(assetFile)).toBe(true);
    expect(ids(fixture, "SELECT id FROM resources WHERE id = 'ret_old'")).toEqual(['ret_old']);
    expect(fixture.permits.released).toBe(0);
  }, 60_000);

  it('lib.rs:3752-3766: the one-time note-links backfill runs at the end of the sweep after ready, not as a pre-ready finalizer', async () => {
    let markReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
    const fixture = await sweepHost({ gate: () => ready });
    seedSweepTargets(fixture);
    const backfillDone = () => fixture.vfs.get<{ value: string }>(
      "SELECT value FROM vfs_indexing_config WHERE key='maintenance.note_links_backfill_done'")?.value;

    expect(fixture.host.ctx.storage.finalizerNames()).not.toContain('notes.note-links-backfill');
    await fixture.host.ctx.storage.runStartupFinalizers();
    expect(backfillDone()).toBeUndefined();

    markReady(true);
    await vi.waitFor(() => { expect(fixture.permits.released === 1).toBe(true); });
    expect(backfillDone()).toBe('true');
    expect(fixture.logs.filter(line => line.includes('[AppSetup]')).at(-1))
      .toBe('info [AppSetup] One-time note links backfill completed');
  }, 60_000);

  it('lib.rs:3657-3664: a busy permit also skips the note-links backfill', async () => {
    const fixture = await sweepHost();
    fixture.permits.busy = new OperationGuardError('busy', '另一数据治理操作正在运行');
    await fixture.host.ctx.storage.runStartupFinalizers();
    await vi.waitFor(() => { expect(fixture.logs.some(line => line.includes('跳过启动删除恢复'))).toBe(true); });
    expect(fixture.vfs.get(
      "SELECT value FROM vfs_indexing_config WHERE key='maintenance.note_links_backfill_done'")).toBeUndefined();
  }, 60_000);

  it('without vfsDatabase only the asset recovery runs; blob and table sweeps warn (lib.rs:3674-3749)', async () => {
    const fixture = await sweepHost({ vfsDatabase: false });
    const { assetFile } = seedSweepTargets(fixture);

    await fixture.host.ctx.storage.runStartupFinalizers();
    await vi.waitFor(() => { expect(fixture.permits.released === 1).toBe(true); });

    expect(fs.existsSync(assetFile)).toBe(false);
    expect(sweepLogs(fixture)).toEqual([
      'info [AppSetup] Recovered 1 prepared asset deletions',
      'warn [AppSetup] Unreferenced blob sweep failed: vfsDatabase service is not available',
      'warn [AppSetup] Retrieval sweep skipped (no connection): vfsDatabase service is not available',
    ]);
  }, 60_000);
});

describe('V09-P1-3 notes startup finalizers across unload and reinstall', () => {
  const registrationWarnings = (fixture: Fixture) => fixture.logs
    .filter(line => line.includes('finalizer not registered') || line.includes('finalizer registration failed'));

  it('V09-P1-3: unloading notes before startup drops its finalizer; the reinstalled one runs once', async () => {
    const fixture = await sweepHost();
    seedSweepTargets(fixture);
    const storage = fixture.host.ctx.storage;
    const notesFinalizers = () => storage.finalizerNames().filter(name => name.startsWith('notes.'));
    expect(notesFinalizers()).toEqual([NOTES_STARTUP_SWEEP_FINALIZER]);

    await fixture.host.unload('dstu.notes');
    expect(notesFinalizers()).toEqual([]);
    await fixture.host.install(notes);
    expect(notesFinalizers()).toEqual([NOTES_STARTUP_SWEEP_FINALIZER]);

    const report = await storage.runStartupFinalizers();
    expect(report.completed).toContain(NOTES_STARTUP_SWEEP_FINALIZER);
    await vi.waitFor(() => { expect(fixture.permits.released === 1).toBe(true); });
    expect(fixture.permits.acquired).toEqual(['delete_propagation']);
    expect(registrationWarnings(fixture)).toEqual([]);
  }, 60_000);

  it('V09-P1-3: reinstalling notes after startup succeeds quietly and does not sweep again', async () => {
    const fixture = await sweepHost();
    seedSweepTargets(fixture);
    await fixture.host.ctx.storage.runStartupFinalizers();
    await vi.waitFor(() => { expect(fixture.permits.released === 1).toBe(true); });

    await fixture.host.unload('dstu.notes');
    await fixture.host.install(notes);
    expect(fixture.host.plugins.map(plugin => plugin.id)).toContain('dstu.notes');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.permits.acquired).toEqual(['delete_propagation']);
    expect(registrationWarnings(fixture)).toEqual([]);
  }, 60_000);
});

describe('runStartupSweep failure isolation', () => {
  it('a storage without the finalizer API leaves plugin apply intact and only warns', () => {
    const warns: string[] = [];
    const effects: unknown[] = [];
    const ctx = {
      logger: () => ({ info() {}, warn: (message: string) => { warns.push(message); } }),
      storage: {},
      effect: (fn: unknown) => { effects.push(fn); },
    };
    expect(() => registerNotesStartupSweep(ctx as never)).not.toThrow();
    expect(warns).toEqual([expect.stringContaining('[AppSetup] startup sweep finalizer not registered:')]);
    expect(effects).toEqual([]);
  });

  function deps(overrides: Partial<StartupSweepDeps> & { failing?: string[] } = {}) {
    const calls: string[] = [];
    const lines: string[] = [];
    const failing = new Set(overrides.failing ?? []);
    const step = <T>(name: string, value: T): T => {
      calls.push(name);
      if (failing.has(name)) throw new Error(`${name} failed`);
      return value;
    };
    const conn = {} as never;
    let released = 0;
    const base: StartupSweepDeps = {
      activeDir: '/data/active',
      acquireGuard: () => ({ release: () => { released += 1; } }),
      recoverAssetDeletions: (dir) => { expect(dir).toBe('/data/active'); return step('assets', 0); },
      vfsDatabase: () => ({ getConnSafe: () => step('conn', conn), blobsDir: () => '/data/active/vfs_blobs' }),
      repos: {
        blobs: { cleanupUnreferenced: (_c: unknown, dir: string) => { expect(dir).toBe('/data/active/vfs_blobs'); return step('blobs', 0); } },
        resources: {
          cleanupUnreferencedRetrievals: (_c: unknown, grace: number) => { expect(grace).toBe(86_400_000); return step('retrievals', 0); },
          cleanupOrphanNoteMindmapResources: (_c: unknown, grace: number) => { expect(grace).toBe(86_400_000); return step('orphans', 0); },
        },
        embeddingUnits: { sweepOrphanIndexUnits: () => step('units', 0) },
      } as never,
      backfillNoteLinks: () => { calls.push(`backfill:released=${released}`); },
      logger: {
        info: (message) => { lines.push(`info ${message}`); },
        warn: (message) => { lines.push(`warn ${message}`); },
      },
    };
    const { failing: _ignored, ...rest } = overrides;
    return { deps: { ...base, ...rest }, calls, lines, released: () => released };
  }

  it('every step failure only warns and the later steps still run; the permit is released', () => {
    const run = deps({ failing: ['assets', 'blobs', 'retrievals', 'orphans', 'units'] });
    runStartupSweep(run.deps);
    expect(run.calls).toEqual(['assets', 'conn', 'blobs', 'conn', 'retrievals', 'orphans', 'units', 'backfill:released=0']);
    expect(run.lines).toEqual([
      'warn [AppSetup] Prepared asset deletion recovery failed: assets failed',
      'warn [AppSetup] Unreferenced blob sweep failed: blobs failed',
      'warn [AppSetup] Retrieval resource sweep failed: retrievals failed',
      'warn [AppSetup] Orphan note/mindmap sweep failed: orphans failed',
      'warn [AppSetup] Orphan index unit sweep failed: units failed',
    ]);
    expect(run.released()).toBe(1);
  });

  it('no connection skips the three table sweeps, still backfills note links under the permit, then releases it', () => {
    const run = deps({ failing: ['conn'] });
    runStartupSweep(run.deps);
    expect(run.calls).toEqual(['assets', 'conn', 'conn', 'backfill:released=0']);
    expect(run.lines).toEqual([
      'warn [AppSetup] Unreferenced blob sweep failed: conn failed',
      'warn [AppSetup] Retrieval sweep skipped (no connection): conn failed',
    ]);
    expect(run.released()).toBe(1);
  });

  it('a busy permit skips every step', () => {
    const run = deps({ acquireGuard: () => { throw new Error('busy'); } });
    runStartupSweep(run.deps);
    expect(run.calls).toEqual([]);
    expect(run.lines).toEqual(['warn [AppSetup] 跳过启动删除恢复：另一数据治理操作正在运行: busy']);
  });
});
