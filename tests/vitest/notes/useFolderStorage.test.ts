/**
 * useFolderStorage Hook 单元测试
 * 
 * 测试引用管理方法的正确性
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFolderStorage } from '@/components/notes/hooks/useFolderStorage';
import type { NoteItem } from '@/utils/notesApi';
import type { ReferenceNode, SourceDatabase } from '@/components/notes/types/reference';

// Mock NotesAPI
vi.mock('@/utils/notesApi', () => ({
  NotesAPI: {
    setPref: vi.fn().mockResolvedValue(true),
    getPref: vi.fn().mockResolvedValue(null),
  },
}));

// Mock @tauri-apps/api/core
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

describe('useFolderStorage - 引用管理', () => {
  const mockSubject = 'test-subject';
  const mockNotes: NoteItem[] = [
    { id: 'note_1', title: 'Test Note 1', subject: mockSubject, content_md: '', tags: [], is_favorite: false, created_at: '', updated_at: '' },
  ];
  const mockSetNotes = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('addReference', () => {
    it('应该能添加引用到根级别', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Test Textbook',
          previewType: 'pdf',
        });
      });

      // 验证返回的 ID 格式
      expect(refId).toMatch(/^ref_[a-zA-Z0-9_-]{8}$/);
      
      // 验证引用已添加到 references
      expect(result.current.references[refId]).toBeDefined();
      expect(result.current.references[refId].sourceDb).toBe('textbooks');
      expect(result.current.references[refId].sourceId).toBe('textbook_1');
      expect(result.current.references[refId].title).toBe('Test Textbook');
      expect(result.current.references[refId].previewType).toBe('pdf');
      expect(result.current.references[refId].createdAt).toBeGreaterThan(0);
      
      // 验证已添加到 rootChildren
      expect(result.current.rootChildren).toContain(refId);
    });

    it('应该能添加引用到指定文件夹', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      // 先创建文件夹
      let folderId: string = '';
      await act(async () => {
        folderId = await result.current.createFolder();
      });

      // 添加引用到文件夹
      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'mistakes',
          sourceId: 'mistake_1',
          title: 'Test Mistake',
          previewType: 'card',
        }, folderId);
      });

      // 验证引用已添加到文件夹的 children
      expect(result.current.folders[folderId].children).toContain(refId);
      // 验证未添加到 rootChildren
      expect(result.current.rootChildren).not.toContain(refId);
    });

    it('应该自动设置 createdAt 时间戳', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      const beforeTime = Date.now();
      
      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_2',
          title: 'Test Textbook 2',
          previewType: 'pdf',
        });
      });

      const afterTime = Date.now();
      
      expect(result.current.references[refId].createdAt).toBeGreaterThanOrEqual(beforeTime);
      expect(result.current.references[refId].createdAt).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('removeReference', () => {
    it('应该能从根级别移除引用', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      // 先添加引用
      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Test Textbook',
          previewType: 'pdf',
        });
      });

      // 移除引用
      await act(async () => {
        result.current.removeReference(refId);
      });

      // 验证已从 references 和 rootChildren 中移除
      expect(result.current.references[refId]).toBeUndefined();
      expect(result.current.rootChildren).not.toContain(refId);
    });

    it('应该能从文件夹中移除引用', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      // 创建文件夹
      let folderId: string = '';
      await act(async () => {
        folderId = await result.current.createFolder();
      });

      // 添加引用到文件夹
      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'mistakes',
          sourceId: 'mistake_1',
          title: 'Test Mistake',
          previewType: 'card',
        }, folderId);
      });

      // 移除引用
      await act(async () => {
        result.current.removeReference(refId);
      });

      // 验证已从 references 和文件夹 children 中移除
      expect(result.current.references[refId]).toBeUndefined();
      expect(result.current.folders[folderId].children).not.toContain(refId);
    });

    it('移除不存在的引用应该警告但不报错', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      await act(async () => {
        result.current.removeReference('ref_nonexist');
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('updateReference', () => {
    it('应该能更新引用的 title', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      // 添加引用
      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Original Title',
          previewType: 'pdf',
        });
      });

      // 更新 title
      await act(async () => {
        result.current.updateReference(refId, { title: 'New Title' });
      });

      expect(result.current.references[refId].title).toBe('New Title');
    });

    it('应该能更新引用的 icon', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      // 添加引用
      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Test',
          previewType: 'pdf',
        });
      });

      // 更新 icon
      await act(async () => {
        result.current.updateReference(refId, { icon: 'Star' });
      });

      expect(result.current.references[refId].icon).toBe('Star');
    });

    it('更新不应该影响其他字段', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      // 添加引用
      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Original Title',
          previewType: 'pdf',
        });
      });

      const originalCreatedAt = result.current.references[refId].createdAt;

      // 更新 title
      await act(async () => {
        result.current.updateReference(refId, { title: 'New Title' });
      });

      // 验证其他字段未变
      expect(result.current.references[refId].sourceDb).toBe('textbooks');
      expect(result.current.references[refId].sourceId).toBe('textbook_1');
      expect(result.current.references[refId].previewType).toBe('pdf');
      expect(result.current.references[refId].createdAt).toBe(originalCreatedAt);
    });
  });

  describe('getReference', () => {
    it('应该返回存在的引用', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Test',
          previewType: 'pdf',
        });
      });

      const ref = result.current.getReference(refId);
      expect(ref).toBeDefined();
      expect(ref?.title).toBe('Test');
    });

    it('应该返回 undefined 对于不存在的引用', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      const ref = result.current.getReference('ref_nonexist');
      expect(ref).toBeUndefined();
    });
  });

  describe('listReferences', () => {
    it('应该返回所有引用', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      // 分开 act 以确保状态正确更新
      await act(async () => {
        result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Textbook 1',
          previewType: 'pdf',
        });
      });
      
      await act(async () => {
        result.current.addReference({
          sourceDb: 'mistakes',
          sourceId: 'mistake_1',
          title: 'Mistake 1',
          previewType: 'card',
        });
      });

      const refs = result.current.listReferences();
      expect(refs.length).toBe(2);
    });

    it('无引用时应该返回空数组', () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      const refs = result.current.listReferences();
      expect(refs).toEqual([]);
    });
  });

  describe('referenceExists', () => {
    it('应该返回 true 对于存在的引用（按 sourceDb + sourceId）', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      await act(async () => {
        result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Test',
          previewType: 'pdf',
        });
      });

      // 按照文档19签名：referenceExists(sourceDb, sourceId) -> boolean
      expect(result.current.referenceExists('textbooks', 'textbook_1')).toBe(true);
    });

    it('应该返回 false 对于不存在的引用', () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      expect(result.current.referenceExists('textbooks', 'nonexist_id')).toBe(false);
    });
  });

  describe('findExistingRef', () => {
    it('应该找到已存在的同源引用', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Test',
          previewType: 'pdf',
        });
      });

      const existingId = result.current.findExistingRef('textbooks', 'textbook_1');
      expect(existingId).toBe(refId);
    });

    it('应该返回 null 对于不存在的同源引用', () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      const existingId = result.current.findExistingRef('textbooks', 'textbook_nonexist');
      expect(existingId).toBeNull();
    });
  });

  describe('validateReferences', () => {
    it('无引用时应该返回空对象', async () => {
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      let validityMap: Record<string, boolean> = {};
      await act(async () => {
        validityMap = await result.current.validateReferences();
      });

      expect(validityMap).toEqual({});
    });
  });

  describe('持久化', () => {
    it('添加引用后应该触发保存', async () => {
      const { NotesAPI } = await import('@/utils/notesApi');
      
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      await act(async () => {
        result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Test',
          previewType: 'pdf',
        });
      });

      expect(NotesAPI.setPref).toHaveBeenCalled();
    });

    it('移除引用后应该触发保存', async () => {
      const { NotesAPI } = await import('@/utils/notesApi');
      
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Test',
          previewType: 'pdf',
        });
      });

      vi.clearAllMocks();

      await act(async () => {
        result.current.removeReference(refId);
      });

      expect(NotesAPI.setPref).toHaveBeenCalled();
    });

    it('更新引用后应该触发保存', async () => {
      const { NotesAPI } = await import('@/utils/notesApi');
      
      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      let refId: string = '';
      await act(async () => {
        refId = result.current.addReference({
          sourceDb: 'textbooks',
          sourceId: 'textbook_1',
          title: 'Test',
          previewType: 'pdf',
        });
      });

      vi.clearAllMocks();

      await act(async () => {
        result.current.updateReference(refId, { title: 'New Title' });
      });

      expect(NotesAPI.setPref).toHaveBeenCalled();
    });
  });

  describe('旧数据兼容性', () => {
    it('加载无 references 字段的旧数据时应该初始化为空对象', async () => {
      const { NotesAPI } = await import('@/utils/notesApi');
      
      // Mock 返回旧格式数据（无 references 字段）
      vi.mocked(NotesAPI.getPref).mockResolvedValueOnce(JSON.stringify({
        folders: { 'fld_test': { title: 'Test Folder', children: [] } },
        rootChildren: ['fld_test'],
        // 无 references 字段
      }));

      const { result } = renderHook(() => 
        useFolderStorage(mockSubject, mockNotes, mockSetNotes)
      );

      await act(async () => {
        await result.current.loadFolders(mockNotes);
      });

      // 验证 references 已初始化为空对象
      expect(result.current.references).toEqual({});
      // 验证 folders 已正确加载
      expect(result.current.folders['fld_test']).toBeDefined();
    });
  });
});
