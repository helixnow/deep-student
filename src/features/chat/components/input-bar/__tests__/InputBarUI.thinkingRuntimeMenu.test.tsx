import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterAll(() => {
  vi.restoreAllMocks();
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (
      _key: string,
      defaultValueOrOptions?: Record<string, unknown> | string,
      maybeOptions?: Record<string, unknown>
    ) => {
      const translations: Record<string, string> = {
        'settings:api.modal.reasoning.effort.high': '高',
        'settings:api.modal.reasoning.effort.low': '低',
        'chatV2:inputBar.chooseRuntimeModel': '选择模型',
        'chatV2:inputBar.runtimeModelTitle': '模型',
        'chatV2:inputBar.thinkingDepthTitle': '推理强度',
        'chatV2:inputBar.runtimeModelSwitchCurrent': '{{label}}，当前：{{current}}',
        'chatV2:modelPicker.t3.searchPlaceholder': '搜索模型...',
        'chatV2:modelPicker.t3.noReasoningEffort': '没有可选的推理强度',
        'chatV2:modelPicker.t3.unavailable': '不可用',
        'chatV2:inputBar.runtimeModelCompareMode': '多选模式',
        'chatV2:inputBar.thinkingOn': '开启',
        'chatV2:inputBar.thinkingOff': '关闭',
        'chatV2:authority.permissionPreset.modes.cautious': '谨慎询问',
        'chatV2:authority.permissionPreset.modes.relaxed': '宽松执行',
        'chatV2:authority.permissionPreset.modes.full_access': '完全访问',
        'chatV2:authority.permissionPreset.modes.danger_full_access': '全自动（高风险）',
      };
      const defaultValue =
        typeof defaultValueOrOptions === 'string'
          ? defaultValueOrOptions
          : typeof defaultValueOrOptions === 'object' &&
              typeof defaultValueOrOptions.defaultValue === 'string'
            ? defaultValueOrOptions.defaultValue
            : undefined;
      const options =
        (typeof defaultValueOrOptions === 'object' && defaultValueOrOptions !== null
          ? defaultValueOrOptions
          : maybeOptions) ?? {};
      const template = translations[_key] ?? defaultValue ?? _key;
      return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
        options[name] !== undefined ? String(options[name]) : match
      );
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

describe('InputBarUI T3 Code unified model / reasoning / permission selector', () => {
  it('closes the active composer panel before opening the attachment launcher or T3 model menu', async () => {
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

    await user.click(screen.getByTestId('btn-toggle-attachments'));
    expect(onSetPanelState).toHaveBeenCalledWith('model', false);

    onSetPanelState.mockClear();
    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    expect(onSetPanelState).toHaveBeenCalledWith('model', false);
  });

  it('displays the model name in the bottom-right T3 Code pill and renders 不可用 badge when missingApiKey is true', () => {
    renderInputBar({
      enableThinking: false,
      thinkingStateLabel: '推理: 不支持',
      thinkingUnsupported: true,
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      runtimeModelLabel: 'gemini-4-neon',
      runtimeModelIconId: 'gemini-4-neon',
      missingApiKey: true,
    });

    const triggerLabel = screen.getByTestId('thinking-runtime-state-label');
    expect(triggerLabel).toHaveTextContent('gemini-4-neon');
    expect(screen.getByTestId('thinking-runtime-unavailable-badge')).toHaveTextContent('不可用');
  });

  it('renders left provider rail, cross-provider search, ⌘1..⌘9 shortcuts, and active model reasoning header', async () => {
    const user = userEvent.setup();
    const onSelectRuntimeModel = vi.fn();

    renderInputBar({
      enableThinking: false,
      thinkingStateLabel: '推理: 关闭',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      runtimeModelOptions: [
        { id: 'claude-opus-5.5', label: 'Claude Opus 5.5', providerLabel: 'Anthropic', iconId: 'claude-opus-5.5' },
        { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', providerLabel: 'Anthropic', iconId: 'claude-sonnet-5.5' },
        { id: 'gpt-4o', label: 'GPT-4o', providerLabel: 'OpenAI', iconId: 'gpt-4o' },
      ],
      onSelectRuntimeModel,
      runtimeModelLabel: 'Claude Opus 5.5',
      runtimeModelProviderLabel: 'Anthropic',
      runtimeCurrentModelId: 'claude-opus-5.5',
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));

    const selector = await screen.findByTestId('t3-model-selector');
    expect(selector).toBeInTheDocument();
    expect(screen.getByTestId('t3-rail-favorites')).toBeInTheDocument();
    expect(screen.getByTestId('t3-rail-group-brand:anthropic')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('t3-rail-group-brand:openai')).toBeInTheDocument();

    // Shortcut badges ⌘1, ⌘2 on visible Anthropic rows
    expect(screen.getByTestId('t3-model-shortcut-1')).toHaveTextContent(/1$/);
    expect(screen.getByTestId('t3-model-shortcut-2')).toHaveTextContent(/2$/);
    expect(screen.getByTestId('t3-reasoning-active-model')).toHaveTextContent('Claude Opus 5.5');

    // Cross-provider search immediately finds OpenAI GPT-4o even while Anthropic rail was selected
    const searchInput = screen.getByPlaceholderText('搜索模型...');
    await user.type(searchInput, 'GPT-4o');
    expect(screen.getByRole('menuitem', { name: /GPT-4o/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Claude Opus 5\.5/ })).not.toBeInTheDocument();

    // Clear search and press ⌘2 to pick 2nd visible Anthropic model (Claude Sonnet 5.5)
    await user.clear(searchInput);
    fireEvent.keyDown(selector, { key: '2', metaKey: true });
    expect(onSelectRuntimeModel).toHaveBeenCalledWith('claude-sonnet-5.5');
  });

  it('runs multi-select inside the T3 Code popover footer without opening a separate modal', async () => {
    const user = userEvent.setup();
    const onActiveChange = vi.fn();
    const onToggle = vi.fn();
    const onSelectRuntimeModel = vi.fn();

    const baseProps = {
      enableThinking: false,
      thinkingStateLabel: '推理: 关闭',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      runtimeModelOptions: [
        { id: 'deepseek-v3.2', label: 'DeepSeek V3.2', providerLabel: 'DeepSeek', iconId: 'deepseek-v3.2' },
        { id: 'deepseek-r1', label: 'DeepSeek R1', providerLabel: 'DeepSeek', iconId: 'deepseek-r1' },
      ],
      onSelectRuntimeModel,
      runtimeModelLabel: 'DeepSeek V3.2',
      runtimeModelProviderLabel: 'DeepSeek',
      runtimeCurrentModelId: 'deepseek-v3.2',
    } satisfies Partial<React.ComponentProps<typeof InputBarUI>>;

    const { rerender } = renderInputBar({
      ...baseProps,
      runtimeModelMultiSelect: { active: false, selectedIds: [], onActiveChange, onToggle },
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    const toggle = await screen.findByTestId('runtime-model-multi-select-switch');
    expect(toggle).toHaveTextContent('多选模式');
    await user.click(toggle);
    expect(onActiveChange).toHaveBeenCalledWith(true);

    rerender(
      <InputBarUI
        inputValue=""
        canSend={false}
        canAbort={false}
        isStreaming={false}
        attachments={[]}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
        {...baseProps}
        runtimeModelMultiSelect={{ active: true, selectedIds: ['deepseek-r1'], onActiveChange, onToggle }}
      />
    );

    const r1Row = screen.getByRole('menuitemcheckbox', { name: /DeepSeek R1/ });
    expect(r1Row).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('menuitemcheckbox', { name: /DeepSeek V3\.2/ }));
    expect(onToggle).toHaveBeenCalledWith('deepseek-v3.2');
    expect(onSelectRuntimeModel).not.toHaveBeenCalled();
  });

  it('renders reasoning effort options in the right pane and omits Off for forced-thinking models', async () => {
    const user = userEvent.setup();
    const onSetThinkingDepth = vi.fn();

    renderInputBar({
      enableThinking: true,
      thinkingStateLabel: '推理: high',
      thinkingCanDisable: false,
      thinkingDepthOptions: [
        { value: 'low', labelKey: 'settings:api.modal.reasoning.effort.low', defaultLabel: 'Low' },
        { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
      ],
      thinkingDepthValue: 'high',
      onToggleThinking: vi.fn(),
      onSetThinkingDepth,
      runtimeModelLabel: 'DeepSeek R1',
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    await screen.findByTestId('t3-reasoning-pane');

    expect(screen.getByRole('menuitemradio', { name: '低' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '高' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('menuitemradio', { name: '关闭' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitemradio', { name: '低' }));
    expect(onSetThinkingDepth).toHaveBeenCalledWith('low');
  });

  it('shows 没有可选的推理强度 when reasoning is unsupported and supports switching permission presets from the footer', async () => {
    const user = userEvent.setup();
    const onPermissionPresetChange = vi.fn();

    renderInputBar({
      sessionId: 'sess-t3-perm',
      enableThinking: false,
      thinkingStateLabel: '推理: 不支持',
      thinkingDepthOptions: [],
      thinkingUnsupported: true,
      onToggleThinking: vi.fn(),
      onSetThinkingDepth: vi.fn(),
      runtimeModelOptions: [
        { id: 'gemini-4-neon', label: 'gemini-4-neon', providerLabel: 'Google', iconId: 'gemini-4-neon' },
      ],
      runtimeModelLabel: 'gemini-4-neon',
      runtimeModelProviderLabel: 'Google',
      runtimeCurrentModelId: 'gemini-4-neon',
      permissionPreset: 'full_access',
      onPermissionPresetChange,
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    const emptyReasoning = await screen.findByTestId('t3-reasoning-empty');
    expect(emptyReasoning).toHaveTextContent('没有可选的推理强度');

    const permTrigger = screen.getByTestId('t3-permission-trigger');
    expect(permTrigger).toHaveTextContent('完全访问');
    await user.click(permTrigger);
    await user.click(screen.getByTestId('t3-permission-option-cautious'));
    expect(onPermissionPresetChange).toHaveBeenCalledWith('cautious', undefined);
  });

  it('exposes Web Search toggle, Danger Full Access confirmation, and in-popover morphed Parameters view without opening a separate panel', async () => {
    const user = userEvent.setup();
    const onWebSearchEnabledChange = vi.fn();
    const onSetPanelState = vi.fn();
    const onPermissionPresetChange = vi.fn();

    renderInputBar({
      sessionId: 'sess-t3-footer',
      enableThinking: false,
      thinkingStateLabel: '推理: 关闭',
      thinkingDepthOptions: [],
      onToggleThinking: vi.fn(),
      runtimeModelOptions: [
        { id: 'deepseek-v3.2', label: 'DeepSeek V3.2', providerLabel: 'DeepSeek', iconId: 'deepseek-v3.2' },
      ],
      runtimeModelLabel: 'DeepSeek V3.2',
      runtimeCurrentModelId: 'deepseek-v3.2',
      webSearchEnabled: true,
      onWebSearchEnabledChange,
      renderAdvancedPanel: () => <div data-testid="advanced-panel">Temperature Slider</div>,
      onSetPanelState,
      permissionPreset: 'relaxed',
      onPermissionPresetChange,
    });

    await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
    const selector = await screen.findByTestId('t3-model-selector');
    const initialHeight = selector.style.height;

    const webBtn = await screen.findByTestId('t3-footer-web-search');
    expect(webBtn).toHaveAttribute('aria-checked', 'true');
    await user.click(webBtn);
    expect(onWebSearchEnabledChange).toHaveBeenCalledWith(false);

    // Danger Full Access requires DsAlertDialog confirmation before persisting
    await user.click(screen.getByTestId('t3-permission-trigger'));
    await user.click(screen.getByTestId('t3-permission-option-danger_full_access'));
    expect(onPermissionPresetChange).not.toHaveBeenCalled();

    const confirmBtn = screen.getAllByRole('button').find((btn) =>
      /dangerConfirmAction|确认开启危险完全访问/i.test(btn.textContent ?? ''),
    );
    expect(confirmBtn).toBeDefined();
    await user.click(confirmBtn!);
    await waitFor(() => {
      expect(onPermissionPresetChange).toHaveBeenCalledWith('danger_full_access', true);
    });

    // Clicking 参数 morphs inside T3ModelSelectorPopover (zero separate panel, zero height change)
    onSetPanelState.mockClear();
    const paramsBtn = screen.getByTestId('t3-footer-advanced');
    await user.click(paramsBtn);
    expect(onSetPanelState).not.toHaveBeenCalledWith('advanced', true);
    expect(screen.getByTestId('t3-params-pane')).toBeInTheDocument();
    expect(screen.getByTestId('advanced-panel')).toHaveTextContent('Temperature Slider');
    expect(selector.style.height).toBe(initialHeight);

    // Clicking ← 返回模型 morphs right back to the model list
    await user.click(screen.getByTestId('t3-params-back'));
    expect(screen.queryByTestId('t3-params-pane')).not.toBeInTheDocument();
    expect(screen.getByTestId('t3-model-list-pane')).toBeInTheDocument();
  });

  it('locks popover width and height across provider switches without jitter and adapts layout tier to viewport width', async () => {
    const user = userEvent.setup();
    const prevInnerWidth = window.innerWidth;

    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 460 });
      window.dispatchEvent(new Event('resize'));

      renderInputBar({
        enableThinking: false,
        thinkingStateLabel: '推理: 关闭',
        thinkingDepthOptions: [],
        onToggleThinking: vi.fn(),
        runtimeModelOptions: [
          {
            id: 'claude-opus-5.5',
            label: 'Claude Opus 5.5',
            providerLabel: 'Anthropic',
            iconId: 'claude-opus-5.5',
          },
          {
            id: 'deepseek-v4-ultra-long-enterprise-preview-name',
            label: 'deepseek-v4-ultra-long-enterprise-preview-name',
            providerLabel: 'DeepSeek',
            iconId: 'deepseek-v4',
          },
        ],
        runtimeModelLabel: 'Claude Opus 5.5',
        runtimeModelProviderLabel: 'Anthropic',
        runtimeCurrentModelId: 'claude-opus-5.5',
      });

      await user.click(screen.getByTestId('thinking-runtime-menu-trigger'));
      const selector = await screen.findByTestId('t3-model-selector');
      expect(selector).toHaveAttribute('data-layout-tier', 'medium');

      const menuShell = selector.closest('.app-menu-content') as HTMLElement;
      const initialWidth = menuShell.style.width;
      const initialHeight = selector.style.height;
      expect(initialWidth).toBe('444px');

      // Switching between Anthropic, DeepSeek (long label), and empty Favorites keeps exact width & height
      await user.click(screen.getByTestId('t3-rail-group-brand:deepseek'));
      expect(menuShell.style.width).toBe(initialWidth);
      expect(selector.style.height).toBe(initialHeight);

      await user.click(screen.getByTestId('t3-rail-favorites'));
      expect(menuShell.style.width).toBe(initialWidth);
      expect(selector.style.height).toBe(initialHeight);

      // Narrowing to 360px switches cleanly to compact tier
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 360 });
      fireEvent(window, new Event('resize'));
      await waitFor(() => {
        expect(selector).toHaveAttribute('data-layout-tier', 'compact');
      });
      expect(screen.getByTestId('t3-reasoning-pane-mobile')).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: prevInnerWidth,
      });
    }
  });
});
