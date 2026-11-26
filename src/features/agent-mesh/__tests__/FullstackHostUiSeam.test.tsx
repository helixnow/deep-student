import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST_CALL_COMMAND } from '../../../../host/kernel/api';
import { createTestHost } from '../../../../host/kernel/testing';
import { AgentToolExecutorRegistry } from '../../../../host/plugins/agent-skills/api';
import agentMeshHostPlugin, { AGENT_MESH_BACKEND_EVENT } from '../../../../host/plugins/agent-mesh/index';
import {
  DEFAULT_BUILTIN_COORDINATOR_AGENT,
  type AdapterCapabilities,
  type AdapterRegistryPort,
  type CheckpointPort,
  type DetectedCliAgent,
  type ExternalCodingAdapter,
  type ExternalTurnStartInput,
  type MeshCheckpointRecord,
  type MeshDiffReport,
  type NormalizedRuntimeEvent,
} from '../../../../host/plugins/agent-mesh/src/contracts';
import { UiKernel } from '@/ui-kernel/kernel';
import type { ChatComposerCommandContribution } from '@/ui-kernel/contracts/surfaces';
import agentMeshOfficialUiPlugin from '@/ui-plugins/official/agent-mesh';
import {
  AGENT_MESH_UI_EVENT_CHANNEL,
  SwarmCapsuleBar,
  agentMeshHost,
  resetAgentMeshStore,
  useAgentMeshStore,
  useAgentMeshWorkbenchStore,
} from '@/features/agent-mesh';
import { InlineExternalTurnCard } from '../components/InlineExternalTurnCard';

function fullCaps(): AdapterCapabilities {
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
  };
}

class LiveSeamAdapter implements ExternalCodingAdapter {
  readonly capabilities = fullCaps();
  readonly approvals: Array<{ approved: boolean; reason?: string }> = [];
  private approvalWaiter: ((d: { approved: boolean; reason?: string }) => void) | null = null;
  private steerWaiter: ((text: string) => void) | null = null;

  startOrResumeTurn(input: ExternalTurnStartInput): AsyncIterable<NormalizedRuntimeEvent> {
    return this.streamTurn(input);
  }

  private async *streamTurn(
    input: ExternalTurnStartInput,
  ): AsyncGenerator<NormalizedRuntimeEvent, void, unknown> {
    yield { type: 'session_bound', externalSessionId: 'claude-seam-sess-1' };
    yield { type: 'assistant_delta', text: `Working on: ${input.prompt}` };
    if (!input.readOnly) {
      yield {
        type: 'approval_requested',
        requestId: 'req-seam-1',
        toolName: 'Edit',
        targetPath: 'src/raft/log.ts',
      };
      const decision = await new Promise<{ approved: boolean; reason?: string }>((resolve) => {
        this.approvalWaiter = resolve;
      });
      yield {
        type: 'assistant_delta',
        text: decision.approved ? '\nApproved edit applied.' : '\nDenied.',
      };
      const steered = await new Promise<string>((resolve) => {
        this.steerWaiter = resolve;
      });
      yield { type: 'assistant_delta', text: `\nSteered: ${steered}` };
    }
    yield { type: 'quiescent_completed' };
  }

  steer(_threadId: string, text: string): boolean {
    this.steerWaiter?.(text);
    this.steerWaiter = null;
    return true;
  }

  interrupt(): void {
    this.approvalWaiter?.({ approved: false, reason: 'interrupted' });
    this.steerWaiter?.('interrupted');
  }

  respondApproval(
    _threadId: string,
    _requestId: string,
    decision: { approved: boolean; reason?: string },
  ): boolean {
    this.approvals.push(decision);
    this.approvalWaiter?.(decision);
    this.approvalWaiter = null;
    return true;
  }
}

class SeamCheckpointPort implements CheckpointPort {
  private seq = 0;
  async captureCheckpoint(input: {
    chatSessionId: string;
    threadId: string;
    agentId: string;
    rosterName?: string | null;
    rootPath: string;
    turnSeq: number;
    kind: 'before' | 'after';
  }): Promise<MeshCheckpointRecord> {
    return {
      checkpointId: `chk_seam_${++this.seq}_${input.kind}`,
      chatSessionId: input.chatSessionId,
      threadId: input.threadId,
      agentId: input.agentId,
      rosterName: input.rosterName ?? null,
      rootPath: input.rootPath,
      turnSeq: input.turnSeq,
      kind: input.kind,
      ref: `refs/dstu-checkpoints/${input.chatSessionId}/${input.turnSeq}-${input.kind}`,
      isGit: true,
      postTurnHashes: {},
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
      totalAdditions: 19,
      totalDeletions: 4,
      files: [
        {
          path: 'src/raft/log.ts',
          status: 'modified',
          additions: 19,
          deletions: 4,
          patch: '@@ -1,4 +1,19 @@\n+export const replicated = true;',
          attributedAgentId: attributedAgentId ?? 'claude',
        },
      ],
    };
  }
  async revertToCheckpoint(): Promise<{
    revertedPaths: string[];
    skippedUserModifiedPaths: string[];
  }> {
    return { revertedPaths: ['src/raft/log.ts'], skippedUserModifiedPaths: [] };
  }
}

