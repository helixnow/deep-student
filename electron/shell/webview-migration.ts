/**
 * Tauri 版 localStorage 迁移的外壳接线（electron/storage-migration/DESIGN.md §8.2）。
 *
 * 1. Host 启动前 {@link prepareWebviewMigrationGate}：失败只给“重试 / 退出”，退出时不创建任何窗口。
 * 2. 有待写条目时，首个主窗口先加载应用 origin 下的空白迁移页（{@link WEBVIEW_MIGRATION_PAGE_PATH}，
 *    不含任何页面脚本）；preload 同步领取条目、写入、回报。
 * 3. {@link WebviewMigrationApplier} 收到回报后 `flushStorageData()`，再加载一次迁移页（核对页）：preload 读回全部键，
 *    写入的键须等于快照值、目标原有的键须仍存在；随后轮询 Electron 自己的 localStorage LevelDB，读回的值都已落盘
 *    （{@link waitForPersistedLocalStorage}）才 `completeWebviewMigration` → 加载应用入口。
 *    任一步失败（含迁移页加载完却没有回报）都只给“重试”（从写入页重来）或“退出”，应用页面不会在迁移完成前运行。
 *    写入后、标记前进程被杀：状态仍是 `snapshotted`，下次启动重放快照，target wins 保证已写入的键不被覆盖。
 */
import { readLevelDb } from '../storage-migration/leveldb.ts';
import { decodeChromiumLocalStorage } from '../storage-migration/formats.ts';
import { WebviewMigrationError, type PreparedWebviewMigration } from '../storage-migration/migration.ts';
import type { WebviewMigrationApplyReport } from '../storage-migration/apply.ts';

/** 迁移页路径：`tauri` 协议对它返回空白文档，而不是回退到 index.html。 */
export const WEBVIEW_MIGRATION_PAGE_PATH = '/__dstu__/webview-migration.html';

export const WEBVIEW_MIGRATION_PAGE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>';

export type MigrationChoice = 'retry' | 'exit';
/** 向用户展示 `message`（`detail` 为技术细节），按钮只有“重试”与“退出”。 */
export type MigrationPrompt = (message: string, detail: string) => Promise<MigrationChoice>;

const UNEXPECTED_MESSAGE = '迁移旧版界面数据时发生意外错误。旧数据未被改动，可以点“重试”；如果一直失败，请导出诊断信息联系支持。';

function asMigrationError(error: unknown): { message: string; detail: string } {
  if (error instanceof WebviewMigrationError) return { message: error.userMessage, detail: error.message };
  return { message: UNEXPECTED_MESSAGE, detail: error instanceof Error ? (error.stack ?? error.message) : String(error) };
}

export async function prepareWebviewMigrationGate(options: {
  prepare: () => Promise<PreparedWebviewMigration>;
  prompt: MigrationPrompt;
  log: (message: string) => void;
}): Promise<PreparedWebviewMigration | null> {
  for (;;) {
    try {
      return await options.prepare();
    } catch (error) {
      const { message, detail } = asMigrationError(error);
      options.log(`[webview-migration] 准备失败: ${detail}`);
      const choice = await options.prompt(message, detail);
      options.log(`[webview-migration] 用户选择${choice === 'retry' ? '重试' : '退出'}`);
      if (choice === 'exit') return null;
    }
  }
}

export interface WebviewMigrationApplierOptions {
  entries: ReadonlyArray<readonly [string, string]>;
  prompt: MigrationPrompt;
  flush(): Promise<void>;
  /** 核对页读回的值（键 → 值）已全部落盘才返回；否则抛 {@link WebviewMigrationError}。 */
  confirmPersisted(expected: ReadonlyMap<string, string>): Promise<void>;
  /** `completeWebviewMigration`：写入失败或状态异常时抛 {@link WebviewMigrationError}。 */
  complete(report: WebviewMigrationApplyReport): void;
  loadMigrationPage(): void;
  loadApp(): void;
  exit(): void;
  log(message: string): void;
}

