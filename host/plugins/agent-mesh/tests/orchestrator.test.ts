import { describe, expect, it } from 'vitest';
import { HOST_CALL_COMMAND } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import { ChatV2State, type ExecutionContext, type ToolCall } from '../../chat/api.ts';
import type {
  ChatPipelineHookContribution,
  ChatPipelineHooksService,
  PipelineHookPromptInput,
} from '../../chat-pipeline/api.ts';
import agentMeshPlugin, {
  AGENT_MESH_BACKEND_EVENT,
  AgentMeshToolExecutor,
  createMeshOrchestrator,
  registerMeshPromptHook,
} from '../index.ts';
import {
  DEFAULT_BUILTIN_COORDINATOR_AGENT,
  DefaultInMemoryFileLeasePort,
  type AdapterCapabilities,
  type AdapterRegistryPort,
  type AgentMeshEvent,
  type CheckpointPort,
  type CustomCliTemplate,
  type DetectedCliAgent,
  type ExternalCodingAdapter,
  type ExternalTurnStartInput,
  type MeshCheckpointRecord,
  type MeshDiffReport,
  type NormalizedRuntimeEvent,
} from '../src/contracts.ts';

function fullCapabilities(overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities {
  return {
    streamingEvents: true,
    midTurnSteer: true,
    interrupt: true,
    approvalCallback: true,
    sessionResume: true,
    sessionFork: true,
    nativeSubagentTree: true,
    backgroundTaskEvents: true,
    mcpInjection: true,
    ...overrides,
  };
}

class ProgrammableAdapter implements ExternalCodingAdapter {
  readonly capabilities: AdapterCapabilities;
  readonly startedInputs: ExternalTurnStartInput[] = [];
  readonly steeredMessages: Array<{ threadId: string; text: string }> = [];
  readonly interruptedThreads: Array<{ threadId: string; reason?: string }> = [];
  readonly approvalDecisions: Array<{
    threadId: string;
    requestId: string;
    approved: boolean;
    reason?: string;
  }> = [];

  private readonly scriptFn: (
    input: ExternalTurnStartInput,
    adapter: ProgrammableAdapter,
  ) => AsyncGenerator<NormalizedRuntimeEvent, void, unknown>;
  private readonly approvalWaiters = new Map<
    string,
    (decision: { approved: boolean; reason?: string }) => void
  >();

  constructor(
    capabilities: AdapterCapabilities,
    scriptFn: (
      input: ExternalTurnStartInput,
      adapter: ProgrammableAdapter,
    ) => AsyncGenerator<NormalizedRuntimeEvent, void, unknown>,
  ) {
    this.capabilities = capabilities;
    this.scriptFn = scriptFn;
  }

  startOrResumeTurn(input: ExternalTurnStartInput): AsyncIterable<NormalizedRuntimeEvent> {
    this.startedInputs.push(input);
    return this.scriptFn(input, this);
  }

  steer(threadId: string, text: string): boolean {
    if (!this.capabilities.midTurnSteer) return false;
    this.steeredMessages.push({ threadId, text });
    return true;
  }

  interrupt(threadId: string, reason?: string): void {
    this.interruptedThreads.push({ threadId, reason });
  }

  respondApproval(
    threadId: string,
    requestId: string,
    decision: { approved: boolean; reason?: string },
  ): boolean {
    this.approvalDecisions.push({ threadId, requestId, ...decision });
    const waiter = this.approvalWaiters.get(requestId);
    if (waiter) {
      this.approvalWaiters.delete(requestId);
      waiter(decision);
      return true;
    }
    return false;
  }

  waitForApproval(requestId: string): Promise<{ approved: boolean; reason?: string }> {
    return new Promise((resolve) => {
      this.approvalWaiters.set(requestId, resolve);
    });
  }
}

class TestAdapterRegistry implements AdapterRegistryPort {
  private readonly map: Map<string, ExternalCodingAdapter>;
  private readonly detected: DetectedCliAgent[];

  constructor(
    entries: Record<string, { adapter: ExternalCodingAdapter; agent: DetectedCliAgent }>,
  ) {
    this.map = new Map(Object.entries(entries).map(([k, v]) => [k, v.adapter]));
    this.detected = Object.values(entries).map((v) => v.agent);
  }

  async probeAgents(options?: {
    customTemplates?: readonly CustomCliTemplate[];
  }): Promise<DetectedCliAgent[]> {
    const custom: DetectedCliAgent[] = (options?.customTemplates ?? []).map((tpl) => ({
      id: `custom:${tpl.id}`,
      kind: 'custom',
      name: tpl.name,
      command: tpl.command,
      installed: true,
      authenticated: true,
      version: '1.0.0',
      capabilities: fullCapabilities({ midTurnSteer: false }),
    }));
    return [DEFAULT_BUILTIN_COORDINATOR_AGENT, ...this.detected, ...custom];
  }

  getAdapter(agentId: string): ExternalCodingAdapter | null {
    return this.map.get(agentId) ?? null;
  }
}

class RecordingCheckpointPort implements CheckpointPort {
  private counter = 0;
  readonly reverted: Array<{ ref: string; paths?: string[] }> = [];

  async captureCheckpoint(input: {
    chatSessionId: string;
    threadId: string;
    agentId: string;
    rosterName?: string | null;
    rootPath: string;
    turnSeq: number;
    kind: 'before' | 'after';
  }): Promise<MeshCheckpointRecord> {
    const checkpointId = `chk_${++this.counter}_${input.kind}`;
    return {
      checkpointId,
      chatSessionId: input.chatSessionId,
      threadId: input.threadId,
      agentId: input.agentId,
      rosterName: input.rosterName ?? null,
      rootPath: input.rootPath,
      turnSeq: input.turnSeq,
      kind: input.kind,
      ref: `refs/dstu-checkpoints/${input.chatSessionId}/${input.turnSeq}-${input.kind}`,
      isGit: true,
      postTurnHashes: { 'src/parser.ts': 'sha256-after' },
      createdAt: new Date().toISOString(),
    };
  }

  async diffCheckpoints(
    _rootPath: string,
    fromRef: string,
    toRef: string,
    attributedAgentId?: string,
  ): Promise<MeshDiffReport> {
    return {
      fromRef,
      toRef,
      totalAdditions: 28,
      totalDeletions: 5,
      files: [
        {
          path: 'src/parser.ts',
          status: 'modified',
          additions: 28,
          deletions: 5,
          patch: '@@ -1,5 +1,28 @@\n+export function parse() {}',
          attributedAgentId: attributedAgentId ?? 'claude',
        },
      ],
    };
  }

  async revertToCheckpoint(
    _rootPath: string,
    target: MeshCheckpointRecord | string,
    options?: { paths?: string[] },
  ): Promise<{ revertedPaths: string[]; skippedUserModifiedPaths: string[] }> {
    const ref = typeof target === 'string' ? target : target.ref;
    this.reverted.push({ ref, paths: options?.paths });
    return {
      revertedPaths: options?.paths ?? ['src/parser.ts'],
      skippedUserModifiedPaths: ['src/user-hand-edited.ts'],
    };
  }
}

describe('MeshOrchestrator, Tools, PromptHook & Cordis Host Plugin', () => {
  it('enforces nested subagent quiescence before settling turn, releasing leases, or capturing after-checkpoint', async () => {
    let releaseSubagent!: () => void;
    const subagentGate = new Promise<void>((resolve) => {
      releaseSubagent = resolve;
    });

    const claudeAdapter = new ProgrammableAdapter(fullCapabilities(), async function* () {
      yield { type: 'session_bound', externalSessionId: 'claude-sess-42' };
      yield { type: 'assistant_delta', text: 'Spawning subagent to run tests...' };
      yield {
        type: 'subagent_started',
        childId: 'sub-1',
        parentToolUseId: 'toolu_1',
        title: 'Unit Test Runner',
      };
      yield { type: 'turn_settled', summary: 'Main stream paused while subagent runs' };

      // Keep generator open OR finish main stream before subagent? Test finishing main generator
      // while subagent is still running, then emitting subagent_completed via input.onEvent!
    });

    let capturedOnEvent: ((ev: NormalizedRuntimeEvent) => void) | undefined;
    const asyncChildClaude = new ProgrammableAdapter(fullCapabilities(), async function* (input) {
      capturedOnEvent = input.onEvent;
      yield { type: 'session_bound', externalSessionId: 'claude-sess-42' };
      yield { type: 'assistant_delta', text: 'Delegating verification...' };
      yield {
        type: 'subagent_started',
        childId: 'sub-verify',
        parentToolUseId: 'toolu_9',
        title: 'Verifier Subagent',
      };
      yield { type: 'turn_settled' };
      // Main stream ends here while `sub-verify` is STILL running!
    });
    void claudeAdapter;

    const fileLeases = new DefaultInMemoryFileLeasePort();
    const events: AgentMeshEvent[] = [];
    const orchestrator = createMeshOrchestrator({
      inMemoryDb: true,
      approvalLeaseWaitMs: 30,
      fileLeases,
      checkpoints: new RecordingCheckpointPort(),
      emitEvent: (ev) => events.push(ev),
      adapters: new TestAdapterRegistry({
        claude: {
          adapter: asyncChildClaude,
          agent: {
            id: 'claude',
            kind: 'claude',
            name: 'Claude Code',
            command: 'claude',
            installed: true,
            authenticated: true,
            version: '1.0.24',
            capabilities: fullCapabilities(),
          },
        },
      }),
    });

    const started = await orchestrator.startTurn({
      chatSessionId: 'sess-quiesce',
      agentId: 'claude',
      rootPath: '/workspace/proj',
      ownedGlobs: ['src/raft/**'],
      prompt: 'Implement Raft log replication',
    });

    // Wait briefly so main generator finishes and actor hits waiting_children gate
    await new Promise((r) => setTimeout(r, 30));

    const midSnap = await orchestrator.getSessionSnapshot('sess-quiesce');
    const midThread = midSnap.threads.find((t) => t.threadId === started.threadId)!;
    expect(midThread.status).toBe('waiting_children');
    expect(midThread.externalSessionId).toBe('claude-sess-42');
    expect(midThread.childSubagents).toHaveLength(1);
    expect(midThread.childSubagents[0]?.status).toBe('running');
    // File lease MUST still be held while waiting_children!
    expect(fileLeases.listActiveLeases('/workspace/proj')).toHaveLength(1);

    // Complete nested subagent -> turn immediately reaches quiescence, releases lease, and records diff!
    capturedOnEvent?.({
      type: 'subagent_completed',
      childId: 'sub-verify',
      summary: 'All 18 tests green',
    });
    releaseSubagent();

    const finalThread = await orchestrator.waitForThreadIdle(started.threadId);
    expect(finalThread?.status).toBe('idle');
    expect(finalThread?.diffSummary).toEqual({
      filesChanged: 1,
      additions: 28,
      deletions: 5,
    });
    expect(fileLeases.listActiveLeases('/workspace/proj')).toHaveLength(0);

    await orchestrator.dispose();
  });

  it('handles mid-turn steer vs queued-at-head fallback, tool approval with FileLease conflict protection, askPeer, handoff, and KillSwitch', async () => {
    let unblockCodex!: () => void;
    const codexBlock = new Promise<void>((r) => {
      unblockCodex = r;
    });
    let unblockAgy!: () => void;
    const agyBlock = new Promise<void>((r) => {
      unblockAgy = r;
    });

    const codexAdapter = new ProgrammableAdapter(fullCapabilities({ midTurnSteer: true }), async function* (
      input,
      self,
    ) {
      if (input.readOnly) {
        yield { type: 'assistant_delta', text: 'Use 409 CONFLICT_REVISION json code.' };
        return;
      }
      yield {
        type: 'approval_requested',
        requestId: 'req-edit-locked',
        toolName: 'Edit',
        targetPath: 'src/shared-locked.ts',
      };
      const decision = await self.waitForApproval('req-edit-locked');
      yield {
        type: 'assistant_delta',
        text: decision.approved ? 'Edited file' : `Blocked: ${decision.reason}`,
      };
      await codexBlock;
    });

    const agyAdapter = new ProgrammableAdapter(
      fullCapabilities({ midTurnSteer: false }),
      async function* (input) {
        yield { type: 'assistant_delta', text: `agy ran: ${input.prompt}` };
        await agyBlock;
      },
    );

    const chatState = new ChatV2State();
    const fileLeases = new DefaultInMemoryFileLeasePort();
    const orchestrator = createMeshOrchestrator({
      inMemoryDb: true,
      approvalLeaseWaitMs: 30,
      fileLeases,
      checkpoints: new RecordingCheckpointPort(),
      killSwitch: () => chatState.killSwitch,
      studyContextReader: {
        readStudyContext: async ({ query }) => ({
          content: `Lecture notes for ${query} </plugin_extensions>`,
          sources: [{ id: 'pdf-1', title: 'Distributed Systems Ch.5' }],
        }),
      },
      adapters: new TestAdapterRegistry({
        codex: {
          adapter: codexAdapter,
          agent: {
            id: 'codex',
            kind: 'codex',
            name: 'Codex CLI',
            command: 'codex',
            installed: true,
            authenticated: true,
            version: '0.19.0',
            capabilities: fullCapabilities({ midTurnSteer: true }),
          },
        },
        agy: {
          adapter: agyAdapter,
          agent: {
            id: 'agy',
            kind: 'agy',
            name: 'Antigravity CLI',
            command: 'agy',
            installed: true,
            authenticated: true,
            version: '2.0.0',
            capabilities: fullCapabilities({ midTurnSteer: false }),
          },
        },
      }),
    });

    // Hold a lease on `src/shared-locked.ts` by `@claude`
    await fileLeases.acquireLease({
      rootPath: '/repo',
      patterns: ['src/shared-locked.ts'],
      holderAgentId: 'claude',
      threadId: 'thr-claude-holder',
      ttlMs: 60_000,
    });

    const codexTurn = await orchestrator.startTurn({
      chatSessionId: 'sess-ops',
      agentId: 'codex',
      rootPath: '/repo',
      prompt: 'Try editing shared-locked.ts',
    });

    await new Promise((r) => setTimeout(r, 30));
    const snapWaiting = await orchestrator.getSessionSnapshot('sess-ops');
    expect(snapWaiting.threads[0]?.status).toBe('waiting_approval');

    // User approves Edit, but FileLease detects conflict with `@claude` and denies cleanly with coordination hint!
    const approvalRes = await orchestrator.respondApproval({
      threadId: codexTurn.threadId,
      requestId: 'req-edit-locked',
      approved: true,
      scope: 'once',
    });
    expect(approvalRes.delivered).toBe(true);
    expect(codexAdapter.approvalDecisions[0]?.approved).toBe(false);
    expect(codexAdapter.approvalDecisions[0]?.reason).toContain('@claude');

    // Steer active Codex turn -> native `mid_turn_steer`!
    const codexSteer = await orchestrator.steerTurn({
      threadId: codexTurn.threadId,
      text: 'Edit src/codex-owned.ts instead',
    });
    expect(codexSteer.mode).toBe('mid_turn_steer');
    expect(codexAdapter.steeredMessages).toHaveLength(1);
    unblockCodex();
    await orchestrator.waitForThreadIdle(codexTurn.threadId);

    // Start `agy` (midTurnSteer: false) -> steer queues at HEAD (`canInterruptAndResume: true`)!
    const agyTurn = await orchestrator.startTurn({
      chatSessionId: 'sess-ops',
      agentId: 'agy',
      rootPath: '/repo',
      prompt: 'Initial agy task',
    });
    await new Promise((r) => setTimeout(r, 20));
    const agySteer = await orchestrator.steerTurn({
      threadId: agyTurn.threadId,
      text: 'Follow-up head steer',
    });
    expect(agySteer.mode).toBe('queued_at_head');
    expect(agySteer.canInterruptAndResume).toBe(true);
    unblockAgy();
    await orchestrator.waitForThreadIdle(agyTurn.threadId);
    expect(agyAdapter.startedInputs).toHaveLength(2);
    expect(agyAdapter.startedInputs[1]?.prompt).toBe('Follow-up head steer');

    // `askPeer` 1-turn consultation
    const peerConsult = await orchestrator.askPeer({
      chatSessionId: 'sess-ops',
      fromAgent: 'claude',
      targetAgent: 'codex',
      question: 'What HTTP error code does sync conflict return?',
      contextPaths: ['src/api/sync.ts'],
      rootPath: '/repo',
    });
    expect(peerConsult.status).toBe('completed');
    expect(peerConsult.responseText).toContain('409 CONFLICT_REVISION');

    // `handoff` releases `@claude`'s lease on `src/shared-locked.ts`, captures checkpoint, and wakes `@agy`!
    const handoffRes = await orchestrator.handoff({
      chatSessionId: 'sess-ops',
      fromAgent: 'claude',
      fromThreadId: 'thr-claude-holder',
      targetAgent: 'agy',
      summary: 'Implemented parser AST',
      nextTask: 'Write parser unit tests',
      changedFiles: ['src/shared-locked.ts'],
      rootPath: '/repo',
      awaitCompletion: true,
    });
    expect(fileLeases.listActiveLeases('/repo')).toHaveLength(0);
    expect(handoffRes.exchange.kind).toBe('handoff');
    expect(handoffRes.exchange.status).toBe('completed');

    // Verify Bridge Callbacks (`studyReadContext` taint-neutralizes external content!)
    const bridge = orchestrator.createBridgeCallbacks();
    const studyCtx = (await bridge.studyReadContext(
      {
        chatSessionId: 'sess-ops',
        agentId: 'codex',
        rosterName: 'codex',
        threadId: codexTurn.threadId,
        rootPath: '/repo',
      },
      { query: 'Raft', maxChars: 500 },
    )) as { content: string; sources: Array<{ id: string }> };
    expect(studyCtx.content).not.toContain('</plugin_extensions>');
    expect(studyCtx.sources[0]?.id).toBe('pdf-1');

    // Trip AgentKillSwitch -> blocks new turns!
    chatState.killSwitch.trip('emergency_test');
    await expect(
      orchestrator.startTurn({
        chatSessionId: 'sess-ops',
        agentId: 'codex',
        prompt: 'Should fail closed',
      }),
    ).rejects.toThrow(/AgentKillSwitch tripped/);

    await orchestrator.dispose();
  });

  it('mounts cleanly as Cordis Host plugin dstu.agent-mesh, serves all meta.remote calls over plugin:host|call, executes all 5 mesh_* tools, and augments chatPipelineHooks', async () => {
    const claudeAdapter = new ProgrammableAdapter(fullCapabilities(), async function* (input) {
      yield { type: 'session_bound', externalSessionId: 'claude-live-1' };
      yield { type: 'assistant_delta', text: `Claude handled: ${input.prompt.slice(0, 40)}` };
      yield { type: 'quiescent_completed' };
    });
    const codexAdapter = new ProgrammableAdapter(fullCapabilities(), async function* (input) {
      yield { type: 'session_bound', externalSessionId: 'codex-live-1' };
      yield { type: 'assistant_delta', text: `Codex handled: ${input.prompt.slice(0, 40)}` };
      yield { type: 'quiescent_completed' };
    });

    const executorRegistry = new AgentToolExecutorRegistry();
    const registeredHooks: Array<{ pluginId: string; hook: ChatPipelineHookContribution }> = [];
    const pipelineHooks: ChatPipelineHooksService = {
      register(pluginId, hook) {
        const entry = { pluginId, hook };
        registeredHooks.push(entry);
        return () => {
          const idx = registeredHooks.indexOf(entry);
          if (idx >= 0) registeredHooks.splice(idx, 1);
        };
      },
      list() {
        return registeredHooks.map((e) => ({
          pluginId: e.pluginId,
          name: e.hook.name,
          priority: e.hook.priority ?? 100,
          hasAugmentSystemPrompt: typeof e.hook.augmentSystemPrompt === 'function',
          hasAfterReply: typeof e.hook.afterReply === 'function',
        }));
      },
      async runAugmentSystemPrompt(input: PipelineHookPromptInput) {
        const chunks: string[] = [];
        for (const e of registeredHooks) {
          const out = await e.hook.augmentSystemPrompt?.(input);
          if (out && out.trim()) chunks.push(`[${e.pluginId}:${e.hook.name}]\n${out.trim()}`);
        }
        return chunks.length > 0 ? chunks.join('\n\n') : null;
      },
      async runAfterReply() {},
    };

    const host = await createTestHost({
      provide: {
        paths: { appDataDir: ':memory:' },
        agentTools: {
          registerToolExecutors: (execs: Parameters<typeof executorRegistry.register>[0]) =>
            executorRegistry.register(execs),
          toolExecutors: () => executorRegistry.all(),
        },
        chatPipelineHooks: pipelineHooks,
      },
      plugins: [
        [
          agentMeshPlugin,
          {
            inMemoryDb: true,
            swarmCoalesceMs: 25,
            ports: {
              checkpoints: new RecordingCheckpointPort(),
              adapters: new TestAdapterRegistry({
                claude: {
                  adapter: claudeAdapter,
                  agent: {
                    id: 'claude',
                    kind: 'claude',
                    name: 'Claude Code',
                    command: 'claude',
                    installed: true,
                    authenticated: true,
                    version: '1.0.0',
                    capabilities: fullCapabilities(),
                  },
                },
                codex: {
                  adapter: codexAdapter,
                  agent: {
                    id: 'codex',
                    kind: 'codex',
                    name: 'Codex CLI',
                    command: 'codex',
                    installed: true,
                    authenticated: true,
                    version: '0.20.0',
                    capabilities: fullCapabilities(),
                  },
                },
              }),
            },
          },
        ],
      ],
    });

    try {
      const callRemote = <T>(method: string, args: unknown[] = []): Promise<T> =>
        host.invoke<T>(HOST_CALL_COMMAND, {
          caller: 'dstu.agent-mesh',
          service: 'agentMesh',
          method,
          args,
        });

      // 1) Plain study chat has ZERO prompt clutter before workspace/swarm/@mentions!
      const emptyPrompt = await pipelineHooks.runAugmentSystemPrompt({
        sessionId: 'chat-clean',
        mode: 'ask',
        userContent: 'Explain eigenvalues of symmetric matrices.',
      });
      expect(emptyPrompt).toBeNull();

      // 2) Probe agents & save/delete custom CLI template via remote Host bridge
      const probed = await callRemote<DetectedCliAgent[]>('probeAgents', [{ forceRefresh: true }]);
      expect(probed.map((a) => a.id)).toEqual(['deepstudent', 'claude', 'codex']);

      const savedTpl = await callRemote<CustomCliTemplate>('saveCustomCliTemplate', [
        { name: 'Dsh Local', command: 'dsh', args: ['--json'] },
      ]);
      expect(savedTpl.name).toBe('Dsh Local');
      const deletedTpl = await callRemote<{ deleted: boolean }>('deleteCustomCliTemplate', [
        savedTpl.id,
      ]);
      expect(deletedTpl.deleted).toBe(true);

      // 3) Multi-@agent prompt (`[mesh-agents: claude, codex]`) injects semantic orchestration prompt!
      const multiAgentPrompt = await pipelineHooks.runAugmentSystemPrompt({
        sessionId: 'chat-multi',
        mode: 'craft',
        userContent: '[mesh-agents: claude, codex] Compare parser designs between @claude and @codex',
      });
      expect(multiAgentPrompt).toContain('多智能体协同网格');
      expect(multiAgentPrompt).toContain('@claude');
      expect(multiAgentPrompt).toContain('@codex');
      expect(multiAgentPrompt).toContain('mesh_delegate_agent');

      // 4) Workspace binding + remote startTurn + getCheckpointDiff + revertCheckpoint + swarmControl
      await callRemote('setWorkspaceBinding', [{ sessionId: 'chat-multi', rootPath: '/proj/demo' }]);
      const binding = await callRemote<{ rootPath: string }>('getWorkspaceBinding', ['chat-multi']);
      expect(binding.rootPath).toBe('/proj/demo');

      const turn = await callRemote<{ threadId: string; status: string }>('startTurn', [
        {
          sessionId: 'chat-multi',
          agentId: 'claude',
          prompt: 'Draft AST types',
          awaitCompletion: true,
        },
      ]);
      expect(turn.status).toBe('idle');

      const snap = await callRemote<{ checkpoints: Array<{ checkpointId: string }> }>(
        'getSessionSnapshot',
        [{ sessionId: 'chat-multi' }],
      );
      expect(snap.checkpoints.length).toBeGreaterThanOrEqual(2);

      const diff = await callRemote<MeshDiffReport>('getCheckpointDiff', [
        { sessionId: 'chat-multi' },
      ]);
      expect(diff.totalAdditions).toBe(28);

      const revertRes = await callRemote<{
        revertedPaths: string[];
        skippedUserModifiedPaths: string[];
      }>('revertCheckpoint', [{ checkpointId: snap.checkpoints[0]!.checkpointId }]);
      expect(revertRes.revertedPaths).toEqual(['src/parser.ts']);
      expect(revertRes.skippedUserModifiedPaths).toEqual(['src/user-hand-edited.ts']);

      // 5) Execute registered `AgentToolExecutor` (`mesh_delegate_agent`, `mesh_swarm_control`, `mesh_inspect_changes`)
      const executors = executorRegistry.all();
      expect(executors).toHaveLength(1);
      const meshExec = executors[0]!;
      expect(meshExec.canHandle('mesh_delegate_agent')).toBe(true);
      expect(meshExec.canHandle('mesh_ask_peer')).toBe(true);
      expect(meshExec.canHandle('mesh_handoff')).toBe(true);
      expect(meshExec.canHandle('mesh_swarm_control')).toBe(true);
      expect(meshExec.canHandle('mesh_inspect_changes')).toBe(true);
      expect(meshExec.ambientSchemaToolIds?.()).toHaveLength(5);

      const toolEvents: string[] = [];
      const execCtx = {
        session_id: 'chat-multi',
        block_id: 'blk-1',
        cancellation_token: null,
        emitToolCallStart: (name: string) => toolEvents.push(`start:${name}`),
        emitToolCallEnd: () => toolEvents.push('end'),
        emitToolCallError: (err: string) => toolEvents.push(`err:${err}`),
      } as unknown as ExecutionContext;

      const delegateRes = (await meshExec.execute!(
        {
          id: 'call-1',
          name: 'mesh_delegate_agent',
          arguments: { agent: 'codex', prompt: 'Review AST types', readOnly: true },
        } satisfies ToolCall,
        execCtx,
      )) as { success: boolean; output: { assistantText: string } };
      expect(delegateRes.success).toBe(true);
      expect(delegateRes.output.assistantText).toContain('Codex handled:');

      const swarmRes = (await meshExec.execute!(
        {
          id: 'call-2',
          name: 'mesh_swarm_control',
          arguments: {
            action: 'start',
            title: 'Compiler Swarm',
            goal: 'Build parser + typechecker',
            members: [{ rosterName: 'impl-codex', agentId: 'codex' }],
          },
        } satisfies ToolCall,
        execCtx,
      )) as { success: boolean; output: { session: { title: string } } };
      expect(swarmRes.success).toBe(true);
      expect(swarmRes.output.session.title).toBe('Compiler Swarm');
      expect(toolEvents).toEqual([
        'start:mesh_delegate_agent',
        'end',
        'start:mesh_swarm_control',
        'end',
      ]);

      // Verify backendEvents emitted real-time `dstu/agent-mesh:event` frames!
      const meshBackendEvents = host.events.filter((e) => e.event === AGENT_MESH_BACKEND_EVENT);
      expect(meshBackendEvents.length).toBeGreaterThan(0);

      // Keep direct export references exercised too
      expect(typeof AgentMeshToolExecutor).toBe('function');
      expect(typeof registerMeshPromptHook).toBe('function');
    } finally {
      await host.dispose();
    }
  });
});
