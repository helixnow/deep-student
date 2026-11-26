import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { createStore } from 'zustand/vanilla';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readOfficialPluginDeclaration } from '@/platform/official-plugins';
import { APP_EVENTS, addAppEventListener, type ChatV2SetInputDetail } from '@/events';
import { UiKernel } from '@/ui-kernel/kernel';
import type { ChatComposerCommandContribution, ChatMessageActionContribution } from '@/ui-kernel/contracts/surfaces';
import type { SettingsSection } from '@/ui-kernel/contracts/settings';
import agentMeshOfficialPlugin from '@/ui-plugins/official/agent-mesh';
import {
  SwarmCapsuleBar,
  pushMeshWorkbenchEvent,
  setMeshWorkbenchHostAdapter,
  useAgentMeshWorkbenchStore,
  type MeshWorkbenchHostAdapter,
} from '@/features/agent-mesh';
import { MeshSettingsSection } from '../components/MeshSettingsSection';
import { AgentTaskPanel } from '@/features/chat/components/AgentTaskPanel';
import type { AgentTaskStoreState } from '@/features/chat/components/agent-task/types';

function makeTaskStore(sessionId = 'sess-swarm-1') {
  return createStore<AgentTaskStoreState>(() => ({
    sessionId,
    blocks: new Map(),
    activeBlockIds: new Set(),
  }));
}

