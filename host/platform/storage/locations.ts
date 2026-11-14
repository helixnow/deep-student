/**
 * 数据空间槽解析与各注册库的文件位置。
 *
 * 移植 `dstu-storage/src/data_space.rs` 中决定活动目录的部分：`read_state`（state.json →
 * state.json.tmp → 目录推断，并把恢复/推断结果写回）、`infer_active_slot_from_dirs`、
 * `dir_has_data`、`dir_latest_mtime`、`write_state`/`atomic_write_state_file`、`active_slot`。
 * 启动期的 `initialize_on_start`（pending 切换、恢复租约、密钥发布收敛）、旧版根目录迁移与
 * 恢复事件不在这里（见 TESTMAP.md「remaining」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveOsDirs } from '../paths/os-dirs.ts';
import { renameSyncWithRetry } from './data-space-files.ts';
import { decodeUtf8Strict, utf8ErrorMessage } from '../util/portable.ts';
import type { CoordinatedDatabaseName, DatabaseName, StorageLocations } from './api.ts';
import { databaseLocation } from './database-layout.ts';
import { storageLog } from './logging.ts';

const LOG_TARGET = 'dstu_storage::data_space';

export type SlotName = 'slotA' | 'slotB' | 'slotC' | 'slotD';

/**
 * 旧版根目录扫描忽略的条目：`slots`/`logs`/`recovery`/清理标记（Rust
 * `legacy_root_entry_names`、`ensure_layout` 的同一列表），以及 F4 安全工件。
 *
 * F4 secrets 在 Host 插件装配期就会创建 `<base>/.secure`（`SecureStore::new_with_dir`），
 * 而 Rust 的 `prepare_startup_recovery`/`ensure_layout`（lib.rs:933）早于安全存储构造，
 * 预检时这些路径还不存在。它们不属于数据时间线，不能触发旧版迁移或恢复事件。
 * RUST-FIX(RF-W07-legacy-root-security-entries-copy): 旧版迁移时它们留在根目录，由 `copyLegacySecurityEntries` 给 slotA 复制一份。
 */
const PLATFORM_SECURITY_ENTRIES: ReadonlySet<string> = new Set([
  '.secure', '.master_key', '.key_seed', '.crypto_restore_journal.json', '.crypto_restore_rollback',
]);

/** 根目录条目是否属于需要迁移的旧版数据。 */
export function isLegacyRootEntry(name: string): boolean {
  return !['slots', 'logs', 'recovery', '.purge_on_next_start'].includes(name)
    && !PLATFORM_SECURITY_ENTRIES.has(name);
}

export interface RestoreCutoverLease {
  target_slot: string;
  backup_id: string;
  created_at: string;
  activation_committed: boolean;
}

/** 与 Rust `SlotState` 的 serde 形状一致（字段顺序即序列化顺序）。 */
export interface SlotState {
  active: string;
  pending: string | null;
  restore_cutover_pending?: RestoreCutoverLease;
}

/** `Slot::from_name`。 */
export function slotFromName(name: string): SlotName | undefined {
  switch (name) {
    case 'slotA':
    case 'A':
      return 'slotA';
    case 'slotB':
    case 'B':
      return 'slotB';
    case 'slotC':
    case 'C':
      return 'slotC';
    case 'slotD':
    case 'D':
      return 'slotD';
    default:
      return undefined;
  }
}

export class DataSpace {
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  get slotsDir(): string {
    return path.join(this.baseDir, 'slots');
  }

  get statePath(): string {
    return path.join(this.slotsDir, 'state.json');
  }

  slotDir(slot: SlotName): string {
    return path.join(this.slotsDir, slot);
  }

  /**
   * `read_state`：缺失或解析失败依次回退到 .tmp、目录推断，并持久化恢复结果。
   * state.json 存在却读不出来时抛错（启动走恢复外壳），不推断也不覆盖。
   */
  readState(): SlotState {
    const tmpPath = path.join(this.slotsDir, 'state.json.tmp');
    const parsed = readStateFile(this.statePath, true);
    if (parsed !== undefined) return parsed;
    if (fs.existsSync(tmpPath)) {
      const fromTmp = readStateFile(tmpPath);
      if (fromTmp !== undefined) {
        // 回写 state.json；成功后才清理 .tmp（与 Rust 相同：回写失败保留 .tmp）。
        let written = true;
        try {
          this.writeState(fromTmp);
        } catch (error) {
          written = false;
          storageLog(LOG_TARGET, 'warn', `[DataSpace] 恢复后回写 state.json 失败: ${String(error)}`);
        }
        if (written) removeIfExists(tmpPath);
        return fromTmp;
      }
    }
    const inferred = this.inferActiveSlotFromDirs();
    try {
      this.writeState(inferred);
    } catch (error) {
      storageLog(LOG_TARGET, 'warn', `[DataSpace] 推断后写入 state.json 失败: ${String(error)}`);
    }
    return inferred;
  }

