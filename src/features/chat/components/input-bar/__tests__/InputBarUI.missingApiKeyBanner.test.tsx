import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useTranslation } from 'react-i18next';
import { APP_EVENTS, addAppEventListener } from '@/events/app';
import { consumePendingSettingsTab } from '@/utils/pendingSettingsTab';
import { InputBarUI } from '../InputBarUI';
import { InputBarV2 } from '../InputBarV2';
import { createDefaultPanelStates } from '../../../core/types/common';
import type { ChatStore } from '../../../core/types/store';

const { invokeMock, showGlobalNotificationMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: (src: string) => src,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
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

vi.mock('@/contexts/DialogControlContext', () => ({
  useDialogControl: () => ({
    availableMcpServers: [],
    selectedMcpServers: [],
    setSelectedMcpServers: vi.fn(),
  }),
}));

function renderInputBarUI(overrides: Partial<React.ComponentProps<typeof InputBarUI>> = {}) {
  return render(
    <InputBarUI
      inputValue=""
      canSend={true}
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
      {...overrides}
    />,
  );
}

function createMinimalChatStore() {
  return createStore<ChatStore>(() => ({
    sessionId: 'sess-u01',
    mode: 'chat',
    sessionStatus: 'idle',
    inputValue: '',
    attachments: [],
    panelStates: createDefaultPanelStates(),
    chatParams: {
      modelId: '',
      modelDisplayName: undefined,
      modelIdPinnedByUser: false,
      model2OverrideId: null,
      enableThinking: false,
      maxTokens: 8192,
      contextLimit: undefined,
      reasoningEffort: undefined,
      thinkingBudget: undefined,
    },
    messageOrder: [],
    messageMap: new Map(),
    blocks: new Map(),
    queuedMessages: [],
    activeSkillIds: [],
    skillStateJson: null,
    pendingContextRefs: [],
    pendingBlockingInteraction: null,
    permissionPreset: 'relaxed',
    permissionPresetSyncing: false,
    features: new Map(),
    contextUsageOverride: null,
    compactionInProgress: false,
    modelRetryTarget: null,
    setInputValue: vi.fn(),
    setChatParams: vi.fn(),
    activateSkill: vi.fn(),
    deactivateSkill: vi.fn(),
    addContextRef: vi.fn(),
    removeContextRef: vi.fn(),
    clearContextRefs: vi.fn(),
    setPermissionPreset: vi.fn(),
    setFeature: vi.fn(),
    setPanelState: vi.fn(),
    addAttachment: vi.fn(),
    updateAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    sendMessage: vi.fn(),
    abortStream: vi.fn(),
    completeStream: vi.fn(),
    canSend: () => true,
    canAbort: () => false,
    setPendingParallelModelIds: vi.fn(),
    setModelRetryTarget: vi.fn(),
  } as unknown as ChatStore));
}

describe('U01 Chat missing API-key inline guidance banner', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    showGlobalNotificationMock.mockReset();
    consumePendingSettingsTab();
  });

  afterEach(() => {
    cleanup();
    consumePendingSettingsTab();
    const { i18n } = useTranslation();
    (i18n as { language: string }).language = 'zh-CN';
  });

  it('shows inline callout in zh-CN and opens Settings -> APIs directly when Configure AI Model is clicked', () => {
    const navTabs: string[] = [];
    const settingsTabs: string[] = [];
    const unsubNav = addAppEventListener(APP_EVENTS.NAVIGATE_TO_TAB, (d) => navTabs.push(d.tabName));
    const unsubSettings = addAppEventListener(APP_EVENTS.SETTINGS_NAVIGATE_TAB, (d) => settingsTabs.push(d.tab));

    try {
      renderInputBarUI({ missingApiKey: true, inputValue: '什么是微积分？' });

      const banner = screen.getByTestId('chat-missing-api-key-banner');
      expect(banner).toBeInTheDocument();
      const cta = screen.getByTestId('chat-configure-api-key-btn');
      expect(cta).toHaveTextContent('配置 AI 模型');

      fireEvent.click(cta);

      expect(navTabs).toEqual(['settings']);
      expect(settingsTabs).toEqual(['apis']);
      expect(consumePendingSettingsTab()).toBe('apis');
    } finally {
      unsubNav();
      unsubSettings();
    }
  });

  it('renders Configure AI Model CTA in en-US and intercepts Enter without losing draft or firing cryptic errors', () => {
    const { i18n } = useTranslation();
    (i18n as { language: string }).language = 'en-US';

    const onSend = vi.fn();
    renderInputBarUI({
      missingApiKey: true,
      inputValue: 'Explain eigenvalues',
      onSend,
    });

    const banner = screen.getByTestId('chat-missing-api-key-banner');
    expect(banner).toHaveAttribute('data-attention', 'false');
    const cta = screen.getByTestId('chat-configure-api-key-btn');
    expect(cta).toHaveTextContent('Configure AI Model');

    fireEvent.keyDown(screen.getByTestId('input-bar-v2-textarea'), {
      key: 'Enter',
      code: 'Enter',
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(banner).toHaveAttribute('data-attention', 'true');
    expect(document.activeElement).toBe(cta);
    expect(showGlobalNotificationMock).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('configure an AI model'),
    );
  });

  it('InputBarV2 automatically shows the missing-API-key banner when no enabled chat models exist and hides it once configured', async () => {
    let configured = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_api_configurations') {
        return configured
          ? [{ id: 'cfg-1', name: 'DeepSeek', model: 'deepseek-chat', enabled: true }]
          : [{ id: 'builtin-sf', name: 'SiliconFlow', model: 'Qwen/Qwen3-8B', isBuiltin: true, enabled: false }];
      }
      if (cmd === 'get_model_assignments') return { model2_config_id: null };
      if (cmd === 'get_model_profiles') return [];
      return [];
    });

    const store = createMinimalChatStore();
    render(<InputBarV2 store={store} availableModels={[]} />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-missing-api-key-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('chat-configure-api-key-btn')).toHaveTextContent('配置 AI 模型');

    // Once user configures a key in Settings, api_configurations_changed dismisses the banner
    configured = true;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('api_configurations_changed'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('chat-missing-api-key-banner')).not.toBeInTheDocument();
    });
  });
});
