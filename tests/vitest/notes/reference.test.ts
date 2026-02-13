/**
 * 引用节点类型和工具函数单元测试
 *
 * 验证 Prompt 1 的实现：
 * - ReferenceNode、SourceDatabase、PreviewType 类型定义
 * - ID 工具函数：isReferenceId、isFolderId、isNoteId、generateRefId
 * - 类型守卫：isValidSourceDatabase、isValidPreviewType、isValidReferenceNode
 * - 工厂函数：createReferenceNode
 */

import { describe, it, expect } from 'vitest';
import {
  // 类型
  type SourceDatabase,
  type PreviewType,
  type ReferenceNode,
  type ExtendedFolderStructure,
  type CreateReferenceNodeParams,

  // ID 常量
  NOTE_ID_PREFIX,
  FOLDER_ID_PREFIX,
  REFERENCE_ID_PREFIX,

  // ID 工具函数
  isReferenceId,
  isFolderId,
  isNoteId,
  generateRefId,
  generateFolderId,
  getNodeType,

  // SourceDatabase 辅助
  SOURCE_DB_DISPLAY_NAMES,
  SOURCE_DB_ICONS,
  SOURCE_DB_PREVIEW_TYPES,
  getSourceDbIcon,
  getSourceDbPreviewType,

  // 类型守卫
  isValidSourceDatabase,
  isValidPreviewType,
  isValidReferenceNode,

  // 工厂函数
  createReferenceNode,
} from '../../../src/components/notes/types/reference';

// ============================================================================
// ID 常量测试
// ============================================================================

describe('ID 常量', () => {
  it('常量值正确', () => {
    expect(NOTE_ID_PREFIX).toBe('note_');
    expect(FOLDER_ID_PREFIX).toBe('fld_');
    expect(REFERENCE_ID_PREFIX).toBe('ref_');
  });
});

// ============================================================================
// isReferenceId 测试
// ============================================================================

describe('isReferenceId', () => {
  it('正确识别 ref_xxx 格式', () => {
    expect(isReferenceId('ref_abc123')).toBe(true);
    expect(isReferenceId('ref_')).toBe(true);
    expect(isReferenceId('ref_12345678')).toBe(true);
  });

  it('拒绝非引用 ID', () => {
    expect(isReferenceId('note_abc')).toBe(false);
    expect(isReferenceId('fld_abc')).toBe(false);
    expect(isReferenceId('abc123')).toBe(false);
    expect(isReferenceId('')).toBe(false);
    expect(isReferenceId('REF_abc')).toBe(false); // 大写
  });

  it('处理无效输入', () => {
    expect(isReferenceId(null as any)).toBe(false);
    expect(isReferenceId(undefined as any)).toBe(false);
    expect(isReferenceId(123 as any)).toBe(false);
  });
});

// ============================================================================
// isFolderId 测试
// ============================================================================

describe('isFolderId', () => {
  it('正确识别 fld_xxx 格式', () => {
    expect(isFolderId('fld_abc123')).toBe(true);
    expect(isFolderId('fld_')).toBe(true);
    expect(isFolderId('fld_12345678')).toBe(true);
  });

  it('拒绝非文件夹 ID', () => {
    expect(isFolderId('note_abc')).toBe(false);
    expect(isFolderId('ref_abc')).toBe(false);
    expect(isFolderId('folder_abc')).toBe(false); // 不是 fld_
    expect(isFolderId('')).toBe(false);
  });
});

// ============================================================================
// isNoteId 测试
// ============================================================================

describe('isNoteId', () => {
  it('正确识别笔记 ID（排除法）', () => {
    expect(isNoteId('note_abc123')).toBe(true);
    expect(isNoteId('abc123')).toBe(true); // 旧格式无前缀
    expect(isNoteId('some-uuid-format')).toBe(true);
  });

  it('排除文件夹和引用 ID', () => {
    expect(isNoteId('fld_abc')).toBe(false);
    expect(isNoteId('ref_abc')).toBe(false);
  });

  it('处理边界情况', () => {
    expect(isNoteId('')).toBe(false);
    expect(isNoteId(null as any)).toBe(false);
    expect(isNoteId(undefined as any)).toBe(false);
  });
});

