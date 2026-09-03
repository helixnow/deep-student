/**
 * 画布 AI 编辑失败文案 i18n key-echo 契约测试。
 *
 * mock `@/i18n` 为 (key) => key，触发 apply / rollback 失败路径，
 * 断言用户/agent 可见错误走 `vfs:canvas_edit.*`，且回执（sendResult）
 * 中携带的是 i18n 输出而非硬编码中文。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { CrepeEditorApi } from '@/components/crepe';

const i18nMock = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}));
vi.mock('@/i18n', () => ({ default: i18nMock }));

const invokeMock = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => null));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { useCanvasAIEditHandler } from '../useCanvasAIEditHandler';

const NOTE_ID = 'note-1';
const ORIGINAL = '# Note\n\noriginal content';

interface FakeEditorOptions {
  /** replaceFullMarkdown 是否报告失败（内容仍会被写入，模拟"已应用但回报失败"） */
  failReplace?: boolean;
}

function createFakeEditor(options: FakeEditorOptions = {}) {
  const state = { content: ORIGINAL, failReplace: options.failReplace ?? false };
  const editor = {
    getMarkdown: () => state.content,
    getFullMarkdown: () => state.content,
    setMarkdown: (markdown: string) => {
      state.content = markdown;
      return true;
    },
    replaceFullMarkdown: async (markdown: string) => {
      state.content = markdown;
      return !state.failReplace;
    },
    focus: () => {},
    isReadonly: () => false,
  };
  return { editor: editor as unknown as CrepeEditorApi, state };
}

function dispatchEditRequest(requestId: string) {
  window.dispatchEvent(
    new CustomEvent('canvas:ai-edit-request', {
      detail: {
        requestId,
        noteId: NOTE_ID,
        operation: 'set',
        content: 'PROPOSED CONTENT',
      },
    })
  );
}

function sentResults(): Array<{ requestId: string; success: boolean; error?: string }> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === 'chat_v2_canvas_edit_result')
    .map(([, args]) => (args as { result: { requestId: string; success: boolean; error?: string } }).result);
}

describe('useCanvasAIEditHandler i18n key-echo', () => {
  beforeEach(() => {
    i18nMock.t.mockClear();
    invokeMock.mockClear();
  });

  it('apply 失败：拒绝应用与恢复失败文案走 vfs:canvas_edit.*，回执携带 i18n 输出', async () => {
    const { editor } = createFakeEditor({ failReplace: true });
    const { result } = renderHook(() =>
      useCanvasAIEditHandler({ noteId: NOTE_ID, editorApi: editor, enabled: true })
    );

    await act(async () => {
      dispatchEditRequest('req-apply-fail');
    });
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));

    await act(async () => {
      await result.current.handleAccept();
    });

    // replaceFullMarkdown 返回 false → 抛出 apply_rejected；
    // 失败后内容已是建议内容 → 尝试恢复，再次失败 → restore_rejected。
    expect(i18nMock.t).toHaveBeenCalledWith(
      'vfs:canvas_edit.apply_rejected',
      expect.objectContaining({ defaultValue: '编辑器拒绝应用建议' })
    );
    expect(i18nMock.t).toHaveBeenCalledWith(
      'vfs:canvas_edit.restore_rejected',
      expect.objectContaining({ defaultValue: '编辑器拒绝恢复建议前内容' })
    );

    const failure = sentResults().find((r) => r.requestId === 'req-apply-fail');
    expect(failure).toBeDefined();
    expect(failure!.success).toBe(false);
    expect(failure!.error).toBe('vfs:canvas_edit.apply_rejected');
  });

  it('rollback 失败：回滚检查点失败文案走 vfs:canvas_edit.rollback_rejected', async () => {
    const { editor, state } = createFakeEditor();
    const { result } = renderHook(() =>
      useCanvasAIEditHandler({ noteId: NOTE_ID, editorApi: editor, enabled: true })
    );

    await act(async () => {
      dispatchEditRequest('req-rollback');
    });
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));

    // 先成功接受，产生检查点
    await act(async () => {
      await result.current.handleAccept();
    });
    expect(result.current.checkpoint).not.toBeNull();

    // 再让编辑器拒绝回滚
    state.failReplace = true;
    await act(async () => {
      await result.current.rollbackCheckpoint();
    });

    expect(i18nMock.t).toHaveBeenCalledWith(
      'vfs:canvas_edit.rollback_rejected',
      expect.objectContaining({ defaultValue: '编辑器拒绝回滚检查点' })
    );
    // 回滚失败时保留检查点，允许重试
    expect(result.current.checkpoint).not.toBeNull();
  });

  it('编辑器只读：回执错误为 vfs:canvas_edit.editor_readonly', async () => {
    const { editor } = createFakeEditor();
    const readonlyRef = { value: false };
    (editor as unknown as { isReadonly: () => boolean }).isReadonly = () => readonlyRef.value;

    const { result } = renderHook(() =>
      useCanvasAIEditHandler({ noteId: NOTE_ID, editorApi: editor, enabled: true })
    );

    await act(async () => {
      dispatchEditRequest('req-readonly');
    });
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));

    readonlyRef.value = true;
    await act(async () => {
      await result.current.handleAccept();
    });

    expect(i18nMock.t).toHaveBeenCalledWith(
      'vfs:canvas_edit.editor_readonly',
      expect.objectContaining({ defaultValue: '编辑器不可写，修改未应用' })
    );
    const failure = sentResults().find((r) => r.requestId === 'req-readonly');
    expect(failure).toBeDefined();
    expect(failure!.error).toBe('vfs:canvas_edit.editor_readonly');
  });
});
