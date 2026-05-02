import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown> | string) => {
      if (typeof options === 'string') {
        return options;
      }
      if (typeof options === 'object' && typeof options.defaultValue === 'string') {
        return options.defaultValue;
      }
      return _key;
    },
  }),
}));

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: false,
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

describe('InputBarUI thinking/runtime model menu', () => {
  it('keeps the runtime model dropdown available when the model has no depth options', async () => {
    const user = userEvent.setup();
    const onOpenRuntimeModelPanel = vi.fn();

    renderInputBar({
      enableThinking: false,
      thinkingStateLabel: '推理: 关闭',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      onOpenRuntimeModelPanel,
      renderModelPanel: () => <div data-testid="runtime-model-panel" />,
      runtimeModelLabel: 'DeepSeek V3.2',
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    await user.click(screen.getByRole('menuitem', { name: '选择模型' }));

    expect(onOpenRuntimeModelPanel).toHaveBeenCalledTimes(1);
  });

  it('keeps the trigger focused on thinking state instead of the model name', () => {
    renderInputBar({
      enableThinking: false,
      thinkingStateLabel: '推理: 关闭',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      onOpenRuntimeModelPanel: vi.fn(),
      renderModelPanel: () => <div data-testid="runtime-model-panel" />,
      runtimeModelLabel: 'DeepSeek V3.2',
    });

    const triggerLabel = screen.getByTestId('thinking-runtime-state-label');
    expect(triggerLabel).toHaveTextContent('关闭');
    expect(triggerLabel).not.toHaveTextContent('DeepSeek V3.2');
  });

  it('lets toggle-only models turn thinking on and off from the same dropdown', async () => {
    const user = userEvent.setup();
    const onSetThinkingDepth = vi.fn();

    renderInputBar({
      enableThinking: true,
      thinkingStateLabel: '推理: 开启',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      onSetThinkingDepth,
      onOpenRuntimeModelPanel: vi.fn(),
      renderModelPanel: () => <div data-testid="runtime-model-panel" />,
      runtimeModelLabel: 'Qwen Max',
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    await user.click(screen.getByRole('menuitem', { name: '关闭' }));

    expect(onSetThinkingDepth).toHaveBeenCalledWith('off');
  });

  it('shows unsupported reasoning as unavailable while keeping model switching available', async () => {
    const user = userEvent.setup();
    const onOpenRuntimeModelPanel = vi.fn();

    renderInputBar({
      enableThinking: false,
      thinkingStateLabel: '推理: 不支持',
      thinkingDepthOptions: [],
      thinkingUnsupported: true,
      onToggleThinking: vi.fn(),
      onSetThinkingDepth: vi.fn(),
      onOpenRuntimeModelPanel,
      renderModelPanel: () => <div data-testid="runtime-model-panel" />,
      runtimeModelLabel: 'GPT-4o',
    } as Partial<React.ComponentProps<typeof InputBarUI>>);

    expect(screen.getByTestId('thinking-runtime-state-label')).toHaveTextContent('不支持');

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));

    expect(screen.getByRole('menuitem', { name: '该模型不支持推理' })).toBeDisabled();
    expect(screen.queryByRole('menuitem', { name: '开启' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '关闭' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: '选择模型' }));
    expect(onOpenRuntimeModelPanel).toHaveBeenCalledTimes(1);
  });
});
