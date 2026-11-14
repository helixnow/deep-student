import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import type { ChatExecutionContext, ChatWorkerRuntimeService } from '../../chat/api.ts';
import type { SubagentTaskData, WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import plugin from '../index.ts';
import { SubagentExecutor } from '../src/subagent-executor.ts';

describe('chat_v2_background_subagent command wiring', () => {
  it('releases the registered executor wait through the real Host command registry', async () => {
    const tasks = new Map<string, SubagentTaskData>();
    const workspace = { id: 'ws-background', creatorSessionId: 'parent' };
    const coordinator = {
      createWorkspace: () => workspace, customAgentsDir: () => null,
      registerAgent: (_workspace: string, sessionId: string) => ({ sessionId }),
      getTaskManager: () => ({ createTask: (task: SubagentTaskData) => tasks.set(task.id, task),
        getTask: (id: string) => tasks.get(id) ?? null }),
      sendMessage: () => ({ id: 'task-message' }),
    } as unknown as WorkspaceCoordinator;
    let executor: SubagentExecutor | undefined;
    const worker = {
      isRunAvailable: () => true,
      sessionStore: { sessionMetadata: () => null, createSession: () => undefined },
      runWorkspaceAgentBackend: vi.fn(async () => ({ message_id: 'child-run', status: 'running' })),
      cancelWorkspaceAgentBackend: vi.fn(),
    } as unknown as ChatWorkerRuntimeService;
    const host = await createTestHost({ acl: CapabilityAcl.fromDirectory('linux'), plugins: [plugin], provide: {
      settings: { get: () => null, save: () => undefined },
      storage: { database: () => { throw new Error('No database needed by this command'); } },
      agentWorkspace: coordinator, chatWorkerRuntime: worker,
      agentTools: { registerToolExecutors: (entries: unknown[]) => {
        executor = entries.find((entry): entry is SubagentExecutor => entry instanceof SubagentExecutor) ?? executor;
        return { dispose: () => undefined };
      } },
    } });
    const controller = new AbortController();
    let running: ReturnType<SubagentExecutor['execute']> | undefined;
    try {
      expect(executor).toBeDefined();
      expect(host.ctx.commands.has('chat_v2_background_subagent')).toBe(true);
      await expect(host.invoke('chat_v2_background_subagent', { sessionId: 'parent', blockId: 'missing' },
        { window: 'main', webview: 'browser-content' })).rejects.toContain('not allowed');
      await expect(host.invoke('chat_v2_background_subagent', { sessionId: 'parent', blockId: 'missing' })).resolves.toBe(false);
      await expect(host.invoke('chat_v2_background_subagent', { sessionId: 'parent' })).rejects.toContain('blockId');
      const chunks: string[] = [];
      const ctx = { session_id: 'parent', message_id: 'message', block_id: 'block', chat_v2_db: {},
        skill_contents: null, llm_manager: null, cancellation_token: controller.signal,
        isCancelled: () => controller.signal.aborted,
        windowRef: () => ({ window: 'main', webview: 'main' }), services: host.ctx,
        emitter: { emitChunk: (_type: string, _block: string, chunk: string) => chunks.push(chunk) },
        emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
        saveToolBlock: () => undefined } as unknown as ChatExecutionContext;
      running = executor!.execute({ id: 'call', name: 'builtin-subagent_call', arguments: { task: 'research' } }, ctx);
      await expect.poll(() => chunks.length).toBe(1);
      await expect(host.invoke('chat_v2_background_subagent', { sessionId: 'wrong-parent', blockId: 'block' })).resolves.toBe(false);
      await expect(host.invoke('chat_v2_background_subagent', { sessionId: 'parent', blockId: 'block' })).resolves.toBe(true);
      expect(await running).toMatchObject({ success: true, output: {
        status: 'running', backgrounded: true, run_id: 'child-run',
      } });
      expect(worker.runWorkspaceAgentBackend).toHaveBeenCalledTimes(1);
      expect(worker.cancelWorkspaceAgentBackend).not.toHaveBeenCalled();
      await expect(host.invoke('chat_v2_background_subagent', { sessionId: 'parent', blockId: 'block' })).resolves.toBe(false);
      await host.unload('dstu.agent-orchestration');
      expect(host.ctx.commands.has('chat_v2_background_subagent')).toBe(false);
    } finally {
      controller.abort();
      await running;
      await host.dispose();
    }
  });
});
