/** todo_executor.rs:471–808 `TodoListExecutor` (memory store shared with DB restore via todo-store.ts). */
import type { ExecutionContext, ToolCall, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import { strip_tool_namespace } from '../../../platform/errors/api.ts';
import {
  TODO_TOOL_NAMES, createTodoList, createTodoStep, todoCompletedCount, todoCurrentRunning, todoIsAllDone,
  todoNextPending, todoToolSchemas, todoTotalCount, type TodoStatus, type TodoStep, type TodoTimestamp,
} from './todo.ts';
import { getTodoList, setTodoList } from './todo-store.ts';

export const TODO_LIST_EXECUTOR_NAME = 'TodoListExecutor';

type Log = (message: string) => void;
type Outcome = [Record<string, unknown>, boolean];

const field = (args: unknown, key: string): unknown =>
  args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>)[key] : undefined;
const NO_LIST = '未找到任务列表，请先调用 todo_init';

function timestamp(value: TodoTimestamp): number { return typeof value === 'bigint' ? Number(value) : value; }

/** serde camelCase view of `TodoStep`: `result` / `updatedAt` are skipped when None. */
function stepJson(step: TodoStep): Record<string, unknown> {
  const out: Record<string, unknown> = { id: step.id, description: step.description, status: step.status };
  if (step.result !== null) out.result = step.result;
  out.createdAt = timestamp(step.createdAt);
  if (step.updatedAt !== null) out.updatedAt = timestamp(step.updatedAt);
  return out;
}

const STATUS_ALIASES: Readonly<Record<string, TodoStatus>> = {
  running: 'running', in_progress: 'running', completed: 'completed', done: 'completed',
  failed: 'failed', error: 'failed', skipped: 'skipped', skip: 'skipped',
};

/**
 * Memory isolation key (todo_executor.rs:717–728): session id (message id when empty);
 * parallel variants add `:{variant_id}` so their lists never overwrite each other.
 */
export function todoSessionKey(ctx: Pick<ExecutionContext, 'session_id' | 'message_id' | 'variant_id'>): string {
  if (ctx.session_id === '') return ctx.message_id;
  return ctx.variant_id !== null ? `${ctx.session_id}:${ctx.variant_id}` : ctx.session_id;
}

export class TodoListExecutor {
  private readonly info: Log;
  private readonly warn: Log;
  private readonly now: () => number;
  constructor(log: { info: Log; warn: Log }, now: () => number = Date.now) {
    this.info = log.info; this.warn = log.warn; this.now = now;
  }

  canHandle(toolName: string): boolean {
    const bare = strip_tool_namespace(toolName);
    return bare === TODO_TOOL_NAMES.init || bare === TODO_TOOL_NAMES.update
      || bare === TODO_TOOL_NAMES.add || bare === TODO_TOOL_NAMES.get;
  }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    const key = todoSessionKey(ctx);
    let outcome: Outcome | undefined;
    let error: string | undefined;
    try {
      switch (strip_tool_namespace(call.name)) {
        case TODO_TOOL_NAMES.init: outcome = this.init(call.arguments, key); break;
        case TODO_TOOL_NAMES.update: outcome = this.update(call.arguments, key); break;
        case TODO_TOOL_NAMES.add: outcome = this.add(call.arguments, key); break;
        case TODO_TOOL_NAMES.get: outcome = this.get(key); break;
        default: throw new Error(`未知的 TODO 工具: ${call.name}`);
      }
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    const durationMs = Math.trunc(performance.now() - started);
    let result: ToolResultInfo;
    if (outcome !== undefined) {
      const [output, continueExecution] = outcome;
      ctx.emitToolCallEnd({ result: output, durationMs });
      this.info(`[TodoListExecutor] Tool ${call.name} completed: continue_execution=${continueExecution}`);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: { ...output, continue_execution: continueExecution }, success: true, durationMs };
    } else {
      ctx.emitToolCallError(error!);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error: error!, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (cause) { this.warn(`[TodoListExecutor] Failed to save tool block: ${cause instanceof Error ? cause.message : String(cause)}`); }
    return result;
  }

  sensitivityLevel(_toolName: string): ToolSensitivity { return 'low'; }
  name(): string { return TODO_LIST_EXECUTOR_NAME; }
  /** registry.rs:150–189. */
  schemaTools(): { id: string; schema: unknown }[] {
    return todoToolSchemas().map(schema => ({ id: schema.function.name, schema }));
  }

