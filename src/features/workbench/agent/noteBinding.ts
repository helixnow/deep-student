/**
 * ACR 笔记会话绑定 — R1-13
 *
 * note 窗聚焦（focusStack 栈顶 typeId==='note'）时，把 instanceKey（= resourceId）
 * 写入当前 chat 会话 store 的 modeState.canvasNoteId，供 TauriAdapter 发送时
 * 作为 Canvas/笔记工具的默认目标。
 *
 * 绑定路径选择：直接 `sessionManager.get(currentSessionId).getState().updateModeState`
 * （比 CustomEvent `canvas:note-changed` 更干净——后者主要服务 legacy NotesContext UI，
 * 且 useCanvasContextRef 已注释停用）。
 *
 * @see docs/dev/acr/DESIGN.md §5.2
 * @see docs/dev/acr/ROUND1.md R1-13
 */
import { sessionManager } from '@/features/chat/core/session';
import { useWindowStore } from '@/features/workbench/core/windowStore';

/** 最近一次写入的 noteId，避免 focusStack 无关抖动重复 updateModeState */
let lastBoundNoteId: string | null | undefined;

/**
 * 将 noteId 同步到当前会话 modeState.canvasNoteId。
 * 无当前会话 / store 未就绪时静默跳过。
 */
function bindCanvasNoteId(noteId: string | null): void {
  if (lastBoundNoteId === noteId) return;
  lastBoundNoteId = noteId;

  const sessionId = sessionManager.getCurrentSessionId();
  if (!sessionId) return;
  const store = sessionManager.get(sessionId);
  if (!store) return;

  const current = store.getState().modeState?.canvasNoteId;
  const currentNormalized =
    typeof current === 'string' && current.length > 0 ? current : null;
  if (currentNormalized === noteId) return;

  store.getState().updateModeState({ canvasNoteId: noteId });
}

/**
 * 从 focusStack 栈顶解析 note 窗的 instanceKey；非 note 或无窗 → null。
 */
function resolveFocusedNoteId(
  windows: ReturnType<typeof useWindowStore.getState>['windows'],
  focusStack: string[],
): string | null {
  const topId = focusStack.length > 0 ? focusStack[focusStack.length - 1] : null;
  if (!topId) return null;
  const win = windows[topId];
  if (!win || win.typeId !== 'note') return null;
  const key = win.instanceKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * 订阅 windowStore.focusStack：栈顶为 note 窗时绑定 canvasNoteId。
 * 返回退订函数（供 registerAllDrivers / StageManager 生命周期调用）。
 */
export function setupNoteBinding(): () => void {
  lastBoundNoteId = undefined;

  const sync = () => {
    const { windows, focusStack } = useWindowStore.getState();
    bindCanvasNoteId(resolveFocusedNoteId(windows, focusStack));
  };

  // 启动时同步一次（可能已有 note 窗在栈顶）
  sync();

  const unsubscribe = useWindowStore.subscribe((state, prev) => {
    if (state.focusStack === prev.focusStack && state.windows === prev.windows) {
      return;
    }
    const nextNoteId = resolveFocusedNoteId(state.windows, state.focusStack);
    const prevNoteId = resolveFocusedNoteId(prev.windows, prev.focusStack);
    if (nextNoteId === prevNoteId) return;
    bindCanvasNoteId(nextNoteId);
  });

  return () => {
    unsubscribe();
    lastBoundNoteId = undefined;
  };
}
