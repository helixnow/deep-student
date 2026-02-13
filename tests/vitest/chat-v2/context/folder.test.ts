/**
 * Chat V2 - 文件夹上下文类型单元测试
 *
 * 测试内容：
 * 1. folderDefinition 的 formatToBlocks 输出
 * 2. getToolsForFolderResource 工具收集
 *
 * 参考文档: 23-VFS文件夹架构与上下文注入改造任务分配.md - Prompt 8
 */

import { describe, it, expect } from 'vitest';
import type { Resource } from '@/chat-v2/context/types';
import { isTextContentBlock } from '@/chat-v2/context/types';
import {
  folderDefinition,
  getToolsForFolderResource,
  FOLDER_TYPE_ID,
  FOLDER_XML_TAG,
  FOLDER_TOOLS,
  type FolderContextData,
} from '@/chat-v2/context/definitions/folder';

// ============================================================================
// 测试数据构造
// ============================================================================

/**
 * 创建 Mock 资源
 */
function createMockResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'res_test123',
    hash: 'abc123',
    type: 'folder',
    data: '{}',
    refCount: 1,
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * 创建 Mock 文件夹上下文数据
 */
function createMockFolderData(overrides: Partial<FolderContextData> = {}): FolderContextData {
  return {
    folderId: 'fld_test123',
    folderTitle: '测试文件夹',
    path: '高考复习/数学',
    resources: [],
    ...overrides,
  };
}

// ============================================================================
// 常量测试
// ============================================================================

describe('常量定义', () => {
  it('FOLDER_TYPE_ID 应该是 folder', () => {
    expect(FOLDER_TYPE_ID).toBe('folder');
  });

  it('FOLDER_XML_TAG 应该是 folder_content', () => {
    expect(FOLDER_XML_TAG).toBe('folder_content');
  });

  it('FOLDER_TOOLS 应该是空数组', () => {
    expect(FOLDER_TOOLS).toEqual([]);
  });
});

// ============================================================================
// folderDefinition 测试
// ============================================================================

