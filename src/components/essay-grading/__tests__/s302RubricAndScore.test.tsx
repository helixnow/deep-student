import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import zhEssay from '@/locales/zh-CN/essay_grading.json';
import enEssay from '@/locales/en-US/essay_grading.json';
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
    'en-US': {
      essay_grading: enEssay,
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
    const lng = i18n.language || 'zh-CN';
    return {
      t: i18n.getFixedT(lng, defaultNs),
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
    void i18n.changeLanguage('zh-CN');
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

  it('shows a high-contrast stale-rubric banner and ScoreCard badge when switching from an IELTS result to a custom 25-point rubric, then clears after re-grading', async () => {
    const ieltsMode: GradingMode = {
      id: 'ielts',
      name: '雅思大作文',
      description: 'IELTS Writing Task 2（议论文）评分模式，总分9分',
      system_prompt: 'IELTS prompt',
      score_dimensions: [
        { name: 'Task Response', max_score: 9 },
        { name: 'Coherence & Cohesion', max_score: 9 },
        { name: 'Lexical Resource', max_score: 9 },
        { name: 'Grammatical Range & Accuracy', max_score: 9 },
      ],
      total_max_score: 9,
      is_builtin: true,
      created_at: '',
      updated_at: '',
    };

    const ieltsResult = `<score total="7.5" max="9">
<dim name="Task Response" score="7.5" max="9">Addresses all parts of the task.</dim>
<dim name="Coherence &amp; Cohesion" score="7.5" max="9">Clear progression throughout.</dim>
<dim name="Lexical Resource" score="7.5" max="9">Natural academic vocabulary.</dim>
<dim name="Grammatical Range &amp; Accuracy" score="7.5" max="9">Good range of complex structures.</dim>
</score>
<note comment="英式英语中 tuition 指教学，此处建议搭配 tuition fees">tuition</note> should be supported by public funds.`;

    const custom25Result = `<score total="21.5" max="25">
<dim name="文献覆盖" score="8.5" max="10">核心文献综述全面。</dim>
<dim name="批判深度" score="7.0" max="8">能够对比研究局限。</dim>
<dim name="学术表达" score="6.0" max="7">术语规范清晰。</dim>
</score>
<good>This literature review synthesizes competing frameworks effectively.</good>`;

    const onRegradeSpy = vi.fn();

    function StaleRubricHarness() {
      const [modes, setModes] = React.useState<GradingMode[]>([ieltsMode]);
      const [modeId, setModeId] = React.useState('ielts');
      const [showSettings, setShowSettings] = React.useState(false);
      const [isGrading, setIsGrading] = React.useState(false);
      const [gradingResult, setGradingResult] = React.useState(ieltsResult);

      const handleRegrade = () => {
        onRegradeSpy(modeId);
        setIsGrading(true);
      };

      return (
        <>
          <button
            type="button"
            data-testid="test-finish-regrade"
            onClick={() => {
              setGradingResult(custom25Result);
              setIsGrading(false);
            }}
          >
            finish
          </button>
          <button
            type="button"
            data-testid="test-switch-back-ielts"
            onClick={() => setModeId('ielts')}
          >
            back to ielts
          </button>
          <GradingMain
            inputText="University tuition should be supported by public funds."
            setInputText={vi.fn()}
            modeId={modeId}
            setModeId={setModeId}
            modes={modes}
            onModesChange={() => setModes([ieltsMode, ...readLocalCustomModes()])}
            modelId="m1"
            setModelId={vi.fn()}
            models={[{ id: 'm1', name: 'DeepSeek', model: 'deepseek-chat', is_default: true }]}
            essayType=""
            setEssayType={vi.fn()}
            gradeLevel=""
            setGradeLevel={vi.fn()}
            isGrading={isGrading}
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
            onRegrade={handleRegrade}
            onCancelGrading={vi.fn()}
            inputCharCount={54}
            inputTextStats={{
              hanChars: 0,
              englishWords: 8,
              punctuationTotal: 1,
              cnPunctuation: 0,
              enPunctuation: 1,
              nonWhitespaceChars: 47,
              totalChars: 54,
              lineCount: 1,
              paragraphCount: 1,
            }}
            uploadedImages={[]}
            onRemoveImage={vi.fn()}
            topicText=""
            setTopicText={vi.fn()}
            topicImages={[]}
            onTopicFilesDropped={vi.fn()}
            onRemoveTopicImage={vi.fn()}
            gradingResult={gradingResult}
            resultCharCount={gradingResult.length}
            onCopyResult={vi.fn()}
            onExportResult={vi.fn()}
            currentRound={1}
            hasGradedRound
            settingsAsPage
          />
        </>
      );
    }

    render(<StaleRubricHarness />);

    // Initially fresh IELTS result: no stale banner or stale ScoreCard badge
    expect(screen.queryByTestId('essay-stale-rubric-banner')).toBeNull();
    expect(screen.queryByTestId('score-card-stale-rubric-badge')).toBeNull();
    expect(screen.getAllByText('7.5').length).toBeGreaterThanOrEqual(2);

    // Open "+ 自定义标准" from summary header and create a 25-point custom rubric
    fireEvent.click(screen.getByTestId('essay-summary-custom-rubric-button'));
    await screen.findByTestId('essay-custom-rubric-editor');
    fireEvent.change(screen.getByTestId('custom-rubric-name-input'), {
      target: { value: 'S302_学术文献评述25分制' },
    });
    fireEvent.change(screen.getByTestId('custom-rubric-score-input'), {
      target: { value: '25' },
    });
    fireEvent.change(screen.getByTestId('custom-rubric-prompt-input'), {
      target: { value: '按文献覆盖(10)、批判深度(8)、学术表达(7)共25分评分。' },
    });
    fireEvent.click(screen.getByTestId('custom-rubric-save-button'));

    // Immediately displays stale-rubric warning banner and ScoreCard source attribution badge
    const banner = await screen.findByTestId('essay-stale-rubric-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent(
      '当前展示的是旧评分标准「雅思大作文（9分制）」的批改结果，与已选标准「S302_学术文献评述25分制（25分制）」不一致',
    );
    const regradeBtn = screen.getByTestId('essay-regrade-with-selected-rubric');
    expect(regradeBtn).toHaveTextContent('按新标准重新批改');

    const staleBadge = screen.getByTestId('score-card-stale-rubric-badge');
    expect(staleBadge).toHaveTextContent('旧标准结果：雅思大作文');
    // ScoreCard still treats the old 7.5/9 result as IELTS 9-band (does not inject percentage rate)
    expect(screen.queryByTestId('score-card-rate')).toBeNull();

    // Switching back to IELTS clears the stale warning without re-grading
    fireEvent.click(screen.getByTestId('test-switch-back-ielts'));
    await waitFor(() => {
      expect(screen.queryByTestId('essay-stale-rubric-banner')).toBeNull();
      expect(screen.queryByTestId('score-card-stale-rubric-badge')).toBeNull();
    });

    // Switch back to the newly created custom rubric via custom rubric panel -> stale returns
    fireEvent.click(screen.getByTestId('essay-summary-custom-rubric-button'));
    const customEditor = await screen.findByTestId('essay-custom-rubric-editor');
    const savedRubricBtns = screen.getAllByRole('button', { name: 'S302_学术文献评述25分制' });
    const rubricBtnInEditor = savedRubricBtns.find((btn) => customEditor.contains(btn)) ?? savedRubricBtns[0];
    fireEvent.click(rubricBtnInEditor);
    await waitFor(() => {
      expect(screen.getByTestId('essay-stale-rubric-banner')).toBeInTheDocument();
    });

    // Clicking the CTA triggers re-grading under the selected custom rubric
    fireEvent.click(screen.getByTestId('essay-regrade-with-selected-rubric'));
    expect(onRegradeSpy).toHaveBeenCalledTimes(1);
    expect(onRegradeSpy.mock.calls[0]?.[0]).toMatch(/^local_custom_/);

    // While grading, banner is hidden
    expect(screen.queryByTestId('essay-stale-rubric-banner')).toBeNull();

    // Once grading completes under the 25-point rubric, stale banner & badge stay cleared
    fireEvent.click(screen.getByTestId('test-finish-regrade'));
    await waitFor(() => {
      expect(screen.queryByTestId('essay-stale-rubric-banner')).toBeNull();
      expect(screen.queryByTestId('score-card-stale-rubric-badge')).toBeNull();
      expect(screen.getAllByText('/25').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByTestId('score-card-rate')).toHaveTextContent('得分率 86%');
    });
  });

  it('infers stale IELTS rubric immediately on cold mount when selected mode is already a 25-point rubric and supports same-scale switches', () => {
    const ieltsMode: GradingMode = {
      id: 'ielts',
      name: '雅思大作文',
      description: 'IELTS Task 2',
      system_prompt: '',
      score_dimensions: [],
      total_max_score: 9,
      is_builtin: true,
      created_at: '',
      updated_at: '',
    };
    const ieltsTask1Mode: GradingMode = {
      id: 'ielts_task1',
      name: '雅思小作文',
      description: 'IELTS Task 1',
      system_prompt: '',
      score_dimensions: [],
      total_max_score: 9,
      is_builtin: true,
      created_at: '',
      updated_at: '',
    };
    const custom25Mode: GradingMode = {
      id: 'local_custom_s302',
      name: 'S302_学术文献评述25分制',
      description: '25分制',
      system_prompt: 'custom prompt',
      score_dimensions: [],
      total_max_score: 25,
      is_builtin: false,
      created_at: '',
      updated_at: '',
    };

    const ieltsResult = `<score total="7.5" max="9">
<dim name="Task Response" score="7.5" max="9">Strong argument.</dim>
<dim name="Coherence &amp; Cohesion" score="7.5" max="9">Cohesive.</dim>
<dim name="Lexical Resource" score="7.5" max="9">Rich lexis.</dim>
<dim name="Grammatical Range &amp; Accuracy" score="7.5" max="9">Accurate.</dim>
</score>
<good>Clear thesis statement.</good>`;

    const commonProps = {
      inputText: 'Sample IELTS essay.',
      setInputText: vi.fn(),
      setModeId: vi.fn(),
      modes: [ieltsMode, ieltsTask1Mode, custom25Mode],
      modelId: 'm1',
      setModelId: vi.fn(),
      models: [{ id: 'm1', name: 'DeepSeek', model: 'deepseek-chat', is_default: true }],
      essayType: '',
      setEssayType: vi.fn(),
      gradeLevel: '',
      setGradeLevel: vi.fn(),
      isGrading: false,
      onFilesDropped: vi.fn(),
      ocrMaxFiles: 5,
      customPrompt: '',
      setCustomPrompt: vi.fn(),
      showPromptEditor: false,
      setShowPromptEditor: vi.fn(),
      onSavePrompt: vi.fn(),
      onRestoreDefaultPrompt: vi.fn(),
      onClear: vi.fn(),
      onGrade: vi.fn(),
      onRegrade: vi.fn(),
      onCancelGrading: vi.fn(),
      inputCharCount: 19,
      inputTextStats: {
        hanChars: 0,
        englishWords: 3,
        punctuationTotal: 1,
        cnPunctuation: 0,
        enPunctuation: 1,
        nonWhitespaceChars: 17,
        totalChars: 19,
        lineCount: 1,
        paragraphCount: 1,
      },
      uploadedImages: [],
      onRemoveImage: vi.fn(),
      topicText: '',
      setTopicText: vi.fn(),
      topicImages: [],
      onTopicFilesDropped: vi.fn(),
      onRemoveTopicImage: vi.fn(),
      gradingResult: ieltsResult,
      resultCharCount: ieltsResult.length,
      onCopyResult: vi.fn(),
      onExportResult: vi.fn(),
      currentRound: 1,
      hasGradedRound: true,
      settingsAsPage: true,
    };

    // Case 1: Cold mount already on custom 25-point rubric while result is IELTS 7.5/9
    const { rerender } = render(<GradingMain {...commonProps} modeId="local_custom_s302" />);
    expect(screen.getByTestId('essay-stale-rubric-banner')).toHaveTextContent('雅思大作文（9分制）');
    expect(screen.getByTestId('essay-stale-rubric-banner')).toHaveTextContent('S302_学术文献评述25分制（25分制）');
    expect(screen.getByTestId('score-card-stale-rubric-badge')).toHaveTextContent('旧标准结果：雅思大作文');

    // Case 2: Same 9-point scale switch (IELTS Task 2 result while IELTS Task 1 is selected)
    rerender(<GradingMain {...commonProps} modeId="ielts_task1" />);
    expect(screen.getByTestId('essay-stale-rubric-banner')).toHaveTextContent('雅思大作文（9分制）');
    expect(screen.getByTestId('essay-stale-rubric-banner')).toHaveTextContent('雅思小作文（9分制）');

    // Case 3: English locale rendering
    void i18n.changeLanguage('en-US');
    rerender(<GradingMain {...commonProps} modeId="local_custom_s302" />);
    expect(screen.getByTestId('essay-stale-rubric-banner')).toHaveTextContent(
      'Showing results graded under the previous rubric "IELTS Writing Task 2 (9-point)", which differs from the selected rubric "S302_学术文献评述25分制 (25-point)".',
    );
    expect(screen.getByTestId('essay-regrade-with-selected-rubric')).toHaveTextContent('Re-grade with New Rubric');
    expect(screen.getByTestId('score-card-stale-rubric-badge')).toHaveTextContent(
      'Previous rubric: IELTS Writing Task 2',
    );
  });
});
