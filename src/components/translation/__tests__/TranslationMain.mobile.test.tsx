import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: true, isMobile: true, breakpoint: 'xs' }),
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../SourcePanel', () => ({
  SourcePanel: () => <div data-testid="mock-source-panel" />,
}));

vi.mock('../TargetPanel', () => ({
  TargetPanel: () => <div data-testid="mock-target-panel" />,
}));

vi.mock('../PromptPanel', () => ({
  PromptPanel: () => <div data-testid="mock-prompt-panel" />,
}));

vi.mock('../LanguageSelect', () => ({
  LanguageSelect: ({ dataTestId, ariaLabel }: { dataTestId?: string; ariaLabel?: string }) => (
    <button type="button" data-testid={dataTestId} aria-label={ariaLabel}>
      {ariaLabel}
    </button>
  ),
}));

import { TranslationMain } from '../TranslationMain';

function renderTranslationMain(
  overrides: Partial<React.ComponentProps<typeof TranslationMain>> = {},
) {
  const setFormality = vi.fn();
  const view = render(
    <TranslationMain
      srcLang="en"
      setSrcLang={vi.fn()}
      tgtLang="zh-CN"
      setTgtLang={vi.fn()}
      sourceText=""
      setSourceText={vi.fn()}
      translatedText=""
      isTranslating={false}
      customPrompt=""
      setCustomPrompt={vi.fn()}
      showPromptEditor={false}
      setShowPromptEditor={vi.fn()}
      formality="auto"
      setFormality={setFormality}
      domain="general"
      setDomain={vi.fn()}
      glossary={[]}
      setGlossary={vi.fn()}
      isEditingTranslation={false}
      editedTranslation=""
      setEditedTranslation={vi.fn()}
      translationQuality={null}
      isSpeaking={false}
      isAutoTranslate={false}
      setIsAutoTranslate={vi.fn()}
      isSyncScroll={false}
      setIsSyncScroll={vi.fn()}
      onSwapLanguages={vi.fn()}
      onFilesDropped={vi.fn()}
      onSavePrompt={vi.fn()}
      onRestoreDefaultPrompt={vi.fn()}
      onTranslate={vi.fn()}
      onCancelTranslation={vi.fn()}
      onClear={vi.fn()}
      onEditTranslation={vi.fn()}
      onSaveEditedTranslation={vi.fn()}
      onCancelEdit={vi.fn()}
      onSpeak={vi.fn()}
      onCopyResult={vi.fn()}
      onExportTranslation={vi.fn()}
      onRateTranslation={vi.fn()}
      {...overrides}
    />,
  );
  return { view, setFormality };
}

describe('G09 TranslationMain 360px mobile formality control', () => {
  it('renders the formality SegmentedControl directly in the main view without hiding behind md:flex or drawer', () => {
    const { setFormality } = renderTranslationMain();

    const formalityBar = screen.getByTestId('translation-formality-bar');
    expect(formalityBar).toBeInTheDocument();
    // Must not be hidden below 768px (the original bug used `hidden md:flex`)
    expect(formalityBar.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
    expect(formalityBar.className).toContain('min-w-0');
    expect(formalityBar.className).toContain('max-w-full');

    const group = within(formalityBar).getByRole('radiogroup', {
      name: 'translation:prompt_editor.formality',
    });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);

    // Every option exposes >=44px coarse pointer touch target sizing
    for (const radio of radios) {
      expect(radio.className).toContain('[@media(pointer:coarse)]:!min-h-11');
    }

    const formalOption = within(group).getByRole('radio', {
      name: 'translation:prompt_editor.formality_formal',
    });
    const casualOption = within(group).getByRole('radio', {
      name: 'translation:prompt_editor.formality_casual',
    });

    fireEvent.click(formalOption);
    expect(setFormality).toHaveBeenCalledWith('formal');

    fireEvent.click(casualOption);
    expect(setFormality).toHaveBeenCalledWith('casual');
  });
});
