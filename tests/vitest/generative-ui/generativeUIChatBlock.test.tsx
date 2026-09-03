import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { createStore } from 'zustand';
import { GenerativeUIBlockComponent } from '@/features/chat/plugins/blocks/generativeUI';
import { buildNoteEditSuggestionIntent } from '@/features/generative-ui/utils/buildNoteEditSuggestionIntent';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';
import type { ChatStore } from '@/features/chat/core/types';
import type { Block } from '@/features/chat/core/types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'notes.edit_apply') return '应用到笔记';
      if (key === 'notes.edit_dismiss') return '忽略建议';
      if (key === 'action.confirm_title') return `确认：${params?.label ?? ''}`;
      if (key === 'action.confirm_desc') return '确认描述';
      if (key === 'action.confirm_execute') return '确认执行';
      const map: Record<string, string> = {
        parse_error_title: '无法解析',
        unknown_block_title: `未知：${params?.type ?? ''}`,
        unknown_block_desc: '跳过',
        validation_failed_title: '校验失败',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中',
        'action.unregistered_hint': '未注册',
        'action.unregistered_label': '未注册操作',
        'action.copy_intent': '复制意图',
        'action.copy_block': '复制该组件',
        'panel.no_intent': '无 UI 意图数据',
        'workbench.briefing.start_review': '开始复习',
        'workbench.briefing.open_qbank': '打开题库',
        'workbench.dashboard.open_task_dashboard': '打开制卡任务',
        'research.actions.copy_report': '复制报告',
        'research.actions.export_plan': '导出计划',
        'research.actions.export_intent': '导出全部意图',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/mindmap/components/mindmap/MindMapEmbed', () => ({
  MindMapEmbed: () => <div data-testid="mindmap-embed-mock" />,
}));

import '@/features/generative-ui/blocks';
import { useHpiasStore } from '@/stores/researchStore';
import { buildResearchPlanIntent } from '@/features/generative-ui/utils/buildResearchPlanIntent';
import { useHpiasEventBridge } from '@/features/generative-ui/hooks/useHpiasEventBridge';

vi.mock('@/features/generative-ui/hooks/useHpiasEventBridge', () => ({
  useHpiasEventBridge: vi.fn(),
}));

const mockedUseHpiasEventBridge = vi.mocked(useHpiasEventBridge);

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'gen-block-1',
    messageId: 'msg-1',
    type: 'generative_ui',
    status: 'success',
    content: '',
    ...overrides,
  };
}

function makeStore(canvasNoteId?: string) {
  return createStore<ChatStore>(() =>
    ({
      sessionId: 'sess-1',
      modeState: canvasNoteId ? { canvasNoteId } : null,
    }) as ChatStore,
  );
}

