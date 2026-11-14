/**
 * 命令层：`import_question_bank`（commands.rs:1087）、`import_question_bank_stream`（1122-1257）、
 * `resume_question_import`（1285-1350）。
 *
 * - 取消：调用方提供 import_id 时先登记（占用即报错），`tokio::select!` 的取消分支对应
 *   `raceCancellation`；无论哪一方先完成，最后都以 `finish_or_cancelled` 判定唯一终态。
 * - 进度：`question_import_progress` 事件，带 import_id 时追加该字段；发送失败记 error 不影响命令。
 * - 清理：流式导入只在登记表仍是本次令牌时移除（`Arc::ptr_eq`），恢复命令无条件移除；
 *   两者都在 finally 中执行，覆盖取消与抛错路径。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { ExamSheetSessionService } from '../../media/api.ts';
import type { ImportQuestionBankRequest, QuestionImportDraftResponse, QuestionImportProgress } from '../api.ts';
import { QuestionImportCancellation, type QuestionImportCancellations } from './question-import-cancellation.ts';
import { resumeLegacy, type LegacyResumeHost } from './question-import-legacy.ts';
import {
  ImportRun, draftResponse, importRequestOf, prepareDocument, resumeV2,
  type ImportResult, type ImportServiceHost, type ProgressSink,
} from './question-import-service.ts';
import type { QbankLogger } from './ports.ts';
import { QbankServiceError } from './question-service.ts';

export const QUESTION_IMPORT_PROGRESS_EVENT = 'question_import_progress';

export interface ImportCommandDeps {
  /** 组合导入服务；VFS 仓储缺失时抛出 Validation「VFS 数据库未初始化」。 */
  host(): ImportServiceHost;
  legacyHost(): LegacyResumeHost;
  sessions(): ExamSheetSessionService;
  readonly registry: QuestionImportCancellations;
  emit(event: string, payload: JsonValue): void;
  readonly log: QbankLogger;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function cancelled(message: string): QbankServiceError {
  return new QbankServiceError(AppError.validation(message));
}

/**
 * `tokio::select! { result = fut => result, _ = token.cancelled() => Err(cancelled) }`。
 * 被取消时丢弃导入 future 的结果（它在下一个 await 点经 `ImportRun.step` 自行停止）。
 */
async function raceCancellation<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<Settled<T>> {
  const settled: Promise<Settled<T>> = work.then(value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }));
  if (signal.aborted) return { ok: false, error: cancelled(message) };
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<Settled<T>>(resolve => {
    onAbort = () => resolve({ ok: false, error: cancelled(message) });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    if (onAbort !== null) signal.removeEventListener('abort', onAbort);
  }
}

async function settle<T>(work: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error };
  }
}

function unwrap<T>(result: Settled<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * 进度事件转发：按需追加 import_id；`emit` 失败记 error。Rust 流式命令在 `to_value` 失败时记 error 并跳过，
 * 而 `QuestionImportProgress` 只含可序列化字段，该分支在 TS 中不可达。
 */
function progressSink(deps: ImportCommandDeps, importId: string | null): ProgressSink {
  return (event: QuestionImportProgress) => {
    const payload = { ...(event as unknown as Record<string, JsonValue>) };
    if (importId !== null) payload.import_id = importId;
    try {
      deps.emit(QUESTION_IMPORT_PROGRESS_EVENT, payload);
    } catch (error) {
      deps.log.error(`[question_import_progress] emit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** `import_question_bank`：无进度、无取消。 */
export async function importQuestionBank(deps: ImportCommandDeps, request: ImportQuestionBankRequest):
  Promise<QuestionImportDraftResponse> {
  const host = deps.host();
  const result = await prepareDocument(host, importRequestOf(request), null, null,
    new ImportRun(null, '题目解析已取消'));
  return draftResponse(deps.sessions(), result);
}

/** `import_question_bank_stream`。 */
export async function importQuestionBankStream(deps: ImportCommandDeps, request: ImportQuestionBankRequest):
  Promise<QuestionImportDraftResponse> {
  const host = deps.host();
  // 去除首尾空白后非空才作为 import_id（commands.rs:1135-1140）。
  const trimmed = request.import_id === undefined || request.import_id === null ? null : request.import_id.trim();
  const importId = trimmed === null || trimmed === '' ? null : trimmed;
  let cancellation: QuestionImportCancellation | null = null;
  if (importId !== null) {
    cancellation = deps.registry.register(importId);
    if (cancellation === null) {
      throw new QbankServiceError(AppError.validation('该题目集导入仍在进行中，请稍后再试'));
    }
  }
  let result: Settled<ImportResult>;
  try {
    const run = new ImportRun(cancellation?.signal ?? null, '题目集导入已取消');
    const work = prepareDocument(host, importRequestOf(request), progressSink(deps, importId), null, run);
    if (cancellation !== null) {
      result = await raceCancellation(work, cancellation.signal, '题目集导入已取消');
      if (!cancellation.finishOrCancelled()) result = { ok: false, error: cancelled('题目集导入已取消') };
    } else {
      result = await settle(work);
    }
  } finally {
    if (importId !== null && cancellation !== null) deps.registry.releaseIfCurrent(importId, cancellation);
  }
  return draftResponse(deps.sessions(), unwrap(result));
}

/** `QuestionImportService::resume_import`：v2 草稿状态或旧版 checkpoint。 */
async function resumeImport(deps: ImportCommandDeps, sessionId: string, progress: ProgressSink,
  run: ImportRun): Promise<ImportResult> {
  const dispatch = await resumeV2(deps.host(), sessionId, run);
  if (dispatch.kind === 'done') return dispatch.result;
  return resumeLegacy(deps.legacyHost(), sessionId, dispatch.stateStr, progress, run);
}

/** `resume_question_import`。 */
export async function resumeQuestionImport(deps: ImportCommandDeps, sessionId: string,
  rawImportId: string | null | undefined): Promise<QuestionImportDraftResponse> {
  deps.host();
  // 恢复命令保留原值（不 trim），仅过滤空白 id（commands.rs:1299）。
  const importId = rawImportId === undefined || rawImportId === null || /^\p{White_Space}*$/u.test(rawImportId)
    ? null : rawImportId;
  let cancellation: QuestionImportCancellation;
  if (importId !== null) {
    const registered = deps.registry.register(importId);
    if (registered === null) throw new QbankServiceError(AppError.validation('该恢复任务仍在运行'));
    cancellation = registered;
  } else {
    cancellation = new QuestionImportCancellation();
  }
  let result: Settled<ImportResult>;
  try {
    const run = new ImportRun(cancellation.signal, '题目解析恢复已取消');
    const work = resumeImport(deps, sessionId, progressSink(deps, importId), run);
    result = await raceCancellation(work, cancellation.signal, '题目解析恢复已取消');
    if (!cancellation.finishOrCancelled()) result = { ok: false, error: cancelled('题目解析恢复已取消') };
  } finally {
    if (importId !== null) deps.registry.remove(importId);
  }
  return draftResponse(deps.sessions(), unwrap(result));
}
