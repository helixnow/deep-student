/**
 * Goal 模式（P0）— 会话级持久目标类型
 *
 * 与后端 `chat_v2::repo::GoalRecord`（serde camelCase）逐字段对应。
 * 跨代理契约：字段名与 status 取值集合不得变更。
 *
 * 事件通道 `chat_v2_session_{sessionId}`：
 * `{"eventType":"goal_updated","sessionId":"...","goal": GoalRecord | null}`
 * （goal 为 null 表示目标已清除）。
 *
 * 独立成文件而非放进 store.ts：adapters/types.ts（SessionEventPayload）
 * 与 core/types/store.ts（ChatStore）都需要引用它，而后者已 import 前者，
 * 放任何一侧都会形成循环依赖。
 */

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete'
  | 'waiting_user';

export interface GoalRecord {
  sessionId: string;
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}
