/**
 * Chat V2 - Registry 单元测试
 *
 * 测试注册表基类和各个具体注册表
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Registry } from '@/chat-v2/registry/Registry';
import { modeRegistry, type ModePlugin, type ModeConfig } from '@/chat-v2/registry/modeRegistry';
import { blockRegistry, type BlockRendererPlugin } from '@/chat-v2/registry/blockRegistry';
import { eventRegistry, type EventHandler, type EventStartPayload } from '@/chat-v2/registry/eventRegistry';
import type { ChatStore } from '@/chat-v2/core/types';

// ============================================================================
// Registry 基类测试
// ============================================================================

describe('Registry', () => {
  let registry: Registry<{ id: string; value: number }>;

  beforeEach(() => {
    registry = new Registry<{ id: string; value: number }>('TestRegistry');
  });

  it('should register and get plugin', () => {
    const plugin = { id: 'test', value: 42 };
    registry.register('test-plugin', plugin);

    const retrieved = registry.get('test-plugin');
    expect(retrieved).toEqual(plugin);
  });

  it('should return undefined for unknown plugin', () => {
    const retrieved = registry.get('non-existent');
    expect(retrieved).toBeUndefined();
  });

  it('should warn when overwriting existing plugin', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plugin1 = { id: 'test', value: 1 };
    const plugin2 = { id: 'test', value: 2 };

    registry.register('same-key', plugin1);
    registry.register('same-key', plugin2);

    expect(warnSpy).toHaveBeenCalledWith(
      '[TestRegistry] Overwriting existing plugin: same-key'
    );

    // 确保新值覆盖旧值
    const retrieved = registry.get('same-key');
    expect(retrieved).toEqual(plugin2);

    warnSpy.mockRestore();
  });


  it('should support silent overwrite mode', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const silentRegistry = new Registry<{ id: string; value: number }>('SilentRegistry', {
      warnOnOverwrite: false,
    });

    silentRegistry.register('same-key', { id: 'test', value: 1 });
    silentRegistry.register('same-key', { id: 'test', value: 2 });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(silentRegistry.get('same-key')?.value).toBe(2);

    warnSpy.mockRestore();
  });

  it('should list all registered plugins', () => {
    const plugin1 = { id: 'a', value: 1 };
    const plugin2 = { id: 'b', value: 2 };
    const plugin3 = { id: 'c', value: 3 };

    registry.register('plugin-a', plugin1);
    registry.register('plugin-b', plugin2);
    registry.register('plugin-c', plugin3);

    const all = registry.getAll();
    expect(all.size).toBe(3);
    expect(all.get('plugin-a')).toEqual(plugin1);
    expect(all.get('plugin-b')).toEqual(plugin2);
    expect(all.get('plugin-c')).toEqual(plugin3);
  });

  it('should check if plugin exists with has()', () => {
    const plugin = { id: 'exists', value: 100 };
    registry.register('exists', plugin);

    expect(registry.has('exists')).toBe(true);
    expect(registry.has('not-exists')).toBe(false);
  });

  it('should return all keys', () => {
    registry.register('key1', { id: '1', value: 1 });
    registry.register('key2', { id: '2', value: 2 });

    const keys = registry.keys();
    expect(keys).toContain('key1');
    expect(keys).toContain('key2');
    expect(keys.length).toBe(2);
  });

  it('should clear all plugins', () => {
    registry.register('key1', { id: '1', value: 1 });
    registry.register('key2', { id: '2', value: 2 });

    expect(registry.getAll().size).toBe(2);

    registry.clear();

    expect(registry.getAll().size).toBe(0);
    expect(registry.has('key1')).toBe(false);
  });

  it('should return registry name', () => {
    expect(registry.getName()).toBe('TestRegistry');
  });

  it('getAll() should return a copy, not the original Map', () => {
    const plugin = { id: 'test', value: 42 };
    registry.register('test', plugin);

    const all = registry.getAll();
    all.delete('test');

    // 原始 Map 不应受影响
    expect(registry.has('test')).toBe(true);
  });
});

// ============================================================================
// modeRegistry 测试
// ============================================================================

describe('modeRegistry', () => {
  beforeEach(() => {
    modeRegistry.clear();
  });

  it('should be a Registry instance', () => {
    expect(modeRegistry).toBeInstanceOf(Registry);
    expect(modeRegistry.getName()).toBe('ModeRegistry');
  });

  it('should register and get ModePlugin', () => {
    const chatPlugin: ModePlugin = {
      name: 'chat',
      config: {
        requiresOcr: false,
        autoStartFirstMessage: false,
      },
    };

    modeRegistry.register('chat', chatPlugin);

    const retrieved = modeRegistry.get('chat');
    expect(retrieved).toEqual(chatPlugin);
    expect(retrieved?.name).toBe('chat');
    expect(retrieved?.config.requiresOcr).toBe(false);
  });

  it('should register mode with full config', () => {
    const analysisConfig: ModeConfig = {
      requiresOcr: true,
      ocrTiming: 'before',
      autoStartFirstMessage: true,
      hasPageNavigation: false,
    };

    const analysisPlugin: ModePlugin = {
      name: 'analysis',
      config: analysisConfig,
      onInit: async () => {},
      onSendMessage: () => {},
    };

    modeRegistry.register('analysis', analysisPlugin);

    const retrieved = modeRegistry.get('analysis');
    expect(retrieved?.config.requiresOcr).toBe(true);
    expect(retrieved?.config.ocrTiming).toBe('before');
    expect(retrieved?.onInit).toBeDefined();
  });
});

// ============================================================================
// blockRegistry 测试
// ============================================================================

describe('blockRegistry', () => {
  beforeEach(() => {
    blockRegistry.clear();
  });

  it('should be a Registry instance', () => {
    expect(blockRegistry).toBeInstanceOf(Registry);
    expect(blockRegistry.getName()).toBe('BlockRegistry');
  });

  it('should register and get BlockRendererPlugin', () => {
    const MockComponent = () => null;

    const thinkingPlugin: BlockRendererPlugin = {
      type: 'thinking',
      component: MockComponent,
      onAbort: 'keep-content',
    };

    blockRegistry.register('thinking', thinkingPlugin);

    const retrieved = blockRegistry.get('thinking');
    expect(retrieved).toEqual(thinkingPlugin);
    expect(retrieved?.type).toBe('thinking');
    expect(retrieved?.onAbort).toBe('keep-content');
  });

  it('should support different onAbort behaviors', () => {
    const MockComponent = () => null;

    blockRegistry.register('content', {
      type: 'content',
      component: MockComponent,
      onAbort: 'keep-content',
    });

    blockRegistry.register('tool', {
      type: 'tool',
      component: MockComponent,
      onAbort: 'mark-error',
    });

    expect(blockRegistry.get('content')?.onAbort).toBe('keep-content');
    expect(blockRegistry.get('tool')?.onAbort).toBe('mark-error');
  });
});

// ============================================================================
// eventRegistry 测试
// ============================================================================

describe('eventRegistry', () => {
  beforeEach(() => {
    eventRegistry.clear();
  });

  it('should be a Registry instance', () => {
    expect(eventRegistry).toBeInstanceOf(Registry);
    expect(eventRegistry.getName()).toBe('EventRegistry');
  });

  it('should register and get EventHandler', () => {
    const thinkingHandler: EventHandler = {
      onStart: (_store: ChatStore, messageId: string, _payload: EventStartPayload) => `block_${messageId}`,
      onChunk: (_store: ChatStore, _blockId: string, _chunk: string) => {},
      onEnd: (_store: ChatStore, _blockId: string) => {},
    };

    eventRegistry.register('thinking', thinkingHandler);

    const retrieved = eventRegistry.get('thinking');
    expect(retrieved).toEqual(thinkingHandler);
    expect(retrieved?.onStart).toBeDefined();
    expect(retrieved?.onChunk).toBeDefined();
    expect(retrieved?.onEnd).toBeDefined();
  });

  it('should support partial EventHandler', () => {
    // 只有 onChunk
    const chunkOnlyHandler: EventHandler = {
      onChunk: (_store: ChatStore, _blockId: string, _chunk: string) => {},
    };

    eventRegistry.register('chunk-only', chunkOnlyHandler);

    const retrieved = eventRegistry.get('chunk-only');
    expect(retrieved?.onStart).toBeUndefined();
    expect(retrieved?.onChunk).toBeDefined();
    expect(retrieved?.onEnd).toBeUndefined();
    expect(retrieved?.onError).toBeUndefined();
  });

  it('should support onError handler', () => {
    const errorHandler: EventHandler = {
      onStart: (_store: ChatStore, _messageId: string, _payload: EventStartPayload) => 'block_id',
      onError: (_store: ChatStore, _blockId: string, error: string) => {
        console.error(error);
      },
    };

    eventRegistry.register('with-error', errorHandler);

    const retrieved = eventRegistry.get('with-error');
    expect(retrieved?.onError).toBeDefined();
  });
});

// ============================================================================
// 注册表集成测试
// ============================================================================

describe('Registry Integration', () => {
  it('should have independent registries', () => {
    // 清空所有注册表
    modeRegistry.clear();
    blockRegistry.clear();
    eventRegistry.clear();

    // 各注册表独立注册
    modeRegistry.register('test', {
      name: 'test',
      config: { requiresOcr: false, autoStartFirstMessage: false },
    });

    blockRegistry.register('test', {
      type: 'test',
      component: () => null,
    });

    eventRegistry.register('test', {
      onStart: (_store: ChatStore, _messageId: string, _payload: EventStartPayload) => 'block_id',
    });

    // 各注册表应该独立
    expect(modeRegistry.getAll().size).toBe(1);
    expect(blockRegistry.getAll().size).toBe(1);
    expect(eventRegistry.getAll().size).toBe(1);

    // 获取的内容应该不同
    expect(modeRegistry.get('test')).toHaveProperty('name');
    expect(blockRegistry.get('test')).toHaveProperty('component');
    expect(eventRegistry.get('test')).toHaveProperty('onStart');
  });
});
