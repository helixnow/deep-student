/**
 * 「保存为笔记」落点契约。
 *
 * 改造前笔记只能落在资源库根目录、toast 也点不开笔记。这里锁定：
 * 1. 选了目录就要真的落进那个目录（folderApi.moveItem）
 * 2. 成功 toast 必须带「打开笔记」动作，点了派发既有 DSTU_OPEN_NOTE
 * 3. 建笔记成功但移动失败时不吞掉笔记（宁可落在根目录也不报整体失败）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createNote = vi.fn();
const moveItem = vi.fn();
const showGlobalNotification = vi.fn();

vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  notesDstuAdapter: { createNote: (...args: unknown[]) => createNote(...args) },
}));

vi.mock('@/dstu', () => ({
  folderApi: { moveItem: (...args: unknown[]) => moveItem(...args) },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => showGlobalNotification(...args),
}));

import {
  deriveNoteTitle,
  saveTextAsNote,
  saveTextAsNoteAndNotify,
} from '../saveTextAsNote';

describe('deriveNoteTitle', () => {
  it('takes the first non-empty line and strips markdown heading marks', () => {
    expect(deriveNoteTitle('\n\n## 三角函数复习\n\n正文…')).toBe('三角函数复习');
  });

  it('truncates very long first lines', () => {
    const title = deriveNoteTitle('x'.repeat(120));
    expect(title.length).toBeLessThanOrEqual(51);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('saveTextAsNote', () => {
  beforeEach(() => {
    createNote.mockReset();
    moveItem.mockReset();
    showGlobalNotification.mockReset();
    createNote.mockResolvedValue({ ok: true, value: { id: 'note-1' } });
    moveItem.mockResolvedValue({ ok: true, value: undefined });
  });

  it('moves the new note into the chosen folder', async () => {
    const result = await saveTextAsNote({ content: '选中的一段话', folderId: 'folder-7' });

    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '选中的一段话' });
    expect(moveItem).toHaveBeenCalledWith('note', 'note-1', 'folder-7');
  });

  it('skips the move when the user picked the library root', async () => {
    await saveTextAsNote({ content: '根目录笔记', folderId: null });
    expect(moveItem).not.toHaveBeenCalled();
  });

  it('rejects empty content before touching the backend', async () => {
    const result = await saveTextAsNote({ content: '   ', folderId: null });
    expect(result.ok).toBe(false);
    expect(createNote).not.toHaveBeenCalled();
  });

  it('keeps the note when only the folder move fails', async () => {
    moveItem.mockResolvedValue({ ok: false, error: { message: 'boom' } });
    const result = await saveTextAsNote({ content: '内容', folderId: 'folder-7' });
    expect(result.ok).toBe(true);
  });

  it('surfaces create failures', async () => {
    createNote.mockResolvedValue({ ok: false, error: { toUserMessage: () => '磁盘已满' } });
    const result = await saveTextAsNote({ content: '内容', folderId: null });
    expect(result).toEqual({ ok: false, error: '磁盘已满' });
  });
});

describe('saveTextAsNoteAndNotify', () => {
  beforeEach(() => {
    createNote.mockReset();
    moveItem.mockReset();
    showGlobalNotification.mockReset();
    createNote.mockResolvedValue({ ok: true, value: { id: 'note-42' } });
    moveItem.mockResolvedValue({ ok: true, value: undefined });
  });

  it('offers an "open note" toast action that dispatches DSTU_OPEN_NOTE', async () => {
    await saveTextAsNoteAndNotify(
      { content: '课堂笔记', folderId: 'folder-1' },
      { openSource: 'pdf-selection' },
    );

    expect(showGlobalNotification).toHaveBeenCalledTimes(1);
    const [type, , , options] = showGlobalNotification.mock.calls[0] as [
      string, unknown, unknown, { action?: { label: string; onClick: () => void } },
    ];
    expect(type).toBe('success');
    expect(options.action).toBeDefined();

    const opened: Array<Record<string, unknown>> = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener('DSTU_OPEN_NOTE', listener);
    options.action!.onClick();
    window.removeEventListener('DSTU_OPEN_NOTE', listener);

    expect(opened).toEqual([{ noteId: 'note-42', source: 'pdf-selection' }]);
  });

  it('reports failures without an open action', async () => {
    createNote.mockResolvedValue({ ok: false, error: { toUserMessage: () => '写入失败' } });
    await saveTextAsNoteAndNotify({ content: '课堂笔记', folderId: null });

    const [type, , , options] = showGlobalNotification.mock.calls[0] as [
      string, unknown, unknown, unknown,
    ];
    expect(type).toBe('error');
    expect(options).toBeUndefined();
  });
});