// ============================================================================
// generateRefId 测试
// ============================================================================

describe('generateRefId', () => {
  it('生成 ref_ 前缀的 ID', () => {
    const id = generateRefId();
    expect(id.startsWith('ref_')).toBe(true);
  });

  it('生成的 ID 长度正确（ref_ + 8位）', () => {
    const id = generateRefId();
    expect(id.length).toBe(12); // "ref_" (4) + nanoid(8)
  });

  it('每次生成不同的 ID', () => {
    const id1 = generateRefId();
    const id2 = generateRefId();
    expect(id1).not.toBe(id2);
  });

  it('生成的 ID 被 isReferenceId 识别', () => {
    const id = generateRefId();
    expect(isReferenceId(id)).toBe(true);
  });
});

// ============================================================================
// generateFolderId 测试
// ============================================================================

describe('generateFolderId', () => {
  it('生成 fld_ 前缀的 ID', () => {
    const id = generateFolderId();
    expect(id.startsWith('fld_')).toBe(true);
  });

  it('生成的 ID 被 isFolderId 识别', () => {
    const id = generateFolderId();
    expect(isFolderId(id)).toBe(true);
  });
});

// ============================================================================
// getNodeType 测试
// ============================================================================

describe('getNodeType', () => {
  it('正确识别文件夹', () => {
    expect(getNodeType('fld_abc')).toBe('folder');
  });

  it('正确识别引用', () => {
    expect(getNodeType('ref_abc')).toBe('reference');
  });

  it('其他认为是笔记', () => {
    expect(getNodeType('note_abc')).toBe('note');
    expect(getNodeType('abc123')).toBe('note');
  });
});

// ============================================================================
// isValidSourceDatabase 测试
// ============================================================================

describe('isValidSourceDatabase', () => {
  it('接受有效值', () => {
    expect(isValidSourceDatabase('textbooks')).toBe(true);
    expect(isValidSourceDatabase('mistakes')).toBe(true);
    expect(isValidSourceDatabase('chat_v2')).toBe(true);
    expect(isValidSourceDatabase('exam_sessions')).toBe(true);
  });

  it('拒绝无效值', () => {
    expect(isValidSourceDatabase('notes')).toBe(false);
    expect(isValidSourceDatabase('other')).toBe(false);
    expect(isValidSourceDatabase('')).toBe(false);
    expect(isValidSourceDatabase(null)).toBe(false);
    expect(isValidSourceDatabase(undefined)).toBe(false);
    expect(isValidSourceDatabase(123)).toBe(false);
  });
});

// ============================================================================
// isValidPreviewType 测试
// ============================================================================

describe('isValidPreviewType', () => {
  it('接受有效值', () => {
    expect(isValidPreviewType('markdown')).toBe(true);
    expect(isValidPreviewType('pdf')).toBe(true);
    expect(isValidPreviewType('exam')).toBe(true);
    expect(isValidPreviewType('text')).toBe(true);
    expect(isValidPreviewType('video')).toBe(true);
    expect(isValidPreviewType('image')).toBe(true);
    expect(isValidPreviewType('none')).toBe(true);
  });

  it('拒绝无效值', () => {
    expect(isValidPreviewType('card')).toBe(false);
    expect(isValidPreviewType('doc')).toBe(false);
    expect(isValidPreviewType('')).toBe(false);
    expect(isValidPreviewType(null)).toBe(false);
  });
});

// ============================================================================
// isValidReferenceNode 测试
// ============================================================================

