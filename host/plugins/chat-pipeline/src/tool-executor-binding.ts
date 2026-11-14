/** tool_loop.rs:3469–3501: L03 composition of the real L04 context and executor registry. */
import type { Context } from '@deepseek-ai/cordis';
import type { WindowRef } from '../../../kernel/api.ts';
import { StorageError, type DatabaseHandle } from '../../../platform/storage/api.ts';
import type { ToolExecutorRegistry } from '../../chat/api.ts';
import type { ToolRegistry } from '../../mcp/api.ts';
import type { ChatToolRuntime } from './tool-round.ts';

export type ToolExecutorBinding = Pick<ChatToolRuntime, 'execute' | 'concurrencyClass'>;

/**
 * executor.rs:333 clones the handle the pipeline already holds and get_conn_safe checks maintenance per
 * connection. `storage.database()` throws during a backup barrier, so tools that never touch mistakes.db
 * get a handle that resolves the database on each use instead.
 */
function mistakesDb(services: Context): DatabaseHandle {
  try { return services.storage.database('mistakes'); }
  catch (error) {
    if (!(error instanceof StorageError) || error.code !== 'MAINTENANCE') throw error;
  }
  return new Proxy({} as DatabaseHandle, {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      if (key === 'name') return 'mistakes';
      if (key === 'path') return services.storage.pathOf('mistakes');
      const db = services.storage.database('mistakes');
      const value: unknown = Reflect.get(db, key, db);
      return typeof value === 'function' ? value.bind(db) : value;
    },
  });
}

export function bindToolExecutorRegistry(services: Context, registry: ToolExecutorRegistry,
  toolRegistry: ToolRegistry): ToolExecutorBinding {
  return {
    concurrencyClass: name => registry.getConcurrencyClass(name),
    execute(call, init) {
      const context = services.chatSession.createExecutionContext({ sessionId: init.sessionId,
        messageId: init.messageId, blockId: init.blockId, emitter: init.emitter,
        services, window: init.emitter.tryWindow() as WindowRef | null, toolRegistry });
      context.tool_call_id = call.id;
      context.canvas_note_id = init.canvasNoteId;
      context.main_db = mistakesDb(services);
      // The desktop Anki card store is in mistakes.db, as in the Rust pipeline builder.
      context.anki_db = context.main_db;
      context.vfs_db = services.get('vfs')?.database ?? null;
      context.llm_manager = services.get('llm') ?? null;
      context.chat_v2_db = services.chatSession.database;
      context.rag_top_k = init.ragTopK;
      context.rag_enable_reranking = init.ragEnableReranking;
      context.variant_id = init.variantId;
      context.skill_state_version = init.skillStateVersion;
      context.round_id = init.roundId;
      context.execution_allowed_tools = init.executionAllowedTools;
      context.skill_package_roots = init.skillPackageRoots;
      context.question_authoring_config = init.questionAuthoringConfig;
      context.shell_guard_approved = init.shellGuardApproved;
      context.shell_authority_admission = init.shellAuthorityAdmission;
      context.admitted_tool_dispatcher = init.admittedDispatcher;
      context.memory_enabled = init.memoryEnabled;
      context.rag_enabled = init.ragEnabled;
      context.web_search_enabled = init.webSearchEnabled;
      context.skill_contents = init.skillContents;
      context.skill_embedded_tools = init.skillEmbeddedTools;
      context.skill_admission_errors = init.skillAdmissionErrors;
      context.cancellation_token = init.cancellation;
      return registry.execute(call, context);
    },
  };
}