export type WebviewMigrationApplierState = 'waiting' | 'completing' | 'verifying' | 'confirming' | 'prompting' | 'done' | 'exited';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isReport(value: unknown, keys: ReadonlySet<string>): value is WebviewMigrationApplyReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Record<string, unknown>;
  return Number.isInteger(report.written) && Number.isInteger(report.kept)
    && isStringArray(report.keptKeys) && report.keptKeys.length === report.kept && report.keptKeys.every((key) => keys.has(key))
    && Array.isArray(report.failed)
    && report.failed.every((item) => typeof item === 'object' && item !== null
      && typeof (item as Record<string, unknown>).key === 'string' && typeof (item as Record<string, unknown>).error === 'string');
}

function describeMismatches(mismatches: readonly string[]): string {
  return `${mismatches.length} 个键不一致（${mismatches.slice(0, 5).join('; ')}${mismatches.length > 5 ? '; …' : ''}）`;
}

export class WebviewMigrationApplier {
  private readonly options: WebviewMigrationApplierOptions;
  private readonly keys: ReadonlySet<string>;
  private current: WebviewMigrationApplierState = 'waiting';
  private delivered = false;
  private reported = false;
  private report: WebviewMigrationApplyReport | null = null;
  /** 迁移页的上一次加载已结束（`did-finish-load` / `did-fail-load`）。 */
  private loadFinished = true;
  /** 上一次加载还没结束时排队的下一次加载：它迟到的完成事件不能算到新页面头上。 */
  private deferred: (() => void) | null = null;
  private work: Promise<void> = Promise.resolve();

  constructor(options: WebviewMigrationApplierOptions) {
    this.options = options;
    this.keys = new Set(options.entries.map(([key]) => key));
  }

  get state(): WebviewMigrationApplierState {
    return this.current;
  }

  /** 等待当前异步处理（flush / 落盘确认 / 对话框）结束；测试与日志用。 */
  idle(): Promise<void> {
    return this.work;
  }

  start(): void {
    this.loadPage('waiting');
  }

  /**
   * preload 的同步领取：只有迁移页、且本次加载尚未领取时才有内容——写入页返回条目 JSON，
   * 核对页返回 `{"verify": [键...]}`，其余一律 `'null'`。
   */
  pending(isMigrationPage: boolean): string {
    if (!isMigrationPage || this.delivered) return 'null';
    if (this.current === 'waiting') {
      this.delivered = true;
      return JSON.stringify(this.options.entries);
    }
    if (this.current === 'verifying') {
      this.delivered = true;
      return JSON.stringify({ verify: this.options.entries.map(([key]) => key) });
    }
    return 'null';
  }

  applied(isMigrationPage: boolean, report: unknown): void {
    if (!isMigrationPage || this.current !== 'waiting' || !this.delivered || this.reported) return;
    this.reported = true;
    if (!isReport(report, this.keys)) {
      this.fail(new WebviewMigrationError('TARGET_WRITE_FAILED', `preload 回报格式无效: ${JSON.stringify(report)}`));
      return;
    }
    if (report.failed.length > 0) {
      const sample = report.failed.slice(0, 5).map((item) => `${item.key}: ${item.error}`).join('; ');
      this.fail(new WebviewMigrationError('TARGET_WRITE_FAILED', `${report.failed.length} 个键写入失败（${sample}）`));
      return;
    }
    this.report = report;
    this.current = 'completing';
    this.work = (async () => {
      try {
        await this.options.flush();
      } catch (error) {
        await this.decide(error);
        return;
      }
      this.afterLoad(() => this.loadPage('verifying'));
    })();
  }

  verified(isMigrationPage: boolean, result: unknown): void {
    if (!isMigrationPage || this.current !== 'verifying' || !this.delivered || this.reported || this.report === null) return;
    this.reported = true;
    const report = this.report;
    const values = typeof result === 'object' && result !== null ? (result as { values?: unknown }).values : undefined;
    if (!Array.isArray(values) || values.length !== this.options.entries.length || !values.every((value) => value === null || typeof value === 'string')) {
      const detail = typeof result === 'object' && result !== null && typeof (result as { error?: unknown }).error === 'string'
        ? `核对页读取 localStorage 失败: ${(result as { error: string }).error}`
        : `核对页回报格式无效: ${JSON.stringify(result)}`;
      this.fail(new WebviewMigrationError('TARGET_VERIFY_FAILED', detail));
      return;
    }
    const kept = new Set(report.keptKeys);
    const expected = new Map<string, string>();
    const mismatches: string[] = [];
    this.options.entries.forEach(([key, value], index) => {
      const actual = values[index] as string | null;
      if (actual === null) mismatches.push(`${JSON.stringify(key)} 读回为空`);
      else if (!kept.has(key) && actual !== value) mismatches.push(`${JSON.stringify(key)} 读回值与快照不同`);
      else expected.set(key, actual);
    });
    if (mismatches.length > 0) {
      this.fail(new WebviewMigrationError('TARGET_VERIFY_FAILED', `重新加载后读回：${describeMismatches(mismatches)}`));
      return;
    }
    this.current = 'confirming';
    this.work = (async () => {
      try {
        await this.options.confirmPersisted(expected);
        this.options.complete(report);
      } catch (error) {
        await this.decide(error);
        return;
      }
      this.current = 'done';
      this.options.log(`[webview-migration] 已写入 ${report.written} 个键、保留 ${report.kept} 个键，读回与落盘核对一致，加载应用入口`);
      this.options.loadApp();
    })();
  }

