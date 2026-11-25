import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import zhEssay from '@/locales/zh-CN/essay_grading.json';
import zhCommon from '@/locales/zh-CN/common.json';
import zhSettings from '@/locales/zh-CN/settings.json';
import type { GradingMode } from '@/essay-grading/types';

const notifyMock = vi.hoisted(() => vi.fn());

const i18n = i18next.createInstance();
void i18n.init({
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  resources: {
    'zh-CN': {
      essay_grading: zhEssay,
      common: zhCommon,
      settings: zhSettings,
    },
  },
  ns: ['essay_grading', 'common', 'settings'],
  defaultNS: 'essay_grading',
  interpolation: { escapeValue: false },
  initImmediate: false,
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: (ns?: string | string[]) => {
    const defaultNs = Array.isArray(ns) ? ns[0] : (ns ?? 'essay_grading');
    return {
      t: i18n.getFixedT('zh-CN', defaultNs),
      i18n,
    };
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/shared/UnifiedModelSelector', () => ({
  UnifiedModelSelector: () => <div data-testid="mock-model-selector" />,
}));

vi.mock('@/features/workbench/apps/system/useWbSysSize', () => ({
  useWbSysSize: () => ({ ref: { current: null }, sizeClass: 'wide', heightClass: 'tall' }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 100 },
}));

import { ScoreCard, reconcileEssayScore } from '../ScoreCard';
import { GradingMain } from '../GradingMain';
import { readLocalCustomModes } from '@/essay-grading/modeIds';

