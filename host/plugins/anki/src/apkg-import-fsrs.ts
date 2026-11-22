/**
 * Anki SM-2 → FSRS 调度换算（`anki_sched_to_fsrs`）。
 *
 * 只做纯换算；向 `fsrs_card_states` / `fsrs_review_logs` 写入由 L15 的
 * `review.enqueueImportedCardsInTx` 在调用方事务内完成（decisions D1/D4）。
 */
import type { FsrsImportedReviewLog } from '../../review/api.ts';
import type { AnkiRevlogRow } from '../repository/apkg-import.ts';
import {
  ANKI_DUE_TIMESTAMP_THRESHOLD,
  FSRS_DECAY,
  FSRS_STATE_LEARNING,
  FSRS_STATE_NEW,
  FSRS_STATE_RELEARNING,
  FSRS_STATE_REVIEW,
  FSRS_W8,
  FSRS_W9,
  FSRS_W10,
  MS_PER_DAY,
  SM2_HISTORICAL_RETENTION,
  ANKI_DEFAULT_EASE,
  type CardSchedState,
  type FsrsImportedSchedule,
  type ParsedCard,
} from './apkg-import-types.ts';

// ============================================================================
// FSRS 换算（`anki_sched_to_fsrs` / `sm2_to_fsrs_memory`）
// ============================================================================

/** `fsrs::FSRS::default().memory_state_from_sm2(ease, interval, 0.9)`（fsrs-rs 6.6.2）。 */
export function sm2ToFsrsMemory(factor: number, intervalDays: number): [number, number] {
  const ease = factor > 0 ? Math.fround(factor / 1000) : Math.fround(ANKI_DEFAULT_EASE);
  const interval = Math.fround(Math.max(intervalDays, 1));
  const decay = -FSRS_DECAY;
  const factorTerm = Math.pow(0.9, 1 / decay) - 1;
  const stability = (interval * factorTerm) / (Math.pow(SM2_HISTORICAL_RETENTION, 1 / decay) - 1);
  const difficulty = 11 - (ease - 1)
    / (Math.exp(FSRS_W8) * Math.pow(stability, -FSRS_W9) * Math.expm1((1 - SM2_HISTORICAL_RETENTION) * FSRS_W10));
  if (!Number.isFinite(stability) || !Number.isFinite(difficulty)) {
    return [interval, 5];
  }
  return [stability, Math.min(10, Math.max(1, difficulty))];
}

