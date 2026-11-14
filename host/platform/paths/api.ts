/**
 * `ctx.paths`：应用目录与文件布局（F4）。全部从 `AppInfo.dataDir`（= Tauri `app_data_dir()`）
 * 与操作系统目录推导，与 Rust 版逐项一致，引用见 host/platform/API.md「paths」。
 *
 * 三个根：
 * - **base** = `AppInfo.dataDir`（`src-tauri/src/lib.rs:855`）。
 * - **slot** = 活动数据槽 `base/slots/slot{A|B}`（`dstu-storage/src/data_space.rs:1005-1019,1651-1675`）。
 *   活动槽只由 F3 `ctx.storage.locations.activeDir` 解析（`read_state` 的 .tmp 恢复与目录推断都在那里），
 *   paths 不提供第二份解析。
 * - **log** = Tauri `app_log_dir()`：macOS `~/Library/Logs/<id>`，Windows/Linux
 *   `<data_local_dir>/<id>/logs`（`tauri-2.11.5/src/path/desktop.rs:278-290`），**不在 base 下**。
 *
 * `<id>` = bundle identifier（`tauri.conf.json` 为 `com.deepstudent.app`）：外壳写入的 `DS_APP_IDENTIFIER` 优先，
 * 缺省或不合法时取 `basename(dataDir)`（`DS_APP_DATA_DIR` 隔离时二者不同）。
 */

export type DataSlot = 'slotA' | 'slotB' | 'slotC' | 'slotD';

/**
 * `dirs` 4.0 / Tauri 的操作系统目录（Rust `dirs::*`），Host 内唯一实现见 `os-dirs.ts`。
 * 外壳经 `DS_SHELL_OS_DIRS` 传入的值（Windows 为 Known Folder）优先于环境变量推导。
 */
export interface OsDirs {
  /** `dirs::home_dir()`。 */
  readonly home: string;
  /** `dirs::data_dir()`：macOS `~/Library/Application Support`，Windows `%APPDATA%`，Linux `$XDG_DATA_HOME|~/.local/share`。 */
  readonly data: string;
  /** `dirs::data_local_dir()`：Windows `%LOCALAPPDATA%`，其余同 data。 */
  readonly dataLocal: string;
  /** `dirs::config_dir()`：macOS 同 data，Windows `%APPDATA%`，Linux `$XDG_CONFIG_HOME|~/.config`。 */
  readonly config: string;
  /** `dirs::cache_dir()`：macOS `~/Library/Caches`，Windows `%LOCALAPPDATA%`，Linux `$XDG_CACHE_HOME|~/.cache`。 */
  readonly cache: string;
  /** `std::env::temp_dir()`。 */
  readonly temp: string;
  /** `dirs::download_dir()`（无则 null）。 */
  readonly download: string | null;
}

/** 活动槽（slot）内的固定布局。参数 `slotDir` 通常是 `ctx.storage.locations.activeDir`。 */
export interface SlotLayout {
  /** `mistakes.db`（主库，含 `settings` 表）。 */
  mainDatabase(slotDir: string): string;
  /** `databases/vfs.db`。 */
  vfsDatabase(slotDir: string): string;
  /** `databases/audit.db`。 */
  auditDatabase(slotDir: string): string;
  chatV2Database(slotDir: string): string;
  llmUsageDatabase(slotDir: string): string;
  browserDatabase(slotDir: string): string;
  /** `.secure`：主库 SecureStore（API Key 等，`Database::new` 用 `db_path.parent()`）。 */
  secureDir(slotDir: string): string;
  /** `.master_key`：CryptoService 主密钥（`lib.rs:3555`、`llm_manager/mod.rs:4757`）。 */
  masterKeyFile(slotDir: string): string;
  /** 相对槽目录的子路径（`images`、`vfs_blobs`、`workspaces` 等，见 API.md 表格）。 */
  join(slotDir: string, ...segments: string[]): string;
}

export interface PathsService {
  /** bundle identifier（`DS_APP_IDENTIFIER`，缺省时 `basename(appDataDir)`）。 */
  readonly identifier: string;
  readonly os: OsDirs;

  /** base：Tauri `app_data_dir()`。 */
  readonly appDataDir: string;
  /** Tauri `app_local_data_dir()`。 */
  readonly appLocalDataDir: string;
  /** Tauri `app_config_dir()`。 */
  readonly appConfigDir: string;
  /** Tauri `app_cache_dir()`（`staged_uploads/`、`heic-convert/`）。 */
  readonly appCacheDir: string;
  /** Tauri `app_log_dir()`。 */
  readonly appLogDir: string;

