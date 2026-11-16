import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import cryptoMobile from '../../crypto/mobile.ts';
import { createOpfsFiles, mobileRoots } from '../../files/opfs.ts';
import { createFakeOpfs } from '../../files/tests/__fixtures__/fake-opfs.ts';
import logMobile from '../../log/mobile.ts';
import pathsMobile from '../../paths/mobile.ts';
import secretsMobile from '../../secrets/mobile.ts';
import type { CoordinatedDatabaseName, SqlParam } from '../../storage/api.ts';
import { bindArgs, planParams } from '../../storage/params.ts';
import { saveMobileAuditEntry } from '../audit.ts';
import storageMobile from '../index.ts';
import type { SqliteDatabase, SqliteModule, SqliteRuntime, SqliteStatement } from '../sqlite-wasm.ts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

function loadCoreMigrations(): Record<CoordinatedDatabaseName, Record<string, string>> {
  const out = { vfs: {}, chat_v2: {}, mistakes: {}, llm_usage: {} } as Record<CoordinatedDatabaseName, Record<string, string>>;
  for (const db of Object.keys(out) as CoordinatedDatabaseName[]) {
    const dir = join(REPO, 'resources/app/migrations', db);
    for (const name of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      out[db][name] = readFileSync(join(dir, name), 'utf8');
    }
  }
  return out;
}

