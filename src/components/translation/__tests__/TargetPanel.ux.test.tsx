import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TargetPanel } from '../TargetPanel';

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/translation/TranslationStreamRenderer', () => ({
  TranslationStreamRenderer: ({ content, placeholder }: { content: string; placeholder: string }) => (
    <div data-testid="mock-translation-stream">{content || placeholder}</div>
  ),
}));

vi.mock('../ComparisonView', () => ({
  ComparisonView: () => <div data-testid="mock-comparison-view" />,
}));

function renderTargetPanel(overrides: Partial<React.ComponentProps<typeof TargetPanel>> = {}) {
  return render(
    <TargetPanel
      sourceText=""
      srcLang="en"
      tgtLang="zh-CN"
      translatedText=""
      isTranslating={false}
      isSyncScroll={false}
      setIsSyncScroll={vi.fn()}
      isEditingTranslation={false}
      editedTranslation=""
      setEditedTranslation={vi.fn()}
      onCancelEdit={vi.fn()}
      onSaveEditedTranslation={vi.fn()}
      translationQuality={null}
      onRateTranslation={vi.fn()}
      targetCharCount={0}
      onEditTranslation={vi.fn()}
      onSpeak={vi.fn()}
      isSpeaking={false}
      onCopyResult={vi.fn()}
      onExportTranslation={vi.fn()}
      {...overrides}
    />,
  );
}

describe('TargetPanel 学习者交互体验', () => {
  it('空态区分无原文引导与原文已就绪快捷键提示', () => {
    const { rerender } = renderTargetPanel({ sourceText: '', translatedText: '' });
    expect(screen.getByTestId('translation-empty-hint').textContent).toContain(
      'translation:target_section.empty_subhint',
    );

    rerender(
      <TargetPanel
        sourceText="Spaced repetition improves retention."
        srcLang="en"
        tgtLang="zh-CN"
        translatedText=""
        isTranslating={false}
        isSyncScroll={false}
        setIsSyncScroll={vi.fn()}
        isEditingTranslation={false}
        editedTranslation=""
        setEditedTranslation={vi.fn()}
        onCancelEdit={vi.fn()}
        onSaveEditedTranslation={vi.fn()}
        translationQuality={null}
        onRateTranslation={vi.fn()}
        targetCharCount={0}
        onEditTranslation={vi.fn()}
        onSpeak={vi.fn()}
        isSpeaking={false}
        onCopyResult={vi.fn()}
        onExportTranslation={vi.fn()}
      />,
    );
    expect(screen.getByTestId('translation-empty-hint').textContent).toContain(
      'translation:target_section.ready_to_translate',
    );
  });

  it('流式翻译态依次展示准备中与实时生成字数胶囊', () => {
    const { rerender } = renderTargetPanel({ isTranslating: true, translatedText: '' });
    expect(screen.getByTestId('translation-streaming-pill').textContent).toContain(
      'translation:target_section.streaming_preparing',
    );

    rerender(
      <TargetPanel
        sourceText="Hello"
        srcLang="en"
        tgtLang="zh-CN"
        translatedText="间隔重复提升记忆"
        isTranslating={true}
        isSyncScroll={false}
        setIsSyncScroll={vi.fn()}
        isEditingTranslation={false}
        editedTranslation=""
        setEditedTranslation={vi.fn()}
        onCancelEdit={vi.fn()}
        onSaveEditedTranslation={vi.fn()}
        translationQuality={null}
        onRateTranslation={vi.fn()}
        targetCharCount={8}
        onEditTranslation={vi.fn()}
        onSpeak={vi.fn()}
        isSpeaking={false}
        onCopyResult={vi.fn()}
        onExportTranslation={vi.fn()}
      />,
    );
    expect(screen.getByTestId('translation-streaming-pill').textContent).toContain(
      'translation:target_section.streaming_live',
    );
  });

  it('点击复制按钮后就地展示已复制微反馈胶囊', () => {
    const onCopyResult = vi.fn();
    renderTargetPanel({ translatedText: '译文内容', onCopyResult });

    const copyBtn = screen.getByTestId('translation-copy-btn');
    fireEvent.click(copyBtn);
    expect(onCopyResult).toHaveBeenCalledTimes(1);
    expect(copyBtn.textContent).toContain('translation:target_section.copied_short');
  });

  it('翻译结果区提供「存为生词闪卡」快捷按钮并触发回调与成功态反馈', async () => {
    const onSaveAsFlashcard = vi.fn(async () => undefined);
    renderTargetPanel({
      sourceText: 'ephemeral',
      translatedText: '短暂的；转瞬即逝的',
      onSaveAsFlashcard,
    });

    const saveBtn = screen.getByTestId('translation-save-flashcard-btn');
    fireEvent.click(saveBtn);
    expect(onSaveAsFlashcard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('translation-target-more-btn'));
    expect(screen.getByTestId('translation-save-flashcard-mobile-btn')).toBeInTheDocument();
  });

  it('过期提示条提供非破坏性选项（另存新版本 / 重新翻译 / 保留当前译文）而非单一覆盖 CTA', () => {
    const onSaveAsNewVersion = vi.fn();
    const onRetranslate = vi.fn();
    const onKeepCurrentTranslation = vi.fn();
    renderTargetPanel({
      sourceText: 'Updated source text',
      translatedText: 'Completed English draft',
      isOutdated: true,
      onSaveAsNewVersion,
      onRetranslate,
      onKeepCurrentTranslation,
    });

    expect(screen.getByTestId('translation-outdated-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('translation-outdated-save-new-version-btn'));
    expect(onSaveAsNewVersion).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('translation-outdated-retranslate-btn'));
    expect(onRetranslate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('translation-outdated-keep-current-btn'));
    expect(onKeepCurrentTranslation).toHaveBeenCalledTimes(1);
  });
});
