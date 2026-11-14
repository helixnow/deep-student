/** persistence.rs:552–849 — L03 orchestration, L04 message/block ownership, F3 transactions. */
import { ChatV2Error } from '../../chat/api.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { AsyncTransaction, DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { PipelineContext } from './pipeline-context.ts';
import type { PipelinePersistenceStore } from './persistence-port.ts';
import { existingUserContentBlockId, persistReplaySidecar, persistUserLlmContentEarly } from './replay-persistence.ts';
import { cloneAgentJson } from '../../../kernel/agent-api.ts';

type Logger = Pick<Context['logger'], 'debug' | 'info' | 'warn' | 'error'>;
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
const debugError = (error: unknown) => error instanceof ChatV2Error
  ? `${error.kind}${error.data === undefined ? '' : `(${JSON.stringify(error.data)})`}`
  : JSON.stringify(text(error));

export class PipelinePersistence {
  private readonly getConnection: () => DatabaseHandle;
  private readonly store: PipelinePersistenceStore;
  private readonly logger: Logger;

  constructor(getConnection: () => DatabaseHandle, store: PipelinePersistenceStore, logger: Logger) {
    this.getConnection = getConnection;
    this.store = store;
    this.logger = logger;
  }

  private buildUser(execution: PipelineContext, timestamp: number) {
    const result = this.store.buildUserMessage({ id: execution.userMessageId, sessionId: execution.sessionId,
      content: execution.userContent, attachments: structuredClone(execution.attachments),
      contextSnapshot: structuredClone(execution.contextSnapshot), canonicalContent: structuredClone(execution.canonicalContent),
      executionSnapshot: structuredClone(execution.executionSnapshot), timestamp });
    if (execution.options.userMessageOrigin != null) {
      result.message._meta ??= {};
      result.message._meta.inboundOrigin = structuredClone(execution.options.userMessageOrigin);
    }
    return result;
  }

  async saveUserMessageImmediately(execution: PipelineContext): Promise<void> {
    const conn = this.getConnection();
    const user = this.buildUser(execution, Date.now());
    this.store.createMessageWithConn(conn, user.message);
    this.store.createBlockWithConn(conn, user.block);
  }

  persistUserLlmContentEarly(execution: PipelineContext): void {
    persistUserLlmContentEarly(execution, this.getConnection,
      (conn, id) => this.store.getMessageBlocksWithConn(conn, id), this.store, this.logger);
  }

  async saveIntermediateResults(execution: PipelineContext): Promise<void> {
    if (execution.interleavedBlocks.length === 0) return;
    const db = this.getConnection();
    const timestamp = Date.now();
    let tx: AsyncTransaction;
    try { tx = await db.begin({ behavior: 'immediate' }); }
    catch (error) {
      this.logger.error(`[ChatV2::pipeline] Failed to begin transaction for save_intermediate_results: ${text(error)}`);
      throw new ChatV2Error('Database', `Failed to begin transaction: ${text(error)}`);
    }
    try { this.saveIntermediateResultsInner(tx, execution, timestamp); }
    catch (error) {
      try {
        await tx.rollback();
        this.logger.warn(`[ChatV2::pipeline] Intermediate save rolled back for session=${execution.sessionId}: ${debugError(error)}`);
      } catch (rollbackError) {
        this.logger.error(`[ChatV2::pipeline] Failed to rollback intermediate save: ${text(rollbackError)} (original: ${debugError(error)})`);
      }
      throw error;
    }
    try { await tx.commit(); }
    catch (error) {
      this.logger.error(`[ChatV2::pipeline] Failed to commit intermediate save transaction: ${text(error)}`);
      if (tx.active) {
        try { await tx.rollback(); }
        catch (rollbackError) { this.logger.error(`[ChatV2::pipeline] Rollback after COMMIT failure: ${text(rollbackError)}`); }
      }
      throw new ChatV2Error('Database', `Failed to commit transaction: ${text(error)}`);
    }
    execution.dirtyInterleavedBlockIds.clear();
    execution.intermediateSaveCommitted = true;
    this.logger.debug(`[ChatV2::pipeline] Intermediate save committed: message_id=${execution.assistantMessageId}, blocks=${execution.interleavedBlocks.length}`);
  }

  private saveIntermediateResultsInner(conn: SqlExecutor, execution: PipelineContext, timestamp: number): void {
    const skip = execution.options.skipUserMessageSave ?? false;
    let userBlockId: string | null;
    if (!skip) {
      const user = this.buildUser(execution, timestamp);
      this.store.createMessageWithConn(conn, user.message);
      this.store.createBlockWithConn(conn, user.block);
      userBlockId = user.block.id;
    } else {
      userBlockId = existingUserContentBlockId(conn,
        (connection, id) => this.store.getMessageBlocksWithConn(connection, id), execution.userMessageId);
    }
    const anki = this.store.listBlockPositionsWithConn(conn, execution.assistantMessageId, 'anki_cards');
    const ids = new Set(execution.interleavedBlocks.map(block => block.id));
    const inserts = anki.filter(([, id]) => !ids.has(id)).sort(([a], [b]) => a - b);
    const indexed: [number, string][] = execution.interleavedBlocks.map((block, index) => [index, block.id]);
    indexed.push(...inserts);
    indexed.sort(([a], [b]) => a - b);
    const blockIds = [...new Set(indexed.map(([, id]) => id))];
    this.store.createMessageWithConn(conn, { id: execution.assistantMessageId, sessionId: execution.sessionId,
      role: 'assistant', blockIds, timestamp });
    execution.interleavedBlocks.forEach((block, index) => {
      if (execution.intermediateSaveCommitted && !execution.dirtyInterleavedBlockIds.has(block.id)) return;
      this.store.createBlockWithConn(conn, { ...cloneAgentJson(block), blockIndex: index });
    });
    persistReplaySidecar(conn, execution, userBlockId,
      execution.intermediateSaveCommitted ? execution.dirtyInterleavedBlockIds : null, this.store);
    this.logger.debug(`[ChatV2::pipeline] Intermediate save: message_id=${execution.assistantMessageId}, blocks=${execution.interleavedBlocks.length}, user_saved=${!skip}`);
  }

  async saveIntermediateResultsWithRetry(execution: PipelineContext, stage: string): Promise<boolean> {
    try { await this.saveIntermediateResults(execution); return true; }
    catch (error) {
      this.logger.warn(`[ChatV2::pipeline] Intermediate save failed at ${stage} (session=${execution.sessionId}, message=${execution.assistantMessageId}): ${text(error)}; retrying once`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    try {
      await this.saveIntermediateResults(execution);
      this.logger.info(`[ChatV2::pipeline] Intermediate save retry succeeded at ${stage} (session=${execution.sessionId})`);
      return true;
    } catch (error) {
      this.logger.error(`[ChatV2::pipeline] Intermediate save failed after retry at ${stage} (session=${execution.sessionId}, message=${execution.assistantMessageId}): ${text(error)}; continuing without persistence — generated blocks may be lost on refresh until the next save point`);
      return false;
    }
  }
}
