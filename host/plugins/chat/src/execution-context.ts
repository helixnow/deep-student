/** Rust tools/executor.rs:172-739; Host runtime dependencies are passed explicitly. */
import type { Context } from '@deepseek-ai/cordis';
import type { WindowRef } from '../../../kernel/api.ts';
import { now } from '../../../platform/time/index.ts';
import type { ApiConfig, LLMManager } from '../../llm/api.ts';
import type { ToolRegistry } from '../../mcp/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import { getBlockTypeForToolStatic } from '../../chat-pipeline/api.ts';
import type { AdmittedToolDispatcher, AuthorityMode, ChatV2Database, ChatV2EventEmitter,
  ExecutionContext, McpToolSchema, PermissionPreset, ToolResultInfo } from '../api.ts';
import type { ChatLogger } from './logger.ts';
import { saveToolBlockRaw } from '../repository/blocks.ts';

export interface ExecutionContextInit {
  sessionId: string;
  messageId: string;
  blockId: string;
  emitter: ChatV2EventEmitter;
  services: Context;
  window?: WindowRef | null;
  toolRegistry: ToolRegistry;
  /** Optional caller override; normal construction uses L03's published static mapper. */
  blockTypeForTool?(toolName: string): string;
}

export class ChatExecutionContext implements ExecutionContext {
  session_id: string;
  message_id: string;
  block_id: string;
  emitter: ChatV2EventEmitter;
  services: Context;
  tauri_window: WindowRef | null;
  tool_registry: ToolRegistry;
  variant_id: string | null = null;
  skill_state_version: number | null = null;
  round_id: string | null = null;
  tool_call_id: string | null = null;
  canvas_note_id: string | null = null;
  chat_v2_db: ChatV2Database | null = null;
  main_db: DatabaseHandle | null = null;
  anki_db: DatabaseHandle | null = null;
  vfs_db: VfsDatabase | null = null;
  llm_manager: LLMManager | null = null;
  question_authoring_config: ApiConfig | null = null;
  skill_contents: Record<string, string> | null = null;
  skill_embedded_tools: Record<string, McpToolSchema[]> | null = null;
  skill_admission_errors: Record<string, string> | null = null;
  skill_package_roots: Record<string, string> | null = null;
  execution_allowed_tools: string[] | null = null;
  cancellation_token: AbortSignal | null = null;
  shell_guard_approved = false;
  shell_authority_admission: [AuthorityMode, PermissionPreset] | null = null;
  admitted_tool_dispatcher: AdmittedToolDispatcher | null = null;
  rag_top_k: number | null = null;
  rag_enable_reranking: boolean | null = null;
  memory_enabled = true;
  rag_enabled = true;
  web_search_enabled = true;
  private readonly log: ChatLogger;
  private readonly blockTypeForTool: (toolName: string) => string;

