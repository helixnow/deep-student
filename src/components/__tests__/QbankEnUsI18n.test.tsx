import path from 'node:path';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import enExamSheet from '@/locales/en-US/exam_sheet.json';
import enCommon from '@/locales/en-US/common.json';
import enLearningHub from '@/locales/en-US/learningHub.json';
import enPractice from '@/locales/en-US/practice.json';
import zhExamSheet from '@/locales/zh-CN/exam_sheet.json';
import zhCommon from '@/locales/zh-CN/common.json';
import zhLearningHub from '@/locales/zh-CN/learningHub.json';
import zhPractice from '@/locales/zh-CN/practice.json';
import type { QbankGenerationTask } from '@/types/qbankGeneration';
import type { Question } from '@/api/questionBankApi';

const { mocks, i18nInstance } = await vi.hoisted(async () => ({
  mocks: {
    invoke: vi.fn(),
    notify: vi.fn(),
    eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  },
  i18nInstance: (await import('i18next')).createInstance(),
}));

vi.mock('react-i18next', () =>
  vi.importActual<typeof import('react-i18next')>(
    path.resolve(process.cwd(), 'node_modules/react-i18next/dist/es/index.js'),
  ),
);
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
vi.mock('@/hooks/useBreakpoint', () => ({
  useIsMobile: () => false,
}));
vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
  getLayoutViewportObscuredHeight: () => 0,
}));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));
vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getApiConfigurations: vi.fn(async () => []),
  },
}));

const { I18nextProvider } = await import('react-i18next');
const { AiQuestionGenerationPanel } = await import('@/components/AiQuestionGenerationPanel');
const { QuestionInlineEditor } = await import('@/components/QuestionInlineEditor');
const {
  QBANK_GENERATION_TASK_EVENT,
  useQbankGenerationTasks,
} = await import('@/hooks/useQbankGenerationTasks');
const { useQbankGenerationStore } = await import('@/stores/qbankGenerationStore');

const CJK_OR_FULLWIDTH_PUNCT_RE = /[\u4e00-\u9fff：（）]/;

const TaskListenerHarness: React.FC = () => {
  useQbankGenerationTasks();
  return null;
};