  private init(args: unknown, key: string): Outcome {
    const title = field(args, 'title');
    if (typeof title !== 'string') throw new Error('缺少必需参数: title');
    const raw = field(args, 'steps');
    if (!Array.isArray(raw)) throw new Error('缺少必需参数: steps');
    const now = this.now();
    const steps = raw.map((entry, index) => {
      const description = field(entry, 'description');
      return createTodoStep(`step_${index + 1}`, typeof description === 'string' ? description : '未命名步骤', now);
    });
    if (steps.length === 0) throw new Error('步骤列表不能为空');
    const list = createTodoList(title, steps, now);
    const total = todoTotalCount(list);
    const output = {
      success: true, todoListId: list.id, title: list.title, totalSteps: total,
      completedCount: todoCompletedCount(list), totalCount: total, isAllDone: todoIsAllDone(list),
      steps: list.steps.map(stepJson), message: `已创建任务列表「${title}」，共 ${total} 个步骤`,
    };
    setTodoList(key, list);
    return [output, true];
  }

  private update(args: unknown, key: string): Outcome {
    const stepId = field(args, 'stepId');
    if (typeof stepId !== 'string') throw new Error('缺少必需参数: stepId');
    const statusText = field(args, 'status');
    if (typeof statusText !== 'string') throw new Error('缺少必需参数: status');
    const status = Object.hasOwn(STATUS_ALIASES, statusText) ? STATUS_ALIASES[statusText]! : null;
    if (status === null) throw new Error(`无效的状态: ${statusText}`);
    const resultText = field(args, 'result');
    const list = getTodoList(key);
    if (list === null) throw new Error(NO_LIST);
    const step = list.steps.find(candidate => candidate.id === stepId);
    if (step === undefined) throw new Error(`未找到步骤: ${stepId}`);
    step.status = status;
    step.result = typeof resultText === 'string' ? resultText : null;
    step.updatedAt = this.now();
    list.updatedAt = this.now();
    const done = todoIsAllDone(list);
    const completed = todoCompletedCount(list), total = todoTotalCount(list);
    const next = todoNextPending(list);
    setTodoList(key, list);
    const output = {
      success: true, stepId, newStatus: statusText, progress: `${completed}/${total}`,
      completedCount: completed, totalCount: total, isAllDone: done,
      nextStep: next === null ? null : stepJson(next), title: list.title, steps: list.steps.map(stepJson),
      message: done ? '🎉 所有任务已完成！' : `已更新步骤状态，进度: ${completed}/${total}`,
    };
    return [output, !done];
  }

  private add(args: unknown, key: string): Outcome {
    const description = field(args, 'description');
    if (typeof description !== 'string') throw new Error('缺少必需参数: description');
    const after = field(args, 'afterStepId');
    const list = getTodoList(key);
    if (list === null) throw new Error(NO_LIST);
    const stepId = `step_${list.steps.length + 1}`;
    const step = createTodoStep(stepId, description, this.now());
    const position = typeof after === 'string' ? list.steps.findIndex(candidate => candidate.id === after) : -1;
    if (position >= 0) list.steps.splice(position + 1, 0, step);
    else list.steps.push(step);
    list.updatedAt = this.now();
    const total = todoTotalCount(list), done = todoIsAllDone(list);
    setTodoList(key, list);
    const output = {
      success: true, stepId, description, totalSteps: total, completedCount: todoCompletedCount(list),
      totalCount: total, isAllDone: done, title: list.title, steps: list.steps.map(stepJson),
      message: `已添加新步骤: ${description}`,
    };
    return [output, !done];
  }

  private get(key: string): Outcome {
    const list = getTodoList(key);
    if (list === null) throw new Error(NO_LIST);
    const completed = todoCompletedCount(list), total = todoTotalCount(list), done = todoIsAllDone(list);
    const next = todoNextPending(list), running = todoCurrentRunning(list);
    const output = {
      success: true, todoListId: list.id, title: list.title, progress: `${completed}/${total}`,
      completedCount: completed, totalCount: total, isAllDone: done, steps: list.steps.map(stepJson),
      nextStep: next === null ? null : stepJson(next), currentRunning: running === null ? null : stepJson(running),
    };
    return [output, !done];
  }
}