describe('isValidReferenceNode', () => {
  const validNode: ReferenceNode = {
    sourceDb: 'textbooks',
    sourceId: 'tb_123',
    title: '高等数学(上)',
    previewType: 'pdf',
    createdAt: Date.now(),
  };

  it('接受有效的 ReferenceNode', () => {
    expect(isValidReferenceNode(validNode)).toBe(true);
  });

  it('接受带可选 icon 的 ReferenceNode', () => {
    expect(isValidReferenceNode({ ...validNode, icon: 'BookOpen' })).toBe(true);
  });

  it('拒绝缺少必要字段', () => {
    expect(isValidReferenceNode({ ...validNode, sourceDb: undefined })).toBe(false);
    expect(isValidReferenceNode({ ...validNode, sourceId: '' })).toBe(false);
    expect(isValidReferenceNode({ ...validNode, title: undefined })).toBe(false);
    expect(isValidReferenceNode({ ...validNode, previewType: undefined })).toBe(false);
    expect(isValidReferenceNode({ ...validNode, createdAt: 0 })).toBe(false);
    expect(isValidReferenceNode({ ...validNode, createdAt: -1 })).toBe(false);
  });

  it('拒绝无效的 sourceDb', () => {
    expect(isValidReferenceNode({ ...validNode, sourceDb: 'invalid' as any })).toBe(false);
  });

  it('拒绝无效的 previewType', () => {
    expect(isValidReferenceNode({ ...validNode, previewType: 'invalid' as any })).toBe(false);
  });

  it('拒绝非对象', () => {
    expect(isValidReferenceNode(null)).toBe(false);
    expect(isValidReferenceNode(undefined)).toBe(false);
    expect(isValidReferenceNode('string')).toBe(false);
    expect(isValidReferenceNode(123)).toBe(false);
    expect(isValidReferenceNode([])).toBe(false);
  });
});

// ============================================================================
// createReferenceNode 测试
// ============================================================================

describe('createReferenceNode', () => {
  it('创建基本 ReferenceNode', () => {
    const params: CreateReferenceNodeParams = {
      sourceDb: 'textbooks',
      sourceId: 'tb_123',
      title: '高等数学(上)',
    };

    const node = createReferenceNode(params);

    expect(node.sourceDb).toBe('textbooks');
    expect(node.sourceId).toBe('tb_123');
    expect(node.title).toBe('高等数学(上)');
    expect(node.previewType).toBe('pdf'); // textbooks 默认 pdf
    expect(node.createdAt).toBeGreaterThan(0);
    expect(node.icon).toBeUndefined();
  });

  it('使用指定的 previewType', () => {
    const node = createReferenceNode({
      sourceDb: 'textbooks',
      sourceId: 'tb_123',
      title: 'Test',
      previewType: 'image',
    });

    expect(node.previewType).toBe('image');
  });

  it('使用指定的 icon', () => {
    const node = createReferenceNode({
      sourceDb: 'mistakes',
      sourceId: 'mis_123',
      title: 'Test',
      icon: 'CustomIcon',
    });

    expect(node.icon).toBe('CustomIcon');
  });

  it('mistakes 默认 previewType 为 none', () => {
    const node = createReferenceNode({
      sourceDb: 'mistakes',
      sourceId: 'mis_123',
      title: 'Test',
    });

    expect(node.previewType).toBe('none');
  });

  it('chat_v2 默认 previewType 为 none', () => {
    const node = createReferenceNode({
      sourceDb: 'chat_v2',
      sourceId: 'res_123',
      title: 'Test',
    });

    expect(node.previewType).toBe('none');
  });

  it('创建的节点通过类型验证', () => {
    const node = createReferenceNode({
      sourceDb: 'textbooks',
      sourceId: 'tb_123',
      title: 'Test',
    });

    expect(isValidReferenceNode(node)).toBe(true);
  });
});

// ============================================================================
// SourceDatabase 辅助函数测试
// ============================================================================

