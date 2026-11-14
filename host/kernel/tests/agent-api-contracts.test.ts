/**
 * dstu-agent-api 契约层：executor / context / host / provider 的默认方法。
 *
 * 这些默认值对应 Rust trait 的默认实现（`crates/dstu-agent-api/src/{executor,context,host,provider}.rs`），
 * 领域执行器只实现 canHandle/execute 时行为必须与 Rust 一致。
 */
import { describe, expect, it } from 'vitest';
import {
  AgentServices,
  DEFAULT_TOOL_RESULT_CHAR_BUDGET,
  DescriptorTable,
  ExecutionContext,
  HostRequest,
  ToolDescriptor,
  ToolExecutorBase,
  ToolRegistryBuilder,
  executorConcurrencyClass,
  executorHasDynamicSensitivity,
  executorManagesCancellation,
  executorResultCharBudget,
  executorSensitivity,
  executorSensitivityForCall,
  type AgentToolCall,
  type AgentToolResultInfo,
  type AppEventEmitter,
  type HostBridge,
  type RuntimeRootResolver,
  type ToolBlockStore,
  type ToolExecutor,
} from '../agent-api.ts';

const CALL: AgentToolCall = { id: 'call-1', name: 'demo_tool', arguments: { value: 1 } };

const emitter: AppEventEmitter = {
  hasFrontend: () => true,
  emitBlockEvent: () => {},
  emitSessionEvent: () => {},
};
const host: HostBridge = {
  hasFrontend: () => false,
  emit: () => {},
  roundTrip: async () => null,
  asAny: () => null,
};
const runtimeRoots: RuntimeRootResolver = {
  artifactRoot: () => '/artifact',
  tempRoot: () => '/temp',
  workspaceRoot: () => '/workspace',
  resolve: relative => `/workspace/${relative}`,
  authorize: () => {},
};
const blockStore: ToolBlockStore = { upsertToolBlock: () => {} };

function context(signal = new AbortController().signal): ExecutionContext {
  return new ExecutionContext({
    call: CALL,
    emitter,
    services: new AgentServices(),
    host,
    runtimeRoots,
    blockStore,
    dispatcher: { dispatchAdmitted: async () => result() },
    cancel: signal,
  });
}

function result(): AgentToolResultInfo {
  return { toolName: 'demo_tool', input: CALL.arguments, output: null, success: true };
}

class DemoExecutor extends ToolExecutorBase {
  canHandle(toolName: string): boolean { return toolName === 'demo_tool'; }
  async execute(): Promise<AgentToolResultInfo> { return result(); }
}

class SensitiveExecutor extends DemoExecutor {
  override sensitivityLevel(): 'high' { return 'high'; }
}

describe('ToolExecutor defaults', () => {
  it('conservative defaults match the Rust trait', () => {
    const executor = new DemoExecutor();
    expect(executor.sensitivityLevel('demo_tool')).toBe('low');
    expect(executor.sensitivityLevelForCall('demo_tool', { value: 1 })).toBe('low');
    expect(executor.hasDynamicSensitivity('demo_tool')).toBe(false);
    expect(executor.concurrencyClass('demo_tool')).toBe('serial');
    expect(executor.managesCancellation('demo_tool')).toBe(false);
    expect(executor.resultCharBudget('demo_tool')).toBe(DEFAULT_TOOL_RESULT_CHAR_BUDGET);
    expect(executor.name()).toBe('DemoExecutor');
  });

  it('sensitivity_level_for_call delegates to the name-level baseline', () => {
    const executor = new SensitiveExecutor();
    expect(executor.sensitivityLevelForCall('demo_tool', {})).toBe('high');
  });

  it('helpers apply defaults to interface-only executors', () => {
    const executor: ToolExecutor = {
      canHandle: () => true,
      execute: async () => result(),
      name: () => 'InterfaceExecutor',
    };
    expect(executorSensitivity(executor, 'demo_tool')).toBe('low');
    expect(executorSensitivityForCall(executor, 'demo_tool', {})).toBe('low');
    expect(executorHasDynamicSensitivity(executor, 'demo_tool')).toBe(false);
    expect(executorConcurrencyClass(executor, 'demo_tool')).toBe('serial');
    expect(executorManagesCancellation(executor, 'demo_tool')).toBe(false);
    expect(executorResultCharBudget(executor, 'demo_tool')).toBe(DEFAULT_TOOL_RESULT_CHAR_BUDGET);
  });

  it('null result budget disables the outer budget', () => {
    class UnboundedExecutor extends DemoExecutor {
      override resultCharBudget(): null { return null; }
    }
    expect(executorResultCharBudget(new UnboundedExecutor(), 'demo_tool')).toBeNull();
  });
});

describe('ExecutionContext', () => {
  it('exposes cancellation and frontend availability', () => {
    const controller = new AbortController();
    const ctx = context(controller.signal);
    expect(ctx.isCancelled()).toBe(false);
    expect(ctx.hasFrontend()).toBe(false);
    controller.abort();
    expect(ctx.isCancelled()).toBe(true);
  });

  it('fills Rust Default values for ids, flags and request', () => {
    const ctx = context();
    expect(ctx.ids).toEqual({ sessionId: '', messageId: '', toolCallId: '', round: 0 });
    expect(ctx.flags).toEqual({ memoryEnabled: false, ragEnabled: false, webSearchEnabled: false, supportsTools: false });
    expect(ctx.request).toEqual({});
  });
});

describe('HostRequest', () => {
  it('serializes to the camelCase shape with an optional timeout', () => {
    expect(new HostRequest('acr_bridge_call', { method: 'ping' })).toEqual({ channel: 'acr_bridge_call', payload: { method: 'ping' }, timeoutMs: undefined });
    const timed = new HostRequest('mcp-bridge-request', null).withTimeoutMs(1_500);
    expect(timed).toEqual({ channel: 'mcp-bridge-request', payload: null, timeoutMs: 1_500 });
  });
});

describe('Provider defaults and descriptor table', () => {
  const executor = { name: () => 'DemoExecutor' };

  it('absent isCatchAll and headlessSchemas behave like the Rust defaults', () => {
    const registry = new ToolRegistryBuilder<typeof executor>()
      .register({
        id: 'demo',
        descriptors: () => [new ToolDescriptor('demo_tool')],
        executor: () => executor,
        executors: () => [executor],
      })
      .build();
    expect(registry.catchAllProvider()).toBeUndefined();
    expect(registry.executorFor('demo_tool')).toBe(executor);
  });

  it('descriptor table exposes get/contains/len/iter', () => {
    const table = new DescriptorTable([['demo_tool', new ToolDescriptor('demo_tool')]]);
    expect(table.get('demo_tool')?.name).toBe('demo_tool');
    expect(table.contains('demo_tool')).toBe(true);
    expect(table.contains('other_tool')).toBe(false);
    expect(table.len()).toBe(1);
    expect(table.isEmpty()).toBe(false);
    expect([...table.iter().keys()]).toEqual(['demo_tool']);
  });
});
