// Rust: chatanki_executor.rs:241–322 (stale running block reaper) and
// dstu-agent manage_session.rs:274–314 (delete gate); 14321–14437 (terminal
// block snapshot refresh from authoritative DB cards).
import type {
  AnkiCard, ChatAnkiChatBlock, ChatAnkiChatBlockStore, DocumentTask,
} from '../api.ts';
import {
  BLOCK_STATUS, ankiBlockLastActivityMs, isStaleRunningAnkiBlock,
  projectChatankiWorkflow,
} from './executor-helpers.ts';
import {
  convertBackendCard, persistAnkiCardsRunningPatch, persistAnkiCardsTerminalBlock,
} from './block-patch.ts';
import { errorText } from './execution.ts';
import { deepMergeValue, findOwnedAnkiCardsBlockId } from './mutation-target.ts';
import { now } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/text.ts';

const RUNNING_BLOCK_STATUSES: readonly string[] = ['pending', 'running'];
const STILL_ACTIVE_TASK_STATUSES: readonly string[] = [
  'Pending', 'Processing', 'Streaming', 'Paused',
];

export type ChatAnkiPipelineActivity = (blockId: string) => boolean;

function toolOutputJson(toolOutput: unknown): string | null {
  if (toolOutput === null || toolOutput === undefined) return null;
  try {
    return JSON.stringify(toolOutput);
  } catch { // boundary-allow empty-catch: Rust 从 DB 读取的 tool_output_json 总是合法 JSON；不可序列化的内存对象按“无进度”处理，Rust 此处无日志
    return null;
  }
}

function runningAnkiBlocks(
  store: ChatAnkiChatBlockStore, sessionId: string,
): ChatAnkiChatBlock[] {
  return store.listSessionBlocks(sessionId)
    .filter((block) => block.type === 'anki_cards'
      && block.status !== undefined && RUNNING_BLOCK_STATUSES.includes(block.status));
}

/**
 * chatanki_executor.rs:241–322: marks crash/force-quit leftovers (running or
 * pending, no live pipeline, no activity past the grace window) as failed and
 * returns their block ids.
 */
export function reapStaleRunningAnkiBlocks(
  store: ChatAnkiChatBlockStore,
  sessionId: string,
  pipelineActive: ChatAnkiPipelineActivity,
  nowMs: number = Date.now(),
): string[] {
  const reaped: string[] = [];
  for (const block of runningAnkiBlocks(store, sessionId)) {
    const blockPipelineActive = pipelineActive(block.id);
    const lastActivityMs = ankiBlockLastActivityMs(
      block.startedAt, block.firstChunkAt, toolOutputJson(block.toolOutput),
    );
    if (!isStaleRunningAnkiBlock(nowMs, lastActivityMs, blockPipelineActive)) continue;

    const toolName = block.toolName !== undefined && block.toolName !== null
      && rustTrim(block.toolName).length > 0 ? block.toolName : 'chatanki_run';
    persistAnkiCardsRunningPatch(store, block.messageId ?? '', block.id, toolName, {
      interrupted: {
        reason: 'stale_running_block',
        detail: 'Pipeline is no longer running (app crash or force quit); block marked failed so the session stays deletable.',
        lastActivityAt: lastActivityMs,
        detectedAt: nowMs,
      },
    });
    persistAnkiCardsTerminalBlock(
      store, block.messageId ?? '', block.id, toolName, BLOCK_STATUS.ERROR, null,
      'blocks.ankiCards.errors.pipelineTimeout',
    );
    reaped.push(block.id);
  }
  return reaped;
}

/**
 * manage_session.rs:274–314: reaps zombies before the delete gate; reap
 * failures only warn and fall back to the conservative running-block count.
 */
