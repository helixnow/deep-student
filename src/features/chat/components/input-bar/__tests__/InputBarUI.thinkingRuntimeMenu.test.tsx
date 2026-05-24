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
  it('closes the active composer panel before opening the attachment launcher', async () => {
    const user = userEvent.setup();
    const onSetPanelState = vi.fn();

    renderInputBar({
      panelStates: {
        ...createDefaultPanelStates(),
        model: true,
      },
      onSetPanelState,
      renderModelPanel: () => <div data-testid="runtime-model-panel" />,
    });

    await user.click(screen.getByTestId('btn-toggle-attachments'));

    expect(onSetPanelState).toHaveBeenCalledWith('model', false);
  });

  it('closes the active composer panel before opening the thinking runtime menu', async () => {
    const user = userEvent.setup();
    const onSetPanelState = vi.fn();

    renderInputBar({
      panelStates: {
        ...createDefaultPanelStates(),
        model: true,
      },
      onSetPanelState,
      enableThinking: false,
      thinkingStateLabel: '推理: 关闭',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      renderModelPanel: () => <div data-testid="runtime-model-panel" />,
      runtimeModelLabel: 'DeepSeek V3.2',
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));

    expect(onSetPanelState).toHaveBeenCalledWith('model', false);
  });

  it('keeps the runtime model dropdown available when the model has no depth options', async () => {
    const user = userEvent.setup();
    const onSelectRuntimeModel = vi.fn();
    const onOpenRuntimeModelPanel = vi.fn();

    renderInputBar({
      enableThinking: false,
      thinkingStateLabel: '推理: 关闭',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      runtimeModelOptions: [
        { id: 'deepseek-v3.2', label: 'DeepSeek V3.2', providerLabel: 'DeepSeek', iconId: 'deepseek-v3.2' },
        { id: 'gpt-4o', label: 'GPT-4o', providerLabel: 'OpenAI', iconId: 'gpt-4o' },
        { id: 'deepseek-r1', label: 'DeepSeek R1', providerLabel: 'DeepSeek', iconId: 'deepseek-r1' },
      ],
      onSelectRuntimeModel,
      onOpenRuntimeModelPanel,
      runtimeModelLabel: 'DeepSeek V3.2',
      runtimeModelProviderLabel: 'DeepSeek',
      runtimeCurrentModelId: 'deepseek-v3.2',
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    expect(screen.getByRole('menuitem', { name: /选择模型，当前：DeepSeek \/ DeepSeek V3\.2/ })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('搜索名称或模型 ID...')).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /选择模型，当前：DeepSeek \/ DeepSeek V3\.2/ }));

    expect(screen.getByPlaceholderText('搜索名称或模型 ID...')).toBeInTheDocument();
    expect(screen.getAllByText('DeepSeek').length).toBeGreaterThan(0);
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0);
    expect(screen.getByRole('menuitem', { name: /进入多选模式/ })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('搜索名称或模型 ID...'), 'V3.2');
    expect(screen.getAllByRole('menuitem', { name: /DeepSeek V3.2/ }).length).toBeGreaterThan(1);
    expect(screen.queryByRole('menuitem', { name: /GPT-4o/ })).not.toBeInTheDocument();

    const deepSeekSubmenuItems = screen.getAllByRole('menuitem', { name: /DeepSeek V3.2/ });
    await user.click(deepSeekSubmenuItems.find((item) => item.getAttribute('aria-haspopup') !== 'menu') ?? deepSeekSubmenuItems[deepSeekSubmenuItems.length - 1]);
    expect(onSelectRuntimeModel).toHaveBeenCalledWith('deepseek-v3.2');

    expect(onOpenRuntimeModelPanel).not.toHaveBeenCalled();
  });

  it('offers a lightweight compare-mode entry from the runtime model submenu', async () => {
    const user = userEvent.setup();
    const onOpenRuntimeModelPanel = vi.fn();

    renderInputBar({
      enableThinking: false,
      thinkingStateLabel: '推理: 关闭',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      runtimeModelOptions: [
        { id: 'deepseek-v3.2', label: 'DeepSeek V3.2', providerLabel: 'DeepSeek', iconId: 'deepseek-v3.2' },
        { id: 'gpt-4o', label: 'GPT-4o', providerLabel: 'OpenAI', iconId: 'gpt-4o' },
      ],
      onSelectRuntimeModel: vi.fn(),
      onOpenRuntimeModelPanel,
      runtimeModelLabel: 'DeepSeek V3.2',
      runtimeModelProviderLabel: 'DeepSeek',
      runtimeCurrentModelId: 'deepseek-v3.2',
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    await user.click(screen.getByRole('menuitem', { name: /选择模型，当前：DeepSeek \/ DeepSeek V3\.2/ }));
    await user.click(screen.getByRole('menuitem', { name: /进入多选模式/ }));

    expect(onOpenRuntimeModelPanel).toHaveBeenCalledWith('compare');
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

  it('shows the current runtime model with its provider as the compact switch row', async () => {
    const user = userEvent.setup();
    const runtimeModelLabel = 'deepseek-ai/DeepSeek-V4-Flash';
    const runtimeModelProviderLabel = 'SiliconFlow';

    renderInputBar({
      enableThinking: false,
      thinkingStateLabel: '推理: 关闭',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      onOpenRuntimeModelPanel: vi.fn(),
      renderModelPanel: () => <div data-testid="runtime-model-panel" />,
      runtimeModelLabel,
      runtimeModelProviderLabel,
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));

    const modelSwitchItem = screen.getByRole('menuitem', {
      name: `选择模型，当前：${runtimeModelProviderLabel} / ${runtimeModelLabel}`,
    });
    const visibleContent = modelSwitchItem.querySelector('.app-menu-item-content');

    expect(modelSwitchItem.querySelector('.app-menu-item-icon')).toBeNull();
    expect(modelSwitchItem.querySelector('.app-menu-item-suffix')).toBeNull();
    expect(visibleContent).toHaveTextContent(runtimeModelLabel);
    expect(visibleContent).toHaveTextContent(runtimeModelProviderLabel);
    expect(visibleContent).not.toHaveTextContent('选择模型');
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
    const onSelectRuntimeModel = vi.fn();

    renderInputBar({
      enableThinking: false,
      thinkingStateLabel: '推理: 不支持',
      thinkingDepthOptions: [],
      thinkingUnsupported: true,
      onToggleThinking: vi.fn(),
      onSetThinkingDepth: vi.fn(),
      runtimeModelOptions: [
        { id: 'gpt-4o', label: 'GPT-4o', providerLabel: 'OpenAI', iconId: 'gpt-4o' },
      ],
      onSelectRuntimeModel,
      runtimeModelLabel: 'GPT-4o',
      runtimeModelProviderLabel: 'OpenAI',
      runtimeCurrentModelId: 'gpt-4o',
    } as Partial<React.ComponentProps<typeof InputBarUI>>);

    expect(screen.getByTestId('thinking-runtime-state-label')).toHaveTextContent('不支持');

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));

    expect(screen.getByRole('menuitem', { name: '该模型不支持推理' })).toBeDisabled();
    expect(screen.queryByRole('menuitem', { name: '开启' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '关闭' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /选择模型，当前：OpenAI \/ GPT-4o/ }));
    const gptItems = screen.getAllByRole('menuitem', { name: /GPT-4o/ });
    await user.click(gptItems.find((item) => item.getAttribute('aria-haspopup') !== 'menu') ?? gptItems[gptItems.length - 1]);
    expect(onSelectRuntimeModel).toHaveBeenCalledWith('gpt-4o');
  });
});
