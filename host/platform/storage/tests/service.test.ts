import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageError } from '../api.ts';
import { createStorageService, StorageCordisService } from '../service.ts';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-svc-'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('StorageService', () => {
  it('opens registered databases at Rust paths with their PRAGMAs and returns the same handle', () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
    const vfs = s.database('vfs');
    expect(s.database('vfs')).toBe(vfs);
    expect(vfs.path).toBe(path.join(base, 'slots', 'slotA', 'databases', 'vfs.db'));
    expect(vfs.pluck('PRAGMA busy_timeout')).toBe(5000);
    expect(s.database('sync_state').path).toBe(path.join(base, 'local', 'deep-student', 'sync', 'sync_state.db'));
    expect(() => s.pathOf('nope' as never)).toThrow(StorageError);
    s.dispose();
  });

  it('browser.db runs its own refinery migrations on first open', () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: base });
    const b = s.database('browser');
    expect(b.pluck('SELECT MAX(version) FROM refinery_schema_history')).toBe(20260711);
    expect(s.migrations.currentVersion('browser')).toBe(20260711);
    s.dispose();
  });

  it('migrations.runAll migrates the active slot; currentVersion/needsMigration reflect it', async () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: base });
    expect(s.migrations.needsMigration('vfs')).toBe(true);
    const report = await s.migrations.runAll();
    expect(report.success).toBe(true);
    expect(s.migrations.needsMigration('vfs')).toBe(false);
    expect(s.migrations.currentVersion('chat_v2')).toBeGreaterThan(20260130);
    s.dispose();
  });

  it('maintenance lease blocks new borrows and releases', async () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: base });
    const db = s.database('chat_v2');
    db.exec('CREATE TABLE x (a)');
    const lease = await s.enterMaintenance(['chat_v2']);
    expect(() => s.database('chat_v2')).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));
    expect(() => db.get('SELECT 1')).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));
    lease.release();
    expect(s.database('chat_v2').pluck("SELECT COUNT(*) FROM sqlite_master WHERE name='x'")).toBe(1);
    s.dispose();
  });

  it('openFile/close manage ad-hoc handles only', () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: base });
    const ws = s.openFile(path.join(base, 'ws_1.db'), { profile: 'workspace' });
    expect(ws.pluck('PRAGMA journal_mode')).toBe('wal');
    s.close(ws);
    expect(() => s.close(s.database('vfs'))).toThrow(StorageError);
    s.dispose();
  });

  it('openFile createParentDirs=false creates a missing database only when its parent exists', () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: base });
    const parent = path.join(base, 'existing-parent');
    fs.mkdirSync(parent);
    const missing = path.join(parent, 'created.db');
    const db = s.openFile(missing, { createParentDirs: false });
    try {
      db.exec('CREATE TABLE probe (value TEXT)');
      expect(fs.existsSync(missing)).toBe(true);
    } finally { s.close(db); }

    const noParent = path.join(base, 'missing-parent', 'nope.db');
    let caught: unknown;
    try { s.openFile(noParent, { createParentDirs: false }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(StorageError);
    expect(caught).toMatchObject({ code: 'SQLITE', sqliteCode: 'SQLITE_CANTOPEN', phase: 'execute' });
    expect(fs.existsSync(path.dirname(noParent))).toBe(false);
    expect(fs.existsSync(noParent)).toBe(false);

    // 既有默认不变：未显式关闭时仍递归创建父目录。
    const nested = path.join(base, 'deep', 'nested', 'default.db');
    const defaultDb = s.openFile(nested);
    try { expect(fs.existsSync(nested)).toBe(true); }
    finally { s.close(defaultDb); }
    s.dispose();
  });

  it('maintenance participants pause before handles and resume only after the last lease', async () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: base });
    const events: string[] = [];
    const removeVfs = s.registerMaintenanceParticipant('vfs-worker', {
      databases: ['vfs'],
      enterMaintenance: async () => { events.push('vfs-enter'); },
      exitMaintenance: () => { events.push('vfs-exit'); },
    });
    s.registerMaintenanceParticipant('chat-worker', {
      databases: ['chat_v2'],
      enterMaintenance: () => { events.push('chat-enter'); },
      exitMaintenance: () => { events.push('chat-exit'); },
    });

    const vfsLease = await s.enterMaintenance(['vfs']);
    expect(events).toEqual(['vfs-enter']);
    expect(() => s.database('vfs')).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));

    const chatLease = await s.enterMaintenance(['chat_v2']);
    expect(events).toEqual(['vfs-enter', 'chat-enter']);
    chatLease.release();
    expect(events).toEqual(['vfs-enter', 'chat-enter', 'chat-exit']);
    vfsLease.release();
    expect(events).toEqual(['vfs-enter', 'chat-enter', 'chat-exit', 'vfs-exit']);
    expect(s.database('vfs').pluck('SELECT 1')).toBe(1);

    removeVfs();
    s.dispose();
  });

  it('reference-counts overlapping leases, lets participants finish borrowing while draining, then blocks borrows', async () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: base });
    let enters = 0;
    let exits = 0;
    let borrowDuringDrain: unknown;
    s.registerMaintenanceParticipant('all-workers', {
      enterMaintenance: async () => {
        enters += 1;
        await Promise.resolve();
        try { borrowDuringDrain = s.database('vfs'); }
        catch (error) { borrowDuringDrain = error; }
      },
      exitMaintenance: () => { exits += 1; },
    });

    const vfsLease = await s.enterMaintenance(['vfs']);
    const chatLease = await s.enterMaintenance(['chat_v2']);
    expect([enters, exits]).toEqual([1, 0]);
    // A participant may need a dependency to finish its in-flight operation;
    // the database barrier closes after participants have drained, not before.
    expect(borrowDuringDrain).toMatchObject({ name: 'vfs' });
    expect(() => s.database('vfs')).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));

    chatLease.release();
    expect([enters, exits]).toEqual([1, 0]);
    vfsLease.release();
    expect([enters, exits]).toEqual([1, 1]);
    s.dispose();
  });

  it('participant enter failure leaves storage usable and registration is rejected during maintenance', async () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: base });
    const remove = s.registerMaintenanceParticipant('broken', {
      databases: ['vfs'],
      enterMaintenance: () => { throw new Error('worker did not drain'); },
      exitMaintenance: () => {},
    });
    await expect(s.enterMaintenance(['vfs'])).rejects.toThrow('worker did not drain');
    expect(s.database('vfs').pluck('SELECT 1')).toBe(1);
    remove();

    const lease = await s.enterMaintenance(['vfs']);
    expect(() => s.registerMaintenanceParticipant('late', {
      enterMaintenance: () => {}, exitMaintenance: () => {},
    })).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));
    lease.release();

    expect(() => s.registerMaintenanceParticipant('dup', {
      enterMaintenance: () => {}, exitMaintenance: () => {},
    })).not.toThrow();
    expect(() => s.registerMaintenanceParticipant('dup', {
      enterMaintenance: () => {}, exitMaintenance: () => {},
    })).toThrow(expect.objectContaining({ code: 'MAINTENANCE_PARTICIPANT_DUPLICATE' }));
    s.dispose();
  });

  it('shares an in-flight participant drain between concurrent disjoint database leases', async () => {
    const s = createStorageService({ baseDir: base, dataLocalDir: base });
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const draining = new Promise<void>(resolve => { finish = resolve; });
    let enters = 0, exits = 0;
    s.registerMaintenanceParticipant('shared-workers', {
      enterMaintenance: async () => { enters++; started(); await draining; },
      exitMaintenance: () => { exits++; },
    });
    const vfs = s.enterMaintenance(['vfs']);
    await ready;
    const chat = s.enterMaintenance(['chat_v2']);
    finish();
    const [vfsLease, chatLease] = await Promise.all([vfs, chat]);
    expect(enters).toBe(1);
    vfsLease.release();
    expect(exits).toBe(0);
    chatLease.release();
    expect(exits).toBe(1);
    s.dispose();
  });

  it('registers as ctx.storage on Cordis and closes connections on dispose', async () => {
    const ctx = new Context();
    (ctx as unknown as { app: unknown }).app = { dataDir: base, version: 't', platform: 'darwin', debug: true };
    const svc = new StorageCordisService(ctx, { dataLocalDir: base });
    expect(ctx.storage.database('llm_usage').pluck('SELECT 1')).toBe(1);
    expect(svc.impl.locations.activeSlot).toBe('slotA');
    let ran = false;
    ctx.storage.registerFinalizer('wired', () => { ran = true; });
    expect(ctx.storage.finalizerNames()).toEqual(['wired']);
    await expect(ctx.storage.runStartupFinalizers()).resolves.toEqual({ completed: ['wired'], skipped: [] });
    expect(ran).toBe(true);

    let participantEntered = false;
    const off = ctx.storage.registerMaintenanceParticipant('wired-worker', {
      databases: ['llm_usage'],
      enterMaintenance: () => { participantEntered = true; },
      exitMaintenance: () => { participantEntered = false; },
    });
    const lease = await ctx.storage.enterMaintenance(['llm_usage']);
    expect(participantEntered).toBe(true);
    lease.release();
    expect(participantEntered).toBe(false);
    off();
  });
});