  /** `infer_active_slot_from_dirs`。 */
  inferActiveSlotFromDirs(): SlotState {
    const a = this.slotDir('slotA');
    const b = this.slotDir('slotB');
    const aValid = dirHasData(a);
    const bValid = dirHasData(b);
    let active: SlotName;
    if (aValid && !bValid) active = 'slotA';
    else if (!aValid && bValid) active = 'slotB';
    else if (aValid && bValid) active = dirLatestMtime(b) > dirLatestMtime(a) ? 'slotB' : 'slotA';
    else active = 'slotA';
    return { active, pending: null };
  }

  /** `write_state`：`serde_json::to_string_pretty` + 同目录临时文件 fsync 后原子替换 + fsync 目录。 */
  writeState(state: SlotState): void {
    const content = serializeSlotState(state);
    fs.mkdirSync(this.slotsDir, { recursive: true });
    const tmp = path.join(this.slotsDir, `.state-${randomBytes(6).toString('base64url')}.tmp`);
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameSyncWithRetry(tmp, this.statePath);
    if (process.platform !== 'win32') {
      // 替换已完成；目录 fsync 尽力而为，打开或 fsync 失败都忽略（Rust `if let Ok(dir) … let _ = dir.sync_all()`）。
      let dirFd: number;
      try {
        dirFd = fs.openSync(this.slotsDir, 'r');
      } catch {
        return;
      }
      try {
        fs.fsyncSync(dirFd);
      } catch { // boundary-allow empty-catch: data_space.rs:1590 `let _ = dir.sync_all()` ignores the directory fsync result
      } finally {
        fs.closeSync(dirFd);
      }
    }
  }

  /** `active_slot`：只有 `slotB` 映射为 B，其余一律 A；state.json 不可读时抛出 `readState` 的错误。 */
  activeSlot(): SlotName {
    return this.readState().active === 'slotB' ? 'slotB' : 'slotA';
  }

  activeDir(): string {
    return this.slotDir(this.activeSlot());
  }
}

/** serde_json pretty 与 `JSON.stringify(_, null, 2)` 格式一致；`restore_cutover_pending` 为 None 时省略。 */
export function serializeSlotState(state: SlotState): string {
  const out: Record<string, unknown> = { active: state.active, pending: state.pending };
  if (state.restore_cutover_pending !== undefined) {
    const lease = state.restore_cutover_pending;
    out.restore_cutover_pending = {
      target_slot: lease.target_slot,
      backup_id: lease.backup_id,
      created_at: lease.created_at,
      activation_committed: lease.activation_committed,
    };
  }
  return JSON.stringify(out, null, 2);
}

function readStateFile(file: string, failOnUnreadable = false): SlotState | undefined {
  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // RUST-FIX(RF-W07-slot-state-unreadable-no-infer): Rust treats any read error (e.g. a Windows sharing violation) as corruption, then infers the slot from mtimes and overwrites state.json, dropping pending/restore_cutover_pending.
    if (failOnUnreadable && code !== 'ENOENT' && code !== 'EISDIR') {
      throw new Error(`[DataSpace] 读取 ${path.basename(file)} 失败（文件存在但暂时不可读），不按目录推断、不覆盖: ${String(error)}`, { cause: error });
    }
    if (code !== 'ENOENT') {
      storageLog(LOG_TARGET, 'warn', `[DataSpace] 读取 ${path.basename(file)} 失败: ${String(error)}`);
    }
    return undefined;
  }
  // `fs::read_to_string` 对非法 UTF-8 返回 InvalidData：按内容损坏处理（回退 .tmp / 目录推断），不做有损解码。
  if (utf8ErrorMessage(bytes) !== null) {
    storageLog(LOG_TARGET, 'warn', `[DataSpace] 读取 ${path.basename(file)} 失败: stream did not contain valid UTF-8`);
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8Strict(bytes));
  } catch (error) {
    storageLog(LOG_TARGET, 'warn', `[DataSpace] ${path.basename(file)} 内容损坏，解析失败: ${String(error)}`);
    return undefined;
  }
  return parseSlotState(value, path.basename(file));
}

