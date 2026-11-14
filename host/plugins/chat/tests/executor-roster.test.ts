import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { APP_EXECUTOR_ROSTER, PIPELINE_EXECUTOR_TAIL, WORKSPACE_COORDINATOR_GROUP, MissingExecutorError } from '../../../kernel/api.ts';
import plugin from '../index.ts';
import { vfsStub } from './database-fixture.ts';
import { ChatV2Emitter, type ExecutionContext, type ToolApprovalPolicyPort } from '../api.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';

describe('L04 runtime consumes L07 executor contributions in the Rust roster order', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let contributions: AgentToolExecutor[];
  const approval: ToolApprovalPolicyPort = { ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false };
  beforeEach(async () => {
    contributions = [];
    host = await createTestHost({ plugins: [plugin], provide: {
      storage: {}, vfs: vfsStub, agentTools: { toolExecutors: () => contributions },
    } });
  });
  afterEach(async () => { await host.dispose(); });
  function foreignExecutor(name: string): AgentToolExecutor {
    return { name: () => name, canHandle: tool => tool === 'shared', async execute(call, context) {
      const ctx = context as ExecutionContext;
      return { toolName: 'shared', input: call, success: true, output: { owner: name, admission: ctx.shell_authority_admission } };
    } };
  }
  it('rejects absent and routing-only contributions rather than creating successful placeholders', () => {
    contributions = APP_EXECUTOR_ROSTER.map(name => ({ name: () => name, canHandle: () => true }));
    try {
      host.ctx.chatSession.assembleExecutorRegistry([], approval, false);
      throw new Error('expected missing executors');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingExecutorError);
      expect((error as MissingExecutorError).names).toContain('AttemptCompletionExecutor');
    }
  });
  it('sorts complete foreign contributions by the fixed roster and executes through the scoped registry', async () => {
    const names = [...APP_EXECUTOR_ROSTER, ...PIPELINE_EXECUTOR_TAIL];
    contributions = names.toReversed().map(foreignExecutor);
    const registry = host.ctx.chatSession.assembleExecutorRegistry([], approval, false);
    expect(registry.executorNames()).toEqual(names);
    const ctx = host.ctx.chatSession.createExecutionContext({ sessionId: 's', messageId: 'm', blockId: 'b', services: host.ctx,
      emitter: ChatV2Emitter.newHeadless('s'), toolRegistry: { async detectToolConflicts() { return []; }, stripMcpNamespace: name => name,
        async callTool() { throw new Error('not used by foreign roster fixture'); } } });
    ctx.shell_authority_admission = ['craft', 'cautious'];
    expect((await registry.execute({ id: 'c', name: 'shared', arguments: {} }, ctx)).output)
      .toEqual({ owner: 'AttemptCompletionExecutor', admission: ['craft', 'cautious'] });
  });
  it('requires workspace group only when the caller has a coordinator and observes later contributions', () => {
    contributions = [...APP_EXECUTOR_ROSTER, ...PIPELINE_EXECUTOR_TAIL].map(foreignExecutor);
    expect(() => host.ctx.chatSession.assembleExecutorRegistry([], approval, true)).toThrow('WorkspaceToolExecutor');
    contributions.push(...WORKSPACE_COORDINATOR_GROUP.map(foreignExecutor));
    expect(host.ctx.chatSession.assembleExecutorRegistry([], approval, true).executorNames())
      .toEqual([...APP_EXECUTOR_ROSTER, ...WORKSPACE_COORDINATOR_GROUP, ...PIPELINE_EXECUTOR_TAIL]);
  });
});
