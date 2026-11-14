/**
 * chat_v2/pipeline/compaction/segmentation.rs — turn splitting, signature
 * preservation scanning and tail selection.
 */
import type { ChatMessage, MessageBlock } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { estimateMessageTokens, HEAD_USER_TURNS } from './compaction-budget.ts';

/** Log surface matching segmentation.rs sites. */
export interface SegmentationLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}
let segmentationLogger: SegmentationLog = { info() {}, warn() {}, debug() {} };
export function configureSegmentationLogger(logger: SegmentationLog): void {
  segmentationLogger = logger;
}

/** A turn runs from one user message to just before the next user message. */
export interface TurnRange {
  /** Inclusive message index. */
  start: number;
  /** Exclusive message index. */
  end: number;
}

export function splitIntoTurns(messages: readonly ChatMessage[]): TurnRange[] {
  const turns: TurnRange[] = [];
  let currentStart: number | null = null;
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      if (currentStart !== null) turns.push({ start: currentStart, end: index });
      currentStart = index;
    }
  });
  if (currentStart !== null) turns.push({ start: currentStart, end: messages.length });
  return turns;
}

/**
 * A turn is signature-sensitive only when a persisted thought_signature exists
 * (Gemini 3 tool results). Thinking text alone is not a signature.
 */
export function turnHasLiveSignature(messages: readonly ChatMessage[], turn: TurnRange,
  _blocksByMsg: ReadonlyMap<string, readonly MessageBlock[]>): boolean {
  for (let index = turn.start; index < turn.end; index++) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    for (const result of message._meta?.toolResults ?? []) {
      if (result.thoughtSignature !== undefined && result.thoughtSignature !== null
        && result.thoughtSignature !== '') {
        return true;
      }
    }
  }
  return false;
}

export interface TailSelection {
  /** Start index of the tail inside `messages`. */
  tailStartIdx: number;
  tailTokens: number;
}

function sumTokens(messages: readonly ChatMessage[], start: number, end: number,
  blocksByMsg: ReadonlyMap<string, readonly MessageBlock[]>, modelId?: string | null): number {
  let total = 0;
  for (let index = start; index < end; index++) {
    total += estimateMessageTokens(messages[index]!, blocksByMsg, modelId);
  }
  return total;
}

/**
 * User-requested compaction summarizes older turns regardless of the model
 * window. Always retain the latest complete turn, including signatures/tool
 * blocks, even when it alone exceeds the target budget.
 */
export function selectManualTail(messages: readonly ChatMessage[], turns: readonly TurnRange[],
  budgetTokens: number, blocksByMsg: ReadonlyMap<string, readonly MessageBlock[]>,
  modelId?: string | null): TailSelection | null {
  const last = turns[turns.length - 1];
  if (last === undefined) return null;
  let start = last.start;
  let tokens = sumTokens(messages, last.start, last.end, blocksByMsg, modelId);
  for (let turnIndex = turns.length - 2; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex]!;
    const extra = sumTokens(messages, turn.start, turn.end, blocksByMsg, modelId);
    if (tokens + extra > budgetTokens) break;
    start = turn.start;
    tokens += extra;
  }
  return start > 0 ? { tailStartIdx: start, tailTokens: tokens } : null;
}

