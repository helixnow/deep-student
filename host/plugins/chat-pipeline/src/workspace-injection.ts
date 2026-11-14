/** tool_loop.rs:2583–2768 — C11 side effects shared by idle and tool checkpoints. */
import type { Context } from '@deepseek-ai/cordis';
import { WorkspaceInjector } from '../../agent-workspace/portable.ts';
import type { WorkspaceCoordinator, WorkspaceMessage } from '../../agent-workspace/api.ts';
import type { ChatV2Emitter, ChatSessionService } from '../../chat/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type { PersistenceBlock } from './persistence-port.ts';
import type { PipelineContext } from './pipeline-context.ts';
import { ChatV2StreamingAdapter } from './llm-adapter.ts';

type Log = Pick<Context['logger'], 'info' | 'warn' | 'debug'>;
type Store = Pick<ChatSessionService, 'createBlockWithConn' | 'getMessageWithConn'
  | 'createMessageWithConn' | 'appendBlockIdToMessageWithConn'>;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export class WorkspaceInjectionRuntime {
  readonly injector: WorkspaceInjector;
  private readonly connection: () => SqlExecutor;
  private readonly store: Store;
  private readonly log: Log;

  constructor(coordinator: WorkspaceCoordinator, connection: () => SqlExecutor, store: Store, log: Log) {
    this.injector = new WorkspaceInjector(coordinator);
    this.connection = connection;
    this.store = store;
    this.log = log;
  }

  apply(ctx: PipelineContext, emitter: ChatV2Emitter, workspaceId: string,
    messages: readonly WorkspaceMessage[], roundId: string | null): void {
    const formatted = WorkspaceInjector.formatInjectedMessages(messages);
    ctx.injectWorkspaceMessages(formatted, this.log);
    const blockId = ChatV2StreamingAdapter.generateBlockId();
    const now = Date.now();
    const meta = { workspace_id: workspaceId, message_count: messages.length,
      senders: [...new Set(messages.map(message => message.senderSessionId))],
      message_types: messages.map(message => message.messageType), injected_at: toRfc3339() };
    const block: PersistenceBlock = { id: blockId, messageId: ctx.assistantMessageId, type: 'workspace_injection',
      status: 'success', content: formatted, toolOutput: meta, startedAt: now, endedAt: now,
      firstChunkAt: now, blockIndex: 0 };
    block.blockIndex = ctx.addInterleavedBlock(block);
    let conn: SqlExecutor | null = null;
    try { conn = this.connection(); }
    catch (error) {
      this.log.warn(`[ChatV2::pipeline] No DB connection for workspace_injection persistence (injection continues): ${messageOf(error)}`);
    }
    if (conn !== null) {
      try { this.store.createBlockWithConn(conn, block); }
      catch (error) {
        this.log.warn(`[ChatV2::pipeline] Failed to persist workspace_injection block: id=${blockId}, err=${messageOf(error)}`);
      }
      try {
        // L04 owns the tables. Keep the synchronous read/append-or-create on the same connection.
        const message = this.store.getMessageWithConn(conn, ctx.assistantMessageId);
        if (message === null) {
          this.store.createMessageWithConn(conn, { id: ctx.assistantMessageId, sessionId: ctx.sessionId,
            role: 'assistant', blockIds: [blockId], timestamp: Date.now() });
        } else {
          this.store.appendBlockIdToMessageWithConn(conn, ctx.assistantMessageId, blockId);
        }
      } catch (error) {
        this.log.warn(`[ChatV2::pipeline] Failed to append workspace_injection block to message: msg=${ctx.assistantMessageId}, block=${blockId}, err=${messageOf(error)}`);
      }
    }
    emitter.emitStartWithMeta('workspace_injection', ctx.assistantMessageId, blockId,
      { workspaceId, messageCount: messages.length }, null, ctx.options.skillStateVersion, roundId);
    emitter.emitChunkWithMeta('workspace_injection', blockId, formatted, null, ctx.options.skillStateVersion, roundId);
    emitter.emitEndWithMeta('workspace_injection', blockId, { result: meta }, null, ctx.options.skillStateVersion, roundId);
    this.log.info(`[ChatV2::pipeline] Created workspace_injection block: id=${blockId}, message_id=${ctx.assistantMessageId}, messages=${messages.length}`);
  }
}
