/**
 * DSTU Path API 单元测试
 *
 * 数据契约来源：28-DSTU真实路径架构重构任务分配.md Prompt 10
 *
 * 测试范围：
 * 1. pathUtils 纯函数测试（不依赖后端）
 * 2. pathApi 类型定义验证
 */

import { describe, it, expect } from 'vitest';
import {
  pathUtils,
  type ParsedPath,
  type ResourceLocation,
  type SubjectMigrationStatus,
  type BatchMoveRequest,
  type BatchMoveResult,
} from '@/dstu';

// ============================================================================
// pathUtils 纯函数测试
// ============================================================================

describe('pathUtils', () => {
  describe('parse', () => {
    it('should parse root path', () => {
      const result = pathUtils.parse('/');
      expect(result.isRoot).toBe(true);
      expect(result.folderPath).toBeNull();
      expect(result.resourceId).toBeNull();
      expect(result.resourceType).toBeNull();
      expect(result.isVirtual).toBe(false);
    });

    it('should parse new format path with resource ID', () => {
      const result = pathUtils.parse('/高考复习/函数/note_abc123');
      expect(result.fullPath).toBe('/高考复习/函数/note_abc123');
      expect(result.folderPath).toBe('/高考复习/函数');
      expect(result.resourceId).toBe('note_abc123');
      expect(result.resourceType).toBe('note');
      expect(result.isRoot).toBe(false);
      expect(result.isVirtual).toBe(false);
    });

    it('should parse folder-only path', () => {
      const result = pathUtils.parse('/高考复习/函数');
      expect(result.fullPath).toBe('/高考复习/函数');
      expect(result.folderPath).toBe('/高考复习/函数');
      expect(result.resourceId).toBeNull();
      expect(result.resourceType).toBeNull();
    });

    it('should parse virtual path (@trash)', () => {
      const result = pathUtils.parse('/@trash');
      expect(result.isVirtual).toBe(true);
      expect(result.isRoot).toBe(false);
    });

    it('should parse virtual path with resource (@trash/note_abc)', () => {
      const result = pathUtils.parse('/@trash/note_abc123');
      expect(result.isVirtual).toBe(true);
      expect(result.resourceId).toBe('note_abc123');
      expect(result.resourceType).toBe('note');
    });

    it('should handle path without leading slash', () => {
      const result = pathUtils.parse('高考复习/函数');
      expect(result.fullPath).toBe('/高考复习/函数');
    });
  });

  describe('build', () => {
    it('should build path from folder and resource ID', () => {
      const result = pathUtils.build('/高考复习/函数', 'note_abc123');
      expect(result).toBe('/高考复习/函数/note_abc123');
    });

    it('should build path from root folder', () => {
      const result = pathUtils.build(null, 'note_abc123');
      expect(result).toBe('/note_abc123');
    });

    it('should build path from "/" folder', () => {
      const result = pathUtils.build('/', 'note_abc123');
      expect(result).toBe('/note_abc123');
    });

    it('should return folder path when no resource ID', () => {
      const result = pathUtils.build('/高考复习', '');
      expect(result).toBe('/高考复习');
    });
  });

  describe('getResourceType', () => {
    it('should infer note type', () => {
      expect(pathUtils.getResourceType('note_abc123')).toBe('note');
    });

    it('should infer textbook type', () => {
      expect(pathUtils.getResourceType('tb_abc123')).toBe('textbook');
    });

    it('should infer folder type', () => {
      expect(pathUtils.getResourceType('fld_abc123')).toBe('folder');
    });

    it('should infer exam type', () => {
      expect(pathUtils.getResourceType('exam_abc123')).toBe('exam');
    });

    it('should infer translation type', () => {
      // 翻译资源的前缀是 tr_ 不是 trans_
      expect(pathUtils.getResourceType('tr_abc123')).toBe('translation');
    });

    it('should infer essay type', () => {
      expect(pathUtils.getResourceType('essay_abc123')).toBe('essay');
    });

    it('should return null for unknown prefix', () => {
      expect(pathUtils.getResourceType('unknown_abc123')).toBeNull();
    });
  });

  describe('isValidPath', () => {
    it('should validate correct paths', () => {
      expect(pathUtils.isValidPath('/')).toBe(true);
      expect(pathUtils.isValidPath('/高考复习')).toBe(true);
      expect(pathUtils.isValidPath('/高考复习/函数')).toBe(true);
      expect(pathUtils.isValidPath('/@trash')).toBe(true);
    });

    it('should reject invalid paths', () => {
      expect(pathUtils.isValidPath('')).toBe(false);
      expect(pathUtils.isValidPath('no-leading-slash')).toBe(false);
      expect(pathUtils.isValidPath('//double-slash')).toBe(false);
    });
  });

  describe('isVirtualPath', () => {
    it('should identify virtual paths', () => {
      expect(pathUtils.isVirtualPath('/@trash')).toBe(true);
      expect(pathUtils.isVirtualPath('/@recent')).toBe(true);
      expect(pathUtils.isVirtualPath('/@favorites')).toBe(true);
    });

    it('should reject non-virtual paths', () => {
      expect(pathUtils.isVirtualPath('/高考复习')).toBe(false);
      expect(pathUtils.isVirtualPath('/')).toBe(false);
    });
  });

  describe('getParentPath', () => {
    it('should get parent of nested path', () => {
      expect(pathUtils.getParentPath('/高考复习/函数/note_abc')).toBe('/高考复习/函数');
    });

    it('should get root as parent of single segment', () => {
      expect(pathUtils.getParentPath('/高考复习')).toBe('/');
    });

    it('should return null for root path', () => {
      expect(pathUtils.getParentPath('/')).toBeNull();
    });
  });

  describe('getBasename', () => {
    it('should get last segment of path', () => {
      expect(pathUtils.getBasename('/高考复习/函数/note_abc')).toBe('note_abc');
      expect(pathUtils.getBasename('/高考复习')).toBe('高考复习');
    });

    it('should return empty string for root', () => {
      expect(pathUtils.getBasename('/')).toBe('');
    });
  });

  describe('join', () => {
    it('should join path segments', () => {
      expect(pathUtils.join('高考复习', '函数', 'note_abc')).toBe('/高考复习/函数/note_abc');
    });

    it('should handle segments with slashes', () => {
      expect(pathUtils.join('/高考复习/', '/函数/')).toBe('/高考复习/函数');
    });

    it('should return root for empty segments', () => {
      expect(pathUtils.join()).toBe('/');
    });
  });
});