export function selectTail(messages: readonly ChatMessage[], turns: readonly TurnRange[],
  budgetTokens: number, blocksByMsg: ReadonlyMap<string, readonly MessageBlock[]>,
  modelId?: string | null): TailSelection | null {
  if (turns.length === 0) return null;

  // Signature fidelity may let a single turn exceed the budget, but never the
  // whole tail beyond budget * 2, otherwise compaction can loop forever.
  const SIGNATURE_GRACE = 2.0;
  const hardCap = Math.trunc(budgetTokens * SIGNATURE_GRACE);

  let selectedStartTurn: number | null = null;
  let tailTokens = 0;

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex]!;
    const turnTokens = sumTokens(messages, turn.start, turn.end, blocksByMsg, modelId);
    const hasSignature = turnHasLiveSignature(messages, turn, blocksByMsg);

    if (selectedStartTurn === null) {
      if (turnTokens > hardCap) {
        // Escape hatch: cut inside the last turn instead of abandoning
        // compaction. Tool call/result pairs live in one MessageBlock, so
        // message-granular cuts keep pairs intact.
        let accumulated = 0;
        let cutIndex: number | null = null;
        for (let index = turn.end - 1; index >= turn.start; index--) {
          const messageTokens = estimateMessageTokens(messages[index]!, blocksByMsg, modelId);
          if (accumulated + messageTokens > hardCap) break;
          accumulated += messageTokens;
          cutIndex = index;
        }
        if (cutIndex !== null && cutIndex > turn.start
          && (turns.length <= HEAD_USER_TURNS || cutIndex >= turns[HEAD_USER_TURNS - 1]!.end)) {
          segmentationLogger.info(`[compaction] last turn alone (${turnTokens} tokens)`
            + ` exceeds hard cap (${hardCap}); intra-turn tail cut at msg idx=${cutIndex}`
            + ` (tail ~${accumulated} tokens)`);
          return { tailStartIdx: cutIndex, tailTokens: accumulated };
        }
        // The final message alone exceeds the hard cap: abort rather than loop.
        segmentationLogger.warn(`[compaction] last turn alone (${turnTokens} tokens)`
          + ` exceeds hard cap (${hardCap}); aborting compaction to avoid loop`);
        return null;
      }
      tailTokens = turnTokens;
      selectedStartTurn = turnIndex;
      continue;
    }

    const newTotal = tailTokens + turnTokens;
    if (newTotal > hardCap) break;
    if (newTotal > budgetTokens && !hasSignature) break;
    tailTokens = newTotal;
    selectedStartTurn = turnIndex;
  }

  if (selectedStartTurn === null) return null;

  // Keep the opening HEAD_USER_TURNS turns as the task anchor. Clamp instead
  // of giving up, otherwise short signed conversations never compact.
  const clampedStart = Math.max(selectedStartTurn, HEAD_USER_TURNS);
  if (clampedStart >= turns.length) {
    segmentationLogger.debug(`[compaction] no middle to summarize (clamped_start=`
      + `${clampedStart}, total_turns=${turns.length}); skip`);
    return null;
  }

  const actualTailTokens = clampedStart !== selectedStartTurn
    ? sumTokens(messages, turns[clampedStart]!.start, turns[turns.length - 1]!.end, blocksByMsg, modelId)
    : tailTokens;

  return { tailStartIdx: turns[clampedStart]!.start, tailTokens: actualTailTokens };
}

export function splitSummaryRanges(messages: readonly ChatMessage[], turns: readonly TurnRange[],
  blocksByMsg: ReadonlyMap<string, readonly MessageBlock[]>, start: number, end: number,
  chunkBudget: number, perMsgTokenCap: number, modelId?: string | null): Array<[number, number]> {
  // Turns straddling [start, end) are clipped by intersection: intra-turn tail
  // cuts hide the turn head, which still needs summary coverage.
  const relevant: Array<[number, number]> = [];
  for (const turn of turns) {
    const turnStart = Math.max(turn.start, start);
    const turnEnd = Math.min(turn.end, end);
    if (turnStart < turnEnd) relevant.push([turnStart, turnEnd]);
  }
  if (relevant.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let rangeStart = relevant[0]![0];
  let rangeEnd = rangeStart;
  let rangeTokens = 0;
  for (const [turnStart, turnEnd] of relevant) {
    let turnTokens = 0;
    for (let index = turnStart; index < turnEnd; index++) {
      turnTokens += Math.min(estimateMessageTokens(messages[index]!, blocksByMsg, modelId), perMsgTokenCap);
    }
    turnTokens = Math.max(1, turnTokens);
    if (rangeEnd > rangeStart && rangeTokens + turnTokens > chunkBudget) {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = turnStart;
      rangeTokens = 0;
    }
    rangeEnd = turnEnd;
    rangeTokens += turnTokens;
  }
  if (rangeEnd > rangeStart) ranges.push([rangeStart, rangeEnd]);
  return ranges;
}
