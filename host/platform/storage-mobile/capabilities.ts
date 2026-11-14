/**
 * 移动端能力清单：`ctx.storage` 部分。
 *
 * 每条能力有稳定 id。`unsupported` 的能力在调用时抛 `StorageError('UNSUPPORTED_ON_PLATFORM')`，
 * 错误的 `capability` 字段与这里的 id 相同，消息以 `UNSUPPORTED_ON_PLATFORM: <id>` 开头（前端据此识别）；
 * `partial` 表示可用但与桌面有已知差异。移动端外壳汇总各服务的清单（`mobile/src/capabilities.ts`）。
 * 这些是平台差异，不是 Rust 行为偏离，不进 `rust-fixes/` 登记。
 */

export type CapabilityStatus = 'supported' | 'partial' | 'unsupported';

export interface PlatformCapability {
  readonly id: string;
  readonly status: CapabilityStatus;
  /** 与桌面的差异或不支持的原因。 */
  readonly note: string;
}

export const MOBILE_PLATFORM = 'mobile';

export const STORAGE_BROWSER_DATABASE = 'storage.database.browser';

export const MOBILE_STORAGE_CAPABILITIES: readonly PlatformCapability[] = [
  { id: 'storage.database.core', status: 'supported', note: 'mistakes / vfs / chat_v2 / llm_usage：与桌面相同的迁移 SQL 与 refinery 历史；audit / sync_state 按桌面相对布局打开' },
  { id: 'storage.openFile', status: 'supported', note: '路径是 OPFS pool 内的虚拟 POSIX 路径；每个库文件只有一条连接：指向注册库时与注册句柄共用连接（profile 以注册库为准），同一文件已被 openFile 打开时抛 BUSY' },
  { id: 'storage.batchArchiveOldMistakes', status: 'supported', note: '与桌面同一实现（batch-operations.ts）' },
  { id: 'storage.batchCleanupOrphanedMessages', status: 'supported', note: '与桌面同一实现（batch-operations.ts）' },
  { id: 'storage.maintenance', status: 'supported', note: '维护屏障、参与者、启动 finalizer 与桌面语义相同' },
  { id: 'storage.backupTo', status: 'partial', note: 'WASM 包未导出在线备份 API，用 VACUUM INTO 生成一致快照（结果是紧凑后的库文件）' },
  { id: 'storage.migrations.schemaFingerprint', status: 'partial', note: '迁移后不写 __governance_schema_fingerprints（fingerprint.ts 依赖 better-sqlite3 / node:crypto）' },
  { id: 'storage.migrations.legacyRepair', status: 'partial', note: '只对新库建库；旧库的基线对齐、checksum 修复、ALTER 列安全重放未移植' },
  { id: 'storage.dataSpace', status: 'unsupported', note: '固定活动槽 slotA，不提供 dataSpace 服务（无槽切换 / 恢复切换）' },
  { id: STORAGE_BROWSER_DATABASE, status: 'unsupported', note: 'browser 库及其迁移只随桌面打包（浏览器自动化插件仅桌面）；database("browser") 抛 UNSUPPORTED_ON_PLATFORM' },
];
