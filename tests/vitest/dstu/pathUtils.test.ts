/**
 * DSTU 路径工具单元测试
 *
 * 数据契约来源：28-DSTU真实路径架构重构任务分配.md 契约 D
 *
 * Prompt 7: 前端 Path API 封装
 *
 * 测试 pathUtils 纯前端路径工具函数
 */

import { describe, it, expect } from 'vitest';
import {
  pathUtils,
  parsePath,
  buildPath,
  getResourceType,
  isValidPath,
  isVirtualPath,
  getParentPath,
  getBasename,
  joinPath,
  RESOURCE_ID_PREFIX_MAP,
  VIRTUAL_PATH_PREFIXES,
} from '@/dstu';

describe('pathUtils', () => {
  // ==========================================================================
  // 1. 路径解析 - parse()
  // ==========================================================================

  describe('parse()', () => {
    describe('根目录路径', () => {
      it('应该正确解析根目录 /', () => {
        const result = pathUtils.parse('/');

        expect(result.fullPath).toBe('/');
        expect(result.folderPath).toBeNull();
        expect(result.resourceId).toBeNull();
        expect(result.resourceType).toBeNull();
        expect(result.isRoot).toBe(true);
        expect(result.isVirtual).toBe(false);
      });
    });

    describe('新格式路径（真实文件夹路径）', () => {
      it('应该解析单层文件夹下的资源', () => {
        const result = pathUtils.parse('/高考复习/note_abc123');

        expect(result.fullPath).toBe('/高考复习/note_abc123');
        expect(result.folderPath).toBe('/高考复习');
        expect(result.resourceId).toBe('note_abc123');
        expect(result.resourceType).toBe('note');
        expect(result.isRoot).toBe(false);
        expect(result.isVirtual).toBe(false);
      });

      it('应该解析多层文件夹下的资源', () => {
        const result = pathUtils.parse('/高考复习/函数/三角函数/note_xyz789');

        expect(result.fullPath).toBe('/高考复习/函数/三角函数/note_xyz789');
        expect(result.folderPath).toBe('/高考复习/函数/三角函数');
        expect(result.resourceId).toBe('note_xyz789');
        expect(result.resourceType).toBe('note');
      });

      it('应该解析根目录下的资源', () => {
        const result = pathUtils.parse('/exam_001');

        expect(result.fullPath).toBe('/exam_001');
        expect(result.folderPath).toBeNull();
        expect(result.resourceId).toBe('exam_001');
        expect(result.resourceType).toBe('exam');
      });

      it('应该解析纯文件夹路径', () => {
        const result = pathUtils.parse('/高考复习/函数');

        expect(result.fullPath).toBe('/高考复习/函数');
        expect(result.folderPath).toBe('/高考复习/函数');
        expect(result.resourceId).toBeNull();
        expect(result.resourceType).toBeNull();
      });
    });

    describe('虚拟路径', () => {
      it('应该识别回收站路径', () => {
        const result = pathUtils.parse('/@trash');

        expect(result.fullPath).toBe('/@trash');
        expect(result.isVirtual).toBe(true);
        expect(result.resourceId).toBeNull();
      });

      it('应该识别回收站下的资源', () => {
        const result = pathUtils.parse('/@trash/note_deleted');

        expect(result.isVirtual).toBe(true);
        expect(result.resourceId).toBe('note_deleted');
        expect(result.resourceType).toBe('note');
      });

      it('应该识别最近使用路径', () => {
        const result = pathUtils.parse('/@recent');

        expect(result.isVirtual).toBe(true);
      });

      it('应该识别收藏路径', () => {
        const result = pathUtils.parse('/@favorites');

        expect(result.isVirtual).toBe(true);
      });
    });

    describe('资源类型推断', () => {
      const testCases = [
        { id: 'note_abc', type: 'note' },
        { id: 'tb_xyz', type: 'textbook' },
        { id: 'exam_123', type: 'exam' },
        { id: 'tr_456', type: 'translation' },
        { id: 'essay_789', type: 'essay' },
        { id: 'fld_folder', type: 'folder' },
        { id: 'att_attachment', type: 'attachment' },
        { id: 'img_image', type: 'image' },
        { id: 'file_doc', type: 'file' },
      ];

      testCases.forEach(({ id, type }) => {
        it(`应该从 ${id} 推断类型为 ${type}`, () => {
          const result = pathUtils.parse(`/folder/${id}`);
          expect(result.resourceType).toBe(type);
        });
      });
    });
  });

  // ==========================================================================
  // 2. 路径构建 - build()
  // ==========================================================================

  describe('build()', () => {
    it('应该构建根目录下的资源路径', () => {
      const result = pathUtils.build(null, 'note_abc');
      expect(result).toBe('/note_abc');
    });

    it('应该构建根目录路径（使用 /）', () => {
      const result = pathUtils.build('/', 'note_abc');
      expect(result).toBe('/note_abc');
    });

    it('应该构建文件夹下的资源路径', () => {
      const result = pathUtils.build('/高考复习', 'note_abc');
      expect(result).toBe('/高考复习/note_abc');
    });

    it('应该处理不带前导斜杠的文件夹路径', () => {
      const result = pathUtils.build('高考复习/函数', 'note_abc');
      expect(result).toBe('/高考复习/函数/note_abc');
    });

    it('应该处理带尾部斜杠的文件夹路径', () => {
      const result = pathUtils.build('/高考复习/', 'note_abc');
      expect(result).toBe('/高考复习/note_abc');
    });

    it('没有资源 ID 时应该返回文件夹路径', () => {
      const result = pathUtils.build('/高考复习', '');
      expect(result).toBe('/高考复习');
    });
  });

  // ==========================================================================
  // 3. 资源类型推断 - getResourceType()
  // ==========================================================================

  describe('getResourceType()', () => {
    it('应该从笔记 ID 推断类型', () => {
      expect(pathUtils.getResourceType('note_abc123')).toBe('note');
    });

    it('应该从教材 ID 推断类型', () => {
      expect(pathUtils.getResourceType('tb_xyz')).toBe('textbook');
    });

    it('应该从整卷 ID 推断类型', () => {
      expect(pathUtils.getResourceType('exam_001')).toBe('exam');
    });

    it('应该从翻译 ID 推断类型', () => {
      expect(pathUtils.getResourceType('tr_translation')).toBe('translation');
    });

    it('应该从作文 ID 推断类型', () => {
      expect(pathUtils.getResourceType('essay_essay1')).toBe('essay');
    });

    it('应该从文件夹 ID 推断类型', () => {
      expect(pathUtils.getResourceType('fld_folder1')).toBe('folder');
    });

    it('未知前缀时应该返回 null', () => {
      expect(pathUtils.getResourceType('unknown_id')).toBeNull();
    });

    it('空字符串应该返回 null', () => {
      expect(pathUtils.getResourceType('')).toBeNull();
    });
  });

  // ==========================================================================
  // 4. 路径验证 - isValidPath()
  // ==========================================================================

  describe('isValidPath()', () => {
    describe('有效路径', () => {
      const validPaths = [
        '/',
        '/folder',
        '/folder/note_abc',
        '/高考复习/函数/note_123',
        '/@trash',
        '/@recent',
        '/a/b/c/d/e',
      ];

      validPaths.forEach((path) => {
        it(`应该接受 ${path}`, () => {
          expect(pathUtils.isValidPath(path)).toBe(true);
        });
      });
    });

    describe('无效路径', () => {
      const invalidPaths = [
        '',
        'no-leading-slash',
        '//double-slash',
        '/folder//subfolder',
        '/@invalid@path',
      ];

      invalidPaths.forEach((path) => {
        it(`应该拒绝 ${path || '(空字符串)'}`, () => {
          expect(pathUtils.isValidPath(path)).toBe(false);
        });
      });
    });
  });

  // ==========================================================================
  // 5. 虚拟路径检查 - isVirtualPath()
  // ==========================================================================

  describe('isVirtualPath()', () => {
    it('应该识别 @trash 为虚拟路径', () => {
      expect(pathUtils.isVirtualPath('/@trash')).toBe(true);
    });

    it('应该识别 @recent 为虚拟路径', () => {
      expect(pathUtils.isVirtualPath('/@recent')).toBe(true);
    });

    it('应该识别 @favorites 为虚拟路径', () => {
      expect(pathUtils.isVirtualPath('/@favorites')).toBe(true);
    });

    it('应该识别虚拟路径下的子路径', () => {
      expect(pathUtils.isVirtualPath('/@trash/note_abc')).toBe(true);
    });

    it('普通路径不是虚拟路径', () => {
      expect(pathUtils.isVirtualPath('/folder/note_abc')).toBe(false);
    });

    it('根目录不是虚拟路径', () => {
      expect(pathUtils.isVirtualPath('/')).toBe(false);
    });
  });

  // ==========================================================================
  // 6. 获取父路径 - getParentPath()
  // ==========================================================================

  describe('getParentPath()', () => {
    it('根目录的父路径为 null', () => {
      expect(pathUtils.getParentPath('/')).toBeNull();
    });

    it('一级路径的父路径为根目录', () => {
      expect(pathUtils.getParentPath('/folder')).toBe('/');
    });

    it('多级路径返回上一级', () => {
      expect(pathUtils.getParentPath('/a/b/c')).toBe('/a/b');
    });

    it('资源路径返回所在文件夹', () => {
      expect(pathUtils.getParentPath('/高考复习/note_abc')).toBe('/高考复习');
    });
  });

  // ==========================================================================
  // 7. 获取基本名称 - getBasename()
  // ==========================================================================

  describe('getBasename()', () => {
    it('根目录返回空字符串', () => {
      expect(pathUtils.getBasename('/')).toBe('');
    });

    it('一级路径返回目录名', () => {
      expect(pathUtils.getBasename('/folder')).toBe('folder');
    });

    it('多级路径返回最后一段', () => {
      expect(pathUtils.getBasename('/a/b/c')).toBe('c');
    });

    it('资源路径返回资源 ID', () => {
      expect(pathUtils.getBasename('/folder/note_abc')).toBe('note_abc');
    });
  });

  // ==========================================================================
  // 8. 路径连接 - join()
  // ==========================================================================

  describe('join()', () => {
    it('应该连接多个路径段', () => {
      expect(pathUtils.join('a', 'b', 'c')).toBe('/a/b/c');
    });

    it('应该处理带斜杠的路径段', () => {
      expect(pathUtils.join('/a/', '/b/', '/c/')).toBe('/a/b/c');
    });

    it('空数组返回根目录', () => {
      expect(pathUtils.join()).toBe('/');
    });

    it('空字符串被忽略', () => {
      expect(pathUtils.join('a', '', 'b')).toBe('/a/b');
    });

    it('应该正确连接文件夹路径和资源 ID', () => {
      expect(pathUtils.join('/高考复习', 'note_abc')).toBe('/高考复习/note_abc');
    });
  });

  // ==========================================================================
  // 9. 导出验证
  // ==========================================================================

  describe('导出验证', () => {
    it('pathUtils 应该包含所有方法', () => {
      expect(typeof pathUtils.parse).toBe('function');
      expect(typeof pathUtils.build).toBe('function');
      expect(typeof pathUtils.getResourceType).toBe('function');
      expect(typeof pathUtils.isValidPath).toBe('function');
      expect(typeof pathUtils.isVirtualPath).toBe('function');
      expect(typeof pathUtils.getParentPath).toBe('function');
      expect(typeof pathUtils.getBasename).toBe('function');
      expect(typeof pathUtils.join).toBe('function');
    });

    it('单独导出的函数应该可用', () => {
      expect(typeof parsePath).toBe('function');
      expect(typeof buildPath).toBe('function');
      expect(typeof getResourceType).toBe('function');
      expect(typeof isValidPath).toBe('function');
      expect(typeof isVirtualPath).toBe('function');
      expect(typeof getParentPath).toBe('function');
      expect(typeof getBasename).toBe('function');
      expect(typeof joinPath).toBe('function');
    });
  });

  // ==========================================================================
  // 10. 常量验证
  // ==========================================================================

  describe('常量验证', () => {
    it('RESOURCE_ID_PREFIX_MAP 应该包含所有已知前缀', () => {
      expect(RESOURCE_ID_PREFIX_MAP['note_']).toBe('note');
      expect(RESOURCE_ID_PREFIX_MAP['tb_']).toBe('textbook');
      expect(RESOURCE_ID_PREFIX_MAP['exam_']).toBe('exam');
      expect(RESOURCE_ID_PREFIX_MAP['tr_']).toBe('translation');
      expect(RESOURCE_ID_PREFIX_MAP['essay_']).toBe('essay');
      expect(RESOURCE_ID_PREFIX_MAP['fld_']).toBe('folder');
    });

    it('VIRTUAL_PATH_PREFIXES 应该包含所有虚拟路径', () => {
      expect(VIRTUAL_PATH_PREFIXES.TRASH).toBe('/@trash');
      expect(VIRTUAL_PATH_PREFIXES.RECENT).toBe('/@recent');
      expect(VIRTUAL_PATH_PREFIXES.FAVORITES).toBe('/@favorites');
    });
  });
});
