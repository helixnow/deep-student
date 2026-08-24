/**
 * DSTU node.type → FolderItemType 共用映射测试
 *
 * 背景（P0）：LearningHubSidebar 曾在五处手写 switch，右键菜单分支漏掉
 * image/file 导致附件右键动作按 note 处理。现统一走 mapDstuTypeToFolderItemType，
 * 本测试锁死映射表与兜底行为，防止再次漂移。
 */
import { describe, expect, it } from 'vitest';
import type { DstuNodeType } from '@/dstu/types';
import type { FolderItemType } from '@/dstu/types/folder';
import {
  mapDstuTypeToFolderItemType,
  nodeTypeToFolderItemType,
} from '../types';

describe('mapDstuTypeToFolderItemType', () => {
  it.each<[DstuNodeType, FolderItemType]>([
    ['note', 'note'],
    ['textbook', 'textbook'],
    ['exam', 'exam'],
    ['translation', 'translation'],
    ['essay', 'essay'],
    ['mindmap', 'mindmap'],
    // ★ 历史 bug：右键菜单 switch 漏掉这两个，附件被当成 note 处理
    ['image', 'image'],
    ['file', 'file'],
  ])('%s → %s', (nodeType, expected) => {
    expect(mapDstuTypeToFolderItemType(nodeType)).toBe(expected);
  });

  it('不支持的类型（folder / retrieval）兜底为 note', () => {
    expect(mapDstuTypeToFolderItemType('folder')).toBe('note');
    expect(mapDstuTypeToFolderItemType('retrieval')).toBe('note');
  });

  it('nodeTypeToFolderItemType 对不支持类型返回 null（供调用方区分）', () => {
    expect(nodeTypeToFolderItemType('folder')).toBeNull();
    expect(nodeTypeToFolderItemType('retrieval')).toBeNull();
    expect(nodeTypeToFolderItemType('image')).toBe('image');
    expect(nodeTypeToFolderItemType('file')).toBe('file');
  });
});