  /** 迁移页 `did-finish-load` / `did-fail-load`：preload 理应已同步回报；没有就是失败（preload 未运行或中途抛错）。 */
  pageLoaded(isMigrationPage: boolean): void {
    if (!isMigrationPage) return;
    this.loadFinished = true;
    const deferred = this.deferred;
    if (deferred !== null) {
      this.deferred = null;
      deferred();
      return;
    }
    if ((this.current !== 'waiting' && this.current !== 'verifying') || this.reported) return;
    this.reported = true;
    const what = this.current === 'verifying' ? '核对' : '写入';
    const code = this.current === 'verifying' ? 'TARGET_VERIFY_FAILED' : 'TARGET_WRITE_FAILED';
    this.fail(new WebviewMigrationError(code, this.delivered ? `迁移页加载完成但 preload 没有回报${what}结果` : `迁移页加载完成但 preload 没有领取待${what}内容`));
  }

  private afterLoad(action: () => void): void {
    if (this.loadFinished) action();
    else this.deferred = action;
  }

  private loadPage(state: 'waiting' | 'verifying'): void {
    this.current = state;
    this.delivered = false;
    this.reported = false;
    this.loadFinished = false;
    this.options.loadMigrationPage();
  }

  private fail(error: unknown): void {
    this.work = this.decide(error);
  }

  private async decide(error: unknown): Promise<void> {
    const { message, detail } = asMigrationError(error);
    this.options.log(`[webview-migration] 写入失败: ${detail}`);
    this.current = 'prompting';
    this.report = null;
    const choice = await this.options.prompt(message, detail).catch((promptError: unknown): MigrationChoice => {
      this.options.log(`[webview-migration] 无法显示对话框，按退出处理: ${asMigrationError(promptError).detail}`);
      return 'exit';
    });
    this.options.log(`[webview-migration] 用户选择${choice === 'retry' ? '重试' : '退出'}`);
    if (choice === 'exit') {
      this.current = 'exited';
      this.options.exit();
      return;
    }
    this.afterLoad(() => this.loadPage('waiting'));
  }
}

/**
 * 轮询 Electron 的 localStorage LevelDB（`<userData>/Local Storage/leveldb`），直到 `expected` 的每个键都以相同的值
 * 出现在 `origin` 下。`flushStorageData()` 只是把写盘任务排进队列、没有完成回调；数据库由浏览器进程持有，
 * 读到写了一半的日志记录会抛错，同样按“尚未落盘”继续等。
 */
export async function waitForPersistedLocalStorage(options: {
  dir: string;
  origin: string;
  expected: ReadonlyMap<string, string>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let last = '';
  for (;;) {
    try {
      const persisted = new Map(decodeChromiumLocalStorage(readLevelDb(options.dir), options.origin));
      const mismatches: string[] = [];
      for (const [key, value] of options.expected) {
        const actual = persisted.get(key);
        if (actual === undefined) mismatches.push(`${JSON.stringify(key)} 不在磁盘上`);
        else if (actual !== value) mismatches.push(`${JSON.stringify(key)} 磁盘上的值不同`);
      }
      if (mismatches.length === 0) return;
      last = describeMismatches(mismatches);
    } catch (error) {
      last = `读取 ${options.dir} 失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (Date.now() >= deadline) throw new WebviewMigrationError('TARGET_VERIFY_FAILED', `落盘确认超时：${last}`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
  }
}
