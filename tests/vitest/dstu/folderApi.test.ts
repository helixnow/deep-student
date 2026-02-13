/**
 * VFS 文件夹 API 单元测试
 *
 * 数据契约来源：23-VFS文件夹架构与上下文注入改造任务分配.md
 *
 * Prompt 6: 前端 DSTU 文件夹 API 封装
 *
 * 测试使用 Mock 实现，验证 API 行为是否符合契约
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { folderApiMock } from '@/dstu/api/folderApiMock';
import { FOLDER_ERRORS, FOLDER_CONSTRAINTS } from '@/dstu/types/folder';

describe('folderApi (Mock)', () => {
  // 每个测试前清空数据
  beforeEach(() => {
    folderApiMock._clearAll();
  });

  // ==========================================================================
  // 1. 创建文件夹
  // ==========================================================================

  describe('createFolder', () => {
    it('应该创建根级文件夹', async () => {
      const folder = await folderApiMock.createFolder('期末复习');

      expect(folder).toBeDefined();
      expect(folder.id).toMatch(/^fld_/);
      expect(folder.title).toBe('期末复习');
      expect(folder.parentId).toBeNull();
      expect(folder.isExpanded).toBe(true);
    });

    it('应该创建带图标和颜色的文件夹', async () => {
      const folder = await folderApiMock.createFolder(
        '重点内容',
        undefined,
        'star',
        'red'
      );

      expect(folder.icon).toBe('star');
      expect(folder.color).toBe('red');
    });

    it('标题超过 100 字符时应该抛出错误', async () => {
      const longTitle = 'a'.repeat(FOLDER_CONSTRAINTS.MAX_TITLE_LENGTH + 1);

      await expect(
        folderApiMock.createFolder(longTitle)
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // 2. 创建嵌套文件夹
  // ==========================================================================

  describe('嵌套文件夹', () => {
    it('应该创建子文件夹', async () => {
      const parent = await folderApiMock.createFolder('函数');
      const child = await folderApiMock.createFolder('三角函数', parent.id);

      expect(child.parentId).toBe(parent.id);
    });

    it('父文件夹不存在时应该抛出错误', async () => {
      await expect(
        folderApiMock.createFolder('子文件夹', 'non_existent_id')
      ).rejects.toThrow(FOLDER_ERRORS.INVALID_PARENT);
    });

    it('超过最大深度时应该抛出错误', async () => {
      // 创建 9 层嵌套（因为根级是第 0 层，最大深度是 10）
      let parentId: string | undefined = undefined;
      for (let i = 0; i < FOLDER_CONSTRAINTS.MAX_DEPTH - 1; i++) {
        const folder = await folderApiMock.createFolder(`层级${i}`, parentId);
        parentId = folder.id;
      }

      // 第 10 层应该失败
      await expect(
        folderApiMock.createFolder('超过深度', parentId)
      ).rejects.toThrow(FOLDER_ERRORS.DEPTH_EXCEEDED);
    });
  });

  // ==========================================================================
  // 3. 添加内容到文件夹
  // ==========================================================================

  describe('addItem', () => {
    it('应该添加内容到文件夹', async () => {
      const folder = await folderApiMock.createFolder('笔记');
      const item = await folderApiMock.addItem(folder.id, 'note', 'note_123');

      expect(item).toBeDefined();
      expect(item.id).toMatch(/^fi_/);
      expect(item.folderId).toBe(folder.id);
      expect(item.itemType).toBe('note');
      expect(item.itemId).toBe('note_123');
    });

    it('应该添加内容到根级', async () => {
      const item = await folderApiMock.addItem(null, 'textbook', 'tb_456');

      expect(item.folderId).toBeNull();
    });

    it('重复添加应该更新 folderId', async () => {
      const folder1 = await folderApiMock.createFolder('文件夹1');
      const folder2 = await folderApiMock.createFolder('文件夹2');

      const item1 = await folderApiMock.addItem(folder1.id, 'note', 'note_123');
      const item2 = await folderApiMock.addItem(folder2.id, 'note', 'note_123');

      // 应该是同一个 item，只是 folderId 变了
      expect(item2.id).toBe(item1.id);
      expect(item2.folderId).toBe(folder2.id);
    });
  });

  // ==========================================================================
  // 4. 移动内容到另一文件夹
  // ==========================================================================

  describe('moveItem', () => {
    it('应该移动内容到另一文件夹', async () => {
      const folder1 = await folderApiMock.createFolder('文件夹1');
      const folder2 = await folderApiMock.createFolder('文件夹2');

      await folderApiMock.addItem(folder1.id, 'note', 'note_123');
      await folderApiMock.moveItem('note', 'note_123', folder2.id);

      const items = await folderApiMock.getFolderItems(folder2.id);
      expect(items.length).toBe(1);
      expect(items[0].itemId).toBe('note_123');
    });

    it('应该移动内容到根级', async () => {
      const folder = await folderApiMock.createFolder('文件夹');

      await folderApiMock.addItem(folder.id, 'note', 'note_123');
      await folderApiMock.moveItem('note', 'note_123', undefined);

      const items = await folderApiMock.getFolderItems(undefined);
      expect(items.some((i) => i.itemId === 'note_123')).toBe(true);
    });
  });

  // ==========================================================================
  // 5. 删除文件夹验证级联
  // ==========================================================================

  describe('deleteFolder', () => {
    it('删除文件夹后内容应该移到根级', async () => {
      const folder = await folderApiMock.createFolder('待删除');
      await folderApiMock.addItem(folder.id, 'note', 'note_123');

      await folderApiMock.deleteFolder(folder.id);

      // 文件夹应该不存在了
      const deletedFolder = await folderApiMock.getFolder(folder.id);
      expect(deletedFolder).toBeNull();

      // 内容应该在根级
      const items = await folderApiMock.getFolderItems(undefined);
      expect(items.some((i) => i.itemId === 'note_123')).toBe(true);
    });

    it('删除父文件夹应该级联删除子文件夹', async () => {
      const parent = await folderApiMock.createFolder('父文件夹');
      const child = await folderApiMock.createFolder('子文件夹', parent.id);

      await folderApiMock.deleteFolder(parent.id);

      // 子文件夹也应该被删除
      const deletedChild = await folderApiMock.getFolder(child.id);
      expect(deletedChild).toBeNull();
    });
  });

  // ==========================================================================
  // 6. 获取文件夹树结构
  // ==========================================================================

  describe('getFolderTree', () => {
    it('应该返回正确的树结构', async () => {
      const parent = await folderApiMock.createFolder('函数');
      const child1 = await folderApiMock.createFolder('三角函数', parent.id);
      const child2 = await folderApiMock.createFolder('指数函数', parent.id);
      await folderApiMock.createFolder('其他'); // 另一个根级文件夹

      // 添加一些内容
      await folderApiMock.addItem(parent.id, 'note', 'note_1');
      await folderApiMock.addItem(child1.id, 'note', 'note_2');

      const tree = await folderApiMock.getFolderTree();

      // 应该有 2 个根级节点
      expect(tree.length).toBe(2);

      // 找到 "函数" 文件夹
      const funcNode = tree.find((n) => n.folder.title === '函数');
      expect(funcNode).toBeDefined();
      expect(funcNode!.children.length).toBe(2);
      expect(funcNode!.items.length).toBe(1);

      // 子文件夹
      const triNode = funcNode!.children.find((n) => n.folder.title === '三角函数');
      expect(triNode).toBeDefined();
      expect(triNode!.items.length).toBe(1);
    });

    it('空数据应该返回空数组', async () => {
      const tree = await folderApiMock.getFolderTree();
      expect(tree).toEqual([]);
    });
  });

  // ==========================================================================
  // 7. 递归获取所有资源
  // ==========================================================================

  describe('getFolderAllResources', () => {
    it('应该获取文件夹内的资源', async () => {
      const folder = await folderApiMock.createFolder('复习');
      await folderApiMock.addItem(folder.id, 'note', 'note_1');
      await folderApiMock.addItem(folder.id, 'textbook', 'tb_1');

      const result = await folderApiMock.getFolderAllResources(folder.id, false, false);

      expect(result.folderId).toBe(folder.id);
      expect(result.folderTitle).toBe('复习');
      expect(result.totalCount).toBe(2);
      expect(result.resources.length).toBe(2);
    });

    it('includeSubfolders=true 时应该递归获取', async () => {
      const parent = await folderApiMock.createFolder('父');
      const child = await folderApiMock.createFolder('子', parent.id);

      await folderApiMock.addItem(parent.id, 'note', 'note_parent');
      await folderApiMock.addItem(child.id, 'note', 'note_child');

      const result = await folderApiMock.getFolderAllResources(parent.id, true, false);

      expect(result.totalCount).toBe(2);
    });

    it('includeSubfolders=false 时只获取当前文件夹', async () => {
      const parent = await folderApiMock.createFolder('父');
      const child = await folderApiMock.createFolder('子', parent.id);

      await folderApiMock.addItem(parent.id, 'note', 'note_parent');
      await folderApiMock.addItem(child.id, 'note', 'note_child');

      const result = await folderApiMock.getFolderAllResources(parent.id, false, false);

      expect(result.totalCount).toBe(1);
    });
  });

  // ==========================================================================
  // 8. 测试深度限制
  // ==========================================================================

  describe('深度限制', () => {
    it('应该拒绝创建超过 10 层的文件夹', async () => {
      let parentId: string | undefined = undefined;

      // 创建 9 层
      for (let i = 0; i < 9; i++) {
        const folder = await folderApiMock.createFolder(`层${i + 1}`, parentId);
        parentId = folder.id;
      }

      // 第 10 层应该失败
      await expect(
        folderApiMock.createFolder('层10', parentId)
      ).rejects.toThrow(FOLDER_ERRORS.DEPTH_EXCEEDED);
    });
  });

  // ==========================================================================
  // 9. 测试数量限制
  // ==========================================================================

  describe('数量限制', () => {
    it('应该拒绝创建超过限制的文件夹', async () => {
      // 这个测试可能较慢，创建 500 个文件夹
      // 在实际测试中可以降低限制或跳过
      const MAX = FOLDER_CONSTRAINTS.MAX_FOLDERS;

      for (let i = 0; i < MAX; i++) {
        await folderApiMock.createFolder(`文件夹${i}`);
      }

      await expect(
        folderApiMock.createFolder('超过限制')
      ).rejects.toThrow();
    }, 60000); // 60 秒超时
  });

  // ==========================================================================
  // 10. 排序
  // ==========================================================================

  describe('reorderFolders', () => {
    it('应该重新排序文件夹', async () => {
      const f1 = await folderApiMock.createFolder('文件夹1');
      const f2 = await folderApiMock.createFolder('文件夹2');
      const f3 = await folderApiMock.createFolder('文件夹3');

      // 原始顺序：f1, f2, f3
      // 新顺序：f3, f1, f2
      await folderApiMock.reorderFolders([f3.id, f1.id, f2.id]);

      const folders = await folderApiMock.listFolders();
      expect(folders[0].id).toBe(f3.id);
      expect(folders[1].id).toBe(f1.id);
      expect(folders[2].id).toBe(f2.id);
    });
  });

  // ==========================================================================
  // 11. 其他操作
  // ==========================================================================

  describe('其他操作', () => {
    it('renameFolder 应该重命名', async () => {
      const folder = await folderApiMock.createFolder('原名');
      await folderApiMock.renameFolder(folder.id, '新名');

      const updated = await folderApiMock.getFolder(folder.id);
      expect(updated?.title).toBe('新名');
    });

    it('setFolderExpanded 应该更新展开状态', async () => {
      const folder = await folderApiMock.createFolder('测试');
      expect(folder.isExpanded).toBe(true);

      await folderApiMock.setFolderExpanded(folder.id, false);

      const updated = await folderApiMock.getFolder(folder.id);
      expect(updated?.isExpanded).toBe(false);
    });

    it('removeItem 应该移除内容', async () => {
      const folder = await folderApiMock.createFolder('测试');
      await folderApiMock.addItem(folder.id, 'note', 'note_123');

      await folderApiMock.removeItem('note', 'note_123');

      const items = await folderApiMock.getFolderItems(folder.id);
      expect(items.length).toBe(0);
    });
  });
});