describe('folderDefinition', () => {
  describe('基本属性', () => {
    it('typeId 应该是 folder', () => {
      expect(folderDefinition.typeId).toBe('folder');
    });

    it('xmlTag 应该是 folder_content', () => {
      expect(folderDefinition.xmlTag).toBe('folder_content');
    });

    it('label 应该是中文 "文件夹"', () => {
      expect(folderDefinition.label).toBe('文件夹');
    });

    it('labelEn 应该是 "Folder"', () => {
      expect(folderDefinition.labelEn).toBe('Folder');
    });

    it('priority 应该是 100（较低优先级）', () => {
      expect(folderDefinition.priority).toBe(100);
    });

    it('tools 应该是空数组', () => {
      expect(folderDefinition.tools).toEqual([]);
    });

    it('systemPromptHint 应该包含标签格式说明', () => {
      expect(folderDefinition.systemPromptHint).toContain('<folder_content');
      expect(folderDefinition.systemPromptHint).toContain('name=');
      expect(folderDefinition.systemPromptHint).toContain('count=');
      expect(folderDefinition.systemPromptHint).toContain('not-found=');
      expect(folderDefinition.systemPromptHint).not.toContain('path=');
    });
  });

  describe('formatToBlocks', () => {
    it('空文件夹应该生成正确的 XML 格式', () => {
      const resource = createMockResource({
        metadata: { title: '测试文件夹', path: '高考复习/数学' },
        _resolvedResources: [],
      });

      const blocks = folderDefinition.formatToBlocks(resource);

      expect(blocks.length).toBe(1);
      expect(isTextContentBlock(blocks[0])).toBe(true);

      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('<folder_content');
      expect(text).toContain('name="测试文件夹"');
      expect(text).toContain('count="0"');
      expect(text).toContain('not-found="0"');
      expect(text).not.toContain('path=');
      expect(text).toContain('<!-- 空文件夹 -->');
      expect(text).toContain('</folder_content>');
    });

    it('包含资源的文件夹应该生成正确的 XML 格式', () => {
      const resource = createMockResource({
        metadata: { title: '测试文件夹', path: '高考复习/数学' },
        _resolvedResources: [
          {
            sourceId: 'note_001',
            resourceHash: 'h1',
            type: 'note',
            name: '函数笔记',
            path: '高考复习/数学/函数笔记',
            content: '# 函数\n\n函数的定义...',
            found: true,
          },
          {
            sourceId: 'tb_001',
            resourceHash: 'h2',
            type: 'textbook',
            name: '数学教材第一章',
            path: '高考复习/数学/数学教材第一章',
            content: '教材内容...',
            found: true,
          },
        ],
      });

      const blocks = folderDefinition.formatToBlocks(resource);

      expect(blocks.length).toBe(1);
      expect(isTextContentBlock(blocks[0])).toBe(true);

      const text = (blocks[0] as { type: 'text'; text: string }).text;
      // 检查文件夹属性
      expect(text).toContain('<folder_content');
      expect(text).toContain('name="测试文件夹"');
      expect(text).toContain('count="2"');
      expect(text).toContain('not-found="0"');
      expect(text).not.toContain('path=');

      // 检查笔记资源
      expect(text).toContain('<note_item');
      expect(text).toContain('type="note"');
      expect(text).toContain('source-id="note_001"');
      expect(text).toContain('title="函数笔记"');
      expect(text).toContain('# 函数');

      // 检查教材资源
      expect(text).toContain('<textbook_item');
      expect(text).toContain('type="textbook"');
      expect(text).toContain('source-id="tb_001"');
      expect(text).toContain('title="数学教材第一章"');
      expect(text).toContain('教材内容...');

      expect(text).toContain('</folder_content>');
    });

    it('应该正确转义 XML 属性中的特殊字符', () => {
      const resource = createMockResource({
        metadata: { title: '包含 "引号" & <特殊> 字符', path: '路径/包含<>字符' },
        _resolvedResources: [
          {
            sourceId: 'note_001',
            resourceHash: 'h1',
            type: 'note',
            name: '标题含"引号"',
            path: '路径/含&字符',
            content: '内容',
            found: true,
          },
        ],
      });

      const blocks = folderDefinition.formatToBlocks(resource);
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      // 检查 XML 属性中的特殊字符被正确转义
      expect(text).toContain('&quot;');
      expect(text).toContain('&amp;');
      expect(text).toContain('&lt;');
      expect(text).toContain('&gt;');
    });

    it('空内容的资源应该使用自闭合标签', () => {
      const resource = createMockResource({
        metadata: { title: '测试文件夹', path: '路径' },
        _resolvedResources: [
          {
            sourceId: 'tb_001',
            resourceHash: 'h1',
            type: 'textbook',
            name: '空教材',
            path: '路径',
            content: '',
            found: true,
          },
          {
            sourceId: 'note_001',
            resourceHash: 'h2',
            type: 'note',
            name: '空白笔记',
            path: '路径',
            content: '   ',
            found: true,
          },
        ],
      });

      const blocks = folderDefinition.formatToBlocks(resource);
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('<textbook_item');
      expect(text).toContain('/>');
    });

    it('无效 JSON 数据应该返回错误标签', () => {
      const resource = createMockResource({
        data: 'invalid json {{{',
      });

      const blocks = folderDefinition.formatToBlocks(resource);

      expect(blocks.length).toBe(1);
      expect(isTextContentBlock(blocks[0])).toBe(true);

      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('status="error"');
    });

    it('应该支持所有 itemType', () => {
      const resource = createMockResource({
        metadata: { title: '测试文件夹', path: 'p' },
        _resolvedResources: [
          { sourceId: 'id1', resourceHash: 'h1', type: 'note', name: 't1', path: 'p1', content: 'c1', found: true },
          { sourceId: 'id2', resourceHash: 'h2', type: 'textbook', name: 't2', path: 'p2', content: 'c2', found: true },
          { sourceId: 'id3', resourceHash: 'h3', type: 'exam', name: 't3', path: 'p3', content: 'c3', found: true },
          { sourceId: 'id4', resourceHash: 'h4', type: 'translation', name: 't4', path: 'p4', content: 'c4', found: true },
          { sourceId: 'id5', resourceHash: 'h5', type: 'essay', name: 't5', path: 'p5', content: 'c5', found: true },
          { sourceId: 'id6', resourceHash: 'h6', type: 'unknown' as never, name: 't6', path: 'p6', content: 'c6', found: true },
        ],
      });

      const blocks = folderDefinition.formatToBlocks(resource);
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('<note_item');
      expect(text).toContain('<textbook_item');
      expect(text).toContain('<exam_item');
      expect(text).toContain('<translation_item');
      expect(text).toContain('<essay_item');
      expect(text).toContain('<resource_item'); // unknown 类型应该使用 resource_item
    });
  });
});

