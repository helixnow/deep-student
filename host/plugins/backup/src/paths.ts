import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { PathFlavor } from '../../../platform/files/api.ts';
import { isWithin, parseAbsolute, relativePath } from '../../../platform/files/path.ts';
import type { PathsService } from '../../../platform/paths/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { CoordinatedId } from './migrations.ts';
import { latestVersion, pendingCount } from './migrations.ts';

/** `get_backup_dir` / `backup_config::default_recovery_backup_dir`。 */
export function backupDir(baseDir: string): string {
  const parent = dirname(baseDir);
  const base = basename(parent) === 'slots' ? dirname(parent) : baseDir;
  return join(base, 'recovery', 'backups');
}

/** `resolve_database_path` / `MigrationCoordinator::get_database_path`。 */
export function databasePath(activeDir: string, id: CoordinatedId): string {
  switch (id) {
    case 'vfs': return join(activeDir, 'databases', 'vfs.db');
    case 'chat_v2': return join(activeDir, 'chat_v2.db');
    case 'mistakes': return join(activeDir, 'mistakes.db');
    case 'llm_usage': return join(activeDir, 'llm_usage.db');
  }
}

/** `classify_recovery_kind` 的稳定字符串。 */
export const RECOVERY_KIND_DISASTER = 'disaster_recovery';
export const RECOVERY_KIND_PARTIAL_ARCHIVE = 'partial_archive';

export const BACKUP_DIR_MISSING_CODE = 'E_BACKUP_DIR_MISSING';
export const RESTORE_DISK_BUDGET_OVERFLOW_CODE = 'E_RESTORE_DISK_BUDGET_OVERFLOW';

/** `backup_dir_missing_error`。 */
export function backupDirMissingError(): string {
  return `[${BACKUP_DIR_MISSING_CODE}] 备份目录不存在。请前往「设置 > 数据治理 > 备份」检查备份目录配置`;
}

/** `checked_restore_disk_budget`：u64 checked arithmetic；溢出返回稳定码错误。 */
export function checkedRestoreDiskBudget(
  fileSizes: Iterable<number | bigint>,
  assetSize: number | bigint,
): { backupSize: bigint; requiredBytes: bigint } {
  const MAX = (1n << 64n) - 1n;
  let filesSize = 0n;
  for (const size of fileSizes) {
    filesSize += BigInt(size);
    if (filesSize > MAX) {
      throw new Error(`[${RESTORE_DISK_BUDGET_OVERFLOW_CODE}] 恢复备份文件大小统计溢出，已拒绝继续`);
    }
  }
  const backupSize = filesSize + BigInt(assetSize);
  if (backupSize > MAX) {
    throw new Error(`[${RESTORE_DISK_BUDGET_OVERFLOW_CODE}] 恢复备份总大小统计溢出，已拒绝继续`);
  }
  const requiredBytes = backupSize * 2n;
  if (requiredBytes > MAX) {
    throw new Error(`[${RESTORE_DISK_BUDGET_OVERFLOW_CODE}] 恢复磁盘预算计算溢出，已拒绝继续`);
  }
  return { backupSize, requiredBytes };
}

/**
 * `dirs::home_dir()`：取 `ctx.paths.os.home`（外壳设置 `DS_APP_DATA_DIR` 时已隔离），
 * 不读进程 `$HOME`；`paths` 不可用时视同 Rust 的 `None`。
 */
export function userHomeDir(ctx: Context): string | null {
  return (ctx.reflect.get('paths') as Partial<PathsService> | undefined)?.os?.home || null;
}

/** 主目录（或路径本身）带盘符 / UNC 根时按 Windows 规则处理。 */
function pathFlavorOf(sample: string): PathFlavor {
  return !sample.startsWith('/') && parseAbsolute(sample, 'win32').parsed !== null ? 'win32' : 'posix';
}

/** `sanitize_path_for_user`：用户主目录（{@link userHomeDir}）内的路径替换为 `~/…`，否则只保留最后两级。 */
// RUST-FIX(RF-W08-sanitize-path-component-match): Rust 用字符串前缀判断主目录（/Users/ann 命中 /Users/anna）且只按 `/` 切分，Windows 路径原样泄露用户名。
export function sanitizePathForUser(path: string, home: string | null): string {
  const flavor = pathFlavorOf(home || path);
  if (home) {
    const parsedHome = parseAbsolute(home, flavor).parsed;
    const parsedPath = parseAbsolute(path, flavor).parsed;
    if (parsedHome && parsedPath && isWithin(parsedPath, parsedHome, flavor)) {
      return `~/${relativePath(parsedPath, parsedHome)}`;
    }
  }
  const components = path.split(flavor === 'win32' ? /[\\/]/ : '/').filter(s => s.length > 0);
  if (components.length > 2) return `.../${components.slice(-2).join('/')}`;
  return path;
}

