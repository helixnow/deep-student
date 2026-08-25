/**
 * 「保存为笔记」共享落点的行为契约。
 *
 * 改造前各入口都是 createNote(title, text) 一把梭，用户既选不了目录、
 * 也点不开刚存的笔记。这里锁住新流程真的做到了：
 * 1. 标题从正文推导，不再堆「未命名」
 * 2. 目录由调用方指定，写入后 moveItem 到该目录
 * 3. 移动失败只降级告警，不把已经写好的笔记吞掉
 * 4. 成功 toast 带「打开笔记」，点了走既有 DSTU_OPEN_NOTE 契约
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: string | Record<string, unknown>) => {
      if (typeof options === 'string') return options;
      const fallback = options?.defaultValue;
      return typeof fallback === 'string' ? fallback : key;
    },
  },
}));

const createNote = vi.fn();
const moveItem = vi.fn();
const showGlobalNotification = vi.fn();

vi.mock('@/dstu', () => ({
  folderApi: {
    moveItem: (...args: unknown[]) => moveItem(...args),
  },
}));

vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  notesDstuAdapter: {
    createNote: (...args: unknown[]) => createNote(...args),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => showGlobalNotification(...args),
}));

import {
  deriveNoteTitle,
  saveTextAsNote,
  saveTextAsNoteAndNotify,
  notifySaveTextAsNoteResult,
  openSavedNote,
} from '../saveTextAsNote';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const err = (message: string) => ({
  ok: false as const,
  error: { message, toUserMessage: () => message },
});

beforeEach(() => {
  createNote.mockReset();
  moveItem.mockReset();
  showGlobalNotification.mockReset();
  createNote.mockResolvedValue(ok({ id: 'note-1' }));
  moveItem.mockResolvedValue(ok(undefined));
});

describe('deriveNoteTitle', () => {
  it('takes the first non-empty line', () => {
    expect(deriveNoteTitle('\n\n  海森堡不确定性原理  \n后面还有正文')).toBe('海森堡不确定性原理');
  });

  it('strips markdown heading and emphasis markers', () => {
    expect(deriveNoteTitle('## **重点** 摘录\n正文')).toBe('重点 摘录');
  });

  it('truncates overlong titles instead of dumping the whole paragraph', () => {
    const title = deriveNoteTitle('长'.repeat(120));
    expect(title.length).toBeLessThanOrEqual(51);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back when the content has no usable line', () => {
    expect(deriveNoteTitle('   \n\n', '兜底标题')).toBe('兜底标题');
  });
});

describe('saveTextAsNote', () => {
  it('rejects empty content without touching the adapter', async () => {
    const result = await saveTextAsNote({ content: '   \n ', folderId: null });
    expect(result.ok).toBe(false);
    expect(createNote).not.toHaveBeenCalled();
  });

  it('writes with the derived title and moves the note into the chosen folder', async () => {
    const result = await saveTextAsNote({
      content: '相对论要点\n第二行',
      folderId: 'folder-9',
      tags: ['物理'],
    });

    expect(createNote).toHaveBeenCalledWith('相对论要点', '相对论要点\n第二行', ['物理']);
    expect(moveItem).toHaveBeenCalledWith('note', 'note-1', 'folder-9');
    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '相对论要点' });
  });

  it('keeps an explicit title over the derived one', async () => {
    await saveTextAsNote({ content: '正文首行', title: '  自定标题 ', folderId: null });
    expect(createNote).toHaveBeenCalledWith('自定标题', '正文首行', []);
  });

  it('skips the move when the target is the library root', async () => {
    await saveTextAsNote({ content: '正文', folderId: null });
    expect(moveItem).not.toHaveBeenCalled();
  });

  it('still reports success when only the folder move fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    moveItem.mockResolvedValue(err('目录不存在'));

    const result = await saveTextAsNote({ content: '正文', folderId: 'folder-x' });

    // 笔记已经写进去了，吞掉它比落在根目录更糟
    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '正文' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('surfaces the adapter error message when the write fails', async () => {
    createNote.mockResolvedValue(err('磁盘写入失败'));
    const result = await saveTextAsNote({ content: '正文', folderId: null });
    expect(result).toEqual({ ok: false, error: '磁盘写入失败' });
  });

  it('turns a thrown error into a failed result rather than rejecting', async () => {
    createNote.mockRejectedValue(new Error('boom'));
    const result = await saveTextAsNote({ content: '正文', folderId: null });
    expect(result.ok).toBe(false);
  });
});

describe('notifySaveTextAsNoteResult', () => {
  it('offers an "open note" action that dispatches DSTU_OPEN_NOTE', () => {
    notifySaveTextAsNoteResult(
      { ok: true, noteId: 'note-1', title: '相对论要点' },
      { openSource: 'pdf-selection' },
    );

    const [level, , , options] = showGlobalNotification.mock.calls[0];
    expect(level).toBe('success');

    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('DSTU_OPEN_NOTE', listener);
    (options as { action: { onClick: () => void } }).action.onClick();
    window.removeEventListener('DSTU_OPEN_NOTE', listener);

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ noteId: 'note-1', source: 'pdf-selection' });
  });

  it('reports failures as an error toast without an open action', () => {
    notifySaveTextAsNoteResult({ ok: false, error: '写入失败' });
    const [level, message, , options] = showGlobalNotification.mock.calls[0];
    expect(level).toBe('error');
    expect(message).toBe('写入失败');
    expect(options).toBeUndefined();
  });
});

describe('openSavedNote', () => {
  it('defaults to the save-as-note source', () => {
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('DSTU_OPEN_NOTE', listener);
    openSavedNote('note-42');
    window.removeEventListener('DSTU_OPEN_NOTE', listener);
    expect(events[0].detail).toEqual({ noteId: 'note-42', source: 'save-as-note' });
  });
});

describe('saveTextAsNoteAndNotify', () => {
  it('writes and then notifies in one step', async () => {
    const result = await saveTextAsNoteAndNotify(
      { content: '正文', folderId: 'folder-1' },
      { openSource: 'chat-selection' },
    );
    expect(result.ok).toBe(true);
    expect(showGlobalNotification).toHaveBeenCalledTimes(1);
  });
});
