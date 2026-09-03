/**
 * 「保存为笔记」共享落点的行为契约。
 *
 * 第 3 轮收口：两步 create+move 模型已删除，folderId + tags 随 dstu_create
 * 一次提交（metadata.folderId）。这里锁住新判据：
 * 1. 标题从正文推导，不再堆「未命名」
 * 2. folderId 进 createNote 调用本身，moveItem 不复存在
 * 3. 目标目录创建失败且未落盘 → 整体 ok:false
 * 4. 后端兼容形态静默落根 → ok:true 但 landed:'root'，toast 明示实际位置
 * 5. 成功 toast 带「打开笔记」，点了走既有 DSTU_OPEN_NOTE 契约
 *
 * 第 7 轮追加（本轮只写不跑，未在本地执行）：把 landed folder/root 的 toast
 * 文案分叉与「创建失败 → ok:false」再从 saveTextAsNoteAndNotify 端到端路径锁
 * 一遍——单元层断言（notifySaveTextAsNoteResult）挡不住组合函数把 landed 或
 * error 传丢的回归。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: string | Record<string, unknown>) => {
      if (typeof options === 'string') return options;
      const fallback = typeof options?.defaultValue === 'string' ? options.defaultValue : key;
      // 测试桩只做 {{title}} 插值，够断言 toast 文案
      return typeof options?.title === 'string'
        ? fallback.replace('{{title}}', options.title)
        : fallback;
    },
  },
}));

const createNote = vi.fn();
const getFolderItems = vi.fn();
const showGlobalNotification = vi.fn();

vi.mock('@/dstu', () => ({
  folderApi: {
    getFolderItems: (...args: unknown[]) => getFolderItems(...args),
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

import { DSTU_FOLDER_CHANGE_EVENT } from '@/dstu/folderEvents';
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

/** 收集一次调用期间 window 上的目录变更事件（emitDstuFolderChange 未被 mock，走真实派发） */
async function collectFolderChangeEvents<T>(run: () => Promise<T>): Promise<{ result: T; events: CustomEvent[] }> {
  const events: CustomEvent[] = [];
  const listener = (e: Event) => events.push(e as CustomEvent);
  window.addEventListener(DSTU_FOLDER_CHANGE_EVENT, listener);
  try {
    const result = await run();
    return { result, events };
  } finally {
    window.removeEventListener(DSTU_FOLDER_CHANGE_EVENT, listener);
  }
}

