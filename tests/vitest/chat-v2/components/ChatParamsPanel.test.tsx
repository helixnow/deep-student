/**
 * Chat V2 - ChatParamsPanel 单元测试
 *
 * 测试要点：
 * - should update model on select
 * - should update temperature on slider change
 * - should toggle thinking mode
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { ChatStore, ChatParams } from '@/chat-v2/core/types';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'chatParams.title': 'Chat Parameters',
        'chatParams.model': 'Model',
        'chatParams.noModels': 'No models available',
        'chatParams.temperature': 'Temperature',
        'chatParams.temperatureHint': 'Lower values are more precise, higher values are more creative',
        'chatParams.maxTokens': 'Max Output',
        'chatParams.enableThinking': 'Enable Thinking',
        'chatParams.enableThinkingDesc': 'Show model reasoning process',
        'chatParams.disableTools': 'Disable Tools',
        'chatParams.disableToolsDesc': "Don't call external tools",
        'chatParams.reset': 'Reset to defaults',
        'chatParams.maxToolRecursion': 'Tool Recursion Limit',
        'chatParams.maxToolRecursionHint': 'Maximum tool calls to prevent infinite loops',
      };
      return translations[key] || key;
    },
  }),
}));

// 导入组件
import { ChatParamsPanel, type ModelConfig } from '@/chat-v2/components/ChatParamsPanel';

// ============================================================================
// 测试数据
// ============================================================================

const mockModelConfigs: ModelConfig[] = [
  {
    id: 'gpt-4',
    name: 'GPT-4',
    provider: 'OpenAI',
    supportsThinking: true,
    supportsTools: true,
    maxContext: 128000,
    maxOutput: 4096,
  },
  {
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    provider: 'OpenAI',
    supportsThinking: false,
    supportsTools: true,
    maxContext: 16384,
    maxOutput: 4096,
  },
  {
    id: 'claude-3',
    name: 'Claude 3',
    provider: 'Anthropic',
    supportsThinking: true,
    supportsTools: true,
    maxContext: 200000,
    maxOutput: 8192,
  },
];

const defaultChatParams: ChatParams = {
  modelId: 'gpt-4',
  temperature: 0.7,
  contextLimit: 8192,
  maxTokens: 4096,
  enableThinking: false,
  disableTools: false,
  model2OverrideId: null,
};

// ============================================================================
// Mock Store 创建
// ============================================================================

function createMockChatStore(params: Partial<ChatParams> = {}) {
  const chatParams = { ...defaultChatParams, ...params };

  const state: Partial<ChatStore> = {
    chatParams,
    setChatParams: vi.fn((updates) => {
      Object.assign(chatParams, updates);
    }),
    resetChatParams: vi.fn(),
  };

  const store = createStore(() => state);

  return store as unknown as StoreApi<ChatStore>;
}

// ============================================================================
// 测试
// ============================================================================

describe('ChatParamsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render panel title', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      expect(screen.getByText('Chat Parameters')).toBeInTheDocument();
    });

    it('should render model selector', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      expect(screen.getByRole('combobox', { name: 'Model' })).toBeInTheDocument();
    });

    it('should render temperature slider', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      expect(screen.getByText('Temperature')).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: 'Temperature' })).toBeInTheDocument();
    });

    it('should render toggle controls', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      expect(screen.getByText('Enable Thinking')).toBeInTheDocument();
      expect(screen.getByText('Disable Tools')).toBeInTheDocument();
    });

    it('should show no models message when empty', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={[]} />);

      expect(screen.getByText('No models available')).toBeInTheDocument();
    });
  });

  describe('model selection', () => {
    it('should update model on select', () => {
      const store = createMockChatStore({ modelId: 'gpt-4' });

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      const select = screen.getByRole('combobox', { name: 'Model' });
      fireEvent.change(select, { target: { value: 'claude-3' } });

      expect(store.getState().setChatParams).toHaveBeenCalledWith({ modelId: 'claude-3' });
    });

    it('should display current model', () => {
      const store = createMockChatStore({ modelId: 'gpt-3.5-turbo' });

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      const select = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
      expect(select.value).toBe('gpt-3.5-turbo');
    });

    it('should show model with provider', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      // 验证模型名称和提供商都显示
      expect(screen.getByText(/GPT-4.*OpenAI/)).toBeInTheDocument();
    });
  });

  describe('temperature control', () => {
    it('should update temperature on slider change', () => {
      const store = createMockChatStore({ temperature: 0.7 });

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      const slider = screen.getByRole('slider', { name: 'Temperature' });
      fireEvent.change(slider, { target: { value: '1.5' } });

      expect(store.getState().setChatParams).toHaveBeenCalledWith({ temperature: 1.5 });
    });

    it('should display current temperature', () => {
      const store = createMockChatStore({ temperature: 0.5 });

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      expect(screen.getByText('0.5')).toBeInTheDocument();
    });

    it('should show temperature hint', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      expect(screen.getByText(/Lower values are more precise/)).toBeInTheDocument();
    });
  });

  describe('thinking mode toggle', () => {
    it('should toggle thinking mode', () => {
      const store = createMockChatStore({ enableThinking: false });

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      const switchButton = screen.getByRole('switch', { name: 'Enable Thinking' });
      fireEvent.click(switchButton);

      expect(store.getState().setChatParams).toHaveBeenCalledWith({ enableThinking: true });
    });

    it('should show thinking description', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      expect(screen.getByText('Show model reasoning process')).toBeInTheDocument();
    });

    it('should disable thinking toggle for unsupported models', () => {
      // gpt-3.5-turbo 不支持 thinking
      const store = createMockChatStore({ modelId: 'gpt-3.5-turbo' });

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      const switchButton = screen.getByRole('switch', { name: 'Enable Thinking' });
      expect(switchButton).toBeDisabled();
    });
  });

  describe('tools toggle', () => {
    it('should toggle disable tools', () => {
      const store = createMockChatStore({ disableTools: false });

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      const switchButton = screen.getByRole('switch', { name: 'Disable Tools' });
      fireEvent.click(switchButton);

      expect(store.getState().setChatParams).toHaveBeenCalledWith({ disableTools: true });
    });
  });

  describe('reset functionality', () => {
    it('should call resetChatParams on reset click', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      // 找到重置按钮（通过 title 属性）
      const resetButton = screen.getByTitle('Reset to defaults');
      fireEvent.click(resetButton);

      expect(store.getState().resetChatParams).toHaveBeenCalled();
    });
  });

  describe('compact mode', () => {
    it('should render compact mode with fewer controls', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} compact={true} />);

      // 紧凑模式只显示模型选择和思维链开关
      expect(screen.getByRole('combobox', { name: 'Model' })).toBeInTheDocument();
      expect(screen.getByText('Enable Thinking')).toBeInTheDocument();

      // 不应显示完整的温度滑块和描述
      expect(screen.queryByText('Temperature')).not.toBeInTheDocument();
      expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    });
  });

  describe('expandable panel', () => {
    it('should toggle expanded state', () => {
      const store = createMockChatStore();
      const onExpandedChange = vi.fn();

      render(
        <ChatParamsPanel
          store={store}
          modelConfigs={mockModelConfigs}
          expanded={true}
          onExpandedChange={onExpandedChange}
        />
      );

      // 点击头部应该切换展开状态
      const header = screen.getByText('Chat Parameters').closest('div[class*="cursor-pointer"]');
      if (header) {
        fireEvent.click(header);
      }

      expect(onExpandedChange).toHaveBeenCalledWith(false);
    });

    it('should hide content when collapsed', () => {
      const store = createMockChatStore();

      render(
        <ChatParamsPanel
          store={store}
          modelConfigs={mockModelConfigs}
          expanded={false}
          onExpandedChange={vi.fn()}
        />
      );

      // 折叠时不应该显示详细内容
      expect(screen.queryByText('Temperature')).not.toBeInTheDocument();
    });
  });

  describe('output limits', () => {
    it('should update max tokens', () => {
      const store = createMockChatStore();

      render(<ChatParamsPanel store={store} modelConfigs={mockModelConfigs} />);

      const maxTokensSlider = screen.getByRole('slider', { name: 'Max Output' });
      fireEvent.change(maxTokensSlider, { target: { value: '2048' } });

      expect(store.getState().setChatParams).toHaveBeenCalledWith({ maxTokens: 2048 });
    });
  });
});
