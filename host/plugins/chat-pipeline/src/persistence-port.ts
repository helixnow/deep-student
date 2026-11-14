/** Minimal L04 consumption port. Signatures follow its published branch API; no SQL lives here. */
import type { ChatMessage, MessageBlock, ContextSnapshot, CanonicalContentPart,
  ModelExecutionSnapshot } from '../../chat/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { AttachmentInput } from './pipeline-context.ts';
import type { ReplaySidecarWriter } from '../api.ts';

export type PersistenceBlock = MessageBlock & { blockIndex: number };
export interface UserMessageBuildParams {
  id: string | null;
  sessionId: string;
  content: string;
  attachments: AttachmentInput[];
  contextSnapshot: ContextSnapshot | null;
  canonicalContent: CanonicalContentPart[];
  executionSnapshot: ModelExecutionSnapshot | null;
  timestamp: number | null;
}
export interface PipelinePersistenceStore extends ReplaySidecarWriter {
  buildUserMessage(params: UserMessageBuildParams): { message: ChatMessage; block: PersistenceBlock };
  createMessageWithConn(conn: SqlExecutor, message: ChatMessage): void;
  createBlockWithConn(conn: SqlExecutor, block: PersistenceBlock): void;
  getMessageBlocksWithConn(conn: SqlExecutor, messageId: string): PersistenceBlock[];
  /** Requested L04 IDs-only query; no old tool/Anki payloads may be hydrated or rewritten. */
  listBlockPositionsWithConn(conn: SqlExecutor, messageId: string, type: string): [number, string][];
}

/** Additional owner reads/updates used by persistence.rs::save_results_inner. */
export interface PipelineFinalStore extends PipelinePersistenceStore {
  getMessageWithConn(conn: SqlExecutor, messageId: string): ChatMessage | null;
  updateMessageWithConn(conn: SqlExecutor, message: ChatMessage): void;
}

/** Owner effects, invoked only after the L03 transaction commits. */
export interface PipelinePostCommitEffects {
  incrementResourceRefs(resourceIds: readonly string[]): Promise<void>;
  triggerAutoMemoryExtraction(execution: import('./pipeline-context.ts').PipelineContext): void;
  onTurnCommitted(execution: import('./pipeline-context.ts').PipelineContext): void;
}
