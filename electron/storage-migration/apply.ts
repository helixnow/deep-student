/**
 * 写入侧（DESIGN.md §5.3）：sandbox preload 在页面任何脚本执行前调用。
 * 不得引入 Node 模块——preload 由 esbuild 打成单文件，在沙箱里运行。
 */

export const WEBVIEW_MIGRATION_PENDING_CHANNEL = 'dstu:webview-migration:pending';
export const WEBVIEW_MIGRATION_APPLIED_CHANNEL = 'dstu:webview-migration:applied';
export const WEBVIEW_MIGRATION_VERIFIED_CHANNEL = 'dstu:webview-migration:verified';

export interface WebviewMigrationApplyReport {
  readonly written: number;
  readonly kept: number;
  /** 目标已有而未写入的键（核对时只要求它们仍存在，值以目标为准）。 */
  readonly keptKeys: readonly string[];
  readonly failed: ReadonlyArray<{ readonly key: string; readonly error: string }>;
}

/** 核对页读回的值，与核对请求的键一一对应；读不了 localStorage 时为 `error`。 */
export type WebviewMigrationVerifyReport = { readonly values: ReadonlyArray<string | null> } | { readonly error: string };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 目标已有的键保留（target wins）；逐键写入，单键失败（如配额）计入报告而不中断其余键。 */
export function applyWebviewMigrationEntries(
  storage: StorageLike,
  entries: ReadonlyArray<readonly [string, string]>,
): WebviewMigrationApplyReport {
  let written = 0;
  const keptKeys: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  for (const [key, value] of entries) {
    try {
      if (storage.getItem(key) !== null) {
        keptKeys.push(key);
        continue;
      }
      storage.setItem(key, value);
      written += 1;
    } catch (error) {
      failed.push({ key, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  }
  return { written, kept: keptKeys.length, keptKeys, failed };
}

export function readBackWebviewMigrationKeys(storage: StorageLike, keys: readonly string[]): WebviewMigrationVerifyReport {
  return { values: keys.map((key) => storage.getItem(key)) };
}
