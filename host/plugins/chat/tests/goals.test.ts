import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import type { GoalRecord } from '../api.ts';
import * as goals from '../repository/goals.ts';

function sample(sessionId: string, goalId: string): GoalRecord {
  return { sessionId, goalId, objective: '学完线性代数第 3 章', status: 'active', tokenBudget: 100_000,
    tokensUsed: 0, timeUsedSeconds: 0, continuationCount: 0, createdAtMs: 1000, updatedAtMs: 1000 };
}

describe('chat_v2/repo.rs goal_tests', () => {
  let f: ReturnType<typeof databaseFixture>;
  beforeEach(() => { f = databaseFixture(); });
  afterEach(() => f.dispose());
  it('goal_crud_roundtrip', () => {
    const record = sample('sess_goal_1', 'goal_aaa');
    goals.insertGoal(f.db, record);
    expect(goals.getGoal(f.db, record.sessionId)).toEqual(record);
    expect(goals.getGoal(f.db, 'sess_missing')).toBeNull();
    const updated = goals.updateObjective(f.db, record.sessionId, '学完线性代数第 4 章', null)!;
    expect(updated.objective).toBe('学完线性代数第 4 章');
    expect(updated.tokenBudget).toBeNull();
    expect(updated.status).toBe('active');
    expect(updated.updatedAtMs).toBeGreaterThanOrEqual(record.updatedAtMs);
    expect(goals.updateStatus(f.db, record.sessionId, record.goalId, 'complete')!.status).toBe('complete');
    goals.deleteGoal(f.db, record.sessionId);
    expect(goals.getGoal(f.db, record.sessionId)).toBeNull();
    goals.deleteGoal(f.db, record.sessionId);
  });
  it('goal_update_status_optimistic_concurrency', () => {
    goals.insertGoal(f.db, sample('sess_occ', 'goal_real'));
    expect(goals.updateStatus(f.db, 'sess_occ', 'goal_stale', 'paused')).toBeNull();
    expect(goals.getGoal(f.db, 'sess_occ')!.status).toBe('active');
    expect(goals.updateStatus(f.db, 'sess_missing', 'goal_real', 'paused')).toBeNull();
  });
  it('goal_add_usage_accumulates', () => {
    goals.insertGoal(f.db, sample('sess_usage', 'goal_u1'));
    goals.addUsage(f.db, 'sess_usage', 'goal_u1', 100, 5);
    goals.addUsage(f.db, 'sess_usage', 'goal_u1', 50, 7);
    expect(goals.getGoal(f.db, 'sess_usage')).toMatchObject({ tokensUsed: 150, timeUsedSeconds: 12 });
    goals.addUsage(f.db, 'sess_usage', 'goal_stale', 999, 999);
    expect(goals.getGoal(f.db, 'sess_usage')).toMatchObject({ tokensUsed: 150, timeUsedSeconds: 12 });
  });
  it('goal_claim_continuation_counts', () => {
    goals.insertGoal(f.db, sample('sess_cont', 'goal_c1'));
    expect(goals.claimContinuation(f.db, 'sess_cont', 'goal_c1', 20)).toBe(true);
    expect(goals.claimContinuation(f.db, 'sess_cont', 'goal_c1', 20)).toBe(true);
    expect(goals.claimContinuation(f.db, 'sess_cont', 'goal_stale', 20)).toBe(false);
    expect(goals.getGoal(f.db, 'sess_cont')!.continuationCount).toBe(2);
  });
  it('goal_claim_continuation_rejects_stale_or_exhausted_goal', () => {
    goals.insertGoal(f.db, sample('sess_claim', 'goal_p1'));
    goals.updateStatus(f.db, 'sess_claim', 'goal_p1', 'paused');
    expect(goals.claimContinuation(f.db, 'sess_claim', 'goal_p1', 20)).toBe(false);
    expect(goals.getGoal(f.db, 'sess_claim')!.continuationCount).toBe(0);
    goals.updateStatus(f.db, 'sess_claim', 'goal_p1', 'active');
    expect(goals.claimContinuation(f.db, 'sess_claim', 'goal_p1', 1)).toBe(true);
    expect(goals.claimContinuation(f.db, 'sess_claim', 'goal_p1', 1)).toBe(false);
    goals.addUsage(f.db, 'sess_claim', 'goal_p1', 100_000, 0);
    expect(goals.claimContinuation(f.db, 'sess_claim', 'goal_p1', 20)).toBe(false);
    goals.deleteGoal(f.db, 'sess_claim');
    expect(goals.claimContinuation(f.db, 'sess_claim', 'goal_p1', 20)).toBe(false);
  });
  it('goal_status_check_constraint_enforced', () => {
    expect(() => goals.insertGoal(f.db, { ...sample('sess_bad', 'goal_bad'), status: 'flying' })).toThrow();
  });
  it('goal_record_serializes_camel_case', () => {
    const value = JSON.parse(JSON.stringify(sample('sess_ser', 'goal_ser')));
    for (const key of ['sessionId', 'goalId', 'objective', 'status', 'tokenBudget', 'tokensUsed', 'timeUsedSeconds', 'continuationCount', 'createdAtMs', 'updatedAtMs']) {
      expect(value).toHaveProperty(key);
    }
    expect(value).not.toHaveProperty('session_id');
  });
});