// ============================================================================
// 类型定义验证测试
// ============================================================================

describe('Type Definitions', () => {
  it('ParsedPath should have required fields', () => {
    const parsed: ParsedPath = {
      fullPath: '/test',
      folderPath: null,
      resourceId: null,
      resourceType: null,
      isRoot: true,
      isVirtual: false,
    };
    expect(parsed.fullPath).toBeDefined();
  });

  it('ResourceLocation should have required fields', () => {
    const location: ResourceLocation = {
      resourceId: 'note_abc',
      folderId: null,
      folderPath: '/',
      fullPath: '/note_abc',
    };
    expect(location.resourceId).toBe('note_abc');
  });

  it('SubjectMigrationStatus should have required fields', () => {
    const status: SubjectMigrationStatus = {
      totalResources: 100,
      migratedCount: 50,
      pendingCount: 50,
      autoCreatedFolders: ['数学', '英语'],
    };
    expect(status.totalResources).toBe(100);
  });

  it('BatchMoveRequest should have required fields', () => {
    const request: BatchMoveRequest = {
      resourceIds: ['note_1', 'note_2'],
      targetFolderId: 'fld_abc',
    };
    expect(request.resourceIds.length).toBe(2);
  });

  it('BatchMoveResult should have required fields', () => {
    const result: BatchMoveResult = {
      successCount: 2,
      failedCount: 0,
      results: [],
    };
    expect(result.successCount).toBe(2);
  });
});
