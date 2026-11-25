/**
 * S2-05 回归测试：AI 出题完成通知携带数量、来源归属与一键审阅操作，并自动触发题库刷新；
 * 当题库有 0 道已发布题目但存在 ≥1 条 AI 生成待确认草稿时，绝不孤立显示“暂无题目”，
 * 而是直接呈现带来源归属的待确认草稿卡片及一键确认入库 / 逐题审阅入口。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notify: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    mocks.eventHandlers.set(eventName, handler);
    return () => {
      mocks.eventHandlers.delete(eventName);
    };
  }),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.notify,
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/shared/UnifiedDragDropZone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/UnifiedDragDropZone')>()),
  UnifiedDragDropZone: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));
vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getApiConfigurations: vi.fn(async () => []),
  },
}));

import '@/i18n';
import { QuestionBankListView } from '@/components/QuestionBankListView';
import { AiQuestionGenerationPanel } from '@/components/AiQuestionGenerationPanel';
import {
  QBANK_GENERATION_TASK_EVENT,
  useQbankGenerationTasks,
} from '@/hooks/useQbankGenerationTasks';
import { useQbankGenerationStore } from '@/stores/qbankGenerationStore';
import {
  extractAuthoringDraftAttribution,
  extractGenerationTaskAttribution,
  QBANK_OPEN_GENERATION_DRAFT_EVENT,
  type PendingAuthoringDraftView,
  type QbankGenerationTask,
  type QbankOpenGenerationDraftDetail,
} from '@/types/qbankGeneration';

const TaskListenerHarness: React.FC = () => {
  useQbankGenerationTasks();
  return null;
};

function makeCompletedAiTask(overrides: Partial<QbankGenerationTask> = {}): QbankGenerationTask {
  return {
    id: 'task-ai-1',
    examId: 'exam-42',
    status: 'completed',
    drafts: [
      {
        local_id: 'q1',
        question_type: 'single_choice',
        content: '极限存在的充要条件是什么？',
        options: [
          { key: 'A', content: '左右极限存在且相等' },
          { key: 'B', content: '函数连续' },
        ],
        answer: 'A',
      },
      {
        local_id: 'q2',
        question_type: 'short_answer',
        content: '简述洛必达法则的使用前提。',
        answer: '0/0 或 ∞/∞ 型未定式且导数比极限存在',
      },
    ],
    rejectedCount: 0,
    rejectionReasons: [],
    skippedReferences: [],
    usedReferenceCount: 1,
    error: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
    finishedAt: 1_700_000_005_000,
    authoringResult: {
      job_id: 'job-ai-99',
      version: 1,
      document: {
        schema_version: 'question_document_v2',
        mode: 'generate',
        materials: [],
        groups: [],
        questions: [
          { local_id: 'q1', content: '极限存在的充要条件是什么？', question_type: 'single_choice' } as never,
          { local_id: 'q2', content: '简述洛必达法则的使用前提。', question_type: 'short_answer' } as never,
        ],
      } as never,
      model_route: {
        source: 'ai_generation',
        request: {
          topic_hint: '极限与连续',
          knowledge_points: ['极限', '连续性'],
          reference_files_base64: [{ name: 'calculus-ch1.pdf', base64: '' }],
        },
        sources: [{ source_id: 's1', name: 'calculus-ch1.pdf' }],
        primary_model: { id: 'm1', name: 'DeepSeek', model: 'deepseek-chat' },
      },
    },
    ...overrides,
  };
}

describe('S2-05: QBank AI question generation completion, attribution & pending-draft confirmation', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.notify.mockReset();
    mocks.eventHandlers.clear();
    useQbankGenerationStore.setState({ tasks: {} });
  });

  it('extracts human-readable attribution metadata for AI generation, chat import, and file import drafts', () => {
    const aiAttr = extractAuthoringDraftAttribution({
      source: 'ai_generation',
      request: {
        topic_hint: '微积分中值定理',
        knowledge_points: ['罗尔定理', '拉格朗日中值定理'],
      },
      sources: [{ source_id: 'src1', name: '高数讲义.pdf' }],
    });
    expect(aiAttr.origin).toBe('ai_generation');
    expect(aiAttr.sourceLabel).toContain('主题：微积分中值定理');
    expect(aiAttr.sourceLabel).toContain('资料：高数讲义.pdf');
    expect(aiAttr.sourceLabel).toContain('知识点：罗尔定理、拉格朗日中值定理');

    const modelFallbackAttr = extractAuthoringDraftAttribution({
      source: 'ai_generation',
      primary_model: { name: 'Claude Sonnet', model: 'claude-sonnet' },
    });
    expect(modelFallbackAttr).toEqual({
      origin: 'ai_generation',
      sourceLabel: 'AI 智能出题 · Claude Sonnet',
    });

    const taskAttr = extractGenerationTaskAttribution(makeCompletedAiTask());
    expect(taskAttr.count).toBe(2);
    expect(taskAttr.sourceLabel).toContain('主题：极限与连续');
    expect(taskAttr.sourceLabel).toContain('资料：calculus-ch1.pdf');

    const chatAttr = extractAuthoringDraftAttribution({ chat_session_id: 'sess-1' });
    expect(chatAttr.origin).toBe('chat_import');
    expect(chatAttr.sourceLabel).toBe('对话导入');
  });

  it('notifies with count, source attribution, and one-click review action on task completion and dispatches qbank:refresh', async () => {
    const refreshEvents: CustomEvent[] = [];
    const openDraftEvents: CustomEvent<QbankOpenGenerationDraftDetail>[] = [];
    const onRefresh = (e: Event) => refreshEvents.push(e as CustomEvent);
    const onOpenDraft = (e: Event) => openDraftEvents.push(e as CustomEvent<QbankOpenGenerationDraftDetail>);
    window.addEventListener('qbank:refresh', onRefresh);
    window.addEventListener(QBANK_OPEN_GENERATION_DRAFT_EVENT, onOpenDraft);

    try {
      render(<TaskListenerHarness />);
      await waitFor(() => {
        expect(mocks.eventHandlers.has(QBANK_GENERATION_TASK_EVENT)).toBe(true);
      });

      const task = makeCompletedAiTask();
      act(() => {
        mocks.eventHandlers.get(QBANK_GENERATION_TASK_EVENT)?.({ payload: task });
      });

      expect(refreshEvents).toHaveLength(1);
      expect(refreshEvents[0].detail).toMatchObject({
        examId: 'exam-42',
        taskId: 'task-ai-1',
        jobId: 'job-ai-99',
        source: 'ai_generation',
      });

      expect(mocks.notify).toHaveBeenCalledTimes(1);
      const [type, message, _title, options] = mocks.notify.mock.calls[0];
      expect(type).toBe('success');
      expect(String(message)).toContain('2');
      expect(String(message)).toContain('极限与连续');
      expect(options?.action?.label).toBeTruthy();

      act(() => {
        options.action.onClick();
      });

      expect(openDraftEvents).toHaveLength(1);
      expect(openDraftEvents[0].detail).toEqual({
        examId: 'exam-42',
        taskId: 'task-ai-1',
        jobId: 'job-ai-99',
      });
    } finally {
      window.removeEventListener('qbank:refresh', onRefresh);
      window.removeEventListener(QBANK_OPEN_GENERATION_DRAFT_EVENT, onOpenDraft);
    }
  });

  it('replaces misleading "暂无题目" empty state with an attributed pending-draft confirmation card when 0 published questions exist', () => {
    const onConfirm = vi.fn();
    const onReview = vi.fn();
    const pendingDrafts: PendingAuthoringDraftView[] = [
      {
        job_id: 'job-ai-99',
        version: 1,
        question_count: 3,
        status: 'ready',
        origin: 'ai_generation',
        sourceLabel: '主题：极限与连续 · 资料：calculus-ch1.pdf',
        taskId: 'task-ai-1',
        localIds: ['q1', 'q2', 'q3'],
      },
    ];

    render(
      <QuestionBankListView
        questions={[]}
        examId="exam-42"
        pendingDrafts={pendingDrafts}
        onConfirmPendingDraft={onConfirm}
        onReviewPendingDraft={onReview}
        onAiGenerate={vi.fn()}
      />,
    );

    // Must NOT display dead-end "暂无题目"
    expect(screen.queryByText('暂无题目')).toBeNull();

    const card = screen.getByTestId('qbank-pending-drafts-card');
    expect(card.textContent).toContain('3');
    expect(card.textContent).toContain('AI 生成待确认题目');
    expect(card.textContent).toContain('主题：极限与连续 · 资料：calculus-ch1.pdf');

    fireEvent.click(screen.getByTestId('qbank-confirm-pending-draft'));
    expect(onConfirm).toHaveBeenCalledWith(pendingDrafts[0]);

    fireEvent.click(screen.getByTestId('qbank-review-pending-draft'));
    expect(onReview).toHaveBeenCalledWith(pendingDrafts[0]);
  });

  it('still shows standard empty state when there are 0 published questions and 0 pending drafts', () => {
    render(
      <QuestionBankListView
        questions={[]}
        examId="exam-empty"
        pendingDrafts={[]}
        onAiGenerate={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('qbank-pending-drafts-card')).toBeNull();
    expect(screen.getByText('暂无题目')).toBeInTheDocument();
  });

  it('loads pending AI draft directly by initialDraftJobId in AiQuestionGenerationPanel, displays attribution, and confirms into QBank', async () => {
    const onImportComplete = vi.fn();
    const onOpenChange = vi.fn();
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'qbank_list_generation_tasks') return [];
      if (cmd === 'qbank_list_authoring_drafts') return [{ job_id: 'job-ai-99', version: 2, question_count: 1, status: 'ready' }];
      if (cmd === 'qbank_get_stats') return { total_count: 0 };
      if (cmd === 'qbank_get_authoring_draft' && args?.jobId === 'job-ai-99') {
        return {
          job_id: 'job-ai-99',
          exam_id: 'exam-42',
          status: 'ready',
          version: 2,
          metadata: {
            source: 'ai_generation',
            request: { topic_hint: '线性代数特征值' },
          },
          document: {
            materials: [],
            groups: [],
            questions: [
              {
                local_id: 'q-eig-1',
                question_type: 'short_answer',
                content: '求实对称矩阵特征值的性质。',
                answer: '实对称矩阵的特征值均为实数',
                tags: ['特征值'],
              },
            ],
          },
        };
      }
      if (cmd === 'qbank_commit_authoring_draft') {
        return { committed: true, imported_count: 1 };
      }
      return null;
    });

    render(
      <AiQuestionGenerationPanel
        open
        onOpenChange={onOpenChange}
        examId="exam-42"
        examName="线性代数"
        initialDraftJobId="job-ai-99"
        onImportComplete={onImportComplete}
      />,
    );

    const attribution = await screen.findByTestId('ai-generation-draft-attribution');
    expect(attribution.textContent).toContain('主题：线性代数特征值');
    expect(await screen.findByText('求实对称矩阵特征值的性质。')).toBeInTheDocument();

    const confirmBtn = screen.getByTestId('ai-generation-confirm-import');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('qbank_commit_authoring_draft', {
        jobId: 'job-ai-99',
        expectedVersion: 2,
        selectedLocalIds: ['q-eig-1'],
      });
    });
    expect(onImportComplete).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