/** 新卡：New、无稳定度/难度、立即到期。 */
export function newImportedSchedule(nowMs: number, suspended: boolean): FsrsImportedSchedule {
  return {
    state: FSRS_STATE_NEW,
    stability: null,
    difficulty: null,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    dueMs: nowMs,
    lastReviewMs: null,
    suspended,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * 把 Anki 调度列换算为 FSRS 初始状态（`anki_sched_to_fsrs`）。
 *
 * Anki 语义：`type` 0=new 1=learning 2=review 3=relearning；`queue` -1=暂停、
 * -2/-3=埋藏、0=new、1=学习（due 为 unix 秒）、2=复习（due 为距 `col.crt` 的天数）、
 * 3=跨日学习（due 为天数）；`ivl` 正数为天、负数为秒。
 */
export function ankiSchedToFsrs(
  sched: CardSchedState,
  collectionCrtSecs: number | null,
  nowMs: number,
): FsrsImportedSchedule {
  const suspended = sched.queue === -1;
  const state = sched.cardType === 1
    ? FSRS_STATE_LEARNING
    : sched.cardType === 2
      ? FSRS_STATE_REVIEW
      : sched.cardType === 3
        ? FSRS_STATE_RELEARNING
        : FSRS_STATE_NEW;
  if (state === FSRS_STATE_NEW) return newImportedSchedule(nowMs, suspended);

  const dueMs = sched.due > ANKI_DUE_TIMESTAMP_THRESHOLD
    ? sched.due * 1000
    : collectionCrtSecs !== null
      ? collectionCrtSecs * 1000 + sched.due * MS_PER_DAY
      : nowMs;
  const ivlDays = Math.max(sched.ivl, 0);
  const [stability, difficulty] = sched.fsrsMemory ?? sm2ToFsrsMemory(sched.factor, ivlDays);
  const lastReviewMs = Math.min(
    sched.lastReviewSecs !== null ? sched.lastReviewSecs * 1000 : dueMs - ivlDays * MS_PER_DAY,
    nowMs,
  );
  return {
    state,
    stability,
    difficulty,
    elapsedDays: 0,
    scheduledDays: ivlDays,
    reps: clampInt(sched.reps, 0, 2_147_483_647),
    lapses: clampInt(sched.lapses, 0, 2_147_483_647),
    dueMs,
    lastReviewMs,
    suspended,
  };
}

/**
 * 把单张卡的 Anki `revlog` 行序列逆映射为 FSRS 复习日志条（`apkg-export-model.ts:321-350` 对称逆运算）。
 * 过滤掉无效评分（非 1..4）及非正时间戳行，并按 `reviewMs` 升序排列。
 */
export function convertAnkiRevlogRows(rows: readonly AnkiRevlogRow[]): FsrsImportedReviewLog[] {
  const valid = rows.filter(
    (row) => Number.isInteger(row.ease) && row.ease >= 1 && row.ease <= 4
      && Number.isFinite(row.id) && row.id > 0,
  );
  if (valid.length === 0) return [];
  const ordered = [...valid].sort((left, right) => left.id - right.id);
  const out: FsrsImportedReviewLog[] = [];
  let prevReviewMs: number | null = null;
  let prevStateAfter: number | null = null;

  for (const row of ordered) {
    const reviewMs = Math.trunc(row.id);
    const rating = row.ease;
    let stateBefore: number;
    if (row.type === 1) {
      stateBefore = FSRS_STATE_REVIEW;
    } else if (row.type === 2) {
      stateBefore = FSRS_STATE_RELEARNING;
    } else if (row.type === 0) {
      stateBefore = prevStateAfter === null && row.lastIvl === 0
        ? FSRS_STATE_NEW
        : FSRS_STATE_LEARNING;
    } else {
      stateBefore = prevStateAfter ?? (
        row.lastIvl > 0
          ? FSRS_STATE_REVIEW
          : row.lastIvl < 0
            ? FSRS_STATE_LEARNING
            : FSRS_STATE_NEW
      );
    }

    const stateAfter = row.ivl > 0
      ? FSRS_STATE_REVIEW
      : (stateBefore === FSRS_STATE_REVIEW || stateBefore === FSRS_STATE_RELEARNING)
          ? FSRS_STATE_RELEARNING
          : FSRS_STATE_LEARNING;

    const scheduledDays = row.ivl > 0 ? Math.trunc(row.ivl) : 0;
    const dueAfterMs = row.ivl > 0
      ? reviewMs + Math.trunc(row.ivl) * MS_PER_DAY
      : row.ivl < 0
        ? reviewMs + Math.trunc(-row.ivl) * 1000
        : reviewMs;
    const elapsedDays = prevReviewMs !== null
      ? Math.max(0, Math.round((reviewMs - prevReviewMs) / MS_PER_DAY))
      : row.lastIvl > 0
        ? Math.trunc(row.lastIvl)
        : 0;
    const durationMs = row.time >= 0 && Number.isFinite(row.time)
      ? Math.min(600_000, Math.trunc(row.time))
      : null;

    out.push({
      rating,
      stateBefore,
      stateAfter,
      scheduledDays,
      elapsedDays,
      reviewMs,
      dueAfterMs,
      durationMs,
    });
    prevReviewMs = reviewMs;
    prevStateAfter = stateAfter;
  }

  return out;
}

/** APKG 导入入队 Seed；与 L15 `FsrsImportedCard` 结构一致。 */
export interface EnqueueSeed {
  cardId: string;
  seed: FsrsImportedSchedule | null;
  reviewLogs?: readonly FsrsImportedReviewLog[];
}