function createBetterSqliteRuntime(tempDir: string): SqliteRuntime {
  const pathMap = new Map<string, string>();
  let nextPtr = 1;
  const dbMap = new Map<number, { raw: Database.Database; lastRowId: number }>();
  const stmtMap = new Map<number, { stmt: Database.Statement; rows: unknown[][] | null; rowIdx: number }>();
  const toReal = (virtualPath: string): string => {
    let real = pathMap.get(virtualPath);
    if (!real) {
      real = join(tempDir, `${pathMap.size}_${virtualPath.replace(/[^A-Za-z0-9._-]/g, '_')}`);
      pathMap.set(virtualPath, real);
    }
    return real;
  };
  const wrapDb = (raw: Database.Database, filename: string): SqliteDatabase => {
    let open = true;
    const dbPtr = nextPtr++;
    const dbState = { raw, lastRowId: 0 };
    dbMap.set(dbPtr, dbState);
    return {
      get pointer() { return open ? dbPtr : undefined; },
      filename,
      exec: (sql: string) => {
        const vacuum = /^VACUUM INTO '([^']+)'$/i.exec(sql.trim());
        if (vacuum) {
          raw.exec(`VACUUM INTO '${toReal(vacuum[1]!.replaceAll("''", "'")).replaceAll("'", "''")}'`);
          return;
        }
        raw.exec(sql);
      },
      prepare: (sql: string): SqliteStatement => {
        const stmt = raw.prepare(sql);
        const plan = planParams(sql);
        const binds: SqlParam[] = [];
        const sPtr = nextPtr++;
        const state: { stmt: Database.Statement; rows: unknown[][] | null; rowIdx: number } = { stmt, rows: null, rowIdx: -1 };
        stmtMap.set(sPtr, state);
        const colCount = () => stmt.reader ? stmt.columns().length : 0;
        return {
          pointer: sPtr,
          get columnCount() { return colCount(); },
          get parameterCount() { return plan.count; },
          bind(index: number, value) { binds[index - 1] = value as SqlParam; return this; },
          clearBindings() { binds.length = 0; return this; },
          step() {
            const args = plan.count === 0 ? [] : bindArgs(plan, binds.slice(0, plan.count));
            if (!stmt.reader) {
              const info = stmt.run(...args);
              dbState.lastRowId = Number(info.lastInsertRowid ?? 0);
              return false;
            }
            if (state.rows === null) {
              state.rows = stmt.raw(true).all(...args) as unknown[][];
              state.rowIdx = 0;
            } else {
              state.rowIdx += 1;
            }
            return state.rowIdx < state.rows.length;
          },
          reset() { state.rows = null; state.rowIdx = -1; return this; },
          finalize() { stmtMap.delete(sPtr); return 0; },
          getColumnName(i: number) { return stmt.columns()[i]!.name; },
          get(i: number) {
            const val = state.rows![state.rowIdx]![i];
            if (Buffer.isBuffer(val)) return new Uint8Array(val);
            return val;
          },
        };
      },
      close() {
        open = false;
        dbMap.delete(dbPtr);
        raw.close();
      },
      changes() { return Number(raw.prepare('SELECT changes() AS c').pluck().get() ?? 0); },
    };
  };
  const cellAt = (sPtr: number, col: number): unknown => {
    const s = stmtMap.get(sPtr);
    return s?.rows?.[s.rowIdx]?.[col];
  };
  const capi = {
    SQLITE_INTEGER: 1,
    SQLITE_FLOAT: 2,
    SQLITE_TEXT: 3,
    SQLITE_BLOB: 4,
    SQLITE_NULL: 5,
    sqlite3_libversion: () => '3.45.0',
    sqlite3_column_type: (sPtr: number, col: number) => {
      const val = cellAt(sPtr, col);
      if (val === null || val === undefined) return 5;
      if (typeof val === 'bigint') return 1;
      if (typeof val === 'number') return Number.isInteger(val) ? 1 : 2;
      if (typeof val === 'string') return 3;
      if (val instanceof Uint8Array || Buffer.isBuffer(val)) return 4;
      return 5;
    },
    sqlite3_column_int64: (sPtr: number, col: number) => {
      const val = cellAt(sPtr, col);
      return typeof val === 'bigint' ? val : BigInt(Math.trunc(Number(val ?? 0)));
    },
    sqlite3_stmt_readonly: (sPtr: number) => (stmtMap.get(sPtr)?.stmt.readonly ? 1 : 0),
    sqlite3_get_autocommit: (dPtr: number) => (dbMap.get(dPtr)?.raw.inTransaction ? 0 : 1),
    sqlite3_last_insert_rowid: (dPtr: number) => dbMap.get(dPtr)?.lastRowId ?? 0,
    sqlite3_errmsg: () => '',
    sqlite3_extended_errcode: () => 0,
    sqlite3_js_rc_str: () => 'SQLITE_OK',
  };
  return {
    sqlite3: { capi, wasm: { heap8u: () => new Uint8Array(0) } } as SqliteModule,
    open: (path: string) => wrapDb(new Database(toReal(path)), path),
    openMemory: () => wrapDb(new Database(':memory:'), ':memory:'),
    exists: (path: string) => {
      const real = pathMap.get(path);
      if (!real) return false;
      try { readFileSync(real); return true; } catch { return false; }
    },
    unlink: (path: string) => {
      const real = pathMap.get(path);
      if (real) {
        try { rmSync(real, { force: true }); } catch { /* ignore */ }
      }
    },
    exportFile: (path: string) => new Uint8Array(readFileSync(toReal(path))),
    migrations: loadCoreMigrations(),
  };
}

