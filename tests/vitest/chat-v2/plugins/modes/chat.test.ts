/**
 * Chat V2 - Chat 模式插件单元测试
 *
 * 测试要点：
 * - 应该注册到 modeRegistry
 * - onInit 时应该将 modeState 设置为 null
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modeRegistry } from '@/chat-v2/registry';
import type { ChatStore } from '@/chat-v2/core/types';

// 导入插件（触发自动注册）
import '@/chat-v2/plugins/modes/chat';

describe('ChatModePlugin', () => {
  beforeEach(() => {
    // 确保插件已注册
  });

  it('should register to modeRegistry', () => {
    // 验证 'chat' 模式已注册
    const chatPlugin = modeRegistry.get('chat');
    expect(chatPlugin).toBeDefined();
    expect(chatPlugin?.name).toBe('chat');
  });

  it('should have correct config', () => {
    const chatPlugin = modeRegistry.get('chat');
    expect(chatPlugin).toBeDefined();

    // 验证配置
    expect(chatPlugin?.config.requiresOcr).toBe(false);
    expect(chatPlugin?.config.autoStartFirstMessage).toBe(false);
  });

  it('should set modeState to null on init', async () => {
    const chatPlugin = modeRegistry.get('chat');
    expect(chatPlugin).toBeDefined();
    expect(chatPlugin?.onInit).toBeDefined();

    // 创建 mock store
    const mockSetModeState = vi.fn();
    const mockStore = {
      setModeState: mockSetModeState,
    } as unknown as ChatStore;

    // 调用 onInit
    await chatPlugin?.onInit?.(mockStore);

    // 验证 setModeState 被调用，参数为 null
    expect(mockSetModeState).toHaveBeenCalledWith(null);
  });

  it('should be accessible via modeRegistry.keys()', () => {
    const keys = modeRegistry.keys();
    expect(keys).toContain('chat');
  });

  it('should not have renderHeader or renderFooter', () => {
    // chat 模式是最基础的模式，没有自定义 header/footer
    const chatPlugin = modeRegistry.get('chat');
    expect(chatPlugin?.renderHeader).toBeUndefined();
    expect(chatPlugin?.renderFooter).toBeUndefined();
  });

  it('should have buildSystemPrompt defined and return string', () => {
    const chatPlugin = modeRegistry.get('chat');
    expect(chatPlugin?.buildSystemPrompt).toBeDefined();

    const context = {
      sessionId: 'sess_test',
      mode: 'chat',
      modeState: null,
    };
    const systemPrompt = chatPlugin?.buildSystemPrompt?.(context);
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt?.length).toBeGreaterThan(0);
  });

  it('should have getEnabledTools defined and return tools array', () => {
    const chatPlugin = modeRegistry.get('chat');
    expect(chatPlugin?.getEnabledTools).toBeDefined();

    const mockStore = {} as ChatStore;
    const tools = chatPlugin?.getEnabledTools?.(mockStore);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toContain('rag');
    expect(tools).toContain('memory');
  });

  it('should have enabledTools in config', () => {
    const chatPlugin = modeRegistry.get('chat');
    expect(chatPlugin?.config.enabledTools).toBeDefined();
    expect(Array.isArray(chatPlugin?.config.enabledTools)).toBe(true);
  });
});
