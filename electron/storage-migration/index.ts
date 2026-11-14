/**
 * Tauri 版 WebView localStorage 迁移（W07）。main 侧编排见 `migration.ts`，preload 侧写入见 `apply.ts`
 * （preload 只能 import `apply.ts`，它不依赖 Node 模块）。接线约定见 DESIGN.md §8。
 */
export {
  applyWebviewMigrationEntries,
  WEBVIEW_MIGRATION_APPLIED_CHANNEL,
  readBackWebviewMigrationKeys,
  WEBVIEW_MIGRATION_PENDING_CHANNEL,
  WEBVIEW_MIGRATION_VERIFIED_CHANNEL,
  type StorageLike,
  type WebviewMigrationApplyReport,
  type WebviewMigrationVerifyReport,
} from './apply.ts';
export {
  completeWebviewMigration,
  defaultWriterProbe,
  MIGRATION_DIR_NAME,
  prepareWebviewMigration,
  webviewMigrationDone,
  WebviewMigrationError,
  type PreparedWebviewMigration,
  type SourceRecord,
  type WebviewMigrationErrorCode,
  type WebviewMigrationOptions,
} from './migration.ts';
export { locateMigrationSource, WEBKIT_ORIGIN, WEBVIEW2_ORIGIN, type MigrationSource, type SourceLocation, type WebviewPlatform } from './sources.ts';
export type { WriterProbe, WriterProbeResult } from './writer-probe.ts';
