/**
 * 「追加到已有笔记」共享落点的行为契约。
 *
 * 锁住：
 * 1. 正文拼接：既有内容 + `\n\n---\n\n` + 追加段；空笔记不加分隔线；首尾空白收敛
 * 2. 来源：调用方正文里的来源行（pdfref:// 等）原样保留；聊天来源补一行引用式来源；
 *    目标笔记 props._origin 绝不改写（不调 setMetadata / attachNoteOrigin）
 * 3. 并发：带 updatedAt 乐观锁基线写入；CONFLICT 时重读重试；打开且有未保存修改的
 *    编辑器先冲刷，冲刷失败则放弃追加
 * 4. 编辑器同步：经 dstu_update 写入（后端成功后广播 dstu:change updated，
 *    NoteContentView 据此刷新）——不旁路 canvas_note_append 等不发 watch 事件的命令
 * 5. 成功 toast 带「打开笔记」，点了走 DSTU_OPEN_NOTE 契约
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: string | Record<string, unknown>) => {
      if (typeof options === 'string') return options;
      const fallback = typeof options?.defaultValue === 'string' ? options.defaultValue : key;
      return typeof options?.title === 'string'
        ? fallback.replace('{{title}}', options.title)
        : fallback;
    },
  },
}));

const dstuGet = vi.fn();
const dstuGetContent = vi.fn();
const dstuUpdate = vi.fn();
const dstuSetMetadata = vi.fn();
const invoke = vi.fn();
const showGlobalNotification = vi.fn();
const isContentDirty = vi.fn();
const saveContentNow = vi.fn();

vi.mock('@/dstu', () => ({
  dstu: {
    get: (...args: unknown[]) => dstuGet(...args),
    getContent: (...args: unknown[]) => dstuGetContent(...args),
    update: (...args: unknown[]) => dstuUpdate(...args),
    setMetadata: (...args: unknown[]) => dstuSetMetadata(...args),
  },
  folderApi: { getFolderItems: vi.fn() },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  notesDstuAdapter: { createNote: vi.fn() },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => showGlobalNotification(...args),
}));

vi.mock('@/features/workbench/apps/content/contentDirtyRegistry', () => ({
  isContentDirty: (...args: unknown[]) => isContentDirty(...args),
  saveContentNow: (...args: unknown[]) => saveContentNow(...args),
}));

import { VfsErrorCode } from '@/shared/result';
import {
  NOTE_APPEND_SEPARATOR,
  joinAppendedNoteContent,
  composeAppendSection,
  appendTextToNote,
  appendTextToNoteAndNotify,
} from '../appendTextToNote';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const err = (message: string, code: VfsErrorCode = VfsErrorCode.UNKNOWN) => ({
  ok: false as const,
  error: { message, code, toUserMessage: () => message },
});

const ORIGIN_PROPS = { _origin: '{"kind":"resource","resourceId":"tb_1","page":3}' };
const noteNode = (updatedAt: number, name = '函数专题') => ({
  id: 'note-1',
  path: '/高考复习/note-1',
  name,
  type: 'note',
  createdAt: 1,
  updatedAt,
  metadata: { props: ORIGIN_PROPS },
});

beforeEach(() => {
  dstuGet.mockReset();
  dstuGetContent.mockReset();
  dstuUpdate.mockReset();
  dstuSetMetadata.mockReset();
  invoke.mockReset();
  showGlobalNotification.mockReset();
  isContentDirty.mockReset();
  saveContentNow.mockReset();
  isContentDirty.mockReturnValue(false);
  dstuGet.mockResolvedValue(ok(noteNode(1000)));
  dstuGetContent.mockResolvedValue(ok('# 函数专题\n\n已有内容\n\n'));
  dstuUpdate.mockImplementation(async (_path: string, content: string) =>
    ok({ ...noteNode(2000), content }),
  );
});

describe('joinAppendedNoteContent', () => {
  it('joins with a thematic-break separator after trimming trailing whitespace', () => {
    expect(joinAppendedNoteContent('# 标题\n\n已有内容\n\n\n', '新段落\n')).toBe(
      `# 标题\n\n已有内容${NOTE_APPEND_SEPARATOR}新段落`,
    );
    expect(NOTE_APPEND_SEPARATOR).toBe('\n\n---\n\n');
  });

  it('does not add a separator into an empty note', () => {
    expect(joinAppendedNoteContent('  \n\n', '\n\n第一段')).toBe('第一段');
  });

  it('keeps leading indentation of the appended block (code blocks)', () => {
    expect(joinAppendedNoteContent('a', '\n    indented code')).toBe(`a${NOTE_APPEND_SEPARATOR}    indented code`);
  });
});

describe('composeAppendSection', () => {
  it('keeps a caller-built source line (pdfref) untouched for resource origins', () => {
    const content = '> [《线代》第 3 页](pdfref://tb_1?page=3)\n\n摘录正文';
    expect(composeAppendSection(content, { kind: 'resource', resourceId: 'tb_1', page: 3 })).toBe(content);
  });

  it('adds a quoted chat source line because the target note origin stays untouched', () => {
    expect(composeAppendSection('回答正文', { kind: 'chat', sessionId: 's1', title: '导数\n复习' })).toBe(
      '> 来自对话「导数 复习」\n\n回答正文',
    );
    expect(composeAppendSection('回答正文', { kind: 'chat', sessionId: 's1' })).toBe('> 来自对话\n\n回答正文');
  });
});

describe('appendTextToNote', () => {
  it('appends to the end via dstu_update with the optimistic-lock baseline', async () => {
    const result = await appendTextToNote({
      noteId: 'note-1',
      content: '> [第 3 页](pdfref://tb_1?page=3)\n\n新摘录',
      origin: { kind: 'resource', resourceId: 'tb_2', page: 9 },
    });

    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '函数专题' });
    expect(dstuGet).toHaveBeenCalledWith('/note-1');
    expect(dstuGetContent).toHaveBeenCalledWith('/note-1');
    expect(dstuUpdate).toHaveBeenCalledTimes(1);
    expect(dstuUpdate).toHaveBeenCalledWith(
      '/note-1',
      '# 函数专题\n\n已有内容\n\n---\n\n> [第 3 页](pdfref://tb_1?page=3)\n\n新摘录',
      'note',
      { expectedUpdatedAtMs: 1000 },
    );
  });

  it('never rewrites the target note origin (no metadata write, no legacy append command)', async () => {
    await appendTextToNote({
      noteId: 'note-1',
      content: '回答正文',
      origin: { kind: 'chat', sessionId: 'session-9', messageId: 'm1', title: '对话' },
    });
    expect(dstuSetMetadata).not.toHaveBeenCalled();
    // canvas_note_append 不广播 DSTU watch 事件，已打开的编辑器收不到刷新
    expect(invoke).not.toHaveBeenCalled();
    const written = dstuUpdate.mock.calls[0][1] as string;
    expect(written.endsWith('---\n\n> 来自对话「对话」\n\n回答正文')).toBe(true);
  });

  it('re-reads and retries on an optimistic-lock conflict instead of overwriting', async () => {
    dstuGet
      .mockResolvedValueOnce(ok(noteNode(1000)))
      .mockResolvedValueOnce(ok(noteNode(1500)));
    dstuGetContent
      .mockResolvedValueOnce(ok('旧版本'))
      .mockResolvedValueOnce(ok('旧版本\n\n别处刚写的'));
    dstuUpdate
      .mockResolvedValueOnce(err('CONFLICT(notes.conflict)', VfsErrorCode.CONFLICT))
      .mockImplementationOnce(async (_p: string, content: string) => ok({ ...noteNode(2000), content }));

    const result = await appendTextToNote({ noteId: 'note-1', content: '追加段' });

    expect(result.ok).toBe(true);
    expect(dstuUpdate).toHaveBeenCalledTimes(2);
    expect(dstuUpdate.mock.calls[1]).toEqual([
      '/note-1',
      `旧版本\n\n别处刚写的${NOTE_APPEND_SEPARATOR}追加段`,
      'note',
      { expectedUpdatedAtMs: 1500 },
    ]);
  });

  it('gives up after repeated conflicts and reports the error', async () => {
    dstuUpdate.mockResolvedValue(err('conflict', VfsErrorCode.CONFLICT));
    const result = await appendTextToNote({ noteId: 'note-1', content: '追加段' });
    expect(result).toEqual({ ok: false, error: 'conflict' });
    expect(dstuUpdate).toHaveBeenCalledTimes(3);
  });

  it('flushes an open dirty editor before reading the baseline', async () => {
    let dirty = true;
    isContentDirty.mockImplementation(() => dirty);
    saveContentNow.mockImplementation(async () => {
      dirty = false;
      return true;
    });

    const result = await appendTextToNote({ noteId: 'note-1', content: '追加段' });

    expect(result.ok).toBe(true);
    expect(saveContentNow).toHaveBeenCalledWith('note', 'note-1');
    expect(saveContentNow.mock.invocationCallOrder[0]).toBeLessThan(dstuGet.mock.invocationCallOrder[0]);
  });

  it('aborts without writing when the open editor cannot be flushed', async () => {
    isContentDirty.mockReturnValue(true);
    saveContentNow.mockResolvedValue(false);

    const result = await appendTextToNote({ noteId: 'note-1', content: '追加段' });

    expect(result).toEqual({ ok: false, error: '这篇笔记有未保存的修改，请先保存后再追加' });
    expect(dstuUpdate).not.toHaveBeenCalled();
  });

  it('rejects empty content and missing notes without writing', async () => {
    expect((await appendTextToNote({ noteId: 'note-1', content: '  \n' })).ok).toBe(false);
    dstuGet.mockResolvedValueOnce(ok(null));
    expect(await appendTextToNote({ noteId: 'note-1', content: '追加段' })).toEqual({
      ok: false,
      error: '笔记不存在或已被删除',
    });
    expect(dstuUpdate).not.toHaveBeenCalled();
  });
});

describe('appendTextToNoteAndNotify', () => {
  it('shows a success toast whose action opens the note via DSTU_OPEN_NOTE', async () => {
    const opened: CustomEvent[] = [];
    const listener = (e: Event) => opened.push(e as CustomEvent);
    window.addEventListener('DSTU_OPEN_NOTE', listener);
    try {
      await appendTextToNoteAndNotify({ noteId: 'note-1', content: '追加段' }, { openSource: 'chat-message' });
      expect(showGlobalNotification).toHaveBeenCalledTimes(1);
      const [kind, message, , options] = showGlobalNotification.mock.calls[0];
      expect(kind).toBe('success');
      expect(message).toBe('已追加到「函数专题」');
      expect(options.action.label).toBe('打开笔记');
      options.action.onClick();
      expect(opened).toHaveLength(1);
      expect(opened[0].detail).toEqual({ noteId: 'note-1', source: 'chat-message' });
    } finally {
      window.removeEventListener('DSTU_OPEN_NOTE', listener);
    }
  });

  it('shows an error toast on failure', async () => {
    dstuUpdate.mockResolvedValue(err('磁盘已满'));
    const result = await appendTextToNoteAndNotify({ noteId: 'note-1', content: '追加段' });
    expect(result.ok).toBe(false);
    expect(showGlobalNotification).toHaveBeenCalledWith('error', '磁盘已满', '追加到笔记失败');
  });
});

describe('composeAppendSection title heading', () => {
  it('adds a heading from the request title unless the body already starts with one', async () => {
    const { composeAppendSection } = await import('../appendTextToNote');
    expect(composeAppendSection('## 概览\n内容', undefined, '学习周报')).toBe('## 概览\n内容');
    expect(composeAppendSection('内容', undefined, '学习周报 09.25–10.01')).toBe('### 学习周报 09.25–10.01\n\n内容');
    expect(composeAppendSection('内容')).toBe('内容');
  });
});