describe('S3-02 Custom rubric quick entry, score rounding consistency, and IELTS 9-band display', () => {
  beforeEach(() => {
    notifyMock.mockReset();
    localStorage.clear();
  });

  it('reconciles 18.5 vs 18.4 total/dimension double rounding on 25-point additive rubrics', () => {
    // Case A: LLM writes total=18.4 while 1-decimal dimensions sum to 18.5
    const driftReconciled = reconcileEssayScore(
      {
        total: 18.4,
        maxTotal: 25,
        grade: 'pass',
        isComplete: true,
        dimensions: [
          { name: '内容切题', score: 6.5, maxScore: 10 },
          { name: '结构衔接', score: 6.0, maxScore: 8 },
          { name: '语言表达', score: 6.0, maxScore: 7 },
        ],
      },
      false,
    );
    expect(driftReconciled.total).toBe(18.5);
    expect(driftReconciled.dimensions.map((d) => d.score)).toEqual([6.5, 6, 6]);

    // Case B: 4 dimensions [4.63, 4.63, 4.62, 4.62] sum to 18.50, avoiding 4 * 4.6 = 18.4 mismatch
    render(
      <ScoreCard
        gradingModeId="custom_local_25"
        score={{
          total: 18.5,
          maxTotal: 25,
          grade: 'pass',
          isComplete: true,
          dimensions: [
            { name: '论点', score: 4.63, maxScore: 6.25 },
            { name: '论据', score: 4.63, maxScore: 6.25 },
            { name: '结构', score: 4.62, maxScore: 6.25 },
            { name: '语言', score: 4.62, maxScore: 6.25 },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('18.5').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('/25')).toBeInTheDocument();
    // Sum of displayed dimension scores equals 18.5 (4.7 + 4.6 + 4.6 + 4.6 = 18.5)
    expect(screen.getByText('4.7')).toBeInTheDocument();
    expect(screen.getByTestId('score-card-rate')).toHaveTextContent('得分率 74%');
  });

  it('hides pass/fail grade badge and percentage score rate on 9-band IELTS modes', () => {
    const { rerender } = render(
      <ScoreCard
        gradingModeId="ielts"
        score={{
          total: 6.5,
          maxTotal: 9,
          grade: 'pass',
          isComplete: true,
          dimensions: [
            { name: 'Task Response', score: 6.5, maxScore: 9 },
            { name: 'Coherence and Cohesion', score: 6.5, maxScore: 9 },
            { name: 'Lexical Resource', score: 6.5, maxScore: 9 },
            { name: 'Grammatical Range & Accuracy', score: 6.5, maxScore: 9 },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('6.5').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('/9').length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByTestId('score-card-rate')).toBeNull();
    expect(screen.queryByText('及格')).toBeNull();
    expect(screen.queryByText(/得分率/)).toBeNull();

    // Non-IELTS mode still shows grade badge and score rate
    rerender(
      <ScoreCard
        gradingModeId="cet4"
        score={{
          total: 12,
          maxTotal: 15,
          grade: 'good',
          isComplete: true,
          dimensions: [
            { name: '内容', score: 6, maxScore: 7 },
            { name: '语言', score: 6, maxScore: 8 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('score-card-rate')).toHaveTextContent('得分率 80%');
    expect(screen.getByText('良好')).toBeInTheDocument();
  });

  it('exposes "+ 新建 / 管理自定义标准" directly in the primary input header, saves custom rubric, and activates it immediately', async () => {
    const builtinMode: GradingMode = {
      id: 'gaokao',
      name: '高考作文',
      description: '60分制',
      system_prompt: '默认高考标准',
      score_dimensions: [],
      total_max_score: 60,
      is_builtin: true,
      created_at: '',
      updated_at: '',
    };

    function Harness() {
      const [modes, setModes] = React.useState<GradingMode[]>([builtinMode]);
      const [modeId, setModeId] = React.useState('gaokao');
      const [showSettings, setShowSettings] = React.useState(false);
      const [inputText, setInputText] = React.useState('');

      return (
        <GradingMain
          inputText={inputText}
          setInputText={setInputText}
          modeId={modeId}
          setModeId={setModeId}
          modes={modes}
          onModesChange={() => setModes([builtinMode, ...readLocalCustomModes()])}
          modelId="m1"
          setModelId={vi.fn()}
          models={[{ id: 'm1', name: 'DeepSeek', model: 'deepseek-chat', is_default: true }]}
          essayType=""
          setEssayType={vi.fn()}
          gradeLevel=""
          setGradeLevel={vi.fn()}
          isGrading={false}
          onFilesDropped={vi.fn()}
          ocrMaxFiles={5}
          customPrompt=""
          setCustomPrompt={vi.fn()}
          showPromptEditor={showSettings}
          setShowPromptEditor={setShowSettings}
          onSavePrompt={vi.fn()}
          onRestoreDefaultPrompt={vi.fn()}
          onClear={vi.fn()}
          onGrade={vi.fn()}
          onCancelGrading={vi.fn()}
          inputCharCount={0}
          inputTextStats={{
            hanChars: 0,
            englishWords: 0,
            punctuationTotal: 0,
            cnPunctuation: 0,
            enPunctuation: 0,
            nonWhitespaceChars: 0,
            totalChars: 0,
            lineCount: 0,
            paragraphCount: 0,
          }}
          uploadedImages={[]}
          onRemoveImage={vi.fn()}
          topicText=""
          setTopicText={vi.fn()}
          topicImages={[]}
          onTopicFilesDropped={vi.fn()}
          onRemoveTopicImage={vi.fn()}
          gradingResult=""
          resultCharCount={0}
          onCopyResult={vi.fn()}
          onExportResult={vi.fn()}
          currentRound={0}
          settingsAsPage
        />
      );
    }

    render(<Harness />);

    // Primary header directly exposes "+ 新建 / 管理自定义标准" without needing "批改设置"
    const quickRubricBtn = screen.getByTestId('essay-manage-custom-rubric-button');
    expect(quickRubricBtn).toHaveTextContent('新建 / 管理自定义标准');
    fireEvent.click(quickRubricBtn);

    // Custom rubric editor is immediately open
    const editor = await screen.findByTestId('essay-custom-rubric-editor');
    expect(editor).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('custom-rubric-name-input'), {
      target: { value: '考研英语小作文25分制' },
    });
    fireEvent.change(screen.getByTestId('custom-rubric-score-input'), {
      target: { value: '25' },
    });
    fireEvent.change(screen.getByTestId('custom-rubric-prompt-input'), {
      target: { value: '按格式规范(5分)、内容要点(10分)、语言准确(10分)严格逐项评分。' },
    });
    fireEvent.click(screen.getByTestId('custom-rubric-save-button'));

    // Automatically returns to workbench with the new custom rubric selected
    await waitFor(() => {
      expect(screen.getByTestId('essay-manage-custom-rubric-button')).toBeVisible();
      expect(screen.getAllByText('考研英语小作文25分制').length).toBeGreaterThan(0);
    });
  });
});
