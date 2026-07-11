import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrepeEditorApi } from '@/components/crepe';
import { useCanvasAIEditHandler } from '@/features/notes/hooks/useCanvasAIEditHandler';

const invoke = vi.fn(async () => undefined);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

function makeEditor(initial = 'old content') {
  let markdown = initial;
  const setMarkdown = vi.fn((next: string) => {
    markdown = next;
  });
  return {
    api: {
      getMarkdown: () => markdown,
      setMarkdown,
      isReadonly: () => false,
    } as unknown as CrepeEditorApi,
    setMarkdown,
  };
}

function dispatchReplace(requestId = 'req-1') {
  window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', {
    detail: {
      requestId,
      noteId: 'note-1',
      operation: 'replace',
      search: 'old',
      replace: 'new',
    },
  }));
}

describe('useCanvasAIEditHandler lifecycle', () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  it('restores the pre-accept snapshot when persistence fails', async () => {
    const editor = makeEditor();
    const onSave = vi.fn(async () => {
      throw new Error('save failed');
    });
    const { result } = renderHook(() => useCanvasAIEditHandler({
      noteId: 'note-1',
      editorApi: editor.api,
      onSave,
    }));

    act(() => dispatchReplace());
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));

    await act(async () => {
      await result.current.handleAccept();
    });

    expect(editor.setMarkdown.mock.calls.map(([value]) => value)).toEqual([
      'new content',
      'old content',
    ]);
    expect(invoke).toHaveBeenCalledWith('chat_v2_canvas_edit_result', {
      result: expect.objectContaining({
        requestId: 'req-1',
        success: false,
        error: 'save failed',
      }),
    });
    expect(result.current.aiEditState.isActive).toBe(true);
    expect(result.current.aiEditState.request?.requestId).toBe('req-1');
  });

  it('keeps the suggestion active when the editor is read-only', async () => {
    const editor = makeEditor();
    editor.api.isReadonly = () => true;
    const onSave = vi.fn(async () => undefined);
    const { result } = renderHook(() => useCanvasAIEditHandler({
      noteId: 'note-1',
      editorApi: editor.api,
      onSave,
    }));

    act(() => dispatchReplace('req-readonly'));
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));
    await act(async () => {
      await result.current.handleAccept();
    });

    expect(result.current.aiEditState.isActive).toBe(true);
    expect(editor.setMarkdown).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent accept attempts while persistence is pending', async () => {
    const editor = makeEditor();
    let finishSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const onSave = vi.fn(() => savePending);
    const { result } = renderHook(() => useCanvasAIEditHandler({
      noteId: 'note-1',
      editorApi: editor.api,
      onSave,
    }));

    act(() => dispatchReplace('req-double'));
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));

    let first!: Promise<void>;
    act(() => {
      first = result.current.handleAccept();
      void result.current.handleAccept();
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(result.current.isApplying).toBe(true);

    finishSave();
    await act(async () => {
      await first;
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(result.current.aiEditState.isActive).toBe(false);
    expect(result.current.isApplying).toBe(false);
  });

  it('rejects a second suggestion instead of replacing the pending diff', async () => {
    const editor = makeEditor();
    const { result } = renderHook(() => useCanvasAIEditHandler({
      noteId: 'note-1',
      editorApi: editor.api,
      onSave: vi.fn(async () => undefined),
    }));

    act(() => {
      dispatchReplace('req-first');
      dispatchReplace('req-second');
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('chat_v2_canvas_edit_result', {
        result: expect.objectContaining({
          requestId: 'req-second',
          success: false,
          error: expect.stringContaining('等待确认'),
        }),
      });
    });
    await waitFor(() => expect(result.current.aiEditState.request?.requestId).toBe('req-first'));
    expect(result.current.aiEditState.request?.requestId).toBe('req-first');
  });

  it('keeps the checkpoint when rollback persistence fails so it can be retried', async () => {
    const editor = makeEditor();
    const onSave = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rollback save failed'));
    const { result } = renderHook(() => useCanvasAIEditHandler({
      noteId: 'note-1',
      editorApi: editor.api,
      onSave,
    }));

    act(() => dispatchReplace('req-rollback'));
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));
    await act(async () => {
      await result.current.handleAccept();
    });
    await waitFor(() => expect(result.current.checkpoint).not.toBeNull());

    await act(async () => {
      await result.current.rollbackCheckpoint();
    });

    expect(result.current.checkpoint).not.toBeNull();
    expect(onSave).toHaveBeenLastCalledWith('old content');
  });

  it('rejects a zero-match replacement instead of opening a no-op diff', async () => {
    const editor = makeEditor();
    const { result } = renderHook(() => useCanvasAIEditHandler({
      noteId: 'note-1',
      editorApi: editor.api,
      onSave: vi.fn(async () => undefined),
    }));

    act(() => {
      window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', {
        detail: {
          requestId: 'req-missing',
          noteId: 'note-1',
          operation: 'replace',
          search: 'not-present',
          replace: 'new',
        },
      }));
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('chat_v2_canvas_edit_result', {
        result: expect.objectContaining({
          requestId: 'req-missing',
          success: false,
          error: '未找到要替换的内容',
        }),
      });
    });
    expect(result.current.aiEditState.isActive).toBe(false);
    expect(editor.setMarkdown).not.toHaveBeenCalled();
  });

  it('keeps the previous checkpoint when a new suggestion is invalid', async () => {
    const editor = makeEditor();
    const onSave = vi.fn(async () => undefined);
    const { result } = renderHook(() => useCanvasAIEditHandler({
      noteId: 'note-1',
      editorApi: editor.api,
      onSave,
    }));

    act(() => dispatchReplace('req-valid'));
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));
    await act(async () => {
      await result.current.handleAccept();
    });
    await waitFor(() => expect(result.current.checkpoint).not.toBeNull());

    act(() => dispatchReplace('req-invalid-after-checkpoint'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('chat_v2_canvas_edit_result', {
        result: expect.objectContaining({
          requestId: 'req-invalid-after-checkpoint',
          success: false,
          error: '未找到要替换的内容',
        }),
      });
    });

    expect(result.current.aiEditState.isActive).toBe(false);
    expect(result.current.checkpoint).not.toBeNull();
    expect(result.current.checkpoint?.originalContent).toBe('old content');
  });
});