/** `validate_user_path`：拒绝 null 字节与 `..` 组件。 */
export function validateUserPath(path: string): void {
  if (path.includes('\0')) throw new Error('路径中不允许包含 null 字节');
  for (const component of path.split(/[\\/]/)) {
    if (component === '..') throw new Error("路径中不允许包含 '..' 目录遍历");
  }
}

/** `validate_backup_id`。 */
export function validateBackupId(raw: string): string {
  const trimmed = rustTrim(raw);
  if (trimmed.length === 0) throw new Error('backup_id 不能为空');
  let decoded: string;
  try { decoded = decodeURIComponent(trimmed); }
  catch (e) { throw new Error(`backup_id 编码非法: ${e instanceof Error ? e.message : String(e)}`); }
  if (decoded !== trimmed) throw new Error('backup_id 不允许包含 URL 编码');
  if (decoded.length > 128) throw new Error('backup_id 长度超限（最大 128）');
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('..') || decoded.startsWith('.')) {
    throw new Error('backup_id 包含非法路径片段');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(decoded)) throw new Error('backup_id 包含非法字符');
  return decoded;
}

/** `ensure_existing_path_within_backup_dir`。 */
export function ensureExistingPathWithinBackupDir(path: string, dir: string, home: string | null): void {
  let canonicalDir: string;
  try { canonicalDir = realpathSync(dir); }
  catch (e) { throw new Error(`解析备份根目录失败: ${ioMessageLike(e)}`); }
  let canonicalPath: string;
  try { canonicalPath = realpathSync(path); }
  catch (e) { throw new Error(`解析备份路径失败: ${ioMessageLike(e)}`); }
  if (canonicalPath !== canonicalDir && !canonicalPath.startsWith(canonicalDir + sep)) {
    throw new Error(`备份路径越界: ${sanitizePathForUser(canonicalPath, home)}。请确认路径在备份目录内，或前往「设置 > 数据治理」重新选择备份目录`);
  }
}

function ioMessageLike(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CHAT_V2_PREFIX_TABLES = new Set(['workspace_index', 'sleep_block', 'subagent_task']);
const MISTAKES_TABLES = new Set([
  'mistakes', 'chat_messages', 'temp_sessions', 'review_analyses', 'review_chat_messages',
  'review_sessions', 'review_session_mistakes', 'settings', 'rag_configurations', 'document_tasks',
  'anki_cards', 'custom_anki_templates', 'document_control_states', 'vectorized_data',
  'rag_sub_libraries', 'search_logs', 'exam_sheet_sessions', 'migration_progress',
]);
const VFS_TABLES = new Set([
  'blobs', 'notes', 'files', 'exam_sheets', 'translations', 'essays', 'essay_sessions', 'folders',
  'folder_items', 'path_cache', 'mindmaps', 'questions', 'question_history', 'question_bank_stats',
  'review_plans', 'review_history', 'review_stats', 'mastery_events', 'mastery_states',
]);
const LLM_USAGE_TABLES = new Set(['llm_usage_logs', 'llm_usage_daily']);

/** `infer_database_from_table`：legacy 无 database_name 的变更路由。 */
export function inferDatabaseFromTable(tableName: string): 'chat_v2' | 'mistakes' | 'vfs' | 'llm_usage' | null {
  if (tableName.startsWith('chat_v2_')) return 'chat_v2';
  if (CHAT_V2_PREFIX_TABLES.has(tableName)) return 'chat_v2';
  if (tableName === 'resources') return null;
  if (MISTAKES_TABLES.has(tableName)) return 'mistakes';
  if (VFS_TABLES.has(tableName)) return 'vfs';
  if (LLM_USAGE_TABLES.has(tableName)) return 'llm_usage';
  return null;
}

/** `resolve_target_and_pending`（commands.rs:40）。 */
export function resolveTargetAndPending(
  id: CoordinatedId,
  currentVersion: number,
  status: { max_compatible_version: number } | undefined,
): { targetVersion: number; pendingCount: number } {
  const targetVersion = status ? status.max_compatible_version : latestVersion(id);
  return { targetVersion, pendingCount: pendingCount(id, currentVersion) };
}

/** `DatabaseId::all_ordered().len()`。 */
export const TOTAL_DATABASES = 4;

/** 数据库文件是否存在（Rust `path.exists()`）。 */
export function databaseFileExists(activeDir: string, id: CoordinatedId): boolean {
  const path = databasePath(activeDir, id);
  return existsSync(path) && statSync(path).isFile();
}
