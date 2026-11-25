import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      t: i18n.getFixedT(i18n.language || 'zh-CN', defaultNs),
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

import { GradingMain } from '../GradingMain';

const IELTS_MODE: GradingMode = {
  id: 'ielts',
  name: '雅思大作文',
  description: 'IELTS Task 2',
  system_prompt: 'IELTS prompt',
  score_dimensions: [],
  total_max_score: 9,
  is_builtin: true,
  created_at: '',
  updated_at: '',
};

const GAOKAO_MODE: GradingMode = {
  id: 'gaokao',
  name: '高考作文',
  description: '60分制',
  system_prompt: 'Gaokao prompt',
  score_dimensions: [],
  total_max_score: 60,
  is_builtin: true,
  created_at: '',
  updated_at: '',
};

const IELTS_RESULT = `<score total="7.5" max="9">
<dim name="Task Response" score="7.5" max="9">Strong argument.</dim>
</score>
<good>Well structured essay.</good>`;

function SettingsHarness({
  initialOpen = true,
  initialModeId = 'gaokao',
  isActive = true,
  onRegrade = vi.fn(),
}: {
  initialOpen?: boolean;
  initialModeId?: string;
  isActive?: boolean;
  onRegrade?: () => void;
}) {
  const [modeId, setModeId] = React.useState(initialModeId);
  const [showSettings, setShowSettings] = React.useState(initialOpen);

  return (
    <div data-testid="settings-open-state" data-open={String(showSettings)}>
      <GradingMain
        inputText="University tuition should be supported by public funds."
        setInputText={vi.fn()}
        modeId={modeId}
        setModeId={setModeId}
        modes={[IELTS_MODE, GAOKAO_MODE]}
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
        onRegrade={onRegrade}
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
        gradingResult={IELTS_RESULT}
        resultCharCount={IELTS_RESULT.length}
        onCopyResult={vi.fn()}
        onExportResult={vi.fn()}
        currentRound={1}
        hasGradedRound
        settingsAsPage
        isActive={isActive}
      />
    </div>
  );
}

describe('Essay Grading Settings Escape handling and visible stale-rubric banner (G08)', () => {
  beforeEach(() => {
    notifyMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('surfaces a single visible stale-rubric banner inside Settings and closes Settings + triggers re-grade on CTA click', () => {
    const onRegrade = vi.fn();
    render(<SettingsHarness initialOpen initialModeId="gaokao" onRegrade={onRegrade} />);

    // Exactly one stale-rubric banner exists in the DOM (inside Settings, not duplicated in hidden ResultPanel)
    const banners = screen.getAllByTestId('essay-stale-rubric-banner');
    expect(banners).toHaveLength(1);
    expect(banners[0]).toHaveAttribute('role', 'status');
    expect(banners[0]).toHaveTextContent('雅思大作文（9分制）');
    expect(banners[0]).toHaveTextContent('高考作文（60分制）');

    const cta = screen.getByTestId('essay-regrade-with-selected-rubric');
    fireEvent.click(cta);

    expect(onRegrade).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-open-state')).toHaveAttribute('data-open', 'false');
  });

  it('dismisses Settings on Escape, closing nested custom-rubric editor first on layered Esc', async () => {
    render(<SettingsHarness initialOpen initialModeId="ielts" />);

    expect(screen.getByTestId('settings-open-state')).toHaveAttribute('data-open', 'true');

    // Open the nested custom-rubric editor inside Settings
    fireEvent.click(screen.getByTestId('essay-custom-rubric-trigger'));
    await screen.findByTestId('essay-custom-rubric-editor');

    // First Escape closes only the nested custom-rubric editor, leaving Settings open
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('essay-custom-rubric-editor')).toBeNull();
    });
    expect(screen.getByTestId('settings-open-state')).toHaveAttribute('data-open', 'true');

    // Second Escape closes the Settings panel itself
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getByTestId('settings-open-state')).toHaveAttribute('data-open', 'false');
    });
  });

  it('ignores Escape during IME composition, when window is inactive, or when inside an inert Stage window', () => {
    const { rerender } = render(<SettingsHarness initialOpen isActive />);

    // IME composition Escape must be ignored
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
    expect(screen.getByTestId('settings-open-state')).toHaveAttribute('data-open', 'true');

    // Inactive window Escape must be ignored
    rerender(<SettingsHarness initialOpen isActive={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('settings-open-state')).toHaveAttribute('data-open', 'true');

    // Occluded/inert Stage window Escape must be ignored
    cleanup();
    const { container } = render(
      <div data-testid="inert-stage-wrapper">
        <SettingsHarness initialOpen isActive />
      </div>,
    );
    const wrapper = container.querySelector('[data-testid="inert-stage-wrapper"]') as HTMLElement;
    wrapper.setAttribute('inert', '');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('settings-open-state')).toHaveAttribute('data-open', 'true');
  });
});