/** 按 serde 规则校验：`active` 必须是字符串，`pending` 为字符串/null/缺省，lease 可缺省。 */
function parseSlotState(value: unknown, source: string): SlotState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    storageLog(LOG_TARGET, 'warn', `[DataSpace] ${source} 不是对象`);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.active !== 'string') {
    storageLog(LOG_TARGET, 'warn', `[DataSpace] ${source} 缺少 active 字段`);
    return undefined;
  }
  const pending = record.pending;
  if (pending !== undefined && pending !== null && typeof pending !== 'string') {
    storageLog(LOG_TARGET, 'warn', `[DataSpace] ${source} pending 字段类型错误`);
    return undefined;
  }
  const state: SlotState = { active: record.active, pending: typeof pending === 'string' ? pending : null };
  const lease = record.restore_cutover_pending;
  if (lease !== undefined && lease !== null) {
    if (typeof lease !== 'object' || Array.isArray(lease)) {
      storageLog(LOG_TARGET, 'warn', `[DataSpace] ${source} restore_cutover_pending 字段类型错误`);
      return undefined;
    }
    const l = lease as Record<string, unknown>;
    if (typeof l.target_slot !== 'string' || typeof l.backup_id !== 'string' || typeof l.created_at !== 'string') {
      storageLog(LOG_TARGET, 'warn', `[DataSpace] ${source} restore_cutover_pending 缺少字段`);
      return undefined;
    }
    const committed = l.activation_committed;
    if (committed !== undefined && typeof committed !== 'boolean') {
      storageLog(LOG_TARGET, 'warn', `[DataSpace] ${source} activation_committed 字段类型错误`);
      return undefined;
    }
    state.restore_cutover_pending = {
      target_slot: l.target_slot,
      backup_id: l.backup_id,
      created_at: l.created_at,
      activation_committed: committed === true,
    };
  }
  return state;
}

/** `dir_has_data`：目录存在且至少有一个条目。 */
export function dirHasData(dir: string): boolean {
  try {
    const handle = fs.opendirSync(dir);
    try {
      return handle.readSync() !== null;
    } finally {
      handle.closeSync();
    }
  } catch {
    return false;
  }
}

/** `dir_latest_mtime`：直接子条目 mtime 的最大值（秒）；读不到为 0。 */
export function dirLatestMtime(dir: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let max = 0;
  for (const name of names) {
    let seconds: number;
    try {
      seconds = Math.floor(fs.lstatSync(path.join(dir, name)).mtimeMs / 1000);
    } catch {
      continue;
    }
    if (seconds > max) max = seconds;
  }
  return max;
}

function removeIfExists(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      storageLog(LOG_TARGET, 'warn', `[DataSpace] 清理旧 state.json.tmp 失败: ${String(error)}`);
    }
  }
}

/**
 * `dirs::data_local_dir()`，由 F4 paths 的 {@link resolveOsDirs} 统一给出（外壳传入的 Known
 * Folder 优先）。Cordis 插件路径直接用 `ctx.paths.os.dataLocal`；这里只服务于未显式传
 * `dataLocalDir` 的独立实例（worker 线程、脚本），保证两边不会各算一套。
 */
export function dataLocalDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const flavour = platform === 'darwin' || platform === 'win32' ? platform : 'linux';
  return resolveOsDirs(flavour, env).dataLocal;
}

export function resolveLocations(baseDir: string, overrides?: { dataLocalDir?: string }): StorageLocations {
  const space = new DataSpace(baseDir);
  const activeSlot = space.activeSlot();
  return {
    baseDir,
    activeSlot,
    activeDir: space.slotDir(activeSlot),
    dataLocalDir: overrides?.dataLocalDir ?? dataLocalDir(),
  };
}

/** 各注册库的文件路径（见 api.ts `DatabaseName` 表；相对布局在 `database-layout.ts`）。 */
export function databasePath(locations: StorageLocations, name: DatabaseName): string {
  const { root, segments } = databaseLocation(name);
  return path.join(root === 'active' ? locations.activeDir : locations.dataLocalDir, ...segments);
}

/** commands_backup.rs::resolve_database_path; no filesystem or slot-state side effects. */
export function coreDatabasePath(activeDir: string, name: CoordinatedDatabaseName): string {
  return path.join(activeDir, ...databaseLocation(name).segments);
}

/**
 * `dstu-sync/src/data_governance/sync/state.rs:22-29` `open_default()` 的路径：
 * `<dataLocalDir>/deep-student/sync/sync_state.db`，**不在**数据空间槽内。
 *
 * L20 的启动期重置提供方必须在 storage 发布前使用同一路径直接打开该库（Rust 的
 * `reset_default_after_local_purge` 也是独立 `open_default()`，不经过存储注册表）。
 */
export function syncStateDatabasePath(dataLocalDir: string): string {
  return path.join(dataLocalDir, ...databaseLocation('sync_state').segments);
}
