/**
 * 迁移诊断 Slot C/D 的免 fsync 连接设置只落在一次性测试槽上；用户库（PROFILES、slotA/slotB 的迁移）保持原样。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMigrationWorker, type MigrationWorker } from '../node.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';
import { PROFILES, diagnosticSandboxProfile, isDiagnosticSandboxDir } from '../profiles.ts';
import { setStorageLogger } from '../logging.ts';

interface OpenedConnection { path: string; synchronous: unknown; journalMode: unknown }
const opened = vi.hoisted(() => [] as OpenedConnection[]);

vi.mock('../connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../connection.ts')>();
  class RecordingConnection extends actual.Connection {
    constructor(...args: ConstructorParameters<typeof actual.Connection>) {
      super(...args);
      opened.push({
        path: args[0],
        synchronous: this.raw.pragma('synchronous', { simple: true }),
        journalMode: this.raw.pragma('journal_mode', { simple: true }),
      });
    }
  }
  return { ...actual, Connection: RecordingConnection };
});

const SQLITE_SYNCHRONOUS_OFF = 0;
const SQLITE_SYNCHRONOUS_FULL = 2;

let base: string | undefined;
let worker: MigrationWorker | undefined;
afterEach(async () => {
  await worker?.close(); worker = undefined;
  setStorageLogger(null);
  opened.splice(0);
  if (base) fs.rmSync(base, { recursive: true, force: true });
  base = undefined;
});

function slotsRoot(): string {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'w07-sandbox-profile-'));
  return path.join(base, 'slots');
}

function databaseFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.db')).sort();
}

describe('diagnostic sandbox connection profile', () => {
  it('leaves every user-database profile exactly as ported from Rust', () => {
    expect(PROFILES).toEqual({
      mistakes: { foreignKeys: true, journalMode: 'WAL', synchronous: 'FULL', busyTimeoutMs: 3000 },
      vfs: { foreignKeys: true, journalMode: 'WAL', synchronous: 'NORMAL', busyTimeoutMs: 5000 },
      chat_v2: { foreignKeys: true, journalMode: 'WAL', synchronous: 'NORMAL', busyTimeoutMs: 10_000, autoVacuum: 'INCREMENTAL' },
      llm_usage: { foreignKeys: true, journalMode: 'WAL', synchronous: 'NORMAL', busyTimeoutMs: 3000 },
      audit: { synchronous: 'FULL', busyTimeoutMs: 5000 },
      browser: { foreignKeys: true, journalMode: 'WAL', synchronous: 'NORMAL', busyTimeoutMs: 3000 },
      sync_state: { synchronous: 'FULL', busyTimeoutMs: 5000 },
      workspace: { foreignKeys: true, journalMode: 'WAL', synchronous: 'FULL', busyTimeoutMs: 5000 },
      plain: { synchronous: 'FULL', busyTimeoutMs: 5000 },
    });
  });

  it('is only handed out for slots/slotC and slots/slotD', () => {
    for (const dir of ['/data/slots/slotC', '/data/slots/slotD/', 'C:\\Users\\a\\AppData\\deep-student\\slots\\slotD']) {
      expect(isDiagnosticSandboxDir(dir), dir).toBe(true);
      expect(diagnosticSandboxProfile(dir)).toEqual({ synchronous: 'OFF', journalMode: 'MEMORY', busyTimeoutMs: 5000 });
    }
    for (const dir of ['/data/slots/slotA', '/data/slots/slotB', '/data/slotC', '/data/slots/slotC/databases', '/data/slots/slotCC', 'slotD', '']) {
      expect(isDiagnosticSandboxDir(dir), dir).toBe(false);
      expect(() => diagnosticSandboxProfile(dir), dir).toThrow('拒绝对非诊断测试槽目录使用免 fsync 的连接设置');
    }
    expect(Object.isFrozen(diagnosticSandboxProfile('/data/slots/slotC'))).toBe(true);
  });

  it('RF-W07-diagnostic-sandbox-no-fsync: a user-slot migration still opens every database with synchronous=FULL and a file journal', async () => {
    const dir = path.join(slotsRoot(), 'slotA');
    const coordinator = new MigrationCoordinator({ appDataDir: dir, auditDbPath: null });
    expect(coordinator.connectionProfile).toBe(PROFILES.plain);

    const report = await coordinator.runAll();

    expect(report.success, report.error ?? '').toBe(true);
    const files = opened.filter((connection) => connection.path !== ':memory:');
    expect(new Set(files.map((connection) => path.relative(dir, connection.path)))).toEqual(new Set(['chat_v2.db', 'mistakes.db', 'llm_usage.db', path.join('databases', 'vfs.db')]));
    for (const connection of files) {
      expect(connection.synchronous, connection.path).toBe(SQLITE_SYNCHRONOUS_FULL);
      expect(connection.journalMode, connection.path).not.toBe('memory');
    }
  });

  it('RF-W07-diagnostic-sandbox-no-fsync: a Slot C diagnostic migration opens its databases without fsync and still migrates every database', async () => {
    const dir = path.join(slotsRoot(), 'slotC');
    const coordinator = new MigrationCoordinator({ appDataDir: dir, auditDbPath: null, diagnosticSandbox: true });

    const report = await coordinator.runAll();

    expect(report.success, report.error ?? '').toBe(true);
    expect(report.databases.every((database) => database.success && database.toVersion > 0)).toBe(true);
    const databases = new Set(report.databases.map((database) => coordinator.getDatabasePath(database.id)));
    const sandboxConnections = opened.filter((connection) => databases.has(connection.path));
    expect(new Set(sandboxConnections.map((connection) => connection.path))).toEqual(databases);
    for (const connection of sandboxConnections) {
      expect(connection.synchronous, connection.path).toBe(SQLITE_SYNCHRONOUS_OFF);
      expect(connection.journalMode, connection.path).toBe('memory');
    }
  });

  it('refuses the sandbox flag for a user slot before opening anything', () => {
    const dir = path.join(slotsRoot(), 'slotB');

    expect(() => new MigrationCoordinator({ appDataDir: dir, auditDbPath: null, diagnosticSandbox: true }))
      .toThrow(`拒绝对非诊断测试槽目录使用免 fsync 的连接设置: ${dir}`);
    expect(opened).toEqual([]);
    expect(databaseFiles(dir)).toEqual([]);
  });

  it('the migration worker carries the flag to the coordinator thread and keeps the guard there', async () => {
    const root = slotsRoot();
    worker = createMigrationWorker({ baseDir: base! });

    await expect(worker.runAll({ appDataDir: path.join(root, 'slotA'), auditDbPath: null, diagnosticSandbox: true }))
      .rejects.toThrow('拒绝对非诊断测试槽目录使用免 fsync 的连接设置');
    expect(databaseFiles(path.join(root, 'slotA'))).toEqual([]);

    const sandbox = path.join(root, 'slotD');
    const report = await worker.runAll({ appDataDir: sandbox, auditDbPath: null, diagnosticSandbox: true });
    expect(report.success, report.error ?? '').toBe(true);
    expect(databaseFiles(sandbox)).toEqual(['chat_v2.db', 'databases/vfs.db', 'llm_usage.db', 'mistakes.db'].map((name) => name.split('/').join(path.sep)).sort());
  });
});
