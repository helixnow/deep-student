/**
 * Memory-as-VFS API 单元测试
 *
 * 数据契约来源：Memory-as-VFS设计方案.md
 *
 * 测试使用 Mock 实现，验证 API 行为是否符合契约
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  getMemoryConfig,
  setMemoryRootFolder,
  createMemoryRootFolder,
  searchMemory,
  readMemory,
  writeMemory,
  listMemory,
  getMemoryTree,
  type MemoryConfig,
  type MemorySearchResult,
  type MemoryListItem,
  type MemoryReadOutput,
  type MemoryWriteOutput,
  type FolderTreeNode,
} from '@/api/memoryApi';

const mockInvoke = vi.mocked(invoke);

describe('memoryApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // 1. 配置管理
  // ==========================================================================

  describe('getMemoryConfig', () => {
    it('应该返回记忆配置', async () => {
      const mockConfig: MemoryConfig = {
        memoryRootFolderId: 'fld_123',
        memoryRootFolderTitle: '我的记忆',
        autoCreateSubfolders: true,
        defaultCategory: 'general',
      };

      mockInvoke.mockResolvedValue(mockConfig);

      const result = await getMemoryConfig();

      expect(mockInvoke).toHaveBeenCalledWith('memory_get_config');
      expect(result).toEqual(mockConfig);
    });

    it('未配置时应该返回 null folderId', async () => {
      const mockConfig: MemoryConfig = {
        memoryRootFolderId: null,
        memoryRootFolderTitle: null,
        autoCreateSubfolders: true,
        defaultCategory: 'general',
      };

      mockInvoke.mockResolvedValue(mockConfig);

      const result = await getMemoryConfig();

      expect(result.memoryRootFolderId).toBeNull();
    });
  });

  describe('setMemoryRootFolder', () => {
    it('应该设置记忆根文件夹', async () => {
      mockInvoke.mockResolvedValue(undefined);

      await setMemoryRootFolder('fld_456');

      expect(mockInvoke).toHaveBeenCalledWith('memory_set_root_folder', {
        folderId: 'fld_456',
      });
    });
  });

  describe('createMemoryRootFolder', () => {
    it('应该创建并返回新文件夹 ID', async () => {
      mockInvoke.mockResolvedValue('fld_new_789');

      const result = await createMemoryRootFolder('学习记忆');

      expect(mockInvoke).toHaveBeenCalledWith('memory_create_root_folder', {
        title: '学习记忆',
      });
      expect(result).toBe('fld_new_789');
    });
  });

  // ==========================================================================
  // 2. 搜索
  // ==========================================================================

  describe('searchMemory', () => {
    it('应该搜索记忆并返回结果', async () => {
      const mockResults: MemorySearchResult[] = [
        {
          noteId: 'note_001',
          noteTitle: '用户偏好',
          folderPath: '我的记忆/偏好',
          chunkText: '用户喜欢深色主题...',
          score: 0.95,
        },
      ];

      mockInvoke.mockResolvedValue(mockResults);

      const result = await searchMemory('深色主题');

      expect(mockInvoke).toHaveBeenCalledWith('memory_search', {
        query: '深色主题',
        topK: undefined,
      });
      expect(result).toHaveLength(1);
      expect(result[0].noteTitle).toBe('用户偏好');
    });

    it('应该支持自定义 topK 参数', async () => {
      mockInvoke.mockResolvedValue([]);

      await searchMemory('测试', 20);

      expect(mockInvoke).toHaveBeenCalledWith('memory_search', {
        query: '测试',
        topK: 20,
      });
    });
  });

  // ==========================================================================
  // 3. 读取
  // ==========================================================================

  describe('readMemory', () => {
    it('应该读取指定记忆的完整内容', async () => {
      const mockOutput: MemoryReadOutput = {
        noteId: 'note_001',
        title: '用户偏好',
        content: '# 用户偏好\n\n用户喜欢深色主题...',
        folderPath: '我的记忆/偏好',
        updatedAt: '2025-01-18T10:00:00Z',
      };

      mockInvoke.mockResolvedValue(mockOutput);

      const result = await readMemory('note_001');

      expect(mockInvoke).toHaveBeenCalledWith('memory_read', {
        noteId: 'note_001',
      });
      expect(result?.content).toContain('深色主题');
    });

    it('记忆不存在时应该返回 null', async () => {
      mockInvoke.mockResolvedValue(null);

      const result = await readMemory('non_existent');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // 4. 写入
  // ==========================================================================

  describe('writeMemory', () => {
    it('应该创建新记忆', async () => {
      const mockOutput: MemoryWriteOutput = {
        noteId: 'note_new_001',
        isNew: true,
      };

      mockInvoke.mockResolvedValue(mockOutput);

      const result = await writeMemory('新记忆', '这是一条新记忆内容');

      expect(mockInvoke).toHaveBeenCalledWith('memory_write', {
        folderPath: undefined,
        title: '新记忆',
        content: '这是一条新记忆内容',
        mode: undefined,
      });
      expect(result.isNew).toBe(true);
    });

    it('应该支持指定文件夹路径', async () => {
      const mockOutput: MemoryWriteOutput = {
        noteId: 'note_002',
        isNew: true,
      };

      mockInvoke.mockResolvedValue(mockOutput);

      await writeMemory('偏好设置', '深色主题', '偏好/界面');

      expect(mockInvoke).toHaveBeenCalledWith('memory_write', {
        folderPath: '偏好/界面',
        title: '偏好设置',
        content: '深色主题',
        mode: undefined,
      });
    });

    it('应该支持 update 模式', async () => {
      const mockOutput: MemoryWriteOutput = {
        noteId: 'note_001',
        isNew: false,
      };

      mockInvoke.mockResolvedValue(mockOutput);

      const result = await writeMemory('用户偏好', '更新后的内容', undefined, 'update');

      expect(mockInvoke).toHaveBeenCalledWith('memory_write', {
        folderPath: undefined,
        title: '用户偏好',
        content: '更新后的内容',
        mode: 'update',
      });
      expect(result.isNew).toBe(false);
    });

    it('应该支持 append 模式', async () => {
      mockInvoke.mockResolvedValue({ noteId: 'note_001', isNew: false });

      await writeMemory('用户偏好', '\n新增内容', undefined, 'append');

      expect(mockInvoke).toHaveBeenCalledWith('memory_write', {
        folderPath: undefined,
        title: '用户偏好',
        content: '\n新增内容',
        mode: 'append',
      });
    });
  });

  // ==========================================================================
  // 5. 列表
  // ==========================================================================

  describe('listMemory', () => {
    it('应该列出所有记忆', async () => {
      const mockList: MemoryListItem[] = [
        {
          id: 'note_001',
          title: '用户偏好',
          folderPath: '我的记忆/偏好',
          updatedAt: '2025-01-18T10:00:00Z',
        },
        {
          id: 'note_002',
          title: '学习笔记',
          folderPath: '我的记忆/学习',
          updatedAt: '2025-01-17T09:00:00Z',
        },
      ];

      mockInvoke.mockResolvedValue(mockList);

      const result = await listMemory();

      expect(mockInvoke).toHaveBeenCalledWith('memory_list', {
        folderPath: undefined,
        limit: undefined,
        offset: undefined,
      });
      expect(result).toHaveLength(2);
    });

    it('应该支持指定文件夹路径筛选', async () => {
      mockInvoke.mockResolvedValue([]);

      await listMemory('偏好');

      expect(mockInvoke).toHaveBeenCalledWith('memory_list', {
        folderPath: '偏好',
        limit: undefined,
        offset: undefined,
      });
    });

    it('应该支持分页参数', async () => {
      mockInvoke.mockResolvedValue([]);

      await listMemory(undefined, 50, 100);

      expect(mockInvoke).toHaveBeenCalledWith('memory_list', {
        folderPath: undefined,
        limit: 50,
        offset: 100,
      });
    });
  });

  // ==========================================================================
  // 6. 文件夹树
  // ==========================================================================

  describe('getMemoryTree', () => {
    it('应该返回记忆文件夹树', async () => {
      const mockTree: FolderTreeNode = {
        folder: {
          id: 'fld_root',
          parentId: null,
          title: '我的记忆',
          sortOrder: 0,
          isExpanded: true,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-18T10:00:00Z',
        },
        children: [
          {
            folder: {
              id: 'fld_child',
              parentId: 'fld_root',
              title: '偏好',
              sortOrder: 0,
              isExpanded: false,
              createdAt: '2025-01-01T00:00:00Z',
              updatedAt: '2025-01-18T10:00:00Z',
            },
            children: [],
            items: [],
          },
        ],
        items: [],
      };

      mockInvoke.mockResolvedValue(mockTree);

      const result = await getMemoryTree();

      expect(mockInvoke).toHaveBeenCalledWith('memory_get_tree');
      expect(result?.folder.title).toBe('我的记忆');
      expect(result?.children).toHaveLength(1);
    });

    it('未配置根文件夹时应该返回 null', async () => {
      mockInvoke.mockResolvedValue(null);

      const result = await getMemoryTree();

      expect(result).toBeNull();
    });
  });
});