function makeEnCompletedTask(overrides: Partial<QbankGenerationTask> = {}): QbankGenerationTask {
  return {
    id: 'task-en-1',
    examId: 'exam-en-1',
    status: 'completed',
    drafts: [
      {
        local_id: 'q1',
        question_type: 'single_choice',
        content: 'What is the derivative of sin(x)?',
        options: [
          { key: 'A', content: 'cos(x)' },
          { key: 'B', content: '-cos(x)' },
        ],
        answer: 'A',
      },
      {
        local_id: 'q2',
        question_type: 'short_answer',
        content: 'State the Mean Value Theorem.',
        answer: 'There exists c in (a,b) such that f\'(c) = (f(b)-f(a))/(b-a).',
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
      job_id: 'job-en-1',
      version: 1,
      document: {
        schema_version: 'question_document_v2',
        mode: 'generate',
        materials: [],
        groups: [],
        questions: [],
      } as never,
      model_route: {
        source: 'ai_generation',
        request: {
          topic_hint: 'Limits and Derivatives',
          knowledge_points: ['Limits', 'Derivatives'],
        },
        sources: [{ source_id: 's1', name: 'calculus-notes.pdf' }],
        primary_model: { id: 'm1', name: 'DeepSeek', model: 'deepseek-chat' },
      },
    },
    ...overrides,
  };
}

describe('QBank en-US localization (zero Chinese leaks)', () => {
  beforeAll(async () => {
    await i18nInstance.init({
      lng: 'en-US',
      fallbackLng: false,
      defaultNS: 'exam_sheet',
      ns: ['exam_sheet', 'common', 'learningHub', 'practice'],
      resources: {
        'en-US': {
          exam_sheet: enExamSheet,
          common: enCommon,
          learningHub: enLearningHub,
          practice: enPractice,
        },
        'zh-CN': {
          exam_sheet: zhExamSheet,
          common: zhCommon,
          learningHub: zhLearningHub,
          practice: zhPractice,
        },
      },
      interpolation: { escapeValue: false },
    });
  });

  beforeEach(async () => {
    mocks.invoke.mockReset();
    mocks.notify.mockReset();
    mocks.eventHandlers.clear();
    useQbankGenerationStore.setState({ tasks: {} });
    await i18nInstance.changeLanguage('en-US');
  });

  afterEach(async () => {
    await i18nInstance.changeLanguage('zh-CN');
  });

  it('emits fully localized English completion toast and Review & Import CTA in useQbankGenerationTasks', async () => {
    render(
      <I18nextProvider i18n={i18nInstance}>
        <TaskListenerHarness />
      </I18nextProvider>,
    );
    await waitFor(() => {
      expect(mocks.eventHandlers.has(QBANK_GENERATION_TASK_EVENT)).toBe(true);
    });

    act(() => {
      mocks.eventHandlers.get(QBANK_GENERATION_TASK_EVENT)?.({
        payload: makeEnCompletedTask(),
      });
    });

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const [type, message, _title, options] = mocks.notify.mock.calls[0];
    expect(type).toBe('success');
    expect(String(message)).toContain('AI question generation finished');
    expect(String(message)).toContain('2');
    expect(String(message)).toContain('Topic: Limits and Derivatives');
    expect(String(message)).toContain('Sources: calculus-notes.pdf');
    expect(String(message)).toContain('Knowledge points: Limits, Derivatives');
    expect(String(message)).not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);
    expect(options?.action?.label).toBe('Review & Import');
    expect(String(options?.action?.label)).not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);

    // Also verify model-fallback attribution when no topic/sources are present
    act(() => {
      mocks.eventHandlers.get(QBANK_GENERATION_TASK_EVENT)?.({
        payload: makeEnCompletedTask({
          id: 'task-en-2',
          authoringResult: {
            job_id: 'job-en-2',
            version: 1,
            document: {
              schema_version: 'question_document_v2',
              mode: 'generate',
              materials: [],
              groups: [],
              questions: [],
            } as never,
            model_route: {
              source: 'ai_generation',
              primary_model: { name: 'GPT-4o', model: 'gpt-4o' },
            },
          },
        }),
      });
    });

    expect(mocks.notify).toHaveBeenCalledTimes(2);
    const [, fallbackMsg, , fallbackOpts] = mocks.notify.mock.calls[1];
    expect(String(fallbackMsg)).toContain('AI Question Generation · GPT-4o');
    expect(String(fallbackMsg)).not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);
    expect(fallbackOpts?.action?.label).toBe('Review & Import');
  });

  it('renders AiQuestionGenerationPanel empty-set hint and draft attribution without Chinese leaks in en-US', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'qbank_list_generation_tasks') return [];
      if (cmd === 'qbank_get_stats') return { total_count: 0 };
      return null;
    });

    render(
      <I18nextProvider i18n={i18nInstance}>
        <AiQuestionGenerationPanel
          open
          onOpenChange={vi.fn()}
          examId="exam-en-empty"
          examName="Linear Algebra"
        />
      </I18nextProvider>,
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('(No existing questions in this set to reference)');
    expect(dialog.textContent ?? '').not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);
  });

  it('renders AiQuestionGenerationPanel draft review attribution and skipped references in English only', async () => {
    const taskWithSkipped = makeEnCompletedTask({
      id: 'task-en-review',
      examId: 'exam-en-review',
      skippedReferences: [
        { name: 'scan.pdf', reason: 'model_not_multimodal', detail: 'No OCR text' },
      ],
    });
    useQbankGenerationStore.setState({
      tasks: { [taskWithSkipped.id]: taskWithSkipped },
    });

    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'qbank_list_generation_tasks') return [taskWithSkipped];
      if (cmd === 'qbank_get_stats') return { total_count: 2 };
      return null;
    });

    render(
      <I18nextProvider i18n={i18nInstance}>
        <AiQuestionGenerationPanel
          open
          onOpenChange={vi.fn()}
          examId="exam-en-review"
          examName="Calculus"
          initialTaskId={taskWithSkipped.id}
        />
      </I18nextProvider>,
    );

    const attribution = await screen.findByTestId('ai-generation-draft-attribution');
    expect(attribution.textContent).toContain('Generated 2 draft question(s) ready to review');
    expect(attribution.textContent).toContain('Topic: Limits and Derivatives');
    expect(attribution.textContent ?? '').not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('scan.pdf:');
    expect(dialog.textContent).toContain('(No OCR text)');
    expect(dialog.textContent ?? '').not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);
  });

  it('renders QuestionInlineEditor manual form, option removal labels, and source button without Chinese leaks in en-US', () => {
    const { container, unmount } = render(
      <I18nextProvider i18n={i18nInstance}>
        <QuestionInlineEditor
          mode="create"
          examId="exam-en-create"
          question={null}
          onCreate={vi.fn(async () => undefined)}
          onCancel={vi.fn()}
        />
      </I18nextProvider>,
    );

    const markMistake = screen.getByTestId('inline-editor-mark-mistake');
    expect(markMistake.textContent).toContain('Mark as mistake and add to FSRS review');
    expect(markMistake.textContent ?? '').not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);

    // Type into option A and click remove once to verify armed confirm label & title
    const optionAInput = screen.getByPlaceholderText('A ...');
    fireEvent.change(optionAInput, { target: { value: 'Option alpha' } });
    const removeBtn = screen.getByRole('button', { name: 'Remove option A' });
    fireEvent.click(removeBtn);

    const confirmRemoveBtn = screen.getByRole('button', { name: 'Click again to remove option A' });
    expect(confirmRemoveBtn.textContent).toContain('Confirm');
    expect(confirmRemoveBtn.getAttribute('title')).toBe('Click again to remove option A');

    // Inspect all visible text and aria-label / title attributes in create form
    expect(container.textContent ?? '').not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);
    container.querySelectorAll('[aria-label], [title]').forEach((el) => {
      expect(el.getAttribute('aria-label') ?? '').not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);
      expect(el.getAttribute('title') ?? '').not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);
    });

    unmount();

    // Edit mode with source refs: source viewer trigger uses English label & aria-label
    const editQuestion = {
      id: 'q-en-1',
      cardId: 'q-en-1',
      questionLabel: '1',
      content: 'Find the limit of sin(x)/x as x -> 0.',
      questionType: 'single_choice',
      options: [
        { key: 'A', content: '1' },
        { key: 'B', content: '0' },
      ],
      answer: 'A',
      explanation: '',
      difficulty: 'easy',
      tags: [],
      status: 'new',
      userNote: '',
      attemptCount: 0,
      correctCount: 0,
      isFavorite: false,
      images: [],
      examId: 'exam-en-create',
      sourceRefs: [{ source_id: 'src_1', page: 1 }],
    } as unknown as Question;

    const { container: editContainer } = render(
      <I18nextProvider i18n={i18nInstance}>
        <QuestionInlineEditor
          mode="edit"
          examId="exam-en-create"
          question={editQuestion}
          onCancel={vi.fn()}
        />
      </I18nextProvider>,
    );

    const sourceBtn = screen.getByRole('button', { name: 'View original source' });
    expect(sourceBtn.textContent).toContain('Source');
    expect(editContainer.textContent ?? '').not.toMatch(CJK_OR_FULLWIDTH_PUNCT_RE);
  });
});
