/**
 * Chat V2 - 上下文发送辅助函数单元测试
 *
 * 测试 Prompt 9 的实现：
 * 1. 验证排序正确（按 priority）
 * 2. 验证 SendContextRef 构建正确
 * 3. 验证发送完成后清空
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildSendContextRefs,
  buildSendContextRefsWithPaths,
  getPendingContextRefs,
  mergeContentBlocks,
  extractContentBlocks,
} from '../contextHelper';
import { contextTypeRegistry } from '../../context/registry';
import { mockResourceStoreApi } from '../../resources/mockApi';
import type { ContextRef, Resource, ContentBlock, SendContextRef } from '../../resources/types';

// ============================================================================
// Mock 设置
// ============================================================================

// Mock resourceStoreApi
vi.mock('../../resources', () => ({
  resourceStoreApi: {
    get: vi.fn(),
    createOrReuse: vi.fn(),
    getLatest: vi.fn(),
    exists: vi.fn(),
    incrementRef: vi.fn(),
    decrementRef: vi.fn(),
    getVersionsBySource: vi.fn(),
  },
}));

// 获取 mock 的引用
import { resourceStoreApi } from '../../resources';
const mockGet = vi.mocked(resourceStoreApi.get);

// ============================================================================
// 测试数据
// ============================================================================

const createTestResource = (
  id: string,
  hash: string,
  type: string,
  data: string
): Resource => ({
  id,
  hash,
  type: type as Resource['type'],
  data,
  refCount: 0,
  createdAt: Date.now(),
});

const createTestContextRef = (
  resourceId: string,
  hash: string,
  typeId: string
): ContextRef => ({
  resourceId,
  hash,
  typeId,
});

// ============================================================================
// 测试
// ============================================================================

describe('contextHelper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 确保注册表有预定义类型
    if (contextTypeRegistry.size === 0) {
      // 注册测试用的类型定义
      contextTypeRegistry.register({
        typeId: 'note',
        xmlTag: 'note',
        label: '笔记',
        labelEn: 'Note',
        priority: 10,
        tools: ['note_read', 'note_write'],
        formatToBlocks: (resource) => [{ type: 'text', text: `<note>${resource.data}</note>` }],
      }, true);

      contextTypeRegistry.register({
        typeId: 'card',
        xmlTag: 'card',
        label: '卡片',
        labelEn: 'Card',
        priority: 20,
        tools: ['card_read'],
        formatToBlocks: (resource) => [{ type: 'text', text: `<card>${resource.data}</card>` }],
      }, true);

      contextTypeRegistry.register({
        typeId: 'image',
        xmlTag: 'image',
        label: '图片',
        labelEn: 'Image',
        priority: 30,
        formatToBlocks: (resource) => [{
          type: 'image',
          mediaType: 'image/png',
          base64: resource.data,
        }],
      }, true);

      contextTypeRegistry.register({
        typeId: 'retrieval',
        xmlTag: 'retrieval',
        label: '检索结果',
        labelEn: 'Retrieval',
        priority: 50,
        formatToBlocks: (resource) => [{ type: 'text', text: `<retrieval>${resource.data}</retrieval>` }],
      }, true);
    }
  });

  describe('buildSendContextRefs', () => {
    it('应该返回空数组当输入为空', async () => {
      const result = await buildSendContextRefs([]);
      expect(result).toEqual([]);
    });

    it('应该按 priority 排序', async () => {
      // 设置 mock 返回
      mockGet.mockImplementation(async (resourceId, hash) => {
        return createTestResource(resourceId, hash, resourceId.replace('res_', ''), 'test data');
      });

      const refs: ContextRef[] = [
        createTestContextRef('res_retrieval', 'hash1', 'retrieval'), // priority 50
        createTestContextRef('res_note', 'hash2', 'note'),           // priority 10
        createTestContextRef('res_card', 'hash3', 'card'),           // priority 20
      ];

      const result = await buildSendContextRefs(refs);

      // 验证顺序：note(10) < card(20) < retrieval(50)
      expect(result.length).toBe(3);
      expect(result[0].typeId).toBe('note');
      expect(result[1].typeId).toBe('card');
      expect(result[2].typeId).toBe('retrieval');
    });

    it('应该正确构建 SendContextRef', async () => {
      const testResource = createTestResource('res_note_1', 'abc123', 'note', 'Test note content');
      mockGet.mockResolvedValue(testResource);

      const refs: ContextRef[] = [
        createTestContextRef('res_note_1', 'abc123', 'note'),
      ];

      const result = await buildSendContextRefs(refs);

      expect(result.length).toBe(1);
      expect(result[0]).toMatchObject({
        resourceId: 'res_note_1',
        hash: 'abc123',
        typeId: 'note',
      });
      expect(result[0].formattedBlocks).toBeDefined();
      expect(result[0].formattedBlocks.length).toBeGreaterThan(0);
    });

    it('应该跳过不存在的资源', async () => {
      mockGet.mockResolvedValue(null);

      const refs: ContextRef[] = [
        createTestContextRef('res_not_exist', 'hash1', 'note'),
      ];

      const result = await buildSendContextRefs(refs);

      expect(result).toEqual([]);
    });

    it('应该正确处理图片类型', async () => {
      const imageResource = createTestResource('res_img_1', 'img123', 'image', 'base64imagedata');
      mockGet.mockResolvedValue(imageResource);

      const refs: ContextRef[] = [
        createTestContextRef('res_img_1', 'img123', 'image'),
      ];

      const result = await buildSendContextRefs(refs);

      expect(result.length).toBe(1);
      expect(result[0].formattedBlocks[0].type).toBe('image');
    });
  });

  describe('getPendingContextRefs', () => {
    it('应该从 store 获取 pendingContextRefs', () => {
      const mockStore = {
        pendingContextRefs: [
          createTestContextRef('res_1', 'hash1', 'note'),
        ],
      };

      const result = getPendingContextRefs(mockStore);

      expect(result.length).toBe(1);
      expect(result[0].resourceId).toBe('res_1');
    });

    it('应该返回空数组当 pendingContextRefs 不存在', () => {
      const mockStore = {};

      const result = getPendingContextRefs(mockStore);

      expect(result).toEqual([]);
    });

    it('应该返回空数组当 pendingContextRefs 不是数组', () => {
      const mockStore = {
        pendingContextRefs: 'invalid',
      };

      const result = getPendingContextRefs(mockStore);

      expect(result).toEqual([]);
    });
  });

  describe('mergeContentBlocks', () => {
    it('应该合并多个 ContentBlock 数组', () => {
      const blocks1: ContentBlock[] = [{ type: 'text', text: 'block1' }];
      const blocks2: ContentBlock[] = [{ type: 'text', text: 'block2' }];

      const result = mergeContentBlocks(blocks1, blocks2);

      expect(result.length).toBe(2);
      expect(result[0]).toEqual({ type: 'text', text: 'block1' });
      expect(result[1]).toEqual({ type: 'text', text: 'block2' });
    });

    it('应该忽略 undefined', () => {
      const blocks1: ContentBlock[] = [{ type: 'text', text: 'block1' }];

      const result = mergeContentBlocks(blocks1, undefined, undefined);

      expect(result.length).toBe(1);
    });
  });

  describe('extractContentBlocks', () => {
    it('应该从 SendContextRef 数组提取所有 ContentBlock', () => {
      const sendRefs: SendContextRef[] = [
        {
          resourceId: 'res_1',
          hash: 'hash1',
          typeId: 'note',
          formattedBlocks: [{ type: 'text', text: 'block1' }],
        },
        {
          resourceId: 'res_2',
          hash: 'hash2',
          typeId: 'card',
          formattedBlocks: [
            { type: 'text', text: 'block2' },
            { type: 'text', text: 'block3' },
          ],
        },
      ];

      const result = extractContentBlocks(sendRefs);

      expect(result.length).toBe(3);
    });
  });

  // ==========================================================================
  // ★ 文档28改造：buildSendContextRefsWithPaths 测试
  // ==========================================================================

  describe('buildSendContextRefsWithPaths', () => {
    it('应该返回空结果当输入为空', async () => {
      const result = await buildSendContextRefsWithPaths([]);
      expect(result.sendRefs).toEqual([]);
      expect(result.pathMap).toEqual({});
    });

    it('应该正确构建 pathMap', async () => {
      // 创建带有 _resolvedResources 的资源
      const testResource = createTestResource('res_note_1', 'abc123', 'note', 'Test note content');
      // 模拟 VFS 解析后的资源
      (testResource as any)._resolvedResources = [{
        sourceId: 'note_abc123',
        resourceHash: 'abc123',
        type: 'note',
        name: 'Test Note',
        path: '/高考复习/函数/note_abc123',
        content: 'Test note content',
        found: true,
      }];
      mockGet.mockResolvedValue(testResource);

      const refs: ContextRef[] = [
        createTestContextRef('res_note_1', 'abc123', 'note'),
      ];

      const result = await buildSendContextRefsWithPaths(refs);

      // 验证 pathMap 包含资源路径
      expect(result.pathMap['res_note_1']).toBe('/高考复习/函数/note_abc123');
      expect(result.sendRefs.length).toBe(1);
    });

    it('应该在资源未找到时不添加到 pathMap', async () => {
      const testResource = createTestResource('res_note_2', 'def456', 'note', 'Test note');
      // 模拟未找到的资源
      (testResource as any)._resolvedResources = [{
        sourceId: 'note_def456',
        resourceHash: 'def456',
        type: 'note',
        name: 'Deleted Note',
        path: '',
        content: '',
        found: false,
      }];
      mockGet.mockResolvedValue(testResource);

      const refs: ContextRef[] = [
        createTestContextRef('res_note_2', 'def456', 'note'),
      ];

      const result = await buildSendContextRefsWithPaths(refs);

      // 未找到的资源不应该有路径
      expect(result.pathMap['res_note_2']).toBeUndefined();
    });

    it('应该正确处理多个资源的路径', async () => {
      // 设置 mock
      mockGet.mockImplementation(async (resourceId: string) => {
        const resource = createTestResource(resourceId, `hash_${resourceId}`, 'note', 'content');
        (resource as any)._resolvedResources = [{
          sourceId: `note_${resourceId}`,
          resourceHash: `hash_${resourceId}`,
          type: 'note',
          name: 'Test Note',
          path: `/folder/${resourceId}`,
          content: 'content',
          found: true,
        }];
        return resource;
      });

      const refs: ContextRef[] = [
        createTestContextRef('res_1', 'hash_res_1', 'note'),
        createTestContextRef('res_2', 'hash_res_2', 'note'),
      ];

      const result = await buildSendContextRefsWithPaths(refs);

      expect(Object.keys(result.pathMap).length).toBe(2);
      expect(result.pathMap['res_1']).toBe('/folder/res_1');
      expect(result.pathMap['res_2']).toBe('/folder/res_2');
    });
  });
});

describe('getEnabledToolIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应该从 pendingContextRefs 收集工具 ID', async () => {
    const { getEnabledToolIds } = await import('../../tools/getEnabledToolIds');

    const mockStore = {
      pendingContextRefs: [
        createTestContextRef('res_1', 'hash1', 'note'),
        createTestContextRef('res_2', 'hash2', 'card'),
      ],
    };

    const result = getEnabledToolIds(mockStore as any);

    // note 关联 ['note_read', 'note_write']，card 关联 ['card_read']
    expect(result).toContain('note_read');
    expect(result).toContain('note_write');
    expect(result).toContain('card_read');
  });

  it('应该返回空数组当没有 pendingContextRefs', async () => {
    const { getEnabledToolIds } = await import('../../tools/getEnabledToolIds');

    const mockStore = {};

    const result = getEnabledToolIds(mockStore as any);

    expect(result).toEqual([]);
  });
});
