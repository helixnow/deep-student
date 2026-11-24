import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionHeader } from '../ChatSessionHeader';
import { MessageItem } from '../MessageItem';
import { SessionBrowser } from '../session-browser/SessionBrowser';
import { createChatStore } from '../../core/store/createChatStore';
import { useSessionListStore } from '../../stores/sessionListStore';
import type { LoadSessionResponseType } from '../../core/types';
import type { Block } from '../../core/types/block';
import type { Message } from '../../core/types/message';

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../BlockRenderer', () => ({
  BlockRendererWithStore: ({ store, blockId }: { store: any; blockId: string }) => {
    const block = store.getState().blocks.get(blockId);
    if (!block) return null;
    return <div data-testid={`block-${blockId}`}>{block.content}</div>;
  },
}));

vi.mock('../ActivityTimeline', async () => {
  const actual = await vi.importActual<typeof import('../ActivityTimeline')>('../ActivityTimeline');
  return {
    ...actual,
    ActivityTimelineWithStore: ({ blockIds }: { blockIds: string[] }) => (
      <div data-testid={`timeline-${blockIds.join(',')}`} />
    ),
  };
});

vi.mock('../ThinkingIndicator', () => ({
  ThinkingIndicator: () => <div data-testid="thinking-indicator">thinking</div>,
}));

