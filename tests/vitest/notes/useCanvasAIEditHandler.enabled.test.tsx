import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { CrepeEditorApi } from '@/components/crepe';
import { useCanvasAIEditHandler } from '@/features/notes/hooks/useCanvasAIEditHandler';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

function editor() {
  let markdown = 'original';
  return {
    getMarkdown: () => markdown,
    setMarkdown: vi.fn((value: string) => { markdown = value; return true; }),
    isReadonly: () => false,
  } as unknown as CrepeEditorApi;
}

function request(onSettled = vi.fn()) {
  window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', {
    detail: { requestId: 'request', noteId: 'note', operation: 'set', content: 'suggested', onSettled },
  }));
}

describe('useCanvasAIEditHandler enable lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('settles a pending suggestion on disable and cannot apply it after re-enabling', async () => {
    const api = editor();
    const settled = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }) => useCanvasAIEditHandler({ noteId: 'note', editorApi: api, enabled }),
      { initialProps: { enabled: true } },
    );
    act(() => request(settled));
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(true));
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.aiEditState.isActive).toBe(false));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('chat_v2_canvas_edit_result', {
      result: expect.objectContaining({ requestId: 'request', success: false }),
    });
    rerender({ enabled: true });
    await act(async () => { await result.current.handleAccept(); });
    expect(api.getMarkdown()).toBe('original');
  });

  it('keeps accepted checkpoints while disabled but blocks their application until enabled', async () => {
    const api = editor();
    const { result, rerender } = renderHook(
      ({ enabled }) => useCanvasAIEditHandler({ noteId: 'note', editorApi: api, enabled }),
      { initialProps: { enabled: true } },
    );
    act(() => request());
    await act(async () => { await result.current.handleAccept(); });
    expect(result.current.checkpoints).toHaveLength(1);
    rerender({ enabled: false });
    await act(async () => { await result.current.rollbackCheckpoint(); });
    expect(api.getMarkdown()).toBe('suggested');
    expect(result.current.checkpoints).toHaveLength(1);
    rerender({ enabled: true });
    await act(async () => { await result.current.rollbackCheckpoint(); });
    expect(api.getMarkdown()).toBe('original');
  });
});