  // ---- base 下的固定路径
  /** `base/slots`。 */
  readonly slotsDir: string;
  /** `base/slots/state.json`。 */
  readonly slotStateFile: string;
  slotDir(slot: DataSlot): string;
  /** `base/recovery/backups`（默认备份目录）。 */
  readonly recoveryBackupsDir: string;
  /** `base/.secure`：云存储凭据 / bilibili / MCP OAuth 的 SecureStore。 */
  readonly baseSecureDir: string;
  /** `base/.device_id`（设备身份主路径）。 */
  readonly deviceIdFile: string;
  /** `.device_id` 的旧路径（按 Rust 查找顺序，不含主路径）。 */
  readonly legacyDeviceIdFiles: readonly string[];
  /** 相对 base 的子路径。 */
  baseJoin(...segments: string[]): string;

  // ---- 日志
  /** `log/deep-student.log`（主日志）。 */
  readonly mainLogFile: string;
  /** `log/crash`。 */
  readonly crashLogDir: string;
  /** `log/debug-logs`。 */
  readonly debugLogsDir: string;
  /** `log/{frontend,backend,debug}`。 */
  structuredLogDir(kind: 'frontend' | 'backend' | 'debug'): string;
  /** 调试日志读取根：`[log, base, base/slots/slotA, base/slots/slotB]` 排序去重（`commands.rs:585-598`）。 */
  readonly debugLogRoots: readonly string[];

  // ---- 外部固定位置
  /** `dirs::data_local_dir()/deep-student/.secure`（`SecureStore::new()` 回退目录）。 */
  readonly fallbackSecureDir: string;
  /** `sync_state.db` 的路径（`dstu-sync/.../sync/state.rs:23-29`，不在 base 下）。 */
  readonly syncStateDatabase: string;

  readonly slot: SlotLayout;

  // ---- 设备身份（`dstu-storage/src/data_space/device_id.rs`；应用层包装见 `data_governance/commands_sync.rs:1197`）
  /**
   * `data_governance/commands_sync.rs::get_device_id()` 的旧根优先包装：
   * 先兼容读取旧位置 `base/device_id`（非空即原样返回并写回 `DEVICE_ID`，
   * 主路径不存在时同时迁移到 `base/.device_id`）；否则委托底层权威语义。
   * L20 data_governance 命令继续使用本方法。
   */
  deviceId(): Promise<string>;
  /**
   * `dstu-storage/src/data_space/device_id.rs::get_device_id()` 的底层权威语义：
   * `DEVICE_ID` 环境变量 → 主路径 `base/.device_id` → 旧路径（`base/device_id`、
   * data_local/config/home 下 `deep-student/.device_id`，命中即迁移）→ 生成并写主路径。
   * L23/L11 等需要与 Rust 底层身份一致的消费方使用本方法，不得复制身份算法。
   */
  dataSpaceDeviceId(): Promise<string>;
  /** `normalize_device_id`：合法（≤128、[A-Za-z0-9._-]、非 `.`/`..`）原样，否则 `device-<sha256 hex>`。 */
  normalizeDeviceId(id: string): string;
  /** `device_id_short_hash`：SHA-256 hex 前 16 位。 */
  deviceIdShortHash(id: string): string;
  /** `generate_device_id_after_restore`：`<hostname>-<uuid 前 8 位>`（规范化）。 */
  generateDeviceIdAfterRestore(): string;
  /** `persist_device_id_after_restore`：写主路径并刷新已存在的旧副本，然后设置 `process.env.DEVICE_ID`。 */
  persistDeviceIdAfterRestore(newId: string): Promise<void>;
  /** `rotate_device_id_after_restore`：返回 `[旧, 新]`。 */
  rotateDeviceIdAfterRestore(): Promise<readonly [string, string]>;
}

// 必须引入 Context 才能合并到 cordis 重导出的 Context（而不是新建同名接口）。
import type { Context } from '@deepseek-ai/cordis';
export type { Context };

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** F4：应用路径。 */
    paths: PathsService;
  }
}
export { sanitize_unicode, safe_truncate, safe_truncate_chars, preview_with_ellipsis } from './text.ts';
