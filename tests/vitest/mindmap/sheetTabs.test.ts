/**
 * 多 sheet 消费（切换器纯逻辑）测试：
 * - getAliveSheetTabs：meta.sheets 过滤存活 sheet，不足 2 个不显示；
 * - resolveActiveSheet：viewRootId 在 sheet 根 / 其子孙 / 全图时的归属判定。
 */
import { describe, expect, it } from 'vitest';

import { getAliveSheetTabs, resolveActiveSheet } from '@/features/mindmap/utils/sheetTabs';
import type { MindMapDocument } from '@/features/mindmap/types';

function multiSheetDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: 'Imported',
      children: [
        {
          id: 's1_root',
          text: 'Alpha',
          children: [{ id: 's1_child', text: 'A1', children: [] }],
        },
        { id: 's2_root', text: 'Beta', children: [] },
        { id: 'manual_node', text: 'Added later', children: [] },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      sheets: [
        { id: 'sheet1', title: 'Sheet One', rootNodeId: 's1_root' },
        { id: 'sheet2', title: 'Sheet Two', rootNodeId: 's2_root' },
      ],
    },
  };
}

describe('getAliveSheetTabs', () => {
  it('returns sheets whose root nodes are still top-level children', () => {
    const tabs = getAliveSheetTabs(multiSheetDoc());
    expect(tabs?.map((sheet) => sheet.id)).toEqual(['sheet1', 'sheet2']);
  });

  it('returns null without meta.sheets (single-sheet import untouched)', () => {
    const doc = multiSheetDoc();
    delete doc.meta.sheets;
    expect(getAliveSheetTabs(doc)).toBeNull();
  });

  it('hides the switcher when fewer than 2 sheets survive deletion', () => {
    const doc = multiSheetDoc();
    // 删除 sheet2 的根节点：只剩 1 个存活 sheet → 不显示
    doc.root.children = doc.root.children.filter((child) => child.id !== 's2_root');
    expect(getAliveSheetTabs(doc)).toBeNull();
  });

  it('drops only the dead sheet when 2+ survive', () => {
    const doc = multiSheetDoc();
    doc.meta.sheets?.push({ id: 'sheet3', title: 'Ghost', rootNodeId: 'gone' });
    const tabs = getAliveSheetTabs(doc);
    expect(tabs?.map((sheet) => sheet.id)).toEqual(['sheet1', 'sheet2']);
  });
});

describe('resolveActiveSheet', () => {
  const doc = multiSheetDoc();
  const tabs = getAliveSheetTabs(doc);

  it('returns null for whole-map view (viewRootId empty or document root)', () => {
    expect(resolveActiveSheet(doc, tabs, null)).toBeNull();
    expect(resolveActiveSheet(doc, tabs, 'root')).toBeNull();
  });

  it('matches when focused exactly on a sheet root', () => {
    expect(resolveActiveSheet(doc, tabs, 's2_root')?.id).toBe('sheet2');
  });

  it('matches when drilled into a descendant of a sheet root', () => {
    expect(resolveActiveSheet(doc, tabs, 's1_child')?.id).toBe('sheet1');
  });

  it('returns null when focused on a node outside all sheets', () => {
    expect(resolveActiveSheet(doc, tabs, 'manual_node')).toBeNull();
  });

  it('returns null when switcher itself is hidden', () => {
    expect(resolveActiveSheet(doc, null, 's1_root')).toBeNull();
  });
});
