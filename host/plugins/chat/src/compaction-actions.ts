/**
 * Context-compaction write actions. Rust source: `chat_v2/handlers/block_actions.rs`.
 * `compact_session` needs the L03 pipeline; `undo_compaction` is DB-only.
 */
import type { UndoCompactionResponse, ChatV2Database, CompactSessionResponse } from '../api.ts';
import type { ChatPipelineService, CompactionOutcome } from '../../chat-pipeline/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { ChatV2Error } from './error.ts';
import type { ChatLogger } from './logger.ts';
import { ensureSessionWritable } from './handlers.ts';
import { StreamGuard, type ChatV2State } from './state.ts';
import { databaseOperation } from '../repository/errors.ts';
import { loadSessionState } from '../repository/session-state.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import {
  clearSessionLastCompaction, getActiveCompaction, getCompactionById, setSessionLastCompaction,
} from '../repository/compactions.ts';

/** Rust compaction.rs:431; aligns with the L03 execution interface candidate. */
export interface CompactionPipelinePort extends Pick<ChatPipelineService,
  'compactionStatus' | 'compactionReasonCode' | 'compactionTokenEstimates'> {
  runCompactionForSession(sessionId: string, modelId: string | null, reason: string,
    excludeIds: string[], contextLimit: number | null, memoryEnabled: boolean | null,
    cancellation: AbortSignal | null): Promise<CompactionOutcome>;
}

/** block_actions.rs:57-115; registration is gated on the actual upstream execution method. */
export async function compactSessionAction(database: ChatV2Database, state: ChatV2State,
  pipeline: CompactionPipelinePort, sessionId: string, modelConfigId: string,
  contextLimit: number | null): Promise<CompactSessionResponse> {
  ensureSessionWritable(database.getConnSafe(), sessionId);
  const modelId = rustTrim(modelConfigId);
  if (modelId === '') throw new ChatV2Error('Validation', 'modelConfigId is required');
  let memoryEnabled: boolean | null = null;
  try {
    const features: unknown = loadSessionState(database.getConnSafe(), sessionId)?.features;
    if (features !== null && typeof features === 'object' && !Array.isArray(features)
      && Object.values(features).every(value => typeof value === 'boolean')
      && 'userMemory' in features && typeof features.userMemory === 'boolean') memoryEnabled = features.userMemory;
  } catch { memoryEnabled = null; }
  const registration = state.tryRegisterStreamOwned(sessionId);
  if (registration === null) return { status: 'skipped', reason: 'streaming' };
  const guard = new StreamGuard(state, sessionId, registration);
  try {
    const outcome = await pipeline.runCompactionForSession(sessionId, modelId, 'manual', [],
      contextLimit, memoryEnabled, registration.token.signal);
    const [before, after] = pipeline.compactionTokenEstimates(outcome);
    return { status: pipeline.compactionStatus(outcome), reason: pipeline.compactionReasonCode(outcome),
      ...(before === null ? {} : { tokensBefore: before }), ...(after === null ? {} : { tokensAfter: after }) };
  } finally { guard.dispose(); }
}

/** `chat_v2_undo_compaction` (block_actions.rs:118-175). */
export function undoCompactionAction(
  db: DatabaseHandle, state: ChatV2State, sessionId: string, compactionId: string,
  log?: ChatLogger,
): UndoCompactionResponse {
  ensureSessionWritable(db, sessionId);
  const registration = state.tryRegisterStreamOwned(sessionId);
  if (registration === null) {
    throw new ChatV2Error('Other', 'Cannot undo compaction while the session is streaming.');
  }
  const guard = new StreamGuard(state, sessionId, registration);
  try {
    return databaseOperation(() => db.transaction((tx) => {
      const active = getActiveCompaction(tx, sessionId, log);
      if (active === null) {
        throw new ChatV2Error('Validation', 'No active context compaction');
      }
      if (active.id !== compactionId) {
        throw new ChatV2Error('Validation', 'Only the active compaction can be undone');
      }
      let previousId: string | null = null;
      if (active.previousCompactionId !== null) {
        const previous = getCompactionById(tx, active.previousCompactionId);
        if (previous !== null && previous.sessionId === sessionId) previousId = previous.id;
      }
      if (previousId !== null) setSessionLastCompaction(tx, sessionId, previousId, log);
      else clearSessionLastCompaction(tx, sessionId, log);
      return { activeCompactionId: previousId };
    }));
  } finally {
    guard.dispose();
  }
}
