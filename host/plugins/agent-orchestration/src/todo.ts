/**
 * 待办（todo_*）工具的数据模型与 schema（todo_executor.rs:34–178, 356–474）。
 *
 * 运行时按会话保存列表；这里保留与 Rust 相同的结构与派生计数语义。
 */
// boundary-allow todo-marker: Rust tool namespace is literally "todo".
export const TODO_NAMESPACE = 'todo';

export const TODO_TOOL_NAMES = {
  init: 'todo_init',
  update: 'todo_update',
  add: 'todo_add',
  get: 'todo_get',
} as const;

export type TodoStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** Rust i64: ordinary millisecond timestamps stay numbers; large historical values retain precision. */
export type TodoTimestamp = number | bigint;

export interface TodoStep {
  id: string;
  description: string;
  status: TodoStatus;
  result: string | null;
  createdAt: TodoTimestamp;
  updatedAt: TodoTimestamp | null;
}

export function createTodoStep(id: string, description: string, nowMs: number = Date.now()): TodoStep {
  return { id, description, status: 'pending', result: null, createdAt: nowMs, updatedAt: null };
}

export interface TodoList {
  id: string;
  title: string;
  steps: TodoStep[];
  createdAt: TodoTimestamp;
  updatedAt: TodoTimestamp;
}

export function createTodoList(
  title: string, steps: TodoStep[], nowMs: number = Date.now(),
): TodoList {
  return {
    id: `todo_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
    title,
    steps,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export function todoCompletedCount(list: TodoList): number {
  return list.steps.filter((step) => step.status === 'completed').length;
}

export function todoTotalCount(list: TodoList): number {
  return list.steps.length;
}

/** A list is done when every step is completed, failed or skipped. */
export function todoIsAllDone(list: TodoList): boolean {
  return list.steps.every((step) => step.status === 'completed' || step.status === 'failed'
    || step.status === 'skipped');
}

export function todoNextPending(list: TodoList): TodoStep | null {
  return list.steps.find((step) => step.status === 'pending') ?? null;
}

export function todoCurrentRunning(list: TodoList): TodoStep | null {
  return list.steps.find((step) => step.status === 'running') ?? null;
}

export interface TodoToolSchema {
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
}

export function todoInitSchema(): TodoToolSchema {
  return {
    type: 'function',
    function: {
      name: TODO_TOOL_NAMES.init,
      description: '开始任务时调用，将复杂任务分解为可执行的子步骤列表。每个步骤应该是具体、可验证的操作。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务的整体目标或标题' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { description: { type: 'string', description: '步骤描述，具体说明要做什么' } },
              required: ['description'],
            },
            description: '任务步骤列表，按执行顺序排列',
          },
        },
        required: ['title', 'steps'],
      },
    },
  };
}

export function todoUpdateSchema(): TodoToolSchema {
  return {
    type: 'function',
    function: {
      name: TODO_TOOL_NAMES.update,
      description: '更新任务步骤的状态。每完成一个步骤都应调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string', description: '要更新的步骤 ID' },
          status: { type: 'string', enum: ['running', 'completed', 'failed', 'skipped'], description: '新状态' },
          result: { type: 'string', description: '执行结果摘要（完成或失败时提供）' },
        },
        required: ['stepId', 'status'],
      },
    },
  };
}

export function todoAddSchema(): TodoToolSchema {
  return {
    type: 'function',
    function: {
      name: TODO_TOOL_NAMES.add,
      description: '在执行过程中发现需要额外步骤时，动态添加新任务。',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '新步骤的描述' },
          afterStepId: { type: 'string', description: '插入位置，在此步骤之后插入。省略则添加到末尾。' },
        },
        required: ['description'],
      },
    },
  };
}

export function todoGetSchema(): TodoToolSchema {
  return {
    type: 'function',
    function: {
      name: TODO_TOOL_NAMES.get,
      description: '获取当前任务列表及所有步骤的状态。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };
}

export function todoToolSchemas(): TodoToolSchema[] {
  return [todoInitSchema(), todoUpdateSchema(), todoAddSchema(), todoGetSchema()];
}
