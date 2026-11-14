// Rust: chatanki_executor.rs:2003–2143 `chatanki_import_apkg` handler.
// Ownership/byte resolution lives in `apkg-import.ts`; L16 owns the importer and
// L11 owns VFS rows, so this executor only orchestrates the published boundaries.
import type {
  ChatAnkiToolExecutor, ToolCall, ToolConcurrency, ToolExecutionContext, ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import { ChatAnkiApkgError, type ChatAnkiApkgImporter } from './apkg-port.ts';
import { decodeChatAnkiImportApkgArgs, normalizeChatAnkiImportApkgArgs } from './executor-args.ts';
import {
  apkgImportResultForTool, resolveApkgResourceBytes, verifyApkgResourceInSessionContext,
  type ResolvedApkgResource,
} from './apkg-import.ts';
import { fsrsImportChangedPayload } from './review-payloads.ts';
import { chatankiSensitivityForCall } from './executor-helpers.ts';
import { errorText, stripToolNamespace, toolResult } from './execution.ts';
import { isAppErrorValue } from '../../../platform/errors/api.ts';
import { beginChatAnkiToolCall, finishChatAnkiAppFailure, publishedAppError } from './result.ts';

const APKG_NEXT_STEPS = [
  '调用 chatanki_enqueue_review 并传入本次返回的 documentId，把导入的卡片加入复习队列',
  '向用户简要汇报导入结果（卡片数、模板数、媒体与告警），并询问是否立即开始复习',
];

function apkgError(
  type: ChatAnkiApkgError['type'], errorCode: string, message: string,
): ChatAnkiApkgError {
  return new ChatAnkiApkgError(type, errorCode, message);
}

/** chatanki_executor.rs:11983–12016 `finish_chatanki_app_failure` (AppError serde shape). */
function finishApkgFailure(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number, error: ChatAnkiApkgError,
): ToolResultInfo {
  const durationMs = Math.floor(performance.now() - startedAt);
  const structured = {
    error_type: error.type,
    message: error.message,
    details: { errorCode: error.errorCode },
  };
  const message = `[${error.errorCode}] ${error.message}`;
  ctx.emitToolCallError(message);
  const result: ToolResultInfo = {
    toolCallId: call.id,
    blockId: ctx.blockId,
    toolName: call.name,
    input: call.arguments,
    output: { error: structured },
    success: false,
    error: message,
    durationMs,
  };
  try { ctx.saveToolBlock(result); }
  catch (caught) {
    ctx.warn(`[ChatAnkiToolExecutor] Failed to persist tool block: ${errorText(caught)}`);
  }
  return result;
}

/**
 * chatanki_executor.rs:2003–2143. Absolute-path imports skip session ownership
 * (the caller supplied a host path); resource imports must resolve inside the
 * current session and read bytes through L11's bounded VFS order.
 */
export async function executeChatAnkiImportApkg(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args;
  try { args = decodeChatAnkiImportApkgArgs(call.arguments); }
  catch (caught) {
    return finishApkgFailure(call, ctx, startedAt, apkgError(
      'Validation', 'apkg_invalid_input',
      `Invalid chatanki_import_apkg arguments: ${errorText(caught)}`,
    ));
  }
  let source;
  try { source = normalizeChatAnkiImportApkgArgs(args); }
  catch (caught) {
    return finishApkgFailure(call, ctx, startedAt, apkgError('Validation', 'apkg_invalid_input', errorText(caught)));
  }

  let resolved: ResolvedApkgResource | null = null;
  if (source.kind === 'resourceId') {
    const lookup = ctx.sessionResources ?? null;
    if (lookup === null) {
      return finishApkgFailure(call, ctx, startedAt, apkgError(
        'Database', 'apkg_database',
        'Chat database not available for APKG resource ownership check',
      ));
    }
    try { verifyApkgResourceInSessionContext(lookup, ctx.sessionId, source.resourceId); }
    catch (caught) {
      return finishApkgFailure(call, ctx, startedAt, mapResourceResolutionError(caught));
    }
  }

  const importer: ChatAnkiApkgImporter | null = ctx.apkgImporter ?? null;
  if (importer === null) {
    return finishApkgFailure(call, ctx, startedAt, apkgError(
      'Database', 'apkg_database', 'Anki database not available',
    ));
  }

  if (source.kind === 'resourceId') {
    const vfs = ctx.apkgVfs ?? null;
    if (vfs === null) {
      return finishApkgFailure(call, ctx, startedAt, apkgError(
        'Database', 'apkg_database', 'VFS database not available',
      ));
    }
    try { resolved = resolveApkgResourceBytes(vfs, source.resourceId); }
    catch (caught) {
      return finishApkgFailure(call, ctx, startedAt, mapResourceResolutionError(caught));
    }
  }

  let imported;
  try {
    if (resolved !== null) {
      imported = importer.importBytes(resolved.bytes, resolved.sourceName, ctx.sessionId);
    } else if (source.kind === 'absolutePath') {
      imported = importer.importPath(source.path, ctx.sessionId);
    } else {
      return finishApkgFailure(call, ctx, startedAt, apkgError(
        'Validation', 'apkg_invalid_input', 'exactly one of resourceId or path is required',
      ));
    }
  } catch (caught) {
    // `Ok(Err(app_error))` from the importer; only a join failure is "APKG import task failed".
    if (!(caught instanceof ChatAnkiApkgError)) {
      const appError = isAppErrorValue(caught) ? caught : publishedAppError(caught);
      if (appError !== null) return finishChatAnkiAppFailure(call, ctx, startedAt, appError);
    }
    return finishApkgFailure(call, ctx, startedAt, asApkgError(caught, 'apkg_database', true));
  }

  const output = apkgImportResultForTool(imported);
  output.nextSteps = [...APKG_NEXT_STEPS];

  if (ctx.emitEvent !== undefined && ctx.emitEvent !== null) {
    ctx.emitEvent(
      'fsrs://changed',
      fsrsImportChangedPayload(imported.documentId, imported.cardIds, ctx.runId ?? ''),
    );
  }

  const durationMs = Math.floor(performance.now() - startedAt);
  ctx.emitToolCallEnd({ result: output, durationMs });
  const result = toolResult(call, ctx, durationMs, output);
  try { ctx.saveToolBlock(result); }
  catch (caught) {
    ctx.warn(`[ChatAnkiToolExecutor] Failed to persist tool block: ${errorText(caught)}`);
  }
  return result;
}

/** chatanki_executor.rs:10170–10176. */
function mapResourceResolutionError(caught: unknown): ChatAnkiApkgError {
  if (caught instanceof ChatAnkiApkgError) return caught;
  const message = errorText(caught);
  return message.toLowerCase().includes('not found')
    ? apkgError('NotFound', 'apkg_not_found', message)
    : apkgError('Validation', 'apkg_invalid_input', message);
}

/** ChatAnkiApkgError passthrough; other boundary failures get the Rust join-error code. */
function asApkgError(
  caught: unknown, fallbackCode: string, importTask = false,
): ChatAnkiApkgError {
  if (caught instanceof ChatAnkiApkgError) return caught;
  const message = errorText(caught);
  return apkgError(
    'Unknown', fallbackCode,
    importTask ? `APKG import task failed: ${message}` : message,
  );
}

export class ChatAnkiApkgExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === 'chatanki_import_apkg';
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  name(): string { return 'ChatAnkiApkgExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    beginChatAnkiToolCall(call, ctx);
    return executeChatAnkiImportApkg(call, ctx);
  }
}
