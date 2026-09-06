/**
 * P2 人机双写 #4：apply-note-edit undo 两态语义
 * 未 accept（建议 pending）→ 撤回建议；已 accept → checkpoint 栈顶回滚。
 * 通道：notes/aiEditControlRegistry。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNotesEditActionHandlers } from '@/features/generative-ui/handlers/notesEditActionHandlers';
import {
  registerNoteAIEditControl,
  getNoteAIEditControl,
} from '@/features/notes/aiEditControlRegistry';
import type { NoteAIEditControlHandle } from '@/features/notes/aiEditControlRegistry';

// dispatchCanvasAIEditRequest 内部走 i18n + zod 校验；mock i18n 防 key-echo
vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}));

const SUGGESTION = {
  noteId: 'note-undo-1',
  operation: 'append' as const,
  content: 'AI 追加的段落',
};

const LABELS = { applyEdit: '应用', dismissSuggestion: '忽略' };

/** 模拟笔记编辑器侧：监听 canvas:ai-edit-request 并认领 */
function listenAndClaim(): void {
  window.addEventListener('canvas:ai-edit-request', (event) => {
    const detail = (event as CustomEvent).detail as {
      onLocalDisposition?: (d: { accepted: boolean }) => void;
    };
    detail.onLocalDisposition?.({ accepted: true });
  });
}

describe('apply-note-edit undo（两态语义）', () => {
  beforeEach(() => {
    listenAndClaim();
  });

  it('handler 返回 undo（认领成功时）', async () => {
    const handlers = createNotesEditActionHandlers(SUGGESTION, LABELS);
    const result = await handlers['apply-note-edit'].handler();
    expect(result).toBeDefined();
    expect(typeof (result as { undo?: unknown }).undo).toBe('function');
  });

  it('未 accept：undo 撤回待确认建议', async () => {
    const rejectPendingSuggestion = vi.fn(async () => {});
    const rollbackLatestCheckpoint = vi.fn(async () => false);
    const handle: NoteAIEditControlHandle = {
      hasPendingSuggestion: () => true,
      rejectPendingSuggestion,
      rollbackLatestCheckpoint,
    };
    const unregister = registerNoteAIEditControl(SUGGESTION.noteId, handle);

    const handlers = createNotesEditActionHandlers(SUGGESTION, LABELS);
    const result = await handlers['apply-note-edit'].handler();
    await (result as { undo: () => Promise<void> }).undo();

    expect(rejectPendingSuggestion).toHaveBeenCalledTimes(1);
    expect(rollbackLatestCheckpoint).not.toHaveBeenCalled();
    unregister();
  });

  it('已 accept：undo 走 checkpoint 栈顶回滚', async () => {
    const rejectPendingSuggestion = vi.fn(async () => {});
    const rollbackLatestCheckpoint = vi.fn(async () => true);
    const unregister = registerNoteAIEditControl(SUGGESTION.noteId, {
      hasPendingSuggestion: () => false,
      rejectPendingSuggestion,
      rollbackLatestCheckpoint,
    });

    const handlers = createNotesEditActionHandlers(SUGGESTION, LABELS);
    const result = await handlers['apply-note-edit'].handler();
    await (result as { undo: () => Promise<void> }).undo();

    expect(rollbackLatestCheckpoint).toHaveBeenCalledTimes(1);
    expect(rejectPendingSuggestion).not.toHaveBeenCalled();
    unregister();
  });

  it('编辑器已卸载（无控制端）：undo 静默 no-op', async () => {
    const handlers = createNotesEditActionHandlers(SUGGESTION, LABELS);
    const result = await handlers['apply-note-edit'].handler();
    expect(getNoteAIEditControl(SUGGESTION.noteId)).toBeNull();
    await expect((result as { undo: () => Promise<void> }).undo()).resolves.toBeUndefined();
  });
});