  constructor(init: ExecutionContextInit, log: ChatLogger) {
    this.session_id = init.sessionId; this.message_id = init.messageId; this.block_id = init.blockId;
    this.emitter = init.emitter; this.services = init.services; this.tauri_window = init.window ?? null;
    this.tool_registry = init.toolRegistry; this.blockTypeForTool = init.blockTypeForTool ?? getBlockTypeForToolStatic;
    this.log = log;
  }
  hasFrontend(): boolean { return this.tauri_window !== null; }
  get ids(): { sessionId: string; messageId: string; blockId: string; toolCallId: string; round: number } {
    return {
      sessionId: this.session_id,
      messageId: this.message_id,
      blockId: this.block_id,
      toolCallId: this.tool_call_id ?? '',
      round: 0,
    };
  }
  get request(): { ragTopK?: number; canvasNoteId?: string; questionAuthoring?: unknown } {
    return {
      ...(this.rag_top_k === null ? {} : { ragTopK: this.rag_top_k }),
      ...(this.canvas_note_id === null ? {} : { canvasNoteId: this.canvas_note_id }),
      ...(this.question_authoring_config === null ? {} : { questionAuthoring: this.question_authoring_config }),
    };
  }
  get cancel(): AbortSignal {
    return this.cancellation_token ?? new AbortController().signal;
  }
  get flags(): { memoryEnabled: boolean; ragEnabled: boolean; webSearchEnabled: boolean; supportsTools: boolean } {
    return {
      memoryEnabled: this.memory_enabled,
      ragEnabled: this.rag_enabled,
      webSearchEnabled: this.web_search_enabled,
      supportsTools: true,
    };
  }
  get host(): { hasFrontend(): boolean; emit(channel: string, payload: unknown): void; request<T = unknown>(req: unknown): Promise<T> } {
    return {
      hasFrontend: () => this.hasFrontend(),
      emit: (channel: string, payload: unknown) => {
        const target = this.tryWindow();
        if (target !== null) this.services.backendEvents?.emitTo({ kind: 'Window', label: target.window }, channel, payload);
        else this.services.backendEvents?.emit(channel, payload);
      },
      request: async () => {
        throw new Error('HostBridge.request is not configured on ChatExecutionContext');
      },
    };
  }
  get runtimeRoots(): { tempRoot(): string; workspaceRoot(rootId?: string | null): string | null } {
    return {
      tempRoot: () => this.services.paths?.os.temp ?? '/tmp/opencode',
      workspaceRoot: () => null,
    };
  }
  tryWindow(): WindowRef | null { return this.tauri_window; }
  windowRef(): WindowRef {
    if (this.tauri_window === null) throw new Error('ExecutionContext.window_ref() called without a Tauri window');
    return this.tauri_window;
  }
  runId(): string { return this.tool_call_id == null || this.tool_call_id === '' ? this.block_id : this.tool_call_id; }
  isCancelled(): boolean { return this.cancellation_token?.aborted ?? false; }
  questionAuthoringRoute(): Record<string, unknown> | null {
    const config = this.question_authoring_config;
    if (config === null) return null;
    return { model_config_id: config.id, name: config.name, model: config.model,
      provider_type: config.providerType ?? null, is_multimodal: config.isMultimodal,
      max_output_tokens: config.maxOutputTokens ?? null, max_tokens_limit: config.maxTokensLimit ?? null,
      context_window: config.contextWindow ?? null };
  }
  scopedWithCancellationToken(token: AbortSignal): ChatExecutionContext {
    const copy = new ChatExecutionContext({ sessionId: this.session_id, messageId: this.message_id,
      blockId: this.block_id, emitter: this.emitter, services: this.services, window: this.tauri_window,
      toolRegistry: this.tool_registry, blockTypeForTool: this.blockTypeForTool }, this.log);
    Object.assign(copy, this);
    copy.skill_contents = this.skill_contents === null ? null : { ...this.skill_contents };
    copy.skill_embedded_tools = this.skill_embedded_tools === null ? null : structuredClone(this.skill_embedded_tools);
    copy.skill_admission_errors = this.skill_admission_errors === null ? null : { ...this.skill_admission_errors };
    copy.skill_package_roots = this.skill_package_roots === null ? null : { ...this.skill_package_roots };
    copy.execution_allowed_tools = this.execution_allowed_tools === null ? null : [...this.execution_allowed_tools];
    copy.shell_authority_admission = this.shell_authority_admission === null ? null : [...this.shell_authority_admission];
    copy.cancellation_token = token;
    return copy;
  }
  saveToolBlock(result: ToolResultInfo): void {
    if (this.chat_v2_db === null) {
      this.log.warn('[ExecutionContext] chat_v2_db not set, skipping tool block save'); return;
    }
    if (result.blockId == null) {
      this.log.warn('[ExecutionContext] block_id not set in result, skipping tool block save'); return;
    }
    const millis = now().millis;
    const started = millis - (result.durationMs ?? 0);
    const block = { id: result.blockId, messageId: this.message_id, type: this.blockTypeForTool(result.toolName),
      status: result.success ? 'success' : 'error', toolName: result.toolName,
      toolInput: result.input, toolOutput: result.output, error: result.error,
      startedAt: started, endedAt: millis, firstChunkAt: started, blockIndex: 0 };
    saveToolBlockRaw(this.chat_v2_db.getConnSafe(), this.session_id, block);
    this.log.debug(`[ExecutionContext] Tool block saved: block_id=${result.blockId}, tool=${this.block_id}`);
  }
  emitToolCallStart(toolName: string, input: unknown, toolCallId: string | null): void {
    this.emitter.emitStartWithMeta('tool_call', this.message_id, this.block_id,
      { toolName, toolInput: input, toolCallId }, this.variant_id, this.skill_state_version, this.round_id);
  }
  emitToolCallEnd(result: unknown | null): void {
    this.emitter.emitEndWithMeta('tool_call', this.block_id, result, this.variant_id, this.skill_state_version, this.round_id);
  }
  emitToolCallError(error: string): void {
    this.emitter.emitErrorWithMeta('tool_call', this.block_id, error, this.variant_id, this.skill_state_version, this.round_id);
  }
  emitToolProgress(phase: string, percent: number | null, message: string | null): void {
    this.emitToolProgressPayload({ progress: { phase,
      ...(percent === null ? {} : { percent: Math.min(percent, 100) }),
      ...(message === null || message === '' ? {} : { message }) } });
  }
  emitToolProgressPayload(payload: unknown): void {
    let line: string | undefined;
    try { line = JSON.stringify(payload); }
    catch { return; } // Rust if let Ok(line) silently ignores serialization failure.
    if (line !== undefined) emitToolProgressLine(this.emitter, this.block_id, line);
  }
}

export function emitToolProgressLine(emitter: ChatV2EventEmitter, blockId: string, line: string): void {
  if (line !== '') emitter.emitChunk('tool_call', blockId, `${line}\n`, null);
}
