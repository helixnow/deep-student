import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';
import type { AttachmentMeta, PanelStates } from '../../../core/types/common';

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

// 📱 移动端布局断点
vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: true,
    isFullscreenContent: false,
  }),
}));

function renderInputBar(overrides: Partial<React.ComponentProps<typeof InputBarUI>> = {}) {
  const props: React.ComponentProps<typeof InputBarUI> = {
    inputValue: '',
    canSend: false,
    canAbort: false,
    isStreaming: false,
    attachments: [],
    panelStates: createDefaultPanelStates(),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onAbort: vi.fn(),
    onAddAttachment: vi.fn(),
    onUpdateAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onClearAttachments: vi.fn(),
    onSetPanelState: vi.fn(),
    placeholder: '输入消息',
    ...overrides,
  };

  return render(<InputBarUI {...props} />);
}

function panelStatesWith(open: Partial<PanelStates>): PanelStates {
  return { ...createDefaultPanelStates(), ...open };
}

describe('InputBarUI mobile inline composer panels (P0-1)', () => {
  it('renders the attachment panel inline inside the composer shell instead of a portal overlay', () => {
    renderInputBar({ panelStates: panelStatesWith({ attachment: true }) });

    const root = screen.getByTestId('input-bar-v2-root');
    const inlinePanel = root.querySelector('[data-composer-panel-inline="attachment"]');
    expect(inlinePanel).not.toBeNull();
    // 面板随文档流展开，不再走 createPortal + fixed 浮层
    expect(document.querySelector('[data-composer-panel-overlay]')).toBeNull();
  });

  it('renders plugin panels (model) through the inline slot on mobile', () => {
    renderInputBar({
      panelStates: panelStatesWith({ model: true }),
      renderModelPanel: () => <div data-testid="model-panel-body">models</div>,
    });

    const root = screen.getByTestId('input-bar-v2-root');
    const inlinePanel = root.querySelector('[data-composer-panel-inline="model"]');
    expect(inlinePanel).not.toBeNull();
    expect(screen.getByTestId('model-panel-body')).toBeInTheDocument();
    expect(document.querySelector('[data-composer-panel-overlay]')).toBeNull();
  });

  it('does not duplicate the model chip in the mobile tool row', () => {
    renderInputBar({
      renderModelPanel: () => <div data-testid="model-panel-body">models</div>,
      onToggleThinking: vi.fn(),
      runtimeModelLabel: 'GPT-6-mini',
    });

    expect(screen.queryByTestId('mobile-model-chip')).toBeNull();
  });

  it('folds the attachment panel header actions into a more menu on mobile (P1-4)', () => {
    renderInputBar({ panelStates: panelStatesWith({ attachment: true }) });

    expect(screen.getByTestId('attachment-panel-more')).toBeInTheDocument();
  });

  it('keeps PDF attachments in a compact collapsed pill strip on mobile instead of auto-expanding the inline panel', () => {
    const onSetPanelState = vi.fn();
    const onRemoveAttachment = vi.fn();
    const pdfAttachment: AttachmentMeta = {
      id: 'att_mobile_pdf',
      name: 'lecture-notes.pdf',
      type: 'document',
      mimeType: 'application/pdf',
      size: 20480,
      status: 'ready',
      sourceId: 'src_mobile_pdf',
      injectModes: { pdf: ['text'] },
      processingStatus: {
        stage: 'completed',
        readyModes: ['text'],
        totalPages: 4,
      },
    };

    renderInputBar({
      attachments: [pdfAttachment],
      onSetPanelState,
      onRemoveAttachment,
    });

    // 上传/资源注入事件在移动端不自动顶起半屏内联附件面板
    window.dispatchEvent(new CustomEvent('CHAT_V2_OPEN_ATTACHMENT_PANEL'));
    expect(onSetPanelState).not.toHaveBeenCalledWith('attachment', true);

    const root = screen.getByTestId('input-bar-v2-root');
    expect(root.querySelector('[data-composer-panel-inline="attachment"]')).toBeNull();

    // 附件条约束为单行紧凑高度，且制卡提示在窄屏隐藏避免叠加撑高输入区
    const previewList = screen.getByRole('list', { name: 'analysis:input_bar.attachments.title' });
    expect(previewList).toHaveClass('max-sm:max-h-[52px]');
    expect(screen.getByTestId('flashcard-hint')).toHaveClass('max-sm:hidden');

    // 删除按钮实体命中框在移动端达到 44×44px，点击删除不误触展开详情
    const removeBtn = screen.getByRole('button', { name: /(?:移除|remove).*lecture-notes\.pdf/i });
    expect(removeBtn).toHaveClass('max-sm:min-h-11', 'max-sm:min-w-11');
    fireEvent.click(removeBtn);
    expect(onRemoveAttachment).toHaveBeenCalledWith('att_mobile_pdf');
    expect(onSetPanelState).not.toHaveBeenCalled();

    // 用户仍可手动点击胶囊按需展开附件详情面板
    const chipItem = screen.getByRole('listitem', { name: 'lecture-notes.pdf' });
    const chipBtn = chipItem.querySelector('.attachment-preview-chip');
    expect(chipBtn).not.toBeNull();
    fireEvent.click(chipBtn!);
    expect(onSetPanelState).toHaveBeenCalledWith('attachment', true);
  });
});
