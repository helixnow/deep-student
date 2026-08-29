/**
 * Finder 剪贴板（复制 / 粘贴 / 制造副本）纯逻辑测试
 *
 * 覆盖：路径构造契约（src 一律 /{id}、dst /{folderId} 或根 '/'）、
 * 不可复制类型过滤、剪贴板状态机（copy/get/clear/subscribe、空数组 no-op）。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildCopySrcPath,
  buildPasteDstPath,
  createFinderClipboard,
  isCopyableNode,
  toClipboardEntries,
} from '../finderClipboard';

describe('buildCopySrcPath / buildPasteDstPath', () => {
  it('src 一律 /{id}（与移动/改名后的 stale path 无关）', () => {
    expect(buildCopySrcPath({ id: 'note_123' })).toBe('/note_123');
    expect(buildCopySrcPath({ id: 'fld_abc' })).toBe('/fld_abc');
  });

  it('dst 为 /{folderId}，根目录为 /', () => {
    expect(buildPasteDstPath('fld_target')).toBe('/fld_target');
    expect(buildPasteDstPath(null)).toBe('/');
  });
});

describe('toClipboardEntries / isCopyableNode', () => {
  it('过滤 retrieval（后端 dstu_copy 不支持），保留 folder / 常规资源', () => {
    const entries = toClipboardEntries([
      { id: 'note_1', name: '笔记', type: 'note' },
      { id: 'res_1', name: '检索节点', type: 'retrieval' },
      { id: 'fld_1', name: '文件夹', type: 'folder' },
      { id: 'file_1', name: '附件.pdf', type: 'file' },
    ]);
    expect(entries.map((e) => e.id)).toEqual(['note_1', 'fld_1', 'file_1']);
    expect(isCopyableNode({ type: 'retrieval' })).toBe(false);
    expect(isCopyableNode({ type: 'folder' })).toBe(true);
    expect(isCopyableNode({ type: 'image' })).toBe(true);
  });

  it('只保留粘贴所需最小字段（id/name/type）', () => {
    const [entry] = toClipboardEntries([
      { id: 'note_1', name: 'n', type: 'note', path: '/x', size: 42 } as never,
    ]);
    expect(entry).toEqual({ id: 'note_1', name: 'n', type: 'note' });
  });
});

describe('createFinderClipboard 状态机', () => {
  it('copy 后 get 返回条目与时间戳；clear 清空并通知', () => {
    const clipboard = createFinderClipboard();
    expect(clipboard.get()).toBeNull();

    const listener = vi.fn();
    const unsubscribe = clipboard.subscribe(listener);

    clipboard.copy([{ id: 'note_1', name: 'n', type: 'note' }]);
    expect(listener).toHaveBeenCalledTimes(1);
    const state = clipboard.get();
    expect(state?.entries).toEqual([{ id: 'note_1', name: 'n', type: 'note' }]);
    expect(typeof state?.copiedAt).toBe('number');

    clipboard.clear();
    expect(clipboard.get()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    clipboard.copy([{ id: 'note_2', name: 'm', type: 'note' }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('空数组 copy 为 no-op（保留原内容不通知）；空剪贴板 clear 不通知', () => {
    const clipboard = createFinderClipboard();
    const listener = vi.fn();
    clipboard.subscribe(listener);

    clipboard.clear();
    expect(listener).not.toHaveBeenCalled();

    clipboard.copy([{ id: 'note_1', name: 'n', type: 'note' }]);
    clipboard.copy([]);
    expect(clipboard.get()?.entries.map((e) => e.id)).toEqual(['note_1']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('二次 copy 整体替换（非追加），与访达剪贴板语义一致', () => {
    const clipboard = createFinderClipboard();
    clipboard.copy([{ id: 'a', name: 'a', type: 'note' }]);
    clipboard.copy([
      { id: 'b', name: 'b', type: 'file' },
      { id: 'c', name: 'c', type: 'folder' },
    ]);
    expect(clipboard.get()?.entries.map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('copy 对入参做快照，外部数组后续变更不影响剪贴板', () => {
    const clipboard = createFinderClipboard();
    const source = [{ id: 'a', name: 'a', type: 'note' as const }];
    clipboard.copy(source);
    source.pop();
    expect(clipboard.get()?.entries).toHaveLength(1);
  });
});
