/**
 * Chat V2 - 统一上下文注入系统单元测试
 *
 * 测试内容：
 * 1. ContextTypeRegistry 注册表功能
 * 2. 预定义类型的 formatToBlocks 输出
 * 3. 优先级排序
 * 4. 工具收集
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  // 类型
  type Resource,
  // 工具函数
  isTextContentBlock,
  isImageContentBlock,
  createTextBlock,
  createImageBlock,
  createXmlTextBlock,
  createEmptyContextSnapshot,
  // 注册表
  ContextTypeRegistry,
  // 预定义类型
  noteDefinition,
  imageDefinition,
  fileDefinition,
  retrievalDefinition,
  builtInDefinitions,
  builtInTypeIds,
  isBuiltInType,
  getAllBuiltInToolIds,
  // 初始化函数
  initializeContextSystem,
  resetContextSystem,
  contextTypeRegistry,
} from '@/chat-v2/context';

// ============================================================================
// 工具函数测试
// ============================================================================

describe('工具函数', () => {
  describe('createTextBlock', () => {
    it('应该创建文本内容块', () => {
      const block = createTextBlock('Hello World');
      expect(block).toEqual({ type: 'text', text: 'Hello World' });
      expect(isTextContentBlock(block)).toBe(true);
      expect(isImageContentBlock(block)).toBe(false);
    });
  });

  describe('createImageBlock', () => {
    it('应该创建图片内容块', () => {
      const block = createImageBlock('image/png', 'base64data');
      expect(block).toEqual({ type: 'image', mediaType: 'image/png', base64: 'base64data' });
      expect(isImageContentBlock(block)).toBe(true);
      expect(isTextContentBlock(block)).toBe(false);
    });
  });

  describe('createXmlTextBlock', () => {
    it('应该创建带 XML 标签的文本块', () => {
      const block = createXmlTextBlock('test', 'content');
      expect(block.type).toBe('text');
      expect(block.text).toBe('<test>\ncontent\n</test>');
    });

    it('应该正确处理属性', () => {
      const block = createXmlTextBlock('test', 'content', { title: 'Test Title' });
      expect(block.text).toContain('title="Test Title"');
    });

    it('应该跳过 undefined 属性', () => {
      const block = createXmlTextBlock('test', 'content', { title: 'Title', empty: undefined });
      expect(block.text).toContain('title="Title"');
      expect(block.text).not.toContain('empty');
    });

    it('应该正确转义 XML 属性', () => {
      const block = createXmlTextBlock('test', 'content', { title: 'Title with "quotes" & <special>' });
      expect(block.text).toContain('&quot;');
      expect(block.text).toContain('&amp;');
      expect(block.text).toContain('&lt;');
      expect(block.text).toContain('&gt;');
    });
  });

  describe('createEmptyContextSnapshot', () => {
    it('应该创建空的上下文快照', () => {
      const snapshot = createEmptyContextSnapshot();
      expect(snapshot).toEqual({ userRefs: [], retrievalRefs: [] });
    });
  });
});

// ============================================================================
// ContextTypeRegistry 测试
// ============================================================================

describe('ContextTypeRegistry', () => {
  let registry: ContextTypeRegistry;

  beforeEach(() => {
    registry = new ContextTypeRegistry();
  });

  describe('register/get', () => {
    it('应该正确注册和获取类型定义', () => {
      registry.register(noteDefinition);
      expect(registry.get('note')).toBe(noteDefinition);
    });

    it('重复注册应该抛出错误', () => {
      registry.register(noteDefinition);
      expect(() => registry.register(noteDefinition)).toThrow();
    });

    it('overwrite=true 时应该允许覆盖', () => {
      registry.register(noteDefinition);
      const newDef = { ...noteDefinition, label: 'Modified' };
      registry.register(newDef, true);
      expect(registry.get('note')?.label).toBe('Modified');
    });
  });

  describe('has', () => {
    it('应该正确检查类型是否存在', () => {
      expect(registry.has('note')).toBe(false);
      registry.register(noteDefinition);
      expect(registry.has('note')).toBe(true);
    });
  });

  describe('registerAll', () => {
    it('应该批量注册所有类型', () => {
      registry.registerAll(builtInDefinitions);
      expect(registry.size).toBe(10);
      expect(registry.has('system_prompt')).toBe(true);
      expect(registry.has('note')).toBe(true);
      expect(registry.has('exam')).toBe(true);
      expect(registry.has('essay')).toBe(true);
      expect(registry.has('translation')).toBe(true);
      expect(registry.has('textbook')).toBe(true);
      expect(registry.has('image')).toBe(true);
      expect(registry.has('file')).toBe(true);
      expect(registry.has('retrieval')).toBe(true);
      expect(registry.has('folder')).toBe(true);
    });
  });

  describe('getAll - 优先级排序', () => {
    it('应该按优先级排序返回所有类型', () => {
      registry.registerAll(builtInDefinitions);
      const all = registry.getAll();
      
      // 验证顺序：system_prompt(1) > note(10) > exam(22) > essay(23) > translation(24) > textbook(25) > image(30) = file(30) > retrieval(50) > folder(100)
      expect(all[0].typeId).toBe('system_prompt');
      expect(all[1].typeId).toBe('note');
      expect(all[2].typeId).toBe('exam');
      expect(all[3].typeId).toBe('essay');
      expect(all[4].typeId).toBe('translation');
      expect(all[5].typeId).toBe('textbook');
      // image 和 file 都是 30，顺序可能不定
      expect(['image', 'file']).toContain(all[6].typeId);
      expect(['image', 'file']).toContain(all[7].typeId);
      expect(all[8].typeId).toBe('retrieval');
      expect(all[9].typeId).toBe('folder');
    });
  });

  describe('getToolsForType', () => {
    it('应该返回类型关联的工具', () => {
      registry.register(noteDefinition);
      const tools = registry.getToolsForType('note');
      // 2026-01: 工具通过内置 MCP 服务器注入，不再绑定到上下文类型
      expect(tools).toEqual([]);
    });

    it('无关联工具的类型应该返回空数组', () => {
      registry.register(imageDefinition);
      const tools = registry.getToolsForType('image');
      expect(tools).toEqual([]);
    });

    it('未注册的类型应该返回空数组', () => {
      const tools = registry.getToolsForType('unknown');
      expect(tools).toEqual([]);
    });
  });

  describe('collectToolsForTypes', () => {
    it('应该收集多个类型的工具并去重', () => {
      registry.registerAll(builtInDefinitions);
      const tools = registry.collectToolsForTypes(['note', 'image']);
      
      // 2026-01: 工具通过内置 MCP 服务器注入，不再从 context definitions 收集
      expect(tools).toEqual([]);
      
      // 不应该有重复
      const uniqueTools = new Set(tools);
      expect(uniqueTools.size).toBe(tools.length);
    });
  });

  describe('getPriority', () => {
    it('应该返回正确的优先级', () => {
      registry.registerAll(builtInDefinitions);
      expect(registry.getPriority('system_prompt')).toBe(1);
      expect(registry.getPriority('note')).toBe(10);
      expect(registry.getPriority('exam')).toBe(22);
      expect(registry.getPriority('textbook')).toBe(25);
      expect(registry.getPriority('image')).toBe(30);
      expect(registry.getPriority('retrieval')).toBe(50);
      expect(registry.getPriority('folder')).toBe(100);
    });

    it('未注册类型应该返回默认值 100', () => {
      expect(registry.getPriority('unknown')).toBe(100);
    });
  });

  describe('getLabel', () => {
    it('应该返回中文标签', () => {
      registry.register(noteDefinition);
      expect(registry.getLabel('note', 'zh')).toBe('笔记');
    });

    it('应该返回英文标签', () => {
      registry.register(noteDefinition);
      expect(registry.getLabel('note', 'en')).toBe('Note');
    });

    it('未注册类型应该返回 typeId', () => {
      expect(registry.getLabel('unknown', 'zh')).toBe('unknown');
    });
  });

  describe('unregister', () => {
    it('应该正确注销类型', () => {
      registry.register(noteDefinition);
      expect(registry.has('note')).toBe(true);
      registry.unregister('note');
      expect(registry.has('note')).toBe(false);
    });
  });

  describe('clear', () => {
    it('应该清空所有注册', () => {
      registry.registerAll(builtInDefinitions);
      expect(registry.size).toBe(10);
      registry.clear();
      expect(registry.size).toBe(0);
    });
  });
});

// ============================================================================
// 预定义类型 formatToBlocks 测试
// ============================================================================

describe('预定义类型 formatToBlocks', () => {
  const createMockResource = (overrides: Partial<Resource> = {}): Resource => ({
    id: 'res_test123',
    hash: 'abc123',
    type: 'note',
    data: 'Test content',
    refCount: 1,
    createdAt: Date.now(),
    ...overrides,
  });

  describe('noteDefinition', () => {
    it('应该生成正确的 XML 格式', () => {
      const resource = createMockResource({
        type: 'note',
        _resolvedResources: [
          {
            sourceId: 'note_123',
            resourceHash: 'abc123',
            type: 'note',
            name: 'Test Note',
            path: '/tmp/TestNote.md',
            content: '# My Note\n\nThis is content.',
            found: true,
            metadata: { title: 'Test Note' },
          },
        ],
      });

      const blocks = noteDefinition.formatToBlocks(resource);
      expect(blocks.length).toBe(1);
      expect(isTextContentBlock(blocks[0])).toBe(true);
      
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('<canvas_note');
      expect(text).toContain('title="Test Note"');
      expect(text).toContain('note-id="note_123"');
      expect(text).toContain('path="/tmp/TestNote.md"');
      expect(text).toContain('# My Note');
      expect(text).toContain('</canvas_note>');
    });
  });

  describe('imageDefinition', () => {
    it('应该生成图片内容块', () => {
      const resource = createMockResource({
        type: 'image',
        _resolvedResources: [
          {
            sourceId: 'img_1',
            resourceHash: 'abc123',
            type: 'image',
            name: 'test.png',
            path: '/tmp/test.png',
            content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            found: true,
            metadata: { mimeType: 'image/png' },
          },
        ],
      });

      const blocks = imageDefinition.formatToBlocks(resource);
      expect(blocks.length).toBe(1);
      expect(isImageContentBlock(blocks[0])).toBe(true);
      
      const block = blocks[0] as { type: 'image'; mediaType: string; base64: string };
      expect(block.mediaType).toBe('image/png');
    });

    it('应该处理 data URL 格式', () => {
      const resource = createMockResource({
        type: 'image',
        _resolvedResources: [
          {
            sourceId: 'img_2',
            resourceHash: 'abc123',
            type: 'image',
            name: 'test.jpg',
            path: '/tmp/test.jpg',
            content: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
            found: true,
            metadata: { mimeType: 'image/jpeg' },
          },
        ],
      });

      const blocks = imageDefinition.formatToBlocks(resource);
      expect(blocks.length).toBe(1);
      expect(isImageContentBlock(blocks[0])).toBe(true);
      
      const block = blocks[0] as { type: 'image'; mediaType: string; base64: string };
      expect(block.mediaType).toBe('image/jpeg');
      expect(block.base64).toBe('/9j/4AAQSkZJRg==');
    });

    it('无效图片数据应该返回占位文本', () => {
      const resource = createMockResource({
        type: 'image',
        _resolvedResources: [
          {
            sourceId: 'img_3',
            resourceHash: 'abc123',
            type: 'image',
            name: 'test.png',
            path: '/tmp/test.png',
            content: 'invalid data!!!',
            found: true,
            metadata: { name: 'test.png' },
          },
        ],
      });

      const blocks = imageDefinition.formatToBlocks(resource);
      expect(blocks.length).toBe(1);
      expect(isTextContentBlock(blocks[0])).toBe(true);
      expect((blocks[0] as { type: 'text'; text: string }).text).toContain('[图片内容无效]');
    });
  });

  describe('fileDefinition', () => {
    it('应该生成正确的 XML 格式', () => {
      const resource = createMockResource({
        type: 'file',
        _resolvedResources: [
          {
            sourceId: 'file_1',
            resourceHash: 'abc123',
            type: 'file',
            name: 'test.txt',
            path: '/tmp/test.txt',
            content: 'File content here',
            found: true,
            metadata: { name: 'test.txt', mimeType: 'text/plain', size: 1024 },
          },
        ],
      });

      const blocks = fileDefinition.formatToBlocks(resource);
      expect(blocks.length).toBe(1);
      
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('<attachment');
      expect(text).toContain('name="test.txt"');
      expect(text).toContain('source_id="file_1"');
      expect(text).toContain('type="text/plain"');
      expect(text).toContain('size="1.0 KB"');
      expect(text).toContain('File content here');
      expect(text).toContain('</attachment>');
    });

    it('大文件应该被截断', () => {
      const largeContent = 'x'.repeat(200 * 1024); // 200KB
      const resource = createMockResource({
        type: 'file',
        _resolvedResources: [
          {
            sourceId: 'file_2',
            resourceHash: 'abc123',
            type: 'file',
            name: 'large.txt',
            path: '/tmp/large.txt',
            content: largeContent,
            found: true,
            metadata: { name: 'large.txt', mimeType: 'text/plain', size: 200 * 1024 },
          },
        ],
      });

      const blocks = fileDefinition.formatToBlocks(resource);
      expect(blocks.length).toBe(2); // 内容 + 截断提示
      expect((blocks[1] as { type: 'text'; text: string }).text).toContain('truncated');
    });
  });

  describe('retrievalDefinition', () => {
    it('应该生成正确的 XML 格式', () => {
      const resource = createMockResource({
        type: 'retrieval',
        sourceId: 'doc_789',
        data: 'Retrieved content',
        metadata: { source: 'rag', title: 'Document Title', score: 0.95 },
      });

      const blocks = retrievalDefinition.formatToBlocks(resource);
      expect(blocks.length).toBe(1);
      
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('<reference');
      expect(text).toContain('source="Knowledge Base"');
      expect(text).toContain('title="Document Title"');
      expect(text).toContain('relevance="95%"');
      expect(text).toContain('source-id="doc_789"');
      expect(text).toContain('Retrieved content');
      expect(text).toContain('</reference>');
    });
  });
});

// ============================================================================
// 批量导出测试
// ============================================================================

describe('批量导出', () => {
  describe('builtInDefinitions', () => {
    it('应该包含 10 个预定义类型', () => {
      expect(builtInDefinitions.length).toBe(10);
    });
  });

  describe('builtInTypeIds', () => {
    it('应该包含正确的类型 ID', () => {
      expect(builtInTypeIds).toContain('system_prompt');
      expect(builtInTypeIds).toContain('note');
      expect(builtInTypeIds).toContain('exam');
      expect(builtInTypeIds).toContain('essay');
      expect(builtInTypeIds).toContain('translation');
      expect(builtInTypeIds).toContain('textbook');
      expect(builtInTypeIds).toContain('image');
      expect(builtInTypeIds).toContain('file');
      expect(builtInTypeIds).toContain('retrieval');
      expect(builtInTypeIds).toContain('folder');
    });
  });

  describe('isBuiltInType', () => {
    it('应该正确识别内置类型', () => {
      expect(isBuiltInType('note')).toBe(true);
      expect(isBuiltInType('system_prompt')).toBe(true);
      expect(isBuiltInType('exam')).toBe(true);
      expect(isBuiltInType('unknown')).toBe(false);
    });
  });

  describe('getAllBuiltInToolIds', () => {
    it('应该返回所有内置工具 ID', () => {
      const tools = getAllBuiltInToolIds();
      // 2026-01: 工具通过内置 MCP 服务器注入，不从 context definitions 收集
      expect(tools).toEqual([]);
    });
  });
});

// ============================================================================
// 初始化函数测试
// ============================================================================

describe('初始化函数', () => {
  afterEach(() => {
    resetContextSystem();
  });

  describe('initializeContextSystem', () => {
    it('应该注册所有预定义类型到全局注册表', () => {
      expect(contextTypeRegistry.size).toBe(0);
      initializeContextSystem();
      expect(contextTypeRegistry.size).toBe(10);
      expect(contextTypeRegistry.has('note')).toBe(true);
    });

    it('重复调用应该是幂等的', () => {
      initializeContextSystem();
      initializeContextSystem();
      expect(contextTypeRegistry.size).toBe(10);
    });
  });

  describe('resetContextSystem', () => {
    it('应该清空注册表', () => {
      initializeContextSystem();
      expect(contextTypeRegistry.size).toBe(10);
      resetContextSystem();
      expect(contextTypeRegistry.size).toBe(0);
    });
  });
});
