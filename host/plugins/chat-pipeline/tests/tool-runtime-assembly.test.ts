import { describe, expect, it } from 'vitest';
import {
  APP_EXECUTOR_ROSTER, EXECUTOR_ROSTER_LEDGER, PIPELINE_EXECUTOR_TAIL, WORKSPACE_COORDINATOR_GROUP,
  orderExecutorsByRoster,
} from '../../../kernel/agent-roster.ts';
import { assembleRuntimeExecutors, schemaToolRegistry, toolAdvertisement } from '../src/tool-runtime.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { ToolExecutor } from '../../chat/api.ts';

function executor(name: string, handles: (tool: string) => boolean, options: { executable?: boolean;
  schemas?: { id: string; schema: unknown }[] } = {}): AgentToolExecutor {
  return {
    name: () => name, canHandle: handles,
    ...(options.executable === false ? {} : { execute: async () => ({}) }),
    ...(options.schemas === undefined ? {} : { schemaTools: () => options.schemas! }),
  };
}
const only = (...names: string[]) => (tool: string) => names.includes(tool);
const names = (list: readonly { name(): string }[]) => list.map(entry => entry.name());

/** Minimal first-wins lookup with the L04 external-MCP rule, enough for the advertisement predicate. */
function lookup(executors: readonly ToolExecutor[]) {
  return { getExecutor: (tool: string) => tool.startsWith('mcp_') && tool !== 'mcp_server_update'
    ? executors.find(entry => entry.name() === 'GeneralToolExecutor') ?? null
    : executors.find(entry => entry.canHandle(tool)) ?? null };
}

describe('roster-ordered runtime assembly (roster.rs + pipeline.rs assemble_registry)', () => {
  it('orders registrations by the Rust roster regardless of plugin registration order and appends the General tail', () => {
    const registered = [
      executor('ChatAnkiStatusExecutor', only('chatanki_status')),
      executor('AskUserExecutor', only('ask_user')),
      executor('PtcExecutor', only('ptc_run')),
      executor('AttemptCompletionExecutor', only('attempt_completion')),
      executor('MemoryToolExecutor', only('memory_search'), { executable: false }),
    ];
    const { executors, missing } = assembleRuntimeExecutors(registered, false);
    expect(names(executors)).toEqual(['AttemptCompletionExecutor', 'AskUserExecutor', 'ChatAnkiStatusExecutor',
      'PtcExecutor', 'GeneralToolExecutor']);
    expect(missing).toContain('MemoryToolExecutor');
    expect(missing).not.toContain('GeneralToolExecutor');
  });

  it('drops the coordinator group without a workspace and keeps it, in roster order, with one', () => {
    const registered = [executor('CoordinatorSleepExecutor', only('coordinator_sleep')),
      executor('CustomAgentExecutor', only('custom_agent_list'))];
    expect(names(orderExecutorsByRoster(registered, { workspace: false }).executors)).toEqual([]);
    expect(names(orderExecutorsByRoster(registered, { workspace: true }).executors))
      .toEqual(['CustomAgentExecutor', 'CoordinatorSleepExecutor']);
  });

  it('keeps a plugin-registered General tail instead of adding a second one', () => {
    const own = executor('GeneralToolExecutor', () => true);
    const { executors } = assembleRuntimeExecutors([own], false);
    expect(executors).toEqual([own]);
  });

  it('builds the schema_tool_ids registry only from executable executors', () => {
    const executors = assembleRuntimeExecutors([
      executor('TodoListExecutor', only('todo_get'), { schemas: [{ id: 'todo_get', schema: { name: 'todo_get' } }] }),
      executor('GoalExecutor', only('goal_get'), { executable: false, schemas: [{ id: 'goal_get', schema: {} }] }),
    ], false).executors;
    const registry = schemaToolRegistry(executors);
    expect(registry.getSchemas(['goal_get', 'todo_get'])).toEqual([{ name: 'todo_get' }]);
  });

  it('advertises builtin names only with a specific executor and external MCP names through the General tail', () => {
    const { executors } = assembleRuntimeExecutors([executor('AskUserExecutor', only('builtin-ask_user'))], false);
    const advertisement = toolAdvertisement(lookup(executors), () => 0);
    expect(advertisement.advertises('builtin-ask_user')).toBe(true);
    expect(advertisement.advertises('builtin-qbank_list')).toBe(false);
    expect(advertisement.advertises('mcp_brave_search')).toBe(true);
    expect(advertisement.advertises('mcp_server_update')).toBe(false);
  });

  it('the roster ledger covers exactly the roster names, each with its Rust source', () => {
    const all = [...APP_EXECUTOR_ROSTER, ...WORKSPACE_COORDINATOR_GROUP, ...PIPELINE_EXECUTOR_TAIL];
    expect(Object.keys(EXECUTOR_ROSTER_LEDGER).sort()).toEqual([...all].sort());
    for (const entry of Object.values(EXECUTOR_ROSTER_LEDGER)) expect(entry.rust).toMatch(/\.rs$/);
  });
});
