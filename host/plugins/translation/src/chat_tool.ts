/**
 * `TranslationToolExecutor` as registered in the Rust roster
 * (`translation_executor.rs:1474-1559`): the L04 execution context is mapped onto
 * the domain executor's `TranslationToolContext`, and the call is framed by
 * `emit_tool_call_start` / `emit_tool_call_end|error` and `save_tool_block`.
 * Failures keep the Rust `ToolResultInfo::failure` shape (`output: null`).
 */
import type { ChatExecutionContext, ToolCall, ToolConcurrency, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import type { DstuNode } from '../../vfs/api.ts';
import type {
  TranslateProgress, TranslationPersistenceOwner, TranslationRunner, TranslationToolExecutor,
} from './tool_executor.ts';
import { TRANSLATE_TEXT_TOOL } from './tool_executor.ts';

export type TranslationChatContext = Pick<ChatExecutionContext,
  'session_id' | 'block_id' | 'variant_id' | 'skill_state_version' | 'round_id' | 'emitter'
  | 'tauri_window' | 'vfs_db' | 'llm_manager' | 'main_db' | 'isCancelled'
  | 'emitToolCallStart' | 'emitToolCallEnd' | 'emitToolCallError' | 'saveToolBlock'>;

export interface TranslationChatToolDeps {
  /** `run_translation`; its `Window::emit` stream events broadcast (Tauri 2). */
  runner(): TranslationRunner;
  /** L11 translation owner on the shared VFS connection; `null` when vfsRepo is absent. */
  owner(): TranslationPersistenceOwner | null;
  /** `emit_watch_event` (Tauri 2 `Window::emit` broadcasts). */
  emit(channel: string, payload: unknown): void;
  createdEvent(path: string, node: DstuNode): unknown;
  info(message: string): void;
  warn(message: string): void;
}

type ChunkMetaEmitter = {
  emitChunkWithMeta?(eventType: string, blockId: string, chunk: string, variantId: string | null,
    skillStateVersion: number | null, roundId: string | null): void;
};

/** `execute_translate` checks llm → main_db → vfs_db before running any segment. */
function missingDependency(context: TranslationChatContext): string | null {
  if (context.llm_manager === null) return 'LLM manager is not available.';
  if (context.main_db === null) return 'Main database is not available.';
  if (context.vfs_db === null) return 'VFS database is not available.';
  return null;
}

export class TranslationChatToolExecutor {
  private readonly inner: TranslationToolExecutor;
  private readonly deps: TranslationChatToolDeps;

  constructor(inner: TranslationToolExecutor, deps: TranslationChatToolDeps) {
    this.inner = inner;
    this.deps = deps;
  }

  name(): string { return this.inner.name(); }

  canHandle(toolName: string): boolean { return this.inner.canHandle(toolName); }

  sensitivityLevel(toolName: string): ToolSensitivity { return this.inner.sensitivityLevel(toolName); }

  concurrencyClass(toolName: string): ToolConcurrency { return this.inner.concurrencyClass(toolName); }

  async execute(call: ToolCall, context: TranslationChatContext): Promise<ToolResultInfo> {
    context.emitToolCallStart(call.name, call.arguments, call.id);
    const missing = missingDependency(context);
    const owner = this.deps.owner();
    const domain = await this.inner.execute(call, {
      sessionId: context.session_id,
      isCancelled: () => context.isCancelled(),
      runner: missing === null ? this.deps.runner() : null,
      runnerUnavailable: missing,
      vfs: context.vfs_db,
      vfsTranslations: context.vfs_db === null ? null : owner,
      emitProgress: progress => { this.emitProgress(context, progress); },
      emitWatchCreated: node => {
        const event = this.deps.createdEvent(node.path, node);
        for (const channel of [`dstu:change:${node.path}`, 'dstu:change']) {
          try { this.deps.emit(channel, event); }
          catch (error) {
            this.deps.warn(`[DSTU::handlers] Failed to emit event ${channel}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
    });
    const durationMs = domain.durationMs ?? 0;
    let result: ToolResultInfo;
    if (domain.success) {
      context.emitToolCallEnd({ result: domain.output, durationMs });
      result = {
        toolCallId: call.id, blockId: context.block_id, toolName: call.name, input: call.arguments,
        output: domain.output, success: true, durationMs,
      };
    } else {
      const error = domain.error ?? '';
      context.emitToolCallError(error);
      result = {
        toolCallId: call.id, blockId: context.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error, durationMs,
      };
    }
    try { context.saveToolBlock(result); }
    catch (error) {
      this.deps.warn(`[TranslationToolExecutor] Failed to persist tool block: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }

  /** `emit_translate_progress`: multi-segment runs only, as a JSON chunk on the tool-call block. */
  private emitProgress(context: TranslationChatContext, progress: TranslateProgress): void {
    if (progress.segmentCount <= 1) return;
    const payload = JSON.stringify({
      progress: {
        tool: TRANSLATE_TEXT_TOOL,
        stage: 'translating',
        completed_segments: progress.completedSegments,
        segment_count: progress.segmentCount,
        translated_chars: progress.translatedChars,
      },
    });
    const emitter = context.emitter as typeof context.emitter & ChunkMetaEmitter;
    if (emitter.emitChunkWithMeta !== undefined) {
      emitter.emitChunkWithMeta('tool_call', context.block_id, payload,
        context.variant_id, context.skill_state_version, context.round_id);
    } else {
      emitter.emitChunk('tool_call', context.block_id, payload, context.variant_id);
    }
    this.deps.info(`[TranslationToolExecutor] translate_text progress: ${progress.completedSegments}/${progress.segmentCount} segments, ${progress.translatedChars} chars`);
  }
}