describe('GenerativeUIBlockComponent chat action handlers', () => {
  beforeEach(() => {
    // clearAllMocks：勿 restoreAllMocks，否则会拆掉 vitest.setup 的 matchMedia mock，
    // Renderer 的 useGenerativeUICompact → useMediaQuery 会读到 undefined.matches。
    vi.clearAllMocks();
    mockedUseHpiasEventBridge.mockClear();
    useHpiasStore.getState().actions.clear();
  });

  it('wires workbench handlers for LEARNING_DASHBOARD_EXAMPLE actions', async () => {
    const user = userEvent.setup();
    const activateSpy = vi.fn();
    vi.doMock('@/features/workbench', () => ({
      workbenchBus: { activateDetailed: activateSpy, launch: vi.fn() },
    }));

    render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent: LEARNING_DASHBOARD_EXAMPLE, isStreaming: false },
        })}
        store={makeStore()}
      />,
    );

    expect(screen.getByText('开始复习')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始复习' })).not.toBeDisabled();
  });

  it('dispatches canvas:ai-edit-request when noteEdit + canvasNoteId present', async () => {
    const user = userEvent.setup();
    const intent = buildNoteEditSuggestionIntent({
      operation: 'append',
      operationLabel: '追加',
      previewText: '## 要点',
      labels: {
        metaTitle: '建议',
        metaDescription: '确认',
        operationKey: '操作',
        previewTitle: '预览',
        applyEdit: '应用到笔记',
        dismissSuggestion: '忽略',
      },
    });

    const captured: unknown[] = [];
    const listener = (event: Event) => {
      captured.push((event as CustomEvent).detail);
      const detail = (event as CustomEvent).detail as {
        onLocalDisposition?: (d: { accepted: boolean }) => void;
      };
      detail.onLocalDisposition?.({ accepted: true });
    };
    window.addEventListener('canvas:ai-edit-request', listener);

    render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: false },
          toolInput: {
            intent,
            noteEdit: { operation: 'append', content: '## 要点\n\n内容' },
          },
        })}
        store={makeStore('note-chat-1')}
      />,
    );

    await user.click(screen.getByRole('button', { name: '应用到笔记' }));
    await user.click(screen.getByRole('button', { name: '确认执行' }));

    window.removeEventListener('canvas:ai-edit-request', listener);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      noteId: 'note-chat-1',
      operation: 'append',
      content: '## 要点\n\n内容',
    });
  });

  it('disables note edit actions when canvasNoteId is missing', () => {
    const intent = buildNoteEditSuggestionIntent({
      operation: 'set',
      operationLabel: '替换',
      previewText: 'preview',
      labels: {
        metaTitle: '建议',
        metaDescription: '确认',
        operationKey: '操作',
        previewTitle: '预览',
        applyEdit: '应用到笔记',
        dismissSuggestion: '忽略',
      },
    });

    render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: false },
          toolInput: {
            intent,
            noteEdit: { operation: 'set', content: 'new body' },
          },
        })}
        store={makeStore()}
      />,
    );

    expect(screen.queryByRole('button', { name: '未注册操作' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '应用到笔记' })).not.toBeInTheDocument();
  });

  it('enables hpias event bridge when researchSessionId is present', () => {
    const intent = buildResearchPlanIntent({
      title: 'Deep research',
      steps: [{ label: 'Plan', status: 'pending' }],
      labels: { metaTitle: 'Research' },
    });

    render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: false },
          toolInput: { intent, researchSessionId: 'chat-hpias-1' },
        })}
        store={makeStore()}
      />,
    );

    expect(mockedUseHpiasEventBridge).toHaveBeenCalledWith({
      enabled: true,
      sessionId: 'chat-hpias-1',
    });
  });

  it('subscribes to hpias_event while the research block is still streaming', () => {
    const intent = buildResearchPlanIntent({
      title: 'Deep research',
      steps: [{ label: 'Plan', status: 'pending' }],
      labels: { metaTitle: 'Research' },
    });

    render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: true },
          toolInput: { intent, researchSessionId: 'chat-hpias-stream' },
        })}
        isStreaming
        store={makeStore()}
      />,
    );

    expect(mockedUseHpiasEventBridge).toHaveBeenCalledWith({
      enabled: true,
      sessionId: 'chat-hpias-stream',
    });
  });

  it('does not subscribe to hpias_event when research blocks lack a session id', () => {
    const intent = buildResearchPlanIntent({
      title: 'Deep research',
      steps: [{ label: 'Plan', status: 'pending' }],
      labels: { metaTitle: 'Research' },
    });

    render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: false },
          toolInput: { intent },
        })}
        store={makeStore()}
      />,
    );

    expect(mockedUseHpiasEventBridge).toHaveBeenCalledWith({
      enabled: false,
      sessionId: undefined,
    });
    expect(screen.queryByTestId('hpias-generative-research-panel')).not.toBeInTheDocument();
  });

  it('shows live hpias panel after session events and keeps non-research blocks', () => {
    const intent = buildResearchPlanIntent({
      title: 'Deep research',
      steps: [{ label: 'Plan', status: 'pending' }],
      labels: { metaTitle: 'Research question?' },
    });
    intent.blocks.unshift({ type: 'text', props: { body: 'Research starting…' } });

    const view = render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: false },
          toolInput: { intent, researchSessionId: 'live-1' },
        })}
        store={makeStore()}
      />,
    );

    act(() => {
      useHpiasStore.getState().actions.handleEvent({
        type: 'session_started',
        session_id: 'live-1',
        question: 'Research question?',
      });
      useHpiasStore.getState().actions.handleEvent({
        type: 'plan_generated',
        session_id: 'live-1',
        round: 1,
        plan: { core: { queries: ['Topic A'] } },
      });
    });

    view.rerender(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: false },
          toolInput: { intent, researchSessionId: 'live-1' },
        })}
        store={makeStore()}
      />,
    );

    expect(screen.getByTestId('hpias-generative-research-panel')).toBeInTheDocument();
    expect(screen.getByText('Research starting…')).toBeInTheDocument();
  });

  it('keeps the live panel for session A after session B starts', () => {
    const intent = buildResearchPlanIntent({
      title: 'Deep research',
      steps: [{ label: 'Plan', status: 'pending' }],
      labels: { metaTitle: 'Research question?' },
    });
    intent.blocks.unshift({ type: 'text', props: { body: 'Research starting…' } });

    render(
      <GenerativeUIBlockComponent
        block={makeBlock({
          toolOutput: { intent, isStreaming: false },
          toolInput: { intent, researchSessionId: 'live-a' },
        })}
        store={makeStore()}
      />,
    );

    act(() => {
      const handleEvent = useHpiasStore.getState().actions.handleEvent;
      handleEvent({ type: 'session_started', session_id: 'live-a', question: 'A' });
      handleEvent({
        type: 'plan_generated',
        session_id: 'live-a',
        round: 1,
        plan: { core: { queries: ['Topic A stays'] } },
      });
      handleEvent({ type: 'session_started', session_id: 'live-b', question: 'B' });
      handleEvent({
        type: 'plan_generated',
        session_id: 'live-b',
        round: 1,
        plan: { core: { queries: ['Topic B wins'] } },
      });
    });

    expect(screen.getByTestId('hpias-generative-research-panel')).toBeInTheDocument();
    expect(screen.getAllByText('Topic A stays').length).toBeGreaterThan(0);
    expect(screen.queryByText('Topic B wins')).not.toBeInTheDocument();
    expect(screen.getByText('Research starting…')).toBeInTheDocument();
  });
});
