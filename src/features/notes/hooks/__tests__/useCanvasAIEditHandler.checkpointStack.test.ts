/**
 * P2 笔记 checkpoint 栈化测试：
 * 多改动并存（栈上限 5）、顺序 undo（仅栈顶可回滚）、
 * 冲突语义（内容偏离 resultContent → 标记 stale 不强行覆盖）、切笔记清空。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { CrepeEditorApi } from '@/components/crepe';

const i18nMock = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}));
vi.mock('@/i18n', () => ({ default: i18nMock }));

const invokeMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { useCanvasAIEditHandler, MAX_AI_EDIT_CHECKPOINTS } from '../useCanvasAIEditHandler';

const NOTE_ID = 'note-1';
const ORIGINAL = '# Note\n\noriginal content';

function createFakeEditor(initial: string = ORIGINAL) {
  const state = { content: initial };
  const editor = {
    getMarkdown: () => state.content,
    getFullMarkdown: () => state.content,
    setMarkdown: (markdown: string) => {
      state.content = markdown;
      return true;
    },
    replaceFullMarkdown: async (markdown: string, opts?: { expectedMarkdown?: string }) => {
      if (opts?.expectedMarkdown !== undefined && state.content !== opts.expectedMarkdown) {
        return false;
      }
      state.content = markdown;
      return true;
    },
    focus: () => {},
    isReadonly: () => false,
  };
  return { editor: editor as unknown as CrepeEditorApi, state };
}

function dispatchEditRequest(requestId: string, content: string, noteId: string = NOTE_ID) {
  window.dispatchEvent(
    new CustomEvent('canvas:ai-edit-request', {
      detail: { requestId, noteId, operation: 'set', content },
    })
  );
}

async function acceptEdit(result: { current: ReturnType<typeof useCanvasAIEditHandler> }, requestId: string, content: string) {
  act(() => dispatchEditRequest(requestId, content));
  await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));
  await act(async () => {
    await result.current.handleAccept();
  });
  await waitFor(() => expect(result.current.aiEditState.isActive).toBe(false));
}

describe('useCanvasAIEditHandler checkpoint 栈（P2）', () => {
  beforeEach(() => {
    i18nMock.t.mockClear();
    invokeMock.mockClear();
  });

  it('两次接受 → 栈两条，栈顶为最新；逐条回滚恢复各自编辑前内容', async () => {
    const { editor, state } = createFakeEditor();
    const { result } = renderHook(() =>
      useCanvasAIEditHandler({ noteId: NOTE_ID, editorApi: editor, enabled: true })
    );

    await acceptEdit(result, 'req-1', 'CONTENT-A');
    expect(state.content).toBe('CONTENT-A');
    await acceptEdit(result, 'req-2', 'CONTENT-B');
    expect(state.content).toBe('CONTENT-B');

    expect(result.current.checkpoints).toHaveLength(2);
    expect(result.current.checkpoint?.resultContent).toBe('CONTENT-B');
    // accept 时重算的 diffLines 已入栈
    expect(result.current.checkpoints[1].diffLines.length).toBeGreaterThan(0);

    // 回滚栈顶（req-2）→ 恢复 CONTENT-A
    await act(async () => {
      await result.current.rollbackCheckpoint();
    });
    expect(state.content).toBe('CONTENT-A');
    expect(result.current.checkpoints).toHaveLength(1);

    // 再回滚（req-1）→ 恢复 ORIGINAL
    await act(async () => {
      await result.current.rollbackCheckpoint();
    });
    expect(state.content).toBe(ORIGINAL);
    expect(result.current.checkpoints).toHaveLength(0);
    expect(result.current.checkpoint).toBeNull();
  });

  it('冲突语义：用户中间编辑使内容偏离 resultContent → 标记 stale，不强行覆盖', async () => {
    const { editor, state } = createFakeEditor();
    const { result } = renderHook(() =>
      useCanvasAIEditHandler({ noteId: NOTE_ID, editorApi: editor, enabled: true })
    );

    await acceptEdit(result, 'req-1', 'CONTENT-A');

    // 用户中间编辑
    act(() => {
      editor.setMarkdown('USER EDITED');
    });

    await act(async () => {
      await result.current.rollbackCheckpoint();
    });

    // 内容未被覆盖，条目标记 stale 且保留
    expect(state.content).toBe('USER EDITED');
    expect(result.current.checkpoints).toHaveLength(1);
    expect(result.current.checkpoints[0].stale).toBe(true);
  });

  it('栈上限：连续接受 MAX+1 次后只保留最新 MAX 条', async () => {
    const { editor } = createFakeEditor();
    const { result } = renderHook(() =>
      useCanvasAIEditHandler({ noteId: NOTE_ID, editorApi: editor, enabled: true })
    );

    for (let i = 0; i < MAX_AI_EDIT_CHECKPOINTS + 1; i += 1) {
      await acceptEdit(result, `req-${i}`, `CONTENT-${i}`);
    }

    expect(result.current.checkpoints).toHaveLength(MAX_AI_EDIT_CHECKPOINTS);
    expect(result.current.checkpoint?.resultContent).toBe(`CONTENT-${MAX_AI_EDIT_CHECKPOINTS}`);
  });

  it('dismissCheckpoint：无 id 清空全部；有 id 移除指定条', async () => {
    const { editor } = createFakeEditor();
    const { result } = renderHook(() =>
      useCanvasAIEditHandler({ noteId: NOTE_ID, editorApi: editor, enabled: true })
    );

    await acceptEdit(result, 'req-1', 'CONTENT-A');
    await acceptEdit(result, 'req-2', 'CONTENT-B');
    const firstId = result.current.checkpoints[0].id;

    act(() => result.current.dismissCheckpoint(firstId));
    expect(result.current.checkpoints).toHaveLength(1);
    expect(result.current.checkpoints[0].resultContent).toBe('CONTENT-B');

    act(() => result.current.dismissCheckpoint());
    expect(result.current.checkpoints).toHaveLength(0);
  });

  it('只允许从栈顶回滚（传非栈顶 id 拒绝）', async () => {
    const { editor, state } = createFakeEditor();
    const { result } = renderHook(() =>
      useCanvasAIEditHandler({ noteId: NOTE_ID, editorApi: editor, enabled: true })
    );

    await acceptEdit(result, 'req-1', 'CONTENT-A');
    await acceptEdit(result, 'req-2', 'CONTENT-B');
    const bottomId = result.current.checkpoints[0].id;

    await act(async () => {
      await result.current.rollbackCheckpoint(bottomId);
    });
    expect(state.content).toBe('CONTENT-B');
    expect(result.current.checkpoints).toHaveLength(2);
  });

  it('切换笔记后栈清空', async () => {
    const { editor } = createFakeEditor();
    const { result, rerender } = renderHook(
      ({ noteId }) => useCanvasAIEditHandler({ noteId, editorApi: editor, enabled: true }),
      { initialProps: { noteId: NOTE_ID as string } },
    );

    await acceptEdit(result, 'req-1', 'CONTENT-A');
    expect(result.current.checkpoints).toHaveLength(1);

    rerender({ noteId: 'note-2' });
    await waitFor(() => expect(result.current.checkpoints).toHaveLength(0));
  });
});