// ============================================================================
// getToolsForFolderResource 测试
// ============================================================================

describe('getToolsForFolderResource', () => {
  it('空文件夹应该返回空工具数组', () => {
    const resource = createMockResource({
      metadata: { title: '测试文件夹', path: 'p' },
      _resolvedResources: [],
    });

    const tools = getToolsForFolderResource(resource);
    expect(tools).toEqual([]);
  });

  it('只有 note 类型应该返回空工具数组（工具不再绑定上下文）', () => {
    const resource = createMockResource({
      metadata: { title: '测试文件夹', path: 'p' },
      _resolvedResources: [
        { sourceId: 'note_001', resourceHash: 'h1', type: 'note', name: '笔记1', path: 'p', content: 'c', found: true },
        { sourceId: 'note_002', resourceHash: 'h2', type: 'note', name: '笔记2', path: 'p', content: 'c', found: true },
      ],
    });

    const tools = getToolsForFolderResource(resource);
    expect(tools).toEqual([]);
  });

  it('只有非 note 类型应该返回空工具数组', () => {
    const resource = createMockResource({
      metadata: { title: '测试文件夹', path: 'p' },
      _resolvedResources: [
        { sourceId: 'tb_001', resourceHash: 'h1', type: 'textbook', name: '教材', path: 'p', content: 'c', found: true },
        { sourceId: 'exam_001', resourceHash: 'h2', type: 'exam', name: '试卷', path: 'p', content: 'c', found: true },
        { sourceId: 'tr_001', resourceHash: 'h3', type: 'translation', name: '翻译', path: 'p', content: 'c', found: true },
        { sourceId: 'es_001', resourceHash: 'h4', type: 'essay', name: '作文', path: 'p', content: 'c', found: true },
      ],
    });

    const tools = getToolsForFolderResource(resource);
    expect(tools).toEqual([]);
  });

  it('混合类型应该收集所有相关工具并去重', () => {
    const resource = createMockResource({
      metadata: { title: '测试文件夹', path: 'p' },
      _resolvedResources: [
        { sourceId: 'note_001', resourceHash: 'h1', type: 'note', name: '笔记1', path: 'p', content: 'c', found: true },
        { sourceId: 'tb_001', resourceHash: 'h2', type: 'textbook', name: '教材', path: 'p', content: 'c', found: true },
        { sourceId: 'note_002', resourceHash: 'h3', type: 'note', name: '笔记2', path: 'p', content: 'c', found: true },
      ],
    });

    const tools = getToolsForFolderResource(resource);
    // 2026-01: 工具通过内置 MCP 服务器注入，不再从 folder 资源动态收集
    expect(tools).toEqual([]);
  });

  it('无效 JSON 数据应该返回空工具数组', () => {
    const resource = createMockResource({
      data: 'invalid json',
    });

    const tools = getToolsForFolderResource(resource);
    expect(tools).toEqual([]);
  });

  it('未知 itemType 应该被忽略', () => {
    const folderData = createMockFolderData({
      resources: [
        { itemType: 'unknown_type', itemId: 'id_001', title: '未知类型', path: 'p', content: 'c' },
      ],
    });
    const resource = createMockResource({
      data: JSON.stringify(folderData),
    });

    const tools = getToolsForFolderResource(resource);
    expect(tools).toEqual([]);
  });

  it('空 resources 数组应该返回空工具数组', () => {
    const resource = createMockResource({
      data: JSON.stringify({ folderId: 'f1', folderTitle: 't', path: 'p', resources: [] }),
    });

    const tools = getToolsForFolderResource(resource);
    expect(tools).toEqual([]);
  });

  it('resources 为 null/undefined 应该返回空工具数组', () => {
    const resource1 = createMockResource({
      data: JSON.stringify({ folderId: 'f1', folderTitle: 't', path: 'p', resources: null }),
    });

    const resource2 = createMockResource({
      data: JSON.stringify({ folderId: 'f1', folderTitle: 't', path: 'p' }),
    });

    expect(getToolsForFolderResource(resource1)).toEqual([]);
    expect(getToolsForFolderResource(resource2)).toEqual([]);
  });
});
