/**
 * Chat V2 - Context Actions 单元测试
 *
 * Prompt 6 单测要求：
 * - 验证添加/移除/清空逻辑
 * - 验证重复检查
 * - 验证 getEnabledTools 收集正确
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContextRef } from '@/chat-v2/context/types';

// Mock 状态
let mockState: {
  pendingContextRefs: ContextRef[];
};

// Mock set 函数
const mockSet = vi.fn((updater) => {
  if (typeof updater === 'function') {
    const updates = updater(mockState);
    Object.assign(mockState, updates);
  } else {
    Object.assign(mockState, updater);
  }
});

// Mock get 函数
const mockGet = vi.fn(() => mockState);

// Mock registry
vi.mock('@/chat-v2/context/registry', () => ({
  contextTypeRegistry: {
    collectToolsForTypes: vi.fn((typeIds: string[]) => {
      const toolsMap: Record<string, string[]> = {
        note: ['note_read', 'note_append', 'note_replace', 'note_set'],
        card: ['card_update', 'card_mark_status'],
      };
      const toolSet = new Set<string>();
      for (const typeId of typeIds) {
        const tools = toolsMap[typeId] || [];
        tools.forEach((t) => toolSet.add(t));
      }
      return Array.from(toolSet);
    }),
  },
}));

// 动态导入 createContextActions（在 mock 设置后）
const { createContextActions } = await import('@/chat-v2/core/store/contextActions');

describe('Context Actions', () => {
  let actions: ReturnType<typeof createContextActions>;

  beforeEach(() => {
    // 重置状态
    mockState = {
      pendingContextRefs: [],
    };
    mockSet.mockClear();
    mockGet.mockClear();

    // 创建 actions
    actions = createContextActions(mockSet as any, mockGet as any);
  });

  describe('addContextRef', () => {
    it('should add a new context ref', () => {
      const ref: ContextRef = {
        resourceId: 'res_123',
        hash: 'abc123',
        typeId: 'note',
      };

      actions.addContextRef(ref);

      expect(mockState.pendingContextRefs).toHaveLength(1);
      expect(mockState.pendingContextRefs[0]).toEqual(ref);
    });

    it('should not add duplicate ref with same resourceId', () => {
      const ref1: ContextRef = {
        resourceId: 'res_123',
        hash: 'abc123',
        typeId: 'note',
      };
      const ref2: ContextRef = {
        resourceId: 'res_123', // same resourceId
        hash: 'def456',
        typeId: 'card',
      };

      actions.addContextRef(ref1);
      actions.addContextRef(ref2); // same resourceId: 去重 + 更新 hash

      expect(mockState.pendingContextRefs).toHaveLength(1);
      expect(mockState.pendingContextRefs[0]).toEqual({
        ...ref1,
        hash: 'def456',
      });
    });

    it('should allow different resourceIds', () => {
      const ref1: ContextRef = {
        resourceId: 'res_123',
        hash: 'abc123',
        typeId: 'note',
      };
      const ref2: ContextRef = {
        resourceId: 'res_456',
        hash: 'def456',
        typeId: 'card',
      };

      actions.addContextRef(ref1);
      actions.addContextRef(ref2);

      expect(mockState.pendingContextRefs).toHaveLength(2);
    });
  });

  describe('removeContextRef', () => {
    it('should remove ref by resourceId', () => {
      mockState.pendingContextRefs = [
        { resourceId: 'res_123', hash: 'abc', typeId: 'note' },
        { resourceId: 'res_456', hash: 'def', typeId: 'card' },
      ];

      actions.removeContextRef('res_123');

      expect(mockState.pendingContextRefs).toHaveLength(1);
      expect(mockState.pendingContextRefs[0].resourceId).toBe('res_456');
    });

    it('should do nothing if resourceId not found', () => {
      mockState.pendingContextRefs = [
        { resourceId: 'res_123', hash: 'abc', typeId: 'note' },
      ];

      actions.removeContextRef('res_nonexistent');

      expect(mockState.pendingContextRefs).toHaveLength(1);
    });
  });

  describe('clearContextRefs', () => {
    it('should clear all refs when no typeId specified', () => {
      mockState.pendingContextRefs = [
        { resourceId: 'res_123', hash: 'abc', typeId: 'note' },
        { resourceId: 'res_456', hash: 'def', typeId: 'card' },
      ];

      actions.clearContextRefs();

      expect(mockState.pendingContextRefs).toHaveLength(0);
    });

    it('should clear only refs of specified typeId', () => {
      mockState.pendingContextRefs = [
        { resourceId: 'res_123', hash: 'abc', typeId: 'note' },
        { resourceId: 'res_456', hash: 'def', typeId: 'card' },
        { resourceId: 'res_789', hash: 'ghi', typeId: 'note' },
      ];

      actions.clearContextRefs('note');

      expect(mockState.pendingContextRefs).toHaveLength(1);
      expect(mockState.pendingContextRefs[0].typeId).toBe('card');
    });
  });

  describe('getContextRefsByType', () => {
    it('should return refs of specified type', () => {
      mockState.pendingContextRefs = [
        { resourceId: 'res_123', hash: 'abc', typeId: 'note' },
        { resourceId: 'res_456', hash: 'def', typeId: 'card' },
        { resourceId: 'res_789', hash: 'ghi', typeId: 'note' },
      ];

      const noteRefs = actions.getContextRefsByType('note');

      expect(noteRefs).toHaveLength(2);
      expect(noteRefs.every((r: ContextRef) => r.typeId === 'note')).toBe(true);
    });

    it('should return empty array if no refs of specified type', () => {
      mockState.pendingContextRefs = [
        { resourceId: 'res_123', hash: 'abc', typeId: 'note' },
      ];

      const cardRefs = actions.getContextRefsByType('card');

      expect(cardRefs).toHaveLength(0);
    });
  });

  describe('getEnabledTools', () => {
    it('should collect tools from all ref types', () => {
      mockState.pendingContextRefs = [
        { resourceId: 'res_123', hash: 'abc', typeId: 'note' },
        { resourceId: 'res_456', hash: 'def', typeId: 'card' },
      ];

      const tools = actions.getEnabledTools();

      // note tools + card tools
      expect(tools).toContain('note_read');
      expect(tools).toContain('note_append');
      expect(tools).toContain('card_update');
      expect(tools).toContain('card_mark_status');
    });

    it('should deduplicate type IDs', () => {
      mockState.pendingContextRefs = [
        { resourceId: 'res_123', hash: 'abc', typeId: 'note' },
        { resourceId: 'res_456', hash: 'def', typeId: 'note' },
        { resourceId: 'res_789', hash: 'ghi', typeId: 'note' },
      ];

      const tools = actions.getEnabledTools();

      // Should only have note tools (4), not duplicated
      expect(tools).toHaveLength(4);
    });

    it('should return empty array when no refs', () => {
      mockState.pendingContextRefs = [];

      const tools = actions.getEnabledTools();

      expect(tools).toHaveLength(0);
    });
  });
});