vi.mock('../ui/ThreadContentShell', () => ({
  ThreadContentShell: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock('../panels/SourcePanelV2', () => ({
  SourcePanelV2: () => null,
}));

vi.mock('../Variant', () => ({
  ParallelVariantView: () => null,
}));

vi.mock('../ContextRefsDisplay', () => ({
  ContextRefsDisplay: () => null,
  hasContextRefs: () => false,
  CONTEXT_REFS_VISIBLE_COUNT: 8,
}));

vi.mock('../message', async () => {
  const actual = await vi.importActual<typeof import('../message')>('../message');
  return {
    ...actual,
    MemoryKernelAttributionPill: () => null,
    MessageActions: ({
      onEdit,
      canEdit,
    }: {
      onEdit?: () => void;
      canEdit?: boolean;
    }) => (
      <div data-testid="mock-message-actions">
        {canEdit && onEdit && (
          <button type="button" data-testid="trigger-edit-btn" onClick={onEdit}>
            edit
          </button>
        )}
      </div>
    ),
    MessageTouchActionBar: () => null,
    UserMessageBubble: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

describe('Stage 4 Chat fixes (S4-01, S4-02, S4-14, S4-15)', () => {
  beforeEach(() => {
    useSessionListStore.getState().setSnapshot([]);
  });

  it('S4-02 P1: renders discoverable Rename session control in ChatSessionHeader and persists via settings callback', async () => {
    const store = createChatStore('sess_rename_1');
    const updateSettingsMock = vi.fn().mockResolvedValue(undefined);
    store.getState().setUpdateSessionSettingsCallback(updateSettingsMock);
    act(() => {
      store.setState({ sessionId: 'sess_rename_1', title: '旧会话标题' });
    });
    useSessionListStore.getState().setSnapshot([
      {
        id: 'sess_rename_1',
        title: '旧会话标题',
        mode: 'chat',
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const updatedEvents: Event[] = [];
    const onSessionsUpdated = (e: Event) => updatedEvents.push(e);
    window.addEventListener('chat-v2:sessions-updated', onSessionsUpdated);

    render(<ChatSessionHeader store={store} />);

    const renameBtn = screen.getByRole('button', { name: '重命名会话' });
    expect(renameBtn).toBeInTheDocument();
    expect(screen.getByTestId('chat-header-title')).toHaveTextContent('旧会话标题');

    fireEvent.click(renameBtn);
    const input = screen.getByTestId('chat-header-rename-input') as HTMLInputElement;
    expect(input.value).toBe('旧会话标题');

    // Rejects empty title locally
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('chat-header-rename-save'));
    expect(screen.getByTestId('chat-header-rename-error')).toBeInTheDocument();
    expect(updateSettingsMock).not.toHaveBeenCalled();

    // Saves non-empty title cleanly
    fireEvent.change(input, { target: { value: '微积分错题复习' } });
    fireEvent.click(screen.getByTestId('chat-header-rename-save'));

    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledWith({ title: '微积分错题复习' });
    });
    expect(store.getState().title).toBe('微积分错题复习');
    expect(useSessionListStore.getState().sessions[0]?.title).toBe('微积分错题复习');
    expect(updatedEvents.length).toBeGreaterThanOrEqual(1);

    // Backend failure rolls back cleanly and keeps editor open
    updateSettingsMock.mockRejectedValueOnce(new Error('network error'));
    fireEvent.click(screen.getByTestId('chat-header-rename-button'));
    const retryInput = screen.getByTestId('chat-header-rename-input') as HTMLInputElement;
    fireEvent.change(retryInput, { target: { value: '失败标题' } });
    fireEvent.click(screen.getByTestId('chat-header-rename-save'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-header-rename-error')).toBeInTheDocument();
    });
    expect(store.getState().title).toBe('微积分错题复习');
    expect(screen.getByTestId('chat-header-rename-input')).toBeInTheDocument();

    window.removeEventListener('chat-v2:sessions-updated', onSessionsUpdated);
  });

  it('S4-02 P1: confirms before replacing downstream replies when editing an earlier user message', async () => {
    const store = createChatStore('sess_edit_confirm');
    const editCallback = vi.fn().mockResolvedValue({
      deletedCount: 2,
      newUserMessageId: 'u1_new',
      newAssistantMessageId: 'a1_new',
    });
    store.getState().setEditAndResendCallback(editCallback);

    const userBlk1: Block = {
      id: 'blk_u1',
      messageId: 'msg_u1',
      type: 'content',
      status: 'success',
      content: '第一问',
    };
    const userBlk2: Block = {
      id: 'blk_u2',
      messageId: 'msg_u2',
      type: 'content',
      status: 'success',
      content: '第二问',
    };
    const asstBlk1: Block = {
      id: 'blk_a1',
      messageId: 'msg_a1',
      type: 'content',
      status: 'success',
      content: '第一答',
    };
    const msgU1: Message = { id: 'msg_u1', role: 'user', blockIds: ['blk_u1'], timestamp: 100 };
    const msgA1: Message = { id: 'msg_a1', role: 'assistant', blockIds: ['blk_a1'], timestamp: 200 };
    const msgU2: Message = { id: 'msg_u2', role: 'user', blockIds: ['blk_u2'], timestamp: 300 };

    act(() => {
      store.setState({
        sessionStatus: 'idle',
        messageOrder: ['msg_u1', 'msg_a1', 'msg_u2'],
        messageMap: new Map([
          ['msg_u1', msgU1],
          ['msg_a1', msgA1],
          ['msg_u2', msgU2],
        ]),
        blocks: new Map([
          ['blk_u1', userBlk1],
          ['blk_a1', asstBlk1],
          ['blk_u2', userBlk2],
        ]),
      });
    });

    const { rerender } = render(
      <MessageItem store={store as unknown as React.ComponentProps<typeof MessageItem>['store']} messageId="msg_u1" />
    );

    fireEvent.click(screen.getByTestId('trigger-edit-btn'));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '修改后的第一问' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // Prompt shown, editAndResend NOT executed yet
    expect(editCallback).not.toHaveBeenCalled();
    const confirmBox = screen.getByTestId('edit-downstream-confirm');
    expect(confirmBox).toHaveTextContent('编辑此消息将替换后续回复，是否继续？');

    // Canceling confirm keeps the draft open
    fireEvent.click(screen.getByTestId('edit-downstream-cancel'));
    expect(screen.queryByTestId('edit-downstream-confirm')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('修改后的第一问');
    expect(editCallback).not.toHaveBeenCalled();

    // Confirming submits editAndResend
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByTestId('edit-downstream-confirm-button'));
    await waitFor(() => {
      expect(editCallback).toHaveBeenCalledWith('msg_u1', '修改后的第一问', undefined);
    });

    // Editing the last message (no downstream replies) submits directly without confirmation
    editCallback.mockClear();
    act(() => {
      store.setState({
        sessionStatus: 'idle',
        messageOrder: ['msg_u1', 'msg_a1', 'msg_u2'],
        messageMap: new Map([
          ['msg_u1', msgU1],
          ['msg_a1', msgA1],
          ['msg_u2', msgU2],
        ]),
        blocks: new Map([
          ['blk_u1', userBlk1],
          ['blk_a1', asstBlk1],
          ['blk_u2', userBlk2],
        ]),
      });
    });
    rerender(
      <MessageItem store={store as unknown as React.ComponentProps<typeof MessageItem>['store']} messageId="msg_u2" />
    );
    fireEvent.click(screen.getByTestId('trigger-edit-btn'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '修改最后一条' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.queryByTestId('edit-downstream-confirm')).toBeNull();
    await waitFor(() => {
      expect(editCallback).toHaveBeenCalledWith('msg_u2', '修改最后一条', undefined);
    });
  });

  it('S4-02 P2 & S4-14 P2: shows manual stop badge on stopped turns and hides false retry prompt on normal turns', () => {
    const store = createChatStore('sess_stop_and_retry');

    // 1. Normal completed turn -> NO "点击选择模型重试" tooltip
    const normalBlock: Block = {
      id: 'blk_normal',
      messageId: 'msg_normal',
      type: 'content',
      status: 'success',
      content: '这是完整回答。',
    };
    const normalMsg: Message = {
      id: 'msg_normal',
      role: 'assistant',
      blockIds: ['blk_normal'],
      timestamp: 100,
      _meta: { modelId: 'gpt-4o', modelDisplayName: 'GPT-4o' },
    };

    act(() => {
      store.setState({
        sessionStatus: 'idle',
        messageOrder: ['msg_normal'],
        messageMap: new Map([['msg_normal', normalMsg]]),
        blocks: new Map([['blk_normal', normalBlock]]),
      });
    });

    const { rerender } = render(
      <MessageItem
        store={store as unknown as React.ComponentProps<typeof MessageItem>['store']}
        messageId="msg_normal"
        isLatest
      />
    );

    expect(screen.getByTestId('chat-message-model-label')).toHaveTextContent('GPT-4o');
    expect(screen.queryByTitle('点击选择模型重试')).toBeNull();
    expect(screen.queryByTestId('chat-message-stopped')).toBeNull();

    // 2. Manually aborted turn with partial thinking block -> explicit "已手动停止" badge & no retry prompt
    const thinkingBlk: Block = {
      id: 'blk_think_stop',
      messageId: 'msg_stopped',
      type: 'thinking',
      status: 'running',
      content: '正在推理中...',
    };
    const streamingMsg: Message = {
      id: 'msg_stopped',
      role: 'assistant',
      blockIds: ['blk_think_stop'],
      timestamp: 200,
      _meta: { modelId: 'gpt-4o', modelDisplayName: 'GPT-4o' },
    };
    act(() => {
      store.setState({
        sessionStatus: 'streaming',
        currentStreamingMessageId: 'msg_stopped',
        activeBlockIds: new Set(['blk_think_stop']),
        messageOrder: ['msg_normal', 'msg_stopped'],
        messageMap: new Map([
          ['msg_normal', normalMsg],
          ['msg_stopped', streamingMsg],
        ]),
        blocks: new Map([
          ['blk_normal', normalBlock],
          ['blk_think_stop', thinkingBlk],
        ]),
      });
      store.getState().completeStream('cancelled');
    });

    expect(store.getState().sessionStatus).toBe('idle');
    expect(store.getState().activeBlockIds.size).toBe(0);
    expect(store.getState().blocks.get('blk_think_stop')).toMatchObject({
      status: 'success',
      aborted: true,
    });
    expect(store.getState().messageMap.get('msg_stopped')?._meta?.stoppedByUser).toBe(true);

    rerender(
      <MessageItem
        store={store as unknown as React.ComponentProps<typeof MessageItem>['store']}
        messageId="msg_stopped"
        isLatest
      />
    );

    expect(screen.getByTestId('chat-message-stopped')).toHaveTextContent('已手动停止');
    expect(screen.queryByTitle('点击选择模型重试')).toBeNull();

    // 3. Zero-output / errored turn -> shows retry affordance
    const errMsg: Message = {
      id: 'msg_err',
      role: 'assistant',
      blockIds: ['blk_err'],
      timestamp: 300,
      _meta: { modelId: 'gpt-4o', modelDisplayName: 'GPT-4o', terminalError: 'upstream 500' },
    };
    const errBlock: Block = {
      id: 'blk_err',
      messageId: 'msg_err',
      type: 'content',
      status: 'success',
      content: '部分输出',
    };
    act(() => {
      store.setState({
        sessionStatus: 'idle',
        messageOrder: ['msg_err'],
        messageMap: new Map([['msg_err', errMsg]]),
        blocks: new Map([['blk_err', errBlock]]),
      });
    });

    rerender(
      <MessageItem
        store={store as unknown as React.ComponentProps<typeof MessageItem>['store']}
        messageId="msg_err"
        isLatest
      />
    );

    expect(screen.getByTitle('点击选择模型重试')).toBeInTheDocument();
  });

  it('S4-01 P1 & S4-15 P1: clears stuck running/pending blocks and streaming variants on DB reload', () => {
    const store = createChatStore('sess_reload');

    const response: LoadSessionResponseType = {
      session: {
        id: 'sess_reload',
        mode: 'chat',
        title: '中断后恢复的会话',
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      messages: [
        {
          id: 'msg_asst_1',
          sessionId: 'sess_reload',
          role: 'assistant',
          blockIds: ['blk_think_stale', 'blk_tool_stale'],
          timestamp: 1000,
          variants: [
            {
              id: 'var_1',
              modelId: 'm1',
              blockIds: ['blk_think_stale'],
              status: 'streaming',
              createdAt: 1000,
            },
          ],
        },
      ],
      blocks: [
        {
          id: 'blk_think_stale',
          messageId: 'msg_asst_1',
          type: 'thinking',
          status: 'running',
          content: '之前中断时的思考...',
          startedAt: 900,
        },
        {
          id: 'blk_tool_stale',
          messageId: 'msg_asst_1',
          type: 'mcp_tool',
          status: 'pending',
          toolName: 'note_read',
          startedAt: 950,
        },
      ],
    };

    act(() => {
      store.getState().restoreFromBackend(response);
    });

    const state = store.getState();
    expect(state.sessionStatus).toBe('idle');
    expect(state.currentStreamingMessageId).toBeNull();
    expect(state.activeBlockIds.size).toBe(0);
    expect(state.streamingVariantIds.size).toBe(0);
    expect(state.blocks.get('blk_think_stale')).toMatchObject({
      status: 'success',
      aborted: true,
    });
    expect(state.blocks.get('blk_tool_stale')).toMatchObject({
      status: 'error',
    });
    expect(state.messageMap.get('msg_asst_1')?.variants?.[0]?.status).toBe('cancelled');
  });

  it('S4-15 P1: keeps SessionBrowser New Chat button enabled and clickable', () => {
    const onCreateSession = vi.fn();
    render(
      <SessionBrowser
        sessions={[]}
        currentSessionId="sess_streaming"
        onSelectSession={vi.fn()}
        onCreateSession={onCreateSession}
        onDeleteSession={vi.fn()}
      />
    );

    const newSessionButtons = screen.getAllByRole('button', { name: /新建会话/i });
    expect(newSessionButtons.length).toBeGreaterThan(0);
    for (const btn of newSessionButtons) {
      expect(btn).toBeEnabled();
    }
    fireEvent.click(newSessionButtons[0]);
    expect(onCreateSession).toHaveBeenCalledTimes(1);
  });
});