describe('storage-mobile commands', () => {
  it('registers all declared commands and implements audit query/cleanup, unified export, and OPFS file ops', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dstu-storage-mobile-cmd-'));
    const host = await createTestHost({
      app: { dataDir: '/deep-student', platform: 'linux', version: '0.20.1' },
      shell: async (op) => {
        if (op === 'mobile:legacy-databases') return null;
        if (op === 'mobile:save-backup') return { method: 'download' };
        throw new Error(`unexpected shell op ${op}`);
      },
    });
    try {
      const files = createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots('/deep-student') });
      host.ctx.reflect.provide('files', files);
      host.ctx.reflect.provide('sqliteRuntime', createBetterSqliteRuntime(tmpDir));
      await host.install(cryptoMobile);
      await host.install(pathsMobile);
      await host.install(logMobile);
      await host.install(secretsMobile);
      await host.install(storageMobile);

      const coverage = host.coverage();
      expect(coverage.declaredNotRegistered).toEqual([]);
      expect(coverage.registeredNotDeclared).toEqual([]);
      const maint = await host.invoke<{ is_in_maintenance_mode: boolean }>('data_governance_get_maintenance_status');
      expect(maint.is_in_maintenance_mode, JSON.stringify(maint)).toBe(false);

      // 1. App info & OPFS file ops
      expect(await host.invoke('get_app_data_dir')).toBe('/deep-student');
      expect(await host.invoke('get_app_version')).toBe('0.20.1');

      const txtPath = '/deep-student/local/hello.txt';
      const copyPath = '/deep-student/local/hello-copy.txt';
      expect(await host.invoke('save_text_to_file', { path: txtPath, content: '你好 mobile' })).toBeNull();
      expect(await host.invoke('read_file_text', { path: txtPath })).toBe('你好 mobile');
      const expectedBytes = new TextEncoder().encode('你好 mobile');
      expect(await host.invoke('get_file_size', { path: txtPath })).toBe(expectedBytes.byteLength);
      const readRaw = await host.invoke<Uint8Array>('read_file_bytes', { path: txtPath });
      expect(readRaw).toEqual(expectedBytes);
      const hash = await host.invoke<string>('hash_file', { path: txtPath });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      expect(await host.invoke('copy_file', { sourcePath: txtPath, destPath: copyPath })).toBeNull();
      expect(await host.invoke('hash_file', { path: copyPath })).toBe(hash);
      await expect(host.invoke('copy_file', { sourcePath: txtPath, destPath: txtPath })).rejects.toMatchObject({ error_type: 'Validation' });
      await expect(host.invoke('read_file_text', { path: '/etc/passwd' })).rejects.toMatchObject({ error_type: 'Validation' });

      // Invalid UTF-8 rejected in read_file_text
      await files.writeBytes('/deep-student/local/bad-utf8.bin', new Uint8Array([0xff, 0xfe]), { createParents: true });
      await expect(host.invoke('read_file_text', { path: '/deep-student/local/bad-utf8.bin' })).rejects.toMatchObject({ error_type: 'FileSystem' });

      // 2. Audit log query + cleanup (backup/verify/cancel/delete coverage lives in upstream's backup tests)
      saveMobileAuditEntry(host.ctx.storage.database('audit'), {
        id: 'audit-1',
        operationType: 'Backup',
        operationData: { type: 'Backup', backup_type: 'Auto', file_count: 1, total_size: 0 },
        target: 'auto_verify/backup-x',
        status: 'Completed',
        durationMs: 1,
        details: null,
        errorMessage: null,
      });
      const auditPage = await host.invoke<{ logs: Array<{ operation_type: string }>; total: number }>('data_governance_get_audit_logs', {});
      expect(auditPage.total).toBeGreaterThanOrEqual(1);
      const token = `AUDIT_CLEANUP_${Math.floor(Date.now() / 1000)}`;
      const cleanedCount = await host.invoke<number>('data_governance_cleanup_audit_logs', {
        keepRecent: 100,
        confirmationToken: token,
      });
      expect(cleanedCount).toBe(0);
      await expect(host.invoke('data_governance_cleanup_audit_logs', {
        keepRecent: 10,
        confirmationToken: token,
      })).rejects.toContain('keep_recent');

      // 3. Unified backup export      // 9. Unified backup export
      host.ctx.storage.database('mistakes').run(
        'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)',
        ['ui.lang', '"zh"', '2026-01-01T00:00:00Z'],
      );
      host.ctx.reflect.provide('llm', {
        getApiConfigs: async () => [{ id: 'cfg-1', provider: 'deepseek' }],
        getModelAssignments: async () => ({ chat: 'cfg-1' }),
      } as never);
      const unified = await host.invoke<{ version: string; traditional_data: { settings: { system_settings: Record<string, string>; api_configurations: unknown[] } } }>(
        'export_unified_backup_data',
        { options: { include_settings: true } },
      );
      expect(unified.version).toBe('3.0');
      expect(unified.traditional_data.settings.system_settings['ui.lang']).toBe('"zh"');
      expect(unified.traditional_data.settings.api_configurations).toEqual([{ id: 'cfg-1', provider: 'deepseek' }]);
    } finally {
      await host.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
