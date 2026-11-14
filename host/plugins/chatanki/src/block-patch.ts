// Rust: chatanki_executor.rs:14455–14602 (running/terminal anki_cards block patches).
// `upsert_block_allow_orphan` 的 message 外键兜底归 L04；本模块只做块投影与合并。
import type { AnkiCard, ChatAnkiChatBlock, ChatAnkiChatBlockStore } from '../api.ts';
import {
  BLOCK_STATUS, classifyGenerationIssue, nextChatankiStateRevision,
} from './executor-helpers.ts';
import { deepMergeValue } from './mutation-target.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function existingBlock(
  store: ChatAnkiChatBlockStore, blockId: string,
): ChatAnkiChatBlock | null {
  try {
    return store.getBlock(blockId);
  } catch {
    return null;
  }
}

function emptySnapshot(): Record<string, unknown> {
  return { cards: [], documentId: null };
}

/** chatanki_executor.rs:13757–13776: DB card snapshot stored in anki_cards blocks. */
export function convertBackendCard(card: AnkiCard): Record<string, unknown> {
  return {
    id: card.id,
    task_id: card.task_id,
    front: card.front,
    back: card.back,
    text: card.text,
    tags: [...card.tags],
    images: [...card.images],
    fields: { ...card.extra_fields },
    extra_fields: { ...card.extra_fields },
    template_id: card.template_id,
    is_error_card: card.is_error_card,
    error_content: card.error_content,
    created_at: card.created_at,
    updated_at: card.updated_at,
  };
}

/**
 * chatanki_executor.rs:14455–14514: best-effort running patch that preserves the
 * existing message id, ordering and timing metadata.
 */
export function persistAnkiCardsRunningPatch(
  store: ChatAnkiChatBlockStore,
  fallbackMessageId: string,
  blockId: string,
  toolName: string,
  patch: Record<string, unknown>,
): void {
  const nowMs = Date.now();
  const existing = existingBlock(store, blockId);
  const toolOutput = existing?.toolOutput === null || existing?.toolOutput === undefined
    ? emptySnapshot()
    : structuredClone(existing.toolOutput);
  const merged = isRecord(toolOutput)
    ? deepMergeValue(toolOutput, patch) as Record<string, unknown>
    : patch;

  const block: ChatAnkiChatBlock = {
    id: blockId,
    sessionId: existing?.sessionId ?? '',
    type: 'anki_cards',
    status: BLOCK_STATUS.RUNNING,
    toolName,
    toolOutput: merged,
    error: null,
    messageId: existing?.messageId ?? fallbackMessageId,
    blockIndex: existing?.blockIndex ?? 1,
    startedAt: existing?.startedAt ?? nowMs,
    firstChunkAt: existing?.firstChunkAt ?? nowMs,
    endedAt: null,
  };
  try {
    store.upsertBlock(block);
  } catch { // boundary-allow empty-catch: chatanki_executor.rs:14504 `let _ = upsert_block_allow_orphan(...)` 显式丢弃块写入错误且不记日志（best-effort，不回滚调用方结果）
  }
}

/**
 * chatanki_executor.rs:14516–14602: terminal patch; error statuses also merge the
 * structured generation issue snapshot.
 */
export function persistAnkiCardsTerminalBlock(
  store: ChatAnkiChatBlockStore,
  fallbackMessageId: string,
  blockId: string,
  toolName: string,
  status: string,
  toolOutputOverride: Record<string, unknown> | null,
  error: string | null,
): void {
  const nowMs = Date.now();
  const existing = existingBlock(store, blockId);
  let toolOutput = toolOutputOverride
    ?? (existing?.toolOutput === null || existing?.toolOutput === undefined
      ? null
      : structuredClone(existing.toolOutput))
    ?? emptySnapshot();
  if (!isRecord(toolOutput)) toolOutput = emptySnapshot();

  if (status === BLOCK_STATUS.ERROR) {
    const detail = error ?? 'generation_failed';
    const { code, retryable } = classifyGenerationIssue(detail);
    toolOutput = deepMergeValue(toolOutput, {
      schemaVersion: 2,
      stateRevision: nextChatankiStateRevision(),
      workflowStatus: 'failed',
      generationStatus: 'failed',
      deliveryStatus: 'empty',
      recoveryStatus: 'none',
      availableCards: 0,
      status: 'error',
      finalStatus: 'error',
      finalError: detail,
      error: detail,
      shouldRetry: retryable,
      issues: [{
        scope: 'generation',
        code,
        severity: 'error',
        retryable,
        recovered: false,
        detail,
      }],
      progress: { stage: 'error' },
    }) as Record<string, unknown>;
  }

  const block: ChatAnkiChatBlock = {
    id: blockId,
    sessionId: existing?.sessionId ?? '',
    type: 'anki_cards',
    status,
    toolName,
    toolOutput,
    error,
    messageId: existing?.messageId ?? fallbackMessageId,
    blockIndex: existing?.blockIndex ?? 1,
    startedAt: existing?.startedAt ?? nowMs,
    firstChunkAt: existing?.firstChunkAt ?? nowMs,
    endedAt: nowMs,
  };
  try {
    store.upsertBlock(block);
  } catch { // boundary-allow empty-catch: chatanki_executor.rs:14589 `let _ = upsert_block_allow_orphan(...)` 显式丢弃块写入错误且不记日志（best-effort，不回滚调用方结果）
  }
}
