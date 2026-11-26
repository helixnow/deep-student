import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '@/i18n';
import { APP_EVENTS, addAppEventListener, type ChatV2SetInputDetail } from '@/events';
import zhAgentMesh from '@/locales/zh-CN/agentMesh.json';
import enAgentMesh from '@/locales/en-US/agentMesh.json';
import {
  applyAgentMeshBackendEvent,
  registerAgentMeshHostBridge,
  resetAgentMeshStore,
  SessionMeshStreamSection,
  useAgentMeshStore,
} from '@/features/agent-mesh';
import { InlineExternalTurnCard } from '../components/InlineExternalTurnCard';
import { PeerExchangeStrip } from '../components/PeerExchangeStrip';

describe('InlineExternalTurnCard, PeerExchangeStrip & SessionMeshStreamSection', () => {
  beforeEach(async () => {
    i18n.addResourceBundle('zh-CN', 'agentMesh', zhAgentMesh, true, true);
    i18n.addResourceBundle('en-US', 'agentMesh', enAgentMesh, true, true);
    await i18n.changeLanguage('zh-CN');
    resetAgentMeshStore();
    registerAgentMeshHostBridge(null);
  });

  it('renders 0 DOM nodes when a session has no external CLI turns or peer exchanges', () => {
    const { container } = render(<SessionMeshStreamSection sessionId="clean-session" />);
    expect(container.firstChild).toBeNull();
  });

  it('enforces waiting_children quiescence in InlineExternalTurnCard and handles inline approvals, revert, and human takeover', async () => {
    const respondApprovalSpy = vi.fn(async () => ({ ok: true }));
    const revertCheckpointSpy = vi.fn(async () => ({
      revertedPaths: ['src/raft/election.ts'],
      skippedUserModifiedPaths: [],
    }));
    const setHumanControlledSpy = vi.fn(async () => ({ ok: true }));

    registerAgentMeshHostBridge({
      respondApproval: respondApprovalSpy,
      revertCheckpoint: revertCheckpointSpy,
      setHumanControlled: setHumanControlledSpy,
    });

    // 1. Start external turn & stream text + 2 nested subagents
    act(() => {
      applyAgentMeshBackendEvent({
        type: 'turn_started',
        thread: {
          threadId: 'thr-1',
          chatSessionId: 'sess-1',
          agentId: 'claude',
          agentName: 'Claude Code',
          rootPath: '/Users/dev/projects/deep-raft',
          status: 'running',
          prompt: '实现随机化选举超时并跑单元测试',
          assistantText: '已完成核心改动：\n```ts\nconst timeout = 150 + Math.random() * 150;\n```',
          toolCalls: [],
          childSubagents: [],
          activeBgTaskCount: 0,
          pendingApproval: null,
          diffSummary: null,
          humanControlled: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
      });
      applyAgentMeshBackendEvent({
        type: 'subagent_started',
        threadId: 'thr-1',
        childId: 'sub-a',
        title: '检索状态机锁边界',
        startedAt: 1010,
      });
      applyAgentMeshBackendEvent({
        type: 'subagent_started',
        threadId: 'thr-1',
        childId: 'sub-b',
        title: '执行并发选举测试',
        startedAt: 1020,
      });
      // Main turn output settles while 2 child subagents are still running -> MUST stay waiting_children!
      applyAgentMeshBackendEvent({
        type: 'turn_settled',
        threadId: 'thr-1',
      });
    });

    expect(useAgentMeshStore.getState().threads['thr-1'].status).toBe('waiting_children');

    const { rerender } = render(
      <InlineExternalTurnCard thread={useAgentMeshStore.getState().threads['thr-1']} />,
    );

    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('~/deep-raft')).toBeTruthy();
    expect(screen.getByText('派生 2 个子代理 · 等待完成…')).toBeTruthy();

    // Expand nested subagent tree
    fireEvent.click(screen.getByTestId('external-turn-subagents-toggle'));
    expect(screen.getByTestId('external-turn-subagents-tree')).toBeTruthy();
    expect(screen.getByText('检索状态机锁边界')).toBeTruthy();
    expect(screen.getByText('执行并发选举测试')).toBeTruthy();

    // 2. Request tool approval mid-turn -> renders inline approval bar
    act(() => {
      applyAgentMeshBackendEvent({
        type: 'approval_requested',
        threadId: 'thr-1',
        requestId: 'req-edit-1',
        toolName: 'Bash',
        command: 'npm test -- raft',
      });
    });

    rerender(<InlineExternalTurnCard thread={useAgentMeshStore.getState().threads['thr-1']} />);
    expect(screen.getByTestId('external-turn-approval-bar')).toBeTruthy();
    expect(screen.getByText('请求执行 Bash')).toBeTruthy();

    fireEvent.click(screen.getByTestId('external-approval-allow-session'));
    await waitFor(() => {
      expect(respondApprovalSpy).toHaveBeenCalledWith({
        threadId: 'thr-1',
        requestId: 'req-edit-1',
        decision: 'allow_session',
      });
    });

    // 3. Complete both child subagents + attach checkpoint diff -> settles cleanly to idle
    act(() => {
      applyAgentMeshBackendEvent({
        type: 'subagent_completed',
        threadId: 'thr-1',
        childId: 'sub-a',
        summary: '无锁冲突',
      });
      applyAgentMeshBackendEvent({
        type: 'subagent_completed',
        threadId: 'thr-1',
        childId: 'sub-b',
        summary: '28/28 通过',
      });
      applyAgentMeshBackendEvent({
        type: 'quiescent_completed',
        threadId: 'thr-1',
        lastCheckpointId: 'cp-turn-1',
        diffSummary: {
          filesChanged: 2,
          totalAdditions: 42,
          totalDeletions: 9,
          checkpointId: 'cp-turn-1',
          files: [
            {
              path: 'src/raft/election.ts',
              status: 'modified',
              additions: 30,
              deletions: 9,
            },
            {
              path: 'src/raft/election.test.ts',
              status: 'added',
              additions: 12,
              deletions: 0,
            },
          ],
        },
      });
    });

    expect(useAgentMeshStore.getState().threads['thr-1'].status).toBe('idle');
    rerender(<InlineExternalTurnCard thread={useAgentMeshStore.getState().threads['thr-1']} />);

    // Footer diff stats & expandable file list
    const diffTrigger = screen.getByTestId('external-turn-diff-trigger');
    expect(diffTrigger.textContent).toContain('+42/-9');
    fireEvent.click(diffTrigger);
    expect(screen.getByTestId('external-turn-diff-files')).toBeTruthy();
    expect(screen.getByText('src/raft/election.ts')).toBeTruthy();

    // Human takeover toggle
    fireEvent.click(screen.getByTestId('external-turn-takeover-btn'));
    await waitFor(() => {
      expect(setHumanControlledSpy).toHaveBeenCalledWith({
        threadId: 'thr-1',
        chatSessionId: 'sess-1',
        humanControlled: true,
      });
    });

    rerender(<InlineExternalTurnCard thread={useAgentMeshStore.getState().threads['thr-1']} />);
    expect(screen.getByTestId('external-turn-human-controlled-badge')).toBeTruthy();

    // Revert turn checkpoint
    fireEvent.click(screen.getByTestId('external-turn-revert-btn'));
    await waitFor(() => {
      expect(revertCheckpointSpy).toHaveBeenCalledWith({
        chatSessionId: 'sess-1',
        checkpointId: 'cp-turn-1',
        threadId: 'thr-1',
        rootPath: '/Users/dev/projects/deep-raft',
      });
    });

    rerender(<InlineExternalTurnCard thread={useAgentMeshStore.getState().threads['thr-1']} />);
    expect(screen.getByTestId('external-turn-reverted-label')).toBeTruthy();
  });

  it('renders collapsible 1-line PeerExchangeStrip for ask_peer and handoff with inter-agent Q&A and changed files', async () => {
    act(() => {
      applyAgentMeshBackendEvent({
        type: 'peer_exchange_upserted',
        exchange: {
          id: 'px-1',
          chatSessionId: 'sess-peer',
          fromAgent: 'claude',
          fromAgentName: 'Claude Code',
          toAgent: 'codex',
          toAgentName: 'Codex CLI',
          kind: 'ask_peer',
          topic: '冲突错误码契约',
          questionOrSummary: '请问 /api/sync 在版本冲突时返回的错误码字段格式是什么？',
          responseText: '返回 { code: "E_SYNC_CONFLICT", conflictingPaths: string[] }。',
          changedFiles: ['src/api/syncContract.ts', 'src/raft/rpc.ts'],
          rounds: 2,
          status: 'completed',
          createdAt: 2000,
          completedAt: 2500,
        },
      });
    });

    render(<SessionMeshStreamSection sessionId="sess-peer" />);

    const trigger = await screen.findByTestId('peer-exchange-strip-trigger');
    expect(trigger.textContent).toContain('Claude Code ⇄ Codex CLI');
    expect(trigger.textContent).toContain('冲突错误码契约');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('peer-exchange-strip-body')).toBeNull();

    // Expand strip smoothly on click
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('peer-exchange-strip-body')).toBeTruthy();
    expect(
      screen.getByText('请问 /api/sync 在版本冲突时返回的错误码字段格式是什么？'),
    ).toBeTruthy();
    expect(
      screen.getByText('返回 { code: "E_SYNC_CONFLICT", conflictingPaths: string[] }。'),
    ).toBeTruthy();

    const fileBadges = screen.getAllByTestId('peer-exchange-changed-file');
    expect(fileBadges).toHaveLength(2);
    expect(screen.getByText('src/api/syncContract.ts')).toBeTruthy();

    // Collapse back to 1-line strip
    fireEvent.click(trigger);
    expect(screen.queryByTestId('peer-exchange-strip-body')).toBeNull();
  });

  it('renders PeerExchangeStrip handoff summary with changed file count', () => {
    render(
      <PeerExchangeStrip
        exchange={{
          id: 'px-handoff',
          chatSessionId: 'sess-peer',
          fromAgent: 'claude',
          toAgent: 'codex',
          kind: 'handoff',
          questionOrSummary: '解析器 AST 已完成，请补齐边界单元测试。',
          changedFiles: ['src/parser.ts', 'src/ast.ts', 'src/lexer.ts'],
          rounds: 1,
          status: 'completed',
          createdAt: 3000,
        }}
      />,
    );

    expect(screen.getByTestId('peer-exchange-strip-trigger').textContent).toContain(
      'Claude Code → Codex CLI · 交接实现与 3 个改动文件',
    );
  });

  it('suppresses InlineExternalTurnCard for timelineMode="native_chat" while running or 0-diff, and renders sleek 1-line diff/revert strip when files changed', async () => {
    const revertCheckpointSpy = vi.fn(async () => ({
      revertedPaths: ['src/raft/log.ts'],
      skippedUserModifiedPaths: [],
    }));
    registerAgentMeshHostBridge({
      revertCheckpoint: revertCheckpointSpy,
    });

    // 1. Running native_chat turn -> 0 DOM nodes in SessionMeshStreamSection (no alien gray card!)
    act(() => {
      useAgentMeshStore.getState().upsertThread({
        threadId: 'thr-native-1',
        chatSessionId: 'sess-native',
        agentId: 'codex',
        agentName: 'Codex CLI',
        rootPath: '/Users/dev/projects/deep-raft',
        status: 'running',
        timelineMode: 'native_chat',
        assistantText: 'Streaming natively in MessageList...',
        toolCalls: [],
        childSubagents: [],
        activeBgTaskCount: 0,
        pendingApproval: null,
        diffSummary: null,
        humanControlled: false,
        createdAt: 1000,
        updatedAt: 1000,
      });
    });

    const { container, rerender } = render(<SessionMeshStreamSection sessionId="sess-native" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('inline-external-turn-thr-native-1')).toBeNull();
    expect(screen.queryByTestId('mesh-turn-diff-strip-thr-native-1')).toBeNull();

    // 2. Completed native_chat turn with 0 file changes -> STILL 0 DOM nodes!
    act(() => {
      useAgentMeshStore.getState().patchThread('thr-native-1', {
        status: 'idle',
        diffSummary: {
          filesChanged: 0,
          totalAdditions: 0,
          totalDeletions: 0,
          files: [],
        },
      });
    });
    rerender(<SessionMeshStreamSection sessionId="sess-native" />);
    expect(container.firstChild).toBeNull();

    // 3. Completed native_chat turn with modified files -> renders 1-line diff & checkpoint strip
    act(() => {
      useAgentMeshStore.getState().patchThread('thr-native-1', {
        status: 'idle',
        lastCheckpointId: 'cp-native-1',
        diffSummary: {
          filesChanged: 2,
          totalAdditions: 31,
          totalDeletions: 6,
          checkpointId: 'cp-native-1',
          files: [
            {
              path: 'src/raft/log.ts',
              status: 'modified',
              additions: 24,
              deletions: 6,
              patch: '@@ -10,6 +10,24 @@\n+export function appendEntries() {}',
            },
            {
              path: 'src/raft/log.test.ts',
              status: 'added',
              additions: 7,
              deletions: 0,
            },
          ],
        },
      });
    });
    rerender(<SessionMeshStreamSection sessionId="sess-native" />);

    expect(screen.queryByTestId('inline-external-turn-thr-native-1')).toBeNull();
    const diffStrip = screen.getByTestId('mesh-turn-diff-strip-thr-native-1');
    expect(diffStrip).toHaveTextContent('Codex CLI 修改了 2 个文件');
    expect(diffStrip).toHaveTextContent('+31');
    expect(diffStrip).toHaveTextContent('-6');

    // Expandable file list & patches (`查看改动`)
    fireEvent.click(screen.getByTestId('mesh-turn-diff-toggle'));
    expect(screen.getByTestId('mesh-turn-diff-files')).toHaveTextContent('src/raft/log.ts');
    expect(screen.getByTestId('mesh-turn-diff-patch')).toHaveTextContent(
      '+export function appendEntries() {}',
    );

    // Summarize button dispatches CHAT_V2_SET_INPUT
    const dispatched: ChatV2SetInputDetail[] = [];
    const off = addAppEventListener(APP_EVENTS.CHAT_V2_SET_INPUT, (detail) => {
      dispatched.push(detail);
    });
    try {
      fireEvent.click(screen.getByTestId('mesh-turn-diff-explain-btn'));
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.content).toContain('Codex CLI');
      expect(dispatched[0]?.content).toContain('src/raft/log.ts');
    } finally {
      off();
    }

    // Revert turn checkpoint -> switches button to `已回退` muted badge
    fireEvent.click(screen.getByTestId('mesh-turn-diff-revert-btn'));
    await waitFor(() => {
      expect(revertCheckpointSpy).toHaveBeenCalledWith({
        chatSessionId: 'sess-native',
        checkpointId: 'cp-native-1',
        threadId: 'thr-native-1',
        rootPath: '/Users/dev/projects/deep-raft',
      });
    });

    rerender(<SessionMeshStreamSection sessionId="sess-native" />);
    expect(screen.queryByTestId('mesh-turn-diff-revert-btn')).toBeNull();
    expect(screen.getByTestId('mesh-turn-diff-reverted')).toHaveTextContent('已回退');
  });
});
