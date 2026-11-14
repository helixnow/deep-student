/**
 * Tauri 版 localStorage 迁移的 preload 侧（DESIGN.md §8.2 第 3 步）：只有 main 认定的迁移页会拿到待写条目
 * （写入页）或待核对的键（核对页），其余文档收到 `'null'`，不访问 localStorage（about:blank 等不透明 origin 访问会抛错）。
 */
import {
  applyWebviewMigrationEntries,
  readBackWebviewMigrationKeys,
  WEBVIEW_MIGRATION_APPLIED_CHANNEL,
  WEBVIEW_MIGRATION_PENDING_CHANNEL,
  WEBVIEW_MIGRATION_VERIFIED_CHANNEL,
  type StorageLike,
  type WebviewMigrationApplyReport,
  type WebviewMigrationVerifyReport,
} from '../storage-migration/apply.ts';

export interface SyncIpc {
  sendSync(channel: string, ...args: unknown[]): unknown;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function applyPendingWebviewMigration(ipc: SyncIpc, storage: () => StorageLike): void {
  const raw = ipc.sendSync(WEBVIEW_MIGRATION_PENDING_CHANNEL);
  const request = typeof raw === 'string' ? (JSON.parse(raw) as Array<[string, string]> | { verify: string[] } | null) : null;
  if (request === null) return;
  if (!Array.isArray(request)) {
    let verified: WebviewMigrationVerifyReport;
    try {
      verified = readBackWebviewMigrationKeys(storage(), request.verify);
    } catch (error) {
      verified = { error: errorText(error) };
    }
    ipc.sendSync(WEBVIEW_MIGRATION_VERIFIED_CHANNEL, verified);
    return;
  }
  let report: WebviewMigrationApplyReport;
  try {
    report = applyWebviewMigrationEntries(storage(), request);
  } catch (error) {
    const message = errorText(error);
    report = { written: 0, kept: 0, keptKeys: [], failed: request.map(([key]) => ({ key, error: message })) };
  }
  ipc.sendSync(WEBVIEW_MIGRATION_APPLIED_CHANNEL, report);
}