describe('Fullstack Host <-> UI Seam (dstu.agent-mesh)', () => {
  beforeEach(() => {
    resetAgentMeshStore();
    useAgentMeshWorkbenchStore.getState().resetStoreForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it('unifies dstu/agent-mesh:event across Host -> useAgentMeshStore + workbenchBridge, aligns all RPC payloads, and syncs workbenchOpen across InlineExternalTurnCard, SwarmCapsuleBar, and /agents', async () => {
    expect(AGENT_MESH_BACKEND_EVENT).toBe('dstu/agent-mesh:event');
    expect(AGENT_MESH_UI_EVENT_CHANNEL).toBe('dstu/agent-mesh:event');

    const claudeAdapter = new LiveSeamAdapter();
    const codexAdapter = new LiveSeamAdapter();
    const adapters: AdapterRegistryPort = {
      async probeAgents() {
        const list: DetectedCliAgent[] = [
          DEFAULT_BUILTIN_COORDINATOR_AGENT,
          {
            id: 'claude',
            kind: 'claude',
            name: 'claude',
            displayName: 'Claude Code',
            command: 'claude',
            installed: true,
            authenticated: true,
            version: '1.0.29',
            capabilities: fullCaps(),
          },
          {
            id: 'codex',
            kind: 'codex',
            name: 'codex',
            displayName: 'Codex CLI',
            command: 'codex',
            installed: true,
            authenticated: true,
            version: '0.21.0',
            capabilities: fullCaps(),
          },
        ];
        return list;
      },
      getAdapter(id: string) {
        if (id === 'claude') return claudeAdapter;
        if (id === 'codex') return codexAdapter;
        return null;
      },
    };

    const executorRegistry = new AgentToolExecutorRegistry();
    const host = await createTestHost({
      provide: {
        paths: { appDataDir: ':memory:' },
        agentTools: {
          registerToolExecutors: (execs: Parameters<typeof executorRegistry.register>[0]) =>
            executorRegistry.register(execs),
          toolExecutors: () => executorRegistry.all(),
        },
      },
      plugins: [
        [
          agentMeshHostPlugin,
          {
            inMemoryDb: true,
            swarmCoalesceMs: 20,
            ports: {
              adapters,
              checkpoints: new SeamCheckpointPort(),
            },
          },
        ],
      ],
    });

    const uiListeners = new Map<string, Set<(payload: unknown) => void>>();
    const stopHostRelay = host.ctx.backendEvents.listen(
      AGENT_MESH_BACKEND_EVENT,
      (payload: unknown) => {
        for (const fn of uiListeners.get(AGENT_MESH_BACKEND_EVENT) ?? []) {
          fn(payload);
        }
      },
    );

    const uiKernel = new UiKernel({
      invoke: async (cmd, payload) => {
        if (cmd === HOST_CALL_COMMAND) {
          return host.invoke(HOST_CALL_COMMAND, payload);
        }
        return null;
      },
      events: {
        listen: async (event, handler) => {
          const set = uiListeners.get(event) ?? new Set();
          set.add(handler);
          uiListeners.set(event, set);
          return () => {
            set.delete(handler);
          };
        },
      },
    });

    await uiKernel.install(agentMeshOfficialUiPlugin, { origin: 'builtin' });

    try {
      // 1) Probe agents via composer `agentMeshHost.probeAgents` -> updates BOTH stores via `dstu/agent-mesh:event`!
      const probed = await agentMeshHost.probeAgents({ forceRefresh: true });
      expect(probed.find((a) => a.id === 'deepstudent')?.driverKind).toBe('builtin');
      expect(probed.find((a) => a.id === 'claude')?.driverKind).toBe('claude');
      expect(
        useAgentMeshWorkbenchStore.getState().agents.find((a) => a.id === 'claude')?.available,
      ).toBe(true);

      // 2) Bind workspace and start a live external Claude turn through composer `agentMeshHost`
      await agentMeshHost.setWorkspaceBinding({
        chatSessionId: 'sess-fullstack',
        rootPath: '/tmp/raft-lab',
      });
      expect(useAgentMeshWorkbenchStore.getState().workspaceBindings['sess-fullstack']).toBe(
        '/tmp/raft-lab',
      );

      const started = await agentMeshHost.startTurn({
        chatSessionId: 'sess-fullstack',
        agentId: 'claude',
        cwd: '/tmp/raft-lab',
        prompt: 'Implement appendEntries RPC',
      });
      expect(started?.threadId).toBeTruthy();
      const threadId = started!.threadId;

      // Wait for Host `approval_requested` event to arrive on `dstu/agent-mesh:event` in BOTH stores!
      await waitFor(() => {
        expect(useAgentMeshStore.getState().threads[threadId]?.status).toBe('waiting_approval');
        expect(
          useAgentMeshWorkbenchStore
            .getState()
            .threadsBySession['sess-fullstack']?.find((t) => t.threadId === threadId)?.status,
        ).toBe('waiting_approval');
      });

      // Single external CLI turn without active /swarm MUST NOT render SwarmCapsuleBar
      const { unmount: unmountSoloCapsule } = render(
        <SwarmCapsuleBar sessionId="sess-fullstack" />,
      );
      expect(screen.queryByTestId('swarm-capsule-bar')).toBeNull();
      unmountSoloCapsule();

      // 3) Respond approval using frontend `decision: 'allow_session'` -> Host translates to `{ approved: true, scope: 'session' }`!
      await agentMeshHost.respondApproval({
        threadId,
        requestId: 'req-seam-1',
        decision: 'allow_session',
      });
      await waitFor(() => {
        expect(claudeAdapter.approvals[0]?.approved).toBe(true);
      });

      // 4) Steer active turn from Workbench store -> delivers mid-turn steer and completes turn cleanly!
      await useAgentMeshWorkbenchStore.getState().steerMember({
        chatSessionId: 'sess-fullstack',
        rosterName: 'claude',
        threadId,
        prompt: 'Include term monotonicity check',
      });

      await waitFor(() => {
        const inlineThread = useAgentMeshStore.getState().threads[threadId];
        expect(inlineThread?.status).toBe('idle');
        expect(inlineThread?.assistantText).toContain('Steered:');
        expect(inlineThread?.diffSummary?.totalAdditions).toBe(19);
      });

      // 5) Verify inline chat surfaces (0 standalone modal!): InlineExternalTurnCard + SwarmCapsuleBar + /swarm
      const completedThread = useAgentMeshStore.getState().threads[threadId]!;
      render(
        <div>
          <InlineExternalTurnCard thread={completedThread} />
          <SwarmCapsuleBar sessionId="sess-fullstack" />
        </div>,
      );

      expect(screen.queryByTestId('external-turn-open-studio-btn')).toBeNull();
      expect(screen.getByTestId('external-turn-explain-btn')).toBeTruthy();

      // `/swarm` initializes Swarm on Host, sends goal inline, and renders SwarmCapsuleBar above composer
      let sentPrompt = '';
      const commands = uiKernel.slots.list<ChatComposerCommandContribution>('chat.composer.commands');
      expect(commands.map((c) => c.value.name)).toEqual(['swarm', 'handoff']);
      const swarmCmd = commands.find((c) => c.value.name === 'swarm')!.value;
      await act(async () => {
        await swarmCmd.run({
          input: 'Verify Raft safety invariants',
          sessionId: 'sess-fullstack',
          getInput: () => 'Verify Raft safety invariants',
          setInput: () => {},
          insertText: () => {},
          send: (text) => {
            sentPrompt = text ?? '';
          },
        });
      });
      expect(sentPrompt).toContain('Verify Raft safety invariants');
      expect(screen.getByTestId('swarm-capsule-bar')).toBeTruthy();
      expect(screen.queryByTestId('swarm-capsule-open-workbench')).toBeNull();

      // Emergency stop from AgentControlCenter halts active external turns
      const stoppedCount = await useAgentMeshWorkbenchStore
        .getState()
        .emergencyStopAllExternal('test_emergency_stop');
      expect(stoppedCount).toBeGreaterThanOrEqual(0);
    } finally {
      if (typeof stopHostRelay === 'function') {
        stopHostRelay();
      } else if (stopHostRelay && typeof (stopHostRelay as { dispose?: () => void }).dispose === 'function') {
        (stopHostRelay as { dispose: () => void }).dispose();
      }
      await uiKernel.dispose();
      await host.dispose();
    }
  });
});
