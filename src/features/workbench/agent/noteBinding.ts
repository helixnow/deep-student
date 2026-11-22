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
import {
  getWorkspaceActiveResource,
  subscribeWorkspaceState,
} from '@/features/workbench/apps/notes/workspaceRegistry';
import { useWindowStore } from '@/features/workbench/core/windowStore';

/** 最近一次写入的 noteId，避免 focusStack 无关抖动重复 updateModeState */
let lastBoundNoteId: string | null | undefined;
let lastBoundSessionId: string | null | undefined;
/** 最近一次非空的笔记 ID，供用户切到对话窗口点击生成式 UI 卡片时兜底定位目标笔记 */
let lastActiveCanvasNoteId: string | null = null;

/**
 * 解析当前桌面中活跃或最近打开的笔记 ID（先看 focusStack 聚焦窗，再看任意打开的 notes/note 窗，最后兜底最近绑定）。
 * 注意：不影响 `modeState.canvasNoteId` 在失焦时置 null 的现有契约。
 */
export function resolveActiveOrLastCanvasNoteId(): string | undefined {
  const { windows, focusStack } = useWindowStore.getState();
  const focused = resolveFocusedNoteId(windows, focusStack);
  if (focused) return focused;
  for (let i = focusStack.length - 1; i >= 0; i -= 1) {
    const win = windows[focusStack[i]!];
    if (!win) continue;
    if (win.typeId === 'notes') {
      const active = getWorkspaceActiveResource(win.id);
      if (active?.type === 'note' && active.id) return active.id;
    } else if (win.typeId === 'note' && typeof win.instanceKey === 'string' && win.instanceKey.length > 0) {
      return win.instanceKey;
    }
  }
  for (const win of Object.values(windows)) {
    if (win.typeId === 'notes') {
      const active = getWorkspaceActiveResource(win.id);
      if (active?.type === 'note' && active.id) return active.id;
    } else if (win.typeId === 'note' && typeof win.instanceKey === 'string' && win.instanceKey.length > 0) {
      return win.instanceKey;
    }
  }
  return lastActiveCanvasNoteId ?? undefined;
}

/**
 * 将 noteId 同步到当前会话 modeState.canvasNoteId。
 * 无当前会话 / store 未就绪时静默跳过。
 */
function bindCanvasNoteId(noteId: string | null): void {
  if (noteId) lastActiveCanvasNoteId = noteId;
  const sessionId = sessionManager.getCurrentSessionId();
  if (lastBoundNoteId === noteId && lastBoundSessionId === sessionId) return;
  lastBoundNoteId = noteId;
  lastBoundSessionId = sessionId;
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
  if (!win) return null;
  if (win.typeId === 'notes') {
    const active = getWorkspaceActiveResource(win.id);
    return active?.type === 'note' && active.id ? active.id : null;
  }
  if (win.typeId !== 'note') return null;
  const key = win.instanceKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * 订阅 windowStore.focusStack：栈顶为 note 窗时绑定 canvasNoteId。
 * 返回退订函数（供 registerAllDrivers / StageManager 生命周期调用）。
 */
export function setupNoteBinding(): () => void {
  lastBoundNoteId = undefined;
  lastBoundSessionId = undefined;

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
  const unsubscribeWorkspace = subscribeWorkspaceState(sync);
  const unsubscribeSession = sessionManager.subscribe((event) => {
    if (event.type === 'current-session-changed') sync();
  });

  return () => {
    unsubscribe();
    unsubscribeWorkspace();
    unsubscribeSession();
    lastBoundNoteId = undefined;
    lastBoundSessionId = undefined;
  };
}