describe('SourceDatabase 辅助', () => {
  describe('SOURCE_DB_DISPLAY_NAMES', () => {
    it('包含所有 SourceDatabase 的显示名称', () => {
      expect(SOURCE_DB_DISPLAY_NAMES.textbooks).toEqual({ zh: '教材', en: 'Textbook' });
      expect(SOURCE_DB_DISPLAY_NAMES.mistakes).toEqual({ zh: '错题', en: 'Mistake' });
      expect(SOURCE_DB_DISPLAY_NAMES.chat_v2).toEqual({ zh: '附件', en: 'Attachment' });
      expect(SOURCE_DB_DISPLAY_NAMES.exam_sessions).toEqual({ zh: '题目集识别', en: 'Exam Session' });
    });
  });

  describe('SOURCE_DB_ICONS', () => {
    it('包含所有 SourceDatabase 的图标', () => {
      expect(SOURCE_DB_ICONS.textbooks).toBe('BookOpen');
      expect(SOURCE_DB_ICONS.mistakes).toBe('ClipboardList');
      expect(SOURCE_DB_ICONS.chat_v2).toBe('Paperclip');
      expect(SOURCE_DB_ICONS.exam_sessions).toBe('FileSpreadsheet');
    });
  });

  describe('getSourceDbIcon', () => {
    it('返回正确的图标', () => {
      expect(getSourceDbIcon('textbooks')).toBe('BookOpen');
      expect(getSourceDbIcon('mistakes')).toBe('ClipboardList');
      expect(getSourceDbIcon('chat_v2')).toBe('Paperclip');
      expect(getSourceDbIcon('exam_sessions')).toBe('FileSpreadsheet');
    });
  });

  describe('getSourceDbPreviewType', () => {
    it('返回正确的预览类型', () => {
      expect(getSourceDbPreviewType('textbooks')).toBe('pdf');
      expect(getSourceDbPreviewType('mistakes')).toBe('none');
      expect(getSourceDbPreviewType('chat_v2')).toBe('none');
      expect(getSourceDbPreviewType('exam_sessions')).toBe('exam');
    });
  });
});

// ============================================================================
// 旧数据兼容性测试
// ============================================================================

describe('旧数据兼容性', () => {
  it('FolderStructure 无 references 字段时应正常工作', () => {
    // 模拟旧数据（无 references 字段）
    const oldData: { folders: Record<string, { title: string; children: string[] }>; rootChildren: string[]; references?: Record<string, ReferenceNode> } = {
      folders: {
        'fld_abc': { title: 'Test Folder', children: ['note_1', 'note_2'] }
      },
      rootChildren: ['fld_abc', 'note_3'],
    };

    // 解析时使用默认值
    const parsed: ExtendedFolderStructure = {
      ...oldData,
      references: oldData.references ?? {},
    };

    expect(parsed.references).toEqual({});
    expect(parsed.folders).toEqual(oldData.folders);
    expect(parsed.rootChildren).toEqual(oldData.rootChildren);
  });

  it('FolderStructure 有 references 字段时应正确解析', () => {
    const newData: ExtendedFolderStructure = {
      folders: {
        'fld_abc': { title: 'Test Folder', children: ['note_1', 'ref_001'] }
      },
      rootChildren: ['fld_abc', 'ref_002'],
      references: {
        'ref_001': {
          sourceDb: 'textbooks',
          sourceId: 'tb_123',
          title: '高等数学',
          previewType: 'pdf',
          createdAt: 1704528000000,
        },
        'ref_002': {
          sourceDb: 'mistakes',
          sourceId: 'mis_456',
          title: '导数错题',
          previewType: 'card',
          createdAt: 1704528100000,
        },
      },
    };

    expect(Object.keys(newData.references!)).toHaveLength(2);
    expect(newData.references!['ref_001'].sourceDb).toBe('textbooks');
    expect(newData.references!['ref_002'].sourceDb).toBe('mistakes');
  });
});
