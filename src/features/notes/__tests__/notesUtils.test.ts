/**
 * notesUtils 单测
 *
 * 覆盖 NotesHeader / 侧栏依赖的 getPathToNote 健壮性，
 * 以及 normalizeContentForEditor 对畸形 JSON 的容错。
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
}));

import { getPathToNote, normalizeContentForEditor, sortTreeChildren } from '../notesUtils';
import type { TreeData } from '../DndFileTree';
import type { NoteItem } from '../../../utils/notesApi';

const note = (id: string, title: string): NoteItem =>
  ({ id, title } as unknown as NoteItem);

describe('getPathToNote', () => {
  const folders = {
    fld_a: { title: 'A', children: ['fld_b'] },
    fld_b: { title: 'B', children: ['note_1'] },
  };

  it('返回从根到笔记的完整路径', () => {
    const path = getPathToNote('note_1', folders, [note('note_1', 'Hello')]);
    expect(path.map((p) => p.id)).toEqual(['fld_a', 'fld_b', 'note_1']);
    expect(path[2]).toEqual({ id: 'note_1', title: 'Hello', type: 'note' });
  });

  it('支持文件夹 ID 入参', () => {
    const path = getPathToNote('fld_b', folders, []);
    expect(path.map((p) => p.id)).toEqual(['fld_a', 'fld_b']);
    expect(path.every((p) => p.type === 'folder')).toBe(true);
  });

  it('未找到节点时返回空数组', () => {
    expect(getPathToNote('note_missing', folders, [])).toEqual([]);
  });

  it('空白标题回退到未命名文案', () => {
    const path = getPathToNote('note_1', folders, [note('note_1', '   ')]);
    expect(path[2].title).toBe('notes:common.untitled');
  });

  it('环状文件夹引用不死循环、不产生重复段', () => {
    const cyclic = {
      fld_x: { title: 'X', children: ['fld_y'] },
      fld_y: { title: 'Y', children: ['fld_x', 'note_1'] },
    };
    const path = getPathToNote('note_1', cyclic, [note('note_1', 'N')]);
    const ids = path.map((p) => p.id);
    // 无重复段
    expect(new Set(ids).size).toBe(ids.length);
    // 笔记自身必然在末位
    expect(ids[ids.length - 1]).toBe('note_1');
  });

  it('children 缺失的坏数据不抛异常', () => {
    const broken = {
      fld_a: { title: 'A' } as unknown as { title: string; children: string[] },
    };
    expect(() => getPathToNote('note_1', broken, [note('note_1', 'N')])).not.toThrow();
  });
});

describe('normalizeContentForEditor', () => {
  it('普通 markdown 原样返回（trim）', () => {
    expect(normalizeContentForEditor('  # Title  ')).toBe('# Title');
  });

  it('空输入返回空字符串', () => {
    expect(normalizeContentForEditor(null)).toBe('');
    expect(normalizeContentForEditor(undefined)).toBe('');
    expect(normalizeContentForEditor('   ')).toBe('');
  });

  it('从 ProseMirror JSON 中抽取文本', () => {
    const doc = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
    });
    expect(normalizeContentForEditor(doc)).toBe('Hello');
  });

  it('JSON 中包含 null 节点时不中断抽取', () => {
    const doc = JSON.stringify({
      type: 'doc',
      content: [null, { type: 'text', text: 'Alive' }, 42],
    });
    expect(normalizeContentForEditor(doc)).toBe('Alive');
  });

  it('无法解析的 JSON 前缀内容原样返回', () => {
    expect(normalizeContentForEditor('{not-json')).toBe('{not-json');
  });
});

describe('sortTreeChildren', () => {
  const items: TreeData = {
    fld_1: { id: 'fld_1', title: 'Zeta', isFolder: true, children: [], data: {} },
    note_a: {
      id: 'note_a',
      title: 'Alpha',
      isFolder: false,
      children: [],
      data: { note: { updated_at: 200, created_at: 10 } },
    },
    note_b: {
      id: 'note_b',
      title: 'Beta',
      isFolder: false,
      children: [],
      data: { note: { updated_at: 100, created_at: 20 } },
    },
  } as unknown as TreeData;

  it('文件夹永远排在笔记前', () => {
    expect(sortTreeChildren(['note_a', 'fld_1'], items, 'name_asc')).toEqual([
      'fld_1',
      'note_a',
    ]);
  });

  it('按名称与修改时间排序', () => {
    expect(sortTreeChildren(['note_b', 'note_a'], items, 'name_asc')).toEqual([
      'note_a',
      'note_b',
    ]);
    expect(sortTreeChildren(['note_b', 'note_a'], items, 'modified_desc')).toEqual([
      'note_a',
      'note_b',
    ]);
  });

  it('不修改入参数组', () => {
    const input = ['note_b', 'note_a'];
    sortTreeChildren(input, items, 'name_asc');
    expect(input).toEqual(['note_b', 'note_a']);
  });

  it('缺失节点视为相等且不抛异常', () => {
    expect(() => sortTreeChildren(['ghost', 'note_a'], items, 'name_asc')).not.toThrow();
  });
});
