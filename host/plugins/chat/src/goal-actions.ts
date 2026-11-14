/**
 * `chat_v2/handlers/goal_handlers.rs` user-side goal transitions.
 * Runtime continuation scheduling/cancellation belongs to the automation lane;
 * these functions return exactly the persisted record and let the command emit.
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { GoalRecord } from '../api.ts';
import { ChatV2Error } from './error.ts';
import { ensureSessionWritable } from './handlers.ts';
import { deleteGoal, getGoal, updateStatus } from '../repository/goals.ts';

/** `goal_updated` is emitted only when the persisted record actually changed. */
export interface GoalTransition { goal: GoalRecord; changed: boolean }

/** `chat_v2_goal_pause` (goal_handlers.rs:86-122). */
export function pauseGoal(db: DatabaseHandle, sessionId: string): GoalTransition {
  ensureSessionWritable(db, sessionId);
  const goal = getGoal(db, sessionId);
  if (!goal) throw new ChatV2Error('Validation', 'cannot pause goal because this session has no goal');
  if (goal.status !== 'active' && goal.status !== 'waiting_user') return { goal, changed: false };
  const updated = updateStatus(db, sessionId, goal.goalId, 'paused');
  if (!updated) throw new ChatV2Error('Validation', 'goal was modified concurrently; please retry');
  return { goal: updated, changed: true };
}

/** `chat_v2_goal_resume` (goal_handlers.rs:127-169). */
export function resumeGoal(db: DatabaseHandle, sessionId: string): GoalTransition {
  ensureSessionWritable(db, sessionId);
  const goal = getGoal(db, sessionId);
  if (!goal) throw new ChatV2Error('Validation', 'cannot resume goal because this session has no goal');
  if (!['paused', 'blocked', 'budget_limited', 'usage_limited'].includes(goal.status)) {
    return { goal, changed: false };
  }
  const updated = updateStatus(db, sessionId, goal.goalId, 'active');
  if (!updated) throw new ChatV2Error('Validation', 'goal was modified concurrently; please retry');
  return { goal: updated, changed: true };
}

/** `chat_v2_goal_clear` (goal_handlers.rs:214-230); deleting an absent goal succeeds silently. */
export function clearGoal(db: DatabaseHandle, sessionId: string): void {
  ensureSessionWritable(db, sessionId);
  deleteGoal(db, sessionId);
}
