import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';
import type { PanelStates } from '../../../core/types/common';

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
});
