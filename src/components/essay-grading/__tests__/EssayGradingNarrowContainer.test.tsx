import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (
      options?.count != null ? `${key}:${options.count}` : key
    ),
  }),
}));

vi.mock('../InputPanel', () => ({
  InputPanel: React.forwardRef<HTMLTextAreaElement, { onCollapse?: () => void }>(({ onCollapse }, _ref) => (
    <div data-testid="input-panel">
      {onCollapse && <button type="button" onClick={onCollapse}>collapse essay</button>}
    </div>
  )),
}));

vi.mock('../ResultPanel', () => ({
  ResultPanel: React.forwardRef<HTMLDivElement, Record<string, unknown>>((_props, ref) => (
    <div ref={ref} data-testid="result-panel" />
  )),
}));

vi.mock('../InlineSettingsPanel', () => ({
  InlineSettingsPanel: () => null,
}));

vi.mock('../../shared/Resizable', () => ({
  HorizontalResizable: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div data-testid="split">{left}{right}</div>
  ),
  VerticalResizable: ({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) => (
    <div data-testid="stack">{top}{bottom}</div>
  ),
}));

vi.mock('@/features/workbench/apps/system/useWbSysSize', () => ({
  useWbSysSize: () => ({ ref: { current: null }, sizeClass: 'medium', heightClass: 'tall' }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 100 },
}));

import { GradingMain } from '../GradingMain';

let observedWidth = 540;
let resizeCallbacks: Array<() => void> = [];
const OriginalResizeObserver = globalThis.ResizeObserver;

const baseProps = (): React.ComponentProps<typeof GradingMain> => ({
  inputText: 'Education empowers every learner.',
  setInputText: vi.fn(),
  modeId: 'ielts',
  setModeId: vi.fn(),
  modes: [{
    id: 'ielts',
    name: '雅思大作文',
    description: '',
    system_prompt: '',
    score_dimensions: [],
    total_max_score: 9,
    is_builtin: true,
    created_at: '',
    updated_at: '',
  }],
  modelId: 'm1',
  setModelId: vi.fn(),
  models: [{ id: 'm1', name: 'deepseek-v4', model: 'deepseek-v4', is_default: true }],
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
  onCancelGrading: vi.fn(),
  inputCharCount: 33,
  inputTextStats: {
    hanChars: 0,
    englishWords: 4,
    punctuationTotal: 1,
    cnPunctuation: 0,
    enPunctuation: 1,
    nonWhitespaceChars: 30,
    totalChars: 33,
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
  gradingResult: '<section-annotation>graded</section-annotation>',
  resultCharCount: 40,
  onCopyResult: vi.fn(),
  onExportResult: vi.fn(),
  currentRound: 1,
});

describe('Essay Grading narrow 440–560px Workbench split-window responsiveness', () => {
  beforeEach(() => {
    resizeCallbacks = [];
    observedWidth = 540;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => observedWidth,
    });
    globalThis.ResizeObserver = class {
      private cb: () => void;
      constructor(cb: ResizeObserverCallback) {
        this.cb = () => cb([], this as unknown as ResizeObserver);
        resizeCallbacks.push(this.cb);
      }
      observe() { this.cb(); }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
    delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
  });

  it('stacks essay editor and feedback panes vertically when container width <= 560px on a 1440px desktop', () => {
    observedWidth = 540;
    const { container } = render(<GradingMain {...baseProps()} />);

    // Reopen essay editor alongside result feedback
    fireEvent.click(screen.getByRole('button', { name: 'essay_grading:input_summary.edit' }));

    expect(screen.getByTestId('stack')).toBeInTheDocument();
    expect(screen.queryByTestId('split')).not.toBeInTheDocument();
    expect(container.querySelector('.essay-grading-root')).toHaveAttribute('data-essay-layout', 'stack');

    // Exact boundary: 560px still stacks single-column
    act(() => {
      observedWidth = 560;
      resizeCallbacks.forEach((cb) => cb());
    });
    expect(screen.getByTestId('stack')).toBeInTheDocument();
    expect(screen.queryByTestId('split')).not.toBeInTheDocument();

    // Wider than 560px switches cleanly back to horizontal split
    act(() => {
      observedWidth = 640;
      resizeCallbacks.forEach((cb) => cb());
    });
    expect(screen.getByTestId('split')).toBeInTheDocument();
    expect(screen.queryByTestId('stack')).not.toBeInTheDocument();
    expect(container.querySelector('.essay-grading-root')).toHaveAttribute('data-essay-layout', 'split');
  });

  it('defines container queries at 560px and 460px in EssayGradingResponsive.css', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/components/essay-grading/EssayGradingResponsive.css'),
      'utf8',
    );
    expect(css).toContain('container-type: inline-size;');
    expect(css).toMatch(/@container\s+essay-pane\s*\(max-width:\s*560px\)/);
    expect(css).toMatch(/@container\s+essay-pane\s*\(max-width:\s*460px\)/);
    expect(css).toMatch(/@container\s+essay-summary\s*\(max-width:\s*560px\)/);
    expect(css).toMatch(/@container\s+essay-summary\s*\(max-width:\s*460px\)/);
    expect(css).toMatch(/@container\s+essay-result\s*\(max-width:\s*560px\)[\s\S]*\.essay-result-legend[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@container\s+essay-settings\s*\(max-width:\s*560px\)[\s\S]*\.essay-rubric-form-grid[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
