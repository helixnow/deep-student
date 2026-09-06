/**
 * 笔记 AI 编辑控制通道（P2 人机双写 #4）
 *
 * 背景：generative-ui 的 apply-note-edit action 只派发 canvas:ai-edit-request
 * 建议，dispatch 即 resolve；用户 accept 在其后。action undo 需要两态语义——
 * 未 accept = 撤回建议；已 accept = checkpoint 回滚。但建议状态与 checkpoint
 * 栈都活在 NotesCrepeEditor 的 useCanvasAIEditHandler 实例里，generative-ui
 * 侧无通道可达。本注册表就是那条查询/回滚通道。
 *
 * 每笔记至多一个控制端（后注册覆盖先注册；同笔记多窗口场景取最后挂载的
 * 编辑器实例，与 canvas:ai-edit-request 的 targetWindowId 精确路由互补）。
 */

export interface NoteAIEditControlHandle {
  /** 当前是否有待确认建议 */
  hasPendingSuggestion(): boolean;
  /** 撤回待确认建议（= reject；无 pending 时 no-op） */
  rejectPendingSuggestion(): Promise<void>;
  /** 回滚最近一次已接受编辑（checkpoint 栈顶）；无可回滚条目返回 false */
  rollbackLatestCheckpoint(): Promise<boolean>;
}

const controls = new Map<string, NoteAIEditControlHandle>();

export function registerNoteAIEditControl(
  noteId: string,
  handle: NoteAIEditControlHandle,
): () => void {
  controls.set(noteId, handle);
  return () => {
    // 防晚到的卸载清理误删新挂载的 handle（同 messageListScrollRegistry 防御模式）
    if (controls.get(noteId) === handle) {
      controls.delete(noteId);
    }
  };
}

export function getNoteAIEditControl(noteId: string): NoteAIEditControlHandle | null {
  return controls.get(noteId) ?? null;
}