beforeEach(() => {
  createNote.mockReset();
  getFolderItems.mockReset();
  showGlobalNotification.mockReset();
  createNote.mockResolvedValue(ok({ id: 'note-1' }));
  // 缺省场景：回查确认笔记确实在目标目录里
  getFolderItems.mockResolvedValue(ok([{ itemId: 'note-1', itemType: 'note', folderId: 'folder-9' }]));
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

  it('commits folderId and tags in the single create call and confirms landed:folder', async () => {
    const result = await saveTextAsNote({
      content: '相对论要点\n第二行',
      folderId: 'folder-9',
      tags: ['物理'],
    });

    // folderId 直接进 createNote（→ metadata.folderId），没有第二步 moveItem
    expect(createNote).toHaveBeenCalledWith('相对论要点', '相对论要点\n第二行', ['物理'], 'folder-9');
    expect(getFolderItems).toHaveBeenCalledWith('folder-9');
    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '相对论要点', landed: 'folder' });
  });

  it('keeps an explicit title over the derived one', async () => {
    await saveTextAsNote({ content: '正文首行', title: '  自定标题 ', folderId: null });
    expect(createNote).toHaveBeenCalledWith('自定标题', '正文首行', [], null);
  });

  it('reports landed:root without a placement check when the target is the library root', async () => {
    const result = await saveTextAsNote({ content: '正文', folderId: null });
    expect(getFolderItems).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '正文', landed: 'root' });
  });

  // 第 3 轮改判：原「移动失败仍 ok:true」已废弃，moveItem 未执行——两步模型删除后
  // 目录归属随 dstu_create 单事务提交，目标目录不可用 = 后端整体回滚（未落盘），
  // 必须是 ok:false，而不是「已保存但去目录里找不到」。
  it('fails as a whole when the backend rejects the create because the folder is unavailable', async () => {
    createNote.mockResolvedValue(err('目录不存在'));

    const result = await saveTextAsNote({ content: '正文', folderId: 'folder-x' });

    expect(result).toEqual({ ok: false, error: '目录不存在' });
    expect(getFolderItems).not.toHaveBeenCalled();
  });

  it('reports landed:root when a compat backend silently drops the note at the root', async () => {
    // 兼容形态：创建成功，但回查目标目录里没有这条笔记
    getFolderItems.mockResolvedValue(ok([{ itemId: 'note-other', itemType: 'note', folderId: 'folder-9' }]));

    const result = await saveTextAsNote({ content: '正文', folderId: 'folder-9' });

    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '正文', landed: 'root' });
  });

  it('reports landed:root when the placement check itself fails (never over-claims the folder)', async () => {
    getFolderItems.mockResolvedValue(err('查询失败'));

    const result = await saveTextAsNote({ content: '正文', folderId: 'folder-9' });

    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '正文', landed: 'root' });
  });

  it('emits a folder-change event only when the note is confirmed inside the folder', async () => {
    const confirmed = await collectFolderChangeEvents(() =>
      saveTextAsNote({ content: '正文', folderId: 'folder-9' }),
    );
    expect(confirmed.events).toHaveLength(1);
    expect(confirmed.events[0].detail).toEqual({
      kind: 'item-added',
      folderId: 'folder-9',
      itemId: 'note-1',
      itemType: 'note',
    });

    // 落根（无论意图还是降级）不补发：根目录列表由 DSTU watch 流覆盖
    getFolderItems.mockResolvedValue(ok([]));
    const degraded = await collectFolderChangeEvents(() =>
      saveTextAsNote({ content: '正文', folderId: 'folder-9' }),
    );
    expect(degraded.events).toHaveLength(0);
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
  it('says the note is in the chosen folder only when landed:folder', () => {
    notifySaveTextAsNoteResult({ ok: true, noteId: 'note-1', title: '相对论要点', landed: 'folder' });

    const [level, message] = showGlobalNotification.mock.calls[0];
    expect(level).toBe('success');
    expect(message).toBe('「相对论要点」已保存到所选目录');
  });

  it('states the actual root location when landed:root instead of claiming the chosen folder', () => {
    notifySaveTextAsNoteResult({ ok: true, noteId: 'note-1', title: '相对论要点', landed: 'root' });

    const [level, message] = showGlobalNotification.mock.calls[0];
    expect(level).toBe('success');
    expect(message).toBe('「相对论要点」已保存到资源库根目录');
    expect(message).not.toContain('所选目录');
  });

  it('offers an "open note" action that dispatches DSTU_OPEN_NOTE', () => {
    notifySaveTextAsNoteResult(
      { ok: true, noteId: 'note-1', title: '相对论要点', landed: 'folder' },
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
      { content: '正文', folderId: 'folder-9' },
      { openSource: 'chat-selection' },
    );
    expect(result.ok).toBe(true);
    expect(showGlobalNotification).toHaveBeenCalledTimes(1);
  });

  // ---- 第 7 轮追加：toast 文案分叉必须由实际落点（landed）驱动，端到端锁一遍 ----

  it('toasts the folder wording end-to-end when the note is confirmed in the chosen folder', async () => {
    const result = await saveTextAsNoteAndNotify({ content: '相对论要点', folderId: 'folder-9' });

    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '相对论要点', landed: 'folder' });
    const [level, message] = showGlobalNotification.mock.calls[0];
    expect(level).toBe('success');
    expect(message).toBe('「相对论要点」已保存到所选目录');
  });

  it('toasts the root wording end-to-end when a compat backend drops the note at the root', async () => {
    // 意图落 folder-9，但回查发现笔记不在目录里 → landed:'root'，文案不得谎称所选目录
    getFolderItems.mockResolvedValue(ok([{ itemId: 'note-other', itemType: 'note', folderId: 'folder-9' }]));

    const result = await saveTextAsNoteAndNotify({ content: '相对论要点', folderId: 'folder-9' });

    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '相对论要点', landed: 'root' });
    const [level, message] = showGlobalNotification.mock.calls[0];
    expect(level).toBe('success');
    expect(message).toBe('「相对论要点」已保存到资源库根目录');
    expect(message).not.toContain('所选目录');
  });

  it('returns ok:false and toasts an error (not success) when the create itself fails', async () => {
    createNote.mockResolvedValue(err('目录不存在'));

    const result = await saveTextAsNoteAndNotify({ content: '正文', folderId: 'folder-x' });

    expect(result).toEqual({ ok: false, error: '目录不存在' });
    expect(showGlobalNotification).toHaveBeenCalledTimes(1);
    const [level, message] = showGlobalNotification.mock.calls[0];
    expect(level).toBe('error');
    expect(message).toBe('目录不存在');
  });
});