describe('dstu.agent-mesh Official UI Plugin, Inline SwarmCapsuleBar & Native MeshSettingsSection', () => {
  let detachHost: (() => void) | undefined;

  beforeEach(() => {
    useAgentMeshWorkbenchStore.getState().resetStoreForTests();
  });

  afterEach(() => {
    detachHost?.();
    detachHost = undefined;
    cleanup();
  });

  it('satisfies readOfficialPluginDeclaration AST rules and registers inline /swarm, /handoff, message action, and native Coding CLI settings without any standalone modal', async () => {
    const file = 'src/ui-plugins/official/agent-mesh/index.ts';
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    const decl = readOfficialPluginDeclaration(file, source);
    expect(decl).toEqual({
      file,
      id: 'dstu.agent-mesh',
      platforms: ['desktop'],
      devOnly: false,
      slots: undefined,
    });

    const hostInvoke = vi.fn(async (_cmd: string, payload?: Record<string, unknown>) => {
      if (payload?.method === 'probeAgents') {
        return [{ id: 'claude', name: 'Claude Code', available: true, version: '2.1.0' }];
      }
      if (payload?.method === 'swarmControl') {
        return { ok: true };
      }
      if (payload?.method === 'startTurn') {
        return { threadId: 'th-dispatched-1' };
      }
      return null;
    });

    const eventListeners = new Map<string, (payload: unknown) => void>();
    const kernel = new UiKernel({
      invoke: hostInvoke,
      events: {
        listen: async (event, handler) => {
          eventListeners.set(event, handler);
          return () => {
            eventListeners.delete(event);
          };
        },
      },
    });

    await kernel.install(agentMeshOfficialPlugin, { origin: 'builtin' });

    // 1. Slash commands: `/swarm` and `/handoff` only (no standalone `/agents` modal command)
    const commands = kernel.slots.list<ChatComposerCommandContribution>('chat.composer.commands');
    expect(commands.map((c) => c.value.name)).toEqual(['swarm', 'handoff']);

    let sentChatText = '';
    const swarmCmd = commands.find((c) => c.value.name === 'swarm')!.value;
    await act(async () => {
      await swarmCmd.run({
        input: '实现 Raft 选举与日志复制',
        sessionId: 'sess-cmd-1',
        getInput: () => '实现 Raft 选举与日志复制',
        setInput: () => {},
        insertText: () => {},
        send: (text) => {
          sentChatText = text ?? '';
        },
      });
    });

    expect(useAgentMeshWorkbenchStore.getState().swarmBySession['sess-cmd-1']?.goal).toBe(
      '实现 Raft 选举与日志复制',
    );
    expect(sentChatText).toContain('实现 Raft 选举与日志复制');
    expect(hostInvoke).toHaveBeenCalledWith(
      'plugin:host|call',
      expect.objectContaining({
        caller: 'dstu.agent-mesh',
        service: 'agentMesh',
        method: 'swarmControl',
      }),
    );

    // /handoff @codex
    let clearedInput = 'initial';
    const handoffCmd = commands.find((c) => c.value.name === 'handoff')!.value;
    await act(async () => {
      await handoffCmd.run({
        input: '@codex 请补齐并发边界单测',
        sessionId: 'sess-cmd-1',
        getInput: () => '@codex 请补齐并发边界单测',
        setInput: (next) => {
          clearedInput = next;
        },
        insertText: () => {},
        send: () => {},
      });
    });
    expect(clearedInput).toBe('');
    expect(
      useAgentMeshWorkbenchStore.getState().membersBySession['sess-cmd-1']?.some(
        (m) => m.rosterName === 'codex',
      ),
    ).toBe(true);

    // 2. Message action ("派发给外部编程 CLI") prefills the chat composer directly
    const dispatchedPayloads: ChatV2SetInputDetail[] = [];
    const removeInputListener = addAppEventListener(APP_EVENTS.CHAT_V2_SET_INPUT, (detail) => {
      dispatchedPayloads.push(detail);
    });
    try {
      const actions = kernel.slots.list<ChatMessageActionContribution>('chat.message.actions');
      expect(actions.map((a) => a.value.label)).toContain('派发给外部编程 CLI');
      const dispatchAction = actions.find((a) => a.value.label === '派发给外部编程 CLI')!.value;
      act(() => {
        dispatchAction.run({
          messageId: 'msg-1',
          role: 'assistant',
          sessionId: 'sess-cmd-1',
          content: '修复 race condition 报错',
        });
      });
      expect(dispatchedPayloads[0]?.content).toContain('修复 race condition 报错');
    } finally {
      removeInputListener();
    }

    // 3. Settings section under integrations (`agentMesh:settings.tabTitle`)
    const settingsEntry = kernel.slots.get<SettingsSection>('settings.sections', 'agent-mesh');
    expect(settingsEntry?.value.group).toBe('integrations');
    expect(settingsEntry?.value.titleKey).toBe('agentMesh:settings.tabTitle');
    expect(settingsEntry?.value.navigation?.category?.id).toBe('integrations');

    // 4. Push event subscription (`dstu/agent-mesh:event`)
    expect(eventListeners.has('dstu/agent-mesh:event')).toBe(true);
    act(() => {
      eventListeners.get('dstu/agent-mesh:event')!({
        type: 'board_message',
        chatSessionId: 'sess-cmd-1',
        message: {
          seq: 5,
          sender: 'claude',
          senderKind: 'worker',
          priority: 'result',
          text: '@codex 接口契约已提交',
          mentions: ['codex'],
        },
      });
    });
    expect(
      useAgentMeshWorkbenchStore.getState().boardBySession['sess-cmd-1']?.some((m) => m.seq === 5),
    ).toBe(true);

    await kernel.dispose();
  });

  it('renders 0 DOM nodes when inactive, and renders quiet inline SwarmCapsuleBar inside AgentTaskPanel with inline expand, circuit-breaker reset, and member controls', async () => {
    const mockAdapter: MeshWorkbenchHostAdapter = {
      swarmControl: vi.fn(async () => ({ ok: true })),
      interruptTurn: vi.fn(async () => ({ ok: true })),
      setHumanControlled: vi.fn(async () => ({ ok: true })),
    };
    detachHost = setMeshWorkbenchHostAdapter(mockAdapter);

    const taskStore = makeTaskStore('sess-cap-1');
    const { container, rerender } = render(<AgentTaskPanel store={taskStore} />);
    expect(container.firstChild).toBeNull();

    // Single-agent active external CLI threads without an active swarm MUST NOT wake AgentTaskPanel or SwarmCapsuleBar
    act(() => {
      useAgentMeshWorkbenchStore.getState().applySessionSnapshot('sess-cap-1', {
        swarm: null,
        threads: [
          {
            threadId: 'th-solo-codex',
            chatSessionId: 'sess-cap-1',
            agentId: 'codex',
            rosterName: 'codex',
            status: 'running',
            childSubagents: [],
            activeBgTasks: [],
            humanControlled: false,
          },
        ],
      });
    });
    rerender(<AgentTaskPanel store={taskStore} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('swarm-capsule-bar')).toBeNull();

    act(() => {
      useAgentMeshWorkbenchStore.getState().applySessionSnapshot('sess-cap-1', {
        swarm: {
          chatSessionId: 'sess-cap-1',
          title: 'Raft 分布式课设',
          goal: '实现 Raft',
          status: 'active',
          coordinatorAgent: 'deepstudent',
          autonomousHops: 3,
          maxAutonomousHops: 12,
          headSeq: 8,
        },
        members: [
          {
            rosterName: 'claude',
            agentId: 'claude',
            roleTitle: '架构师',
            status: 'working',
            threadId: 'th-claude-cap',
            lastSeenSeq: 4,
            ownedGlobs: ['src/raft/types.ts'],
            humanControlled: false,
          },
          {
            rosterName: 'codex',
            agentId: 'codex',
            roleTitle: '实现与测试',
            status: 'waiting_children',
            activeChildCount: 2,
            lastSeenSeq: 6,
            ownedGlobs: ['src/raft/node.ts'],
            humanControlled: false,
          },
        ],
        checkpoints: [
          {
            checkpointId: 'cp-1',
            turnSeq: 1,
            agentId: 'claude',
            additions: 126,
            deletions: 19,
            filesChanged: 3,
            files: [],
          },
        ],
      });
    });

    rerender(<AgentTaskPanel store={taskStore} />);
    const capsule = await screen.findByTestId('swarm-capsule-bar');
    expect(capsule).toHaveTextContent('蜂群协作中');
    expect(capsule).toHaveTextContent('Claude(运行中)');
    expect(capsule).toHaveTextContent('Codex(等待 2 子代理)');
    expect(capsule).toHaveTextContent('公告板 8 条');
    expect(capsule).toHaveTextContent('+126');
    expect(capsule).toHaveTextContent('-19');
    expect(screen.queryByTestId('swarm-capsule-open-workbench')).toBeNull();

    // Expand inline member details right inside the capsule bar (0 modal)
    fireEvent.click(screen.getByTestId('swarm-capsule-summary-toggle'));
    expect(screen.getByTestId('swarm-capsule-inline-details')).toHaveTextContent('@claude');
    expect(screen.getByTestId('swarm-capsule-inline-details')).toHaveTextContent('@codex');

    // Toggle pause / resume
    fireEvent.click(screen.getByTestId('swarm-capsule-toggle-pause'));
    await waitFor(() => {
      expect(screen.getByTestId('swarm-capsule-bar')).toHaveTextContent('蜂群已暂停');
    });
  });

  it('renders native MeshSettingsSection (excluding builtin @deepstudent, zero standalone studio button) and saves custom CLI tools, per-CLI path overrides, and safety preferences', async () => {
    const saveCustomCliTemplate = vi.fn(async () => ({ ok: true }));
    const saveCliOverride = vi.fn(async () => ({ ok: true }));
    const deleteCliOverride = vi.fn(async () => ({ deleted: true, agentId: 'codex' }));
    let codexOverridePath: string | null = null;
    let codexExtraArgs: string[] = [];

    detachHost = setMeshWorkbenchHostAdapter({
      probeAgents: async () => [
        { id: 'deepstudent', driver: 'builtin', name: 'DeepStudent', available: true },
        { id: 'claude', driver: 'claude', name: 'Claude Code', available: true, version: '2.1.4' },
        {
          id: 'codex',
          driver: 'codex',
          name: 'Codex CLI',
          available: Boolean(codexOverridePath),
          version: codexOverridePath ? '0.171.0' : null,
          binaryPath: codexOverridePath,
          customExecutablePath: codexOverridePath,
          extraArgs: codexExtraArgs,
        },
      ],
      saveCustomCliTemplate,
      saveCliOverride: async (input) => {
        codexOverridePath = input.executablePath ?? null;
        codexExtraArgs = input.extraArgs ?? [];
        return saveCliOverride(input);
      },
      deleteCliOverride: async (input) => {
        codexOverridePath = null;
        codexExtraArgs = [];
        return deleteCliOverride(input);
      },
    });

    render(<MeshSettingsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('mesh-settings-agent-claude')).toHaveTextContent('已就绪');
    });
    expect(screen.queryByTestId('mesh-settings-agent-deepstudent')).toBeNull();
    expect(screen.queryByTestId('mesh-settings-open-workbench-btn')).toBeNull();

    // Configure per-CLI custom executable path + extra args (T3 Code parity)
    fireEvent.click(screen.getByTestId('mesh-settings-configure-codex'));
    fireEvent.change(screen.getByTestId('mesh-settings-override-path-codex'), {
      target: { value: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex' },
    });
    fireEvent.change(screen.getByTestId('mesh-settings-override-args-codex'), {
      target: { value: '--sandbox workspace-write' },
    });
    fireEvent.click(screen.getByTestId('mesh-settings-override-save-codex'));

    await waitFor(() => {
      expect(saveCliOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'codex',
          executablePath: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex',
          extraArgs: ['--sandbox', 'workspace-write'],
        }),
      );
      expect(screen.getByTestId('mesh-settings-custom-path-badge-codex')).toBeInTheDocument();
      expect(screen.getByTestId('mesh-settings-agent-codex')).toHaveTextContent('已就绪');
    });

    // Reset override back to auto-detect
    fireEvent.click(screen.getByTestId('mesh-settings-configure-codex'));
    fireEvent.click(screen.getByTestId('mesh-settings-override-reset-codex'));
    await waitFor(() => {
      expect(deleteCliOverride).toHaveBeenCalledWith({ agentId: 'codex' });
      expect(screen.queryByTestId('mesh-settings-custom-path-badge-codex')).toBeNull();
    });

    // Add & edit custom CLI template
    fireEvent.click(screen.getByTestId('mesh-settings-add-custom-btn'));
    fireEvent.change(screen.getByTestId('mesh-settings-custom-id'), { target: { value: 'aider' } });
    fireEvent.change(screen.getByTestId('mesh-settings-custom-name'), { target: { value: 'Aider CLI' } });
    fireEvent.change(screen.getByTestId('mesh-settings-custom-command'), { target: { value: 'aider' } });
    fireEvent.click(screen.getByTestId('mesh-settings-custom-save'));

    await waitFor(() => {
      expect(saveCustomCliTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'aider', command: 'aider' }),
      );
    });
    expect(screen.getByTestId('mesh-settings-custom-item-aider')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mesh-settings-custom-edit-aider'));
    fireEvent.change(screen.getByTestId('mesh-settings-custom-command'), {
      target: { value: '/opt/homebrew/bin/aider' },
    });
    fireEvent.click(screen.getByTestId('mesh-settings-custom-save'));
    await waitFor(() => {
      expect(saveCustomCliTemplate).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'aider', command: '/opt/homebrew/bin/aider' }),
      );
    });

    cleanup();
    render(<SwarmCapsuleBar sessionId="sess-push-1" />);
    expect(screen.queryByTestId('swarm-capsule-bar')).toBeNull();
    act(() => {
      pushMeshWorkbenchEvent({
        type: 'swarm_updated',
        chatSessionId: 'sess-push-1',
        swarm: { status: 'active', headSeq: 3 },
      });
    });
    expect(screen.getByTestId('swarm-capsule-bar')).toBeInTheDocument();
  });
});