export function sessionHasRunningAnkiBlocks(
  store: ChatAnkiChatBlockStore,
  sessionId: string,
  pipelineActive: ChatAnkiPipelineActivity,
  nowMs: number = Date.now(),
  warn: (message: string) => void = () => undefined,
): boolean {
  try {
    const reaped = reapStaleRunningAnkiBlocks(store, sessionId, pipelineActive, nowMs);
    if (reaped.length > 0) {
      warn(`[ChatV2::handlers] Marked ${reaped.length} stale running anki block(s) as failed`
        + ` before delete check (session ${sessionId})`);
    }
  } catch (caught) {
    warn(`[ChatV2::handlers] Failed to reap stale running anki blocks for ${sessionId}:`
      + ` ${errorText(caught)}`);
  }
  return store.listSessionBlocks(sessionId)
    .some((block) => block.type === 'anki_cards'
      && block.status !== undefined && RUNNING_BLOCK_STATUSES.includes(block.status));
}

export interface ChatAnkiTerminalSyncEmitter {
  emitChunk(blockId: string, update: Record<string, unknown>): void;
  emitError(blockId: string, error: string): void;
}

function stringSet(value: unknown): Set<string> {
  const result = new Set<string>();
  if (!Array.isArray(value)) return result;
  for (const item of value) if (typeof item === 'string') result.add(item);
  return result;
}

function equalSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/**
 * chatanki_executor.rs:14321–14437: when a document is terminal but its
 * `anki_cards` block snapshot is an orphan/running row or has a stale card id
 * set, rewrite the snapshot from the authoritative DB cards.
 *
 * Block-side `deletedCardIds` are honored so in-preview deletions never
 * resurrect. Returns whether a refresh happened.
 */
export function syncTerminalAnkiBlockWithDb(
  store: ChatAnkiChatBlockStore,
  sessionId: string,
  documentId: string,
  tasks: readonly DocumentTask[],
  cards: readonly AnkiCard[],
  emitter: ChatAnkiTerminalSyncEmitter | null = null,
): boolean {
  if (tasks.length === 0) return false;
  if (tasks.some((task) => STILL_ACTIVE_TASK_STATUSES.includes(task.status))) return false;

  const blockId = findOwnedAnkiCardsBlockId(store, sessionId, documentId);
  if (blockId === null) return false;
  const block = store.getBlock(blockId);
  if (block === null) throw new Error(`anki block ${blockId} disappeared during refresh`);

  const output = block.toolOutput !== null && typeof block.toolOutput === 'object'
    && !Array.isArray(block.toolOutput)
    ? block.toolOutput as Record<string, unknown>
    : null;
  const deletedCardIds = stringSet(output?.deletedCardIds);
  const visibleCards = cards.filter((card) => !deletedCardIds.has(card.id));

  const blockOrphanRunning = block.status === 'pending' || block.status === 'running';
  const blockCardIds = stringSet(
    Array.isArray(output?.cards)
      ? output.cards
        .map((card) => card !== null && typeof card === 'object' && !Array.isArray(card)
          ? (card as Record<string, unknown>).id
          : null)
        .filter((id): id is string => typeof id === 'string')
      : [],
  );
  const dbCardIds = new Set(visibleCards.map((card) => card.id));
  if (!blockOrphanRunning && equalSets(blockCardIds, dbCardIds)) return false;

  const projection = projectChatankiWorkflow(tasks, cards, null, 0);
  let refreshed: Record<string, unknown> = output ?? { cards: [], documentId };
  refreshed.cards = visibleCards.map(convertBackendCard);
  refreshed.documentId = documentId;
  refreshed = deepMergeValue(refreshed, projection.outputPatch) as Record<string, unknown>;
  refreshed.cardsRefreshedFromDb = true;
  refreshed.cardsRefreshedAt = now().rfc3339;

  const toolName = block.toolName !== undefined && block.toolName !== null
    && rustTrim(block.toolName).length > 0 ? block.toolName : 'chatanki_run';
  persistAnkiCardsTerminalBlock(
    store, block.messageId ?? '', block.id, toolName, projection.blockStatus,
    refreshed, projection.blockError,
  );
  if (emitter !== null) {
    emitter.emitChunk(block.id, refreshed);
    if (projection.blockStatus === BLOCK_STATUS.ERROR && projection.blockError !== null) {
      emitter.emitError(block.id, projection.blockError);
    }
  }
  return true;
}
