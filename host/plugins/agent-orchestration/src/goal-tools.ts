/** goal_executor.rs:35–117,160–166. */

export const GOAL_CREATE = 'goal_create';
export const GOAL_UPDATE = 'goal_update';
export const GOAL_GET = 'goal_get';

export type GoalToolSchema = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
};

export function goalCreateSchema(): GoalToolSchema {
  return {
    type: 'function',
    function: {
      name: GOAL_CREATE,
      description: '创建一个新的会话目标。目标会跨轮次持续存在：本轮结束后系统会自动发起续跑轮继续推进，直到目标被标记完成。只有在用户明确提出一个需要多步推进的目标时才使用。token_budget 为正整数 token 预算，除非用户明确要求否则省略。',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: '要达成的目标描述，需具体、可验证' },
          token_budget: { type: 'integer', description: 'token 预算上限（正整数）。除非用户明确要求，否则省略。' },
        },
        required: ['objective'],
      },
    },
  };
}

export function goalUpdateSchema(): GoalToolSchema {
  return {
    type: 'function',
    function: {
      name: GOAL_UPDATE,
      description: '更新当前会话目标的状态。仅允许：complete（目标已达成——必须经过逐条证据核实，不得凭印象）、blocked（同一阻塞条件已连续多轮无法推进）、waiting_user（需要用户回答/输入才能继续，目标挂起直到用户回复）。pause/resume/预算类状态由用户或系统控制，模型不得设置。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['complete', 'blocked', 'waiting_user'], description: '新状态' },
        },
        required: ['status'],
      },
    },
  };
}

export function goalGetSchema(): GoalToolSchema {
  return {
    type: 'function',
    function: {
      name: GOAL_GET,
      description: '获取当前会话目标，含状态、token 预算、已用 token/时间与剩余预算。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };
}

export function goalToolSchemas(): GoalToolSchema[] {
  return [goalCreateSchema(), goalUpdateSchema(), goalGetSchema()];
}

export function canHandleGoalTool(toolName: string): boolean {
  const bare = toolName.startsWith('builtin-') ? toolName.slice('builtin-'.length) : toolName;
  return bare === GOAL_CREATE || bare === GOAL_UPDATE || bare === GOAL_GET;
}

/** goal_executor.rs:159–168. */
export function parseGoalTokenBudget(args: unknown): number | null {
  const object = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  const raw = object.token_budget;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error("'token_budget' must be a positive integer");
  }
  return raw;
}
