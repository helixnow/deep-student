/**
 * types/reference.ts 类型守卫补充单测（B8 统一后的新面）
 *
 * 与 tests/vitest/notes/reference.test.ts 互补：
 * - 窄集合 isValidSourceDatabase 语义不变（'notes' 为 false）
 * - 新增宽集合 isExtendedSourceDatabase
 * - isValidPreviewType 与 PreviewType 联合同源（'epub' 漂移修复）
 */

import { describe, expect, it } from 'vitest';
import {
  SOURCE_DATABASES,
  EXTENDED_SOURCE_DATABASES,
  PREVIEW_TYPES,
  isValidSourceDatabase,
  isExtendedSourceDatabase,
  isValidPreviewType,
  type SourceDatabase,
  type ExtendedSourceDatabase,
} from '../types/reference';

describe('SourceDatabase 窄/宽集合', () => {
  it('窄集合语义不变（合同锁定）', () => {
    expect(isValidSourceDatabase('textbooks')).toBe(true);
    expect(isValidSourceDatabase('chat_v2')).toBe(true);
    expect(isValidSourceDatabase('exam_sessions')).toBe(true);
    // 'notes' 在引用节点 UI 支持面之外
    expect(isValidSourceDatabase('notes')).toBe(false);
    expect(isValidSourceDatabase(null)).toBe(false);
  });

  it('宽集合覆盖 DSTU 全量支持面', () => {
    (
      [
        'notes',
        'textbooks',
        'chat_v2',
        'exam_sessions',
        'translations',
        'essays',
        'attachments',
        'mindmaps',
      ] as const
    ).forEach((db) => {
      expect(isExtendedSourceDatabase(db)).toBe(true);
    });
    expect(isExtendedSourceDatabase('mistakes')).toBe(false);
    expect(isExtendedSourceDatabase(undefined)).toBe(false);
  });

  it('窄集合是宽集合的子集', () => {
    SOURCE_DATABASES.forEach((db) => {
      expect((EXTENDED_SOURCE_DATABASES as readonly string[]).includes(db)).toBe(true);
      // 类型层面：SourceDatabase 可赋给 ExtendedSourceDatabase
      const widened: ExtendedSourceDatabase = db as SourceDatabase;
      expect(widened).toBe(db);
    });
  });
});

describe('PreviewType 守卫与联合同源', () => {
  it('守卫接受联合中的每个成员（含此前漏掉的 epub）', () => {
    PREVIEW_TYPES.forEach((pt) => {
      expect(isValidPreviewType(pt)).toBe(true);
    });
    expect(isValidPreviewType('epub')).toBe(true);
  });

  it('拒绝已废弃与非法值', () => {
    expect(isValidPreviewType('card')).toBe(false);
    expect(isValidPreviewType('doc')).toBe(false);
    expect(isValidPreviewType('')).toBe(false);
    expect(isValidPreviewType(null)).toBe(false);
  });
});
