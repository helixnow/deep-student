/**
 * 桌面基准：用桌面 `MigrationCoordinator`（better-sqlite3）在临时目录建出四个核心库，输出
 * refinery 历史（version / name / checksum）、完整 sqlite_master，以及每个迁移 SQL 文件的 SHA-256。
 * 移动端端到端测试在 Chromium 里建库后与本输出逐项比较。
 *
 * 用法：`node mobile/scripts/desktop-golden.ts`（在仓库根或任意目录均可；输出 JSON 到 stdout）。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { MigrationCoordinator } from '../../host/platform/storage/migration/coordinator.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../resources/app/migrations/', import.meta.url));
const DATABASES = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const;

const dir = mkdtempSync(join(tmpdir(), 'dstu-mobile-golden-'));
try {
  const coordinator = new MigrationCoordinator({ appDataDir: dir, auditDbPath: null });
  const report = await coordinator.runAll();
  if (!report.success) throw new Error(`desktop migration failed: ${report.error}`);
  const databases: Record<string, { history: unknown[]; schema: unknown[]; pragmas: Record<string, unknown> }> = {};
  for (const name of DATABASES) {
    const db = new BetterSqlite3(coordinator.getDatabasePath(name), { readonly: true });
    try {
      databases[name] = {
        history: db.prepare('SELECT version, name, CAST(checksum AS TEXT) AS checksum FROM refinery_schema_history ORDER BY version').all(),
        schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        pragmas: { page_size: db.pragma('page_size', { simple: true }), journal_mode: db.pragma('journal_mode', { simple: true }) },
      };
    } finally {
      db.close();
    }
  }
  const files: Record<string, string> = {};
  for (const name of DATABASES) {
    for (const file of readdirSync(join(MIGRATIONS_DIR, name)).filter(f => f.endsWith('.sql')).sort()) {
      files[`${name}/${file}`] = createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, name, file))).digest('hex');
    }
  }
  const memory = new BetterSqlite3(':memory:');
  const sqliteVersion = memory.prepare('SELECT sqlite_version()').pluck().get();
  memory.close();
  process.stdout.write(`${JSON.stringify({ sqliteVersion, databases, files })}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
