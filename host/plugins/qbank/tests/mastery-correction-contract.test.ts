/**
 * `src-tauri/tests/mastery_qbank_correction.rs` 的两个跨 crate 黑盒契约。
 *
 * 原 TESTMAP 把这两条并入 `review/tests/mastery.test.ts`，但目标用例缺少
 * 首判链长/锁定链长/同向重放链长等关键断言；这里按 Rust 原序列完整重放，
 * 生产入口是 review 插件通过 `mastery` 服务暴露的 pub 纠正 API。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import review from '../../review/index.ts';

interface MasteryState {
  score: number;
  total: number;
  wrongCount: number;
  streak: number;
}

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-mastery-correction-');
  const host = await createTestHost({ plugins: [review], provide: { storage } });
  const db = storage.database('vfs');
  const mastery = host.ctx.mastery;
  return {
    db, mastery,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function eventRow(db: DatabaseHandle, eventId: string) {
  return db.get<{ outcome: string; weight: number; deleted_at: string | null }>(
    'SELECT outcome, weight, deleted_at FROM mastery_events WHERE id = ?1', [eventId]);
}

/** Rust `chain_count`：base + `_r{n}` 前缀匹配，包含 tombstone。 */
function chainCount(db: DatabaseHandle, submissionId: string): number {
  const base = `me_qbank_${submissionId}`;
  return db.pluck<number>(
    `SELECT COUNT(*) FROM mastery_events
      WHERE id = ?1 OR substr(id, 1, length(?2)) = ?2`, [base, `${base}_r`])!;
}

describe('tests/mastery_qbank_correction.rs', () => {
  it('false_to_true_correction_recomputes_state_and_breaks_first_verdict_lock', async () => {
    const f = await fixture();
    try {
      const submissionId = 'sub_it_corr_main';
      const questionId = 'q_it_corr_main';
      const tags = ['集成换判概念'];

      const first = f.db.transaction(
        tx => f.mastery.recordQbankAnswerWithConn(tx, submissionId, questionId, tags, false),
        { behavior: 'immediate' }) as MasteryState;
      expect(first.total).toBe(1);
      expect(first.wrongCount).toBe(1);
      expect(Math.abs(first.score - 0.35)).toBeLessThan(1e-9);

      const locked = f.db.transaction(
        tx => f.mastery.recordQbankAnswerWithConn(tx, submissionId, questionId, tags, true),
        { behavior: 'immediate' }) as MasteryState;
      expect(locked.wrongCount).toBe(1);
      expect(Math.abs(locked.score - 0.35)).toBeLessThan(1e-9);
      expect(chainCount(f.db, submissionId)).toBe(1);

      const corrected = f.mastery.recordQbankVerdictCorrection(
        submissionId, questionId, tags, true) as MasteryState;
      expect(Math.abs(corrected.score - 0.65)).toBeLessThan(1e-9);
      expect(corrected.total).toBe(1);
      expect(corrected.wrongCount).toBe(0);
      expect(corrected.streak).toBe(1);

      const base = eventRow(f.db, `me_qbank_${submissionId}`);
      expect(base).not.toBeNull();
      expect(base!.deleted_at).not.toBeNull();
      expect(base!.outcome).toBe('wrong');
      const revision = eventRow(f.db, `me_qbank_${submissionId}_r1`);
      expect(revision).not.toBeNull();
      expect(revision!.outcome).toBe('correct');
      expect(revision!.deleted_at).toBeNull();
      expect(Math.abs(revision!.weight - 1)).toBeLessThan(1e-9);
      expect(chainCount(f.db, submissionId)).toBe(2);
    } finally { await f.dispose(); }
  });

  it('correction_same_direction_replay_is_idempotent', async () => {
    const f = await fixture();
    try {
      const submissionId = 'sub_it_corr_replay';
      const questionId = 'q_it_corr_replay';
      const tags = ['纠正幂等概念'];

      f.db.transaction(
        tx => f.mastery.recordQbankAnswerWithConn(tx, submissionId, questionId, tags, false),
        { behavior: 'immediate' });

      const firstFlip = f.mastery.recordQbankVerdictCorrection(
        submissionId, questionId, tags, true) as MasteryState;
      expect(Math.abs(firstFlip.score - 0.65)).toBeLessThan(1e-9);
      expect(chainCount(f.db, submissionId)).toBe(2);

      const replay = f.mastery.recordQbankVerdictCorrection(
        submissionId, questionId, tags, true) as MasteryState;
      expect(Math.abs(replay.score - 0.65)).toBeLessThan(1e-9);
      expect(replay.total).toBe(1);
      expect(replay.wrongCount).toBe(0);
      expect(chainCount(f.db, submissionId)).toBe(2);
      expect(eventRow(f.db, `me_qbank_${submissionId}_r1`)!.deleted_at).toBeNull();
    } finally { await f.dispose(); }
  });
});
